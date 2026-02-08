import express from "express";
// import cors from "cors";
import dotenv from "dotenv";
import {
  createPublicClient,
  http,
  getAddress,
  isHex,
  Hex
} from "viem";

dotenv.config();

const app = express();
// app.use(
//   cors({
//     exposedHeaders: ["PAYMENT-REQUIRED", "PAYMENT-RESPONSE"],
//     allowedHeaders: ["Content-Type", "PAYMENT-SIGNATURE"]
//   })
// );
app.use(express.json());
app.use(express.static("public"));

const PORT = Number(process.env.PORT ?? 3001);
const useTestnet = (process.env.USE_TESTNET ?? "false").toLowerCase() === "true";
const config = useTestnet
  ? {
      name: "Conflux eSpace Testnet",
      chainId: 71,
      network: "eip155:71",
      rpcUrl: process.env.TESTNET_RPC_URL ?? "https://evmtestnet.confluxrpc.com"
    }
  : {
      name: "Conflux eSpace Mainnet",
      chainId: 1030,
      network: "eip155:1030",
      rpcUrl: process.env.MAINNET_RPC_URL ?? "https://evm.confluxrpc.com"
    };
const RPC_URL = config.rpcUrl;
const CHAIN_ID = config.chainId;
const PAY_TO = process.env.PAY_TO ?? "";
const PRICE_UNITS = process.env.PRICE_UNITS ?? "100000000000000000";
const MAX_TIMEOUT_SECONDS = Number(process.env.MAX_TIMEOUT_SECONDS ?? 3600);
const PENDING_WAIT_MS = Number(process.env.PENDING_WAIT_MS ?? 5000);
const RETRY_AFTER_SECONDS = Number(process.env.RETRY_AFTER_SECONDS ?? 5);

if (!RPC_URL) {
  // eslint-disable-next-line no-console
  console.warn("[x402] RPC_URL is empty. On-chain settlement will fail.");
}
if (!PAY_TO) {
  // eslint-disable-next-line no-console
  console.warn("[x402] PAY_TO is empty. Payment requirements will be invalid.");
}

const payToAddress = PAY_TO ? getAddress(PAY_TO) : "0x0000000000000000000000000000000000000000";

const chain = {
  id: CHAIN_ID,
  name: config.name,
  nativeCurrency: { name: "CFX", symbol: "CFX", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL || "http://localhost"] } }
};

const publicClient = createPublicClient({
  chain,
  transport: http(RPC_URL || "http://localhost")
});

const usedTxHashes = new Set<string>();

class PendingTransactionError extends Error {
  retryAfterSeconds: number;
  constructor(message: string, retryAfterSeconds: number) {
    super(message);
    this.name = "PendingTransactionError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function base64Encode(value: object): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

function base64Decode<T = unknown>(value: string): T {
  return JSON.parse(Buffer.from(value, "base64").toString("utf8")) as T;
}

type PaymentRequirement = {
  scheme: "exact";
  network: string;
  amount: string;
  asset: "CFX";
  payTo: string;
  maxTimeoutSeconds?: number;
};

type PaymentSignaturePayload = {
  x402Version: 2;
  resource?: { url?: string };
  accepted?: PaymentRequirement;
  scheme?: string;
  network?: string;
  transactionHash?: string;
};

function buildPaymentRequired(reqUrl: string) {
  const requirements: PaymentRequirement = {
    scheme: "exact",
    network: config.network,
    amount: PRICE_UNITS,
    asset: "CFX",
    payTo: payToAddress,
    maxTimeoutSeconds: MAX_TIMEOUT_SECONDS
  };

  return {
    x402Version: 2,
    error: "Payment required",
    resource: {
      url: reqUrl,
      description: "Paid API response",
      mimeType: "application/json"
    },
    accepts: [requirements]
  };
}

function normalizeRequirement(payload: PaymentSignaturePayload): PaymentRequirement | null {
  if (payload.accepted) return payload.accepted;
  if (payload.scheme && payload.network) {
    return {
      scheme: "exact",
      network: payload.network,
      amount: PRICE_UNITS,
      asset: "CFX",
      payTo: payToAddress
    };
  }
  return null;
}

// 验证并确认用户已发链上交易
async function verifyAndSettle(payment: PaymentSignaturePayload) {
  const requirement = normalizeRequirement(payment);
  if (!requirement) {
    throw new Error("Missing accepted payment requirement");
  }

  if (requirement.scheme !== "exact") {
    throw new Error("Unsupported scheme");
  }
  if (requirement.network !== config.network) {
    throw new Error("Unsupported network");
  }
  if (requirement.asset !== "CFX") {
    throw new Error("Unsupported asset");
  }
  if (getAddress(requirement.payTo) !== payToAddress) {
    throw new Error("payTo mismatch");
  }
  if (requirement.amount !== PRICE_UNITS) {
    throw new Error("Amount mismatch");
  }

  const txHash = payment.transactionHash;
  if (!txHash || !isHex(txHash) || txHash.length !== 66) {
    throw new Error("Missing transaction hash");
  }

  const txKey = txHash.toLowerCase();
  if (usedTxHashes.has(txKey)) {
    throw new Error("Transaction already used");
  }

  const tx = await publicClient.getTransaction({ hash: txHash as Hex });
  if (!tx.to) {
    throw new Error("Transaction missing recipient");
  }
  if (getAddress(tx.to) !== payToAddress) {
    throw new Error("Transaction target mismatch");
  }
  if ((tx.input ?? "0x") !== "0x") {
    throw new Error("Transaction must be native transfer");
  }
  if (tx.value !== BigInt(PRICE_UNITS)) {
    throw new Error("Transaction value mismatch");
  }

  let receipt;
  try {
    receipt = await publicClient.waitForTransactionReceipt({
      hash: txHash as Hex,
      confirmations: 1,
      timeout: PENDING_WAIT_MS
    });
  } catch {
    throw new PendingTransactionError(
      "Transaction pending confirmation",
      RETRY_AFTER_SECONDS
    );
  }

  if (receipt.status !== "success") {
    throw new Error("Transaction failed");
  }

  usedTxHashes.add(txKey);

  return {
    transactionHash: txHash,
    payer: getAddress(tx.from)
  };
}

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

// 付费接口示例
app.get("/api/answer", async (req, res) => {

  // 检查 PAYMENT-SIGNATURE 头
  const paymentHeader = req.header("PAYMENT-SIGNATURE") || req.header("payment-signature");

  if (!paymentHeader) {
    const reqUrl = `${req.protocol}://${req.get("host")}${req.originalUrl.split("?")[0]}`;
    const paymentRequired = buildPaymentRequired(reqUrl);

    // 返回 402 Payment Required 响应
    res.status(402);
    res.setHeader("PAYMENT-REQUIRED", base64Encode(paymentRequired));
    res.setHeader("Content-Type", "application/json");
    res.setHeader(
      "Access-Control-Expose-Headers",
      "PAYMENT-REQUIRED, PAYMENT-RESPONSE"
    );

    return res.json({
      error: "Payment required",
      accepts: paymentRequired.accepts
    });
  }


  // 如果提供了 PAYMENT-SIGNATURE，则验证并结算付款
  try {

    // 解析经过用户端签名的付款头
    const decoded = base64Decode<PaymentSignaturePayload>(paymentHeader);
    const result = await verifyAndSettle(decoded);

    // 返回付费内容
    const responseHeader = {
      x402Version: 2,
      scheme: "exact",
      network: config.network,
      transactionHash: result.transactionHash,
      settlementTimestamp: nowSeconds(),
      status: "settled"
    };

    res.setHeader("PAYMENT-RESPONSE", base64Encode(responseHeader));
    res.setHeader("Content-Type", "application/json");

    return res.json({
      success: true,
      data: {
        answer: `Paid response for q=${String(req.query.q ?? "")}`,
        payer: result.payer,
        txHash: result.transactionHash
      }
    });
  } catch (err) {
    if (err instanceof PendingTransactionError) {
      res.status(402);
      res.setHeader("Retry-After", String(err.retryAfterSeconds));
      res.setHeader("Access-Control-Expose-Headers", "Retry-After");
      res.setHeader("Content-Type", "application/json");
      return res.json({
        error: err.message,
        status: "pending",
        retryAfterSeconds: err.retryAfterSeconds
      });
    }
    const message = err instanceof Error ? err.message : "Payment verification failed";
    return res.status(402).json({ error: message });
  }
});

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`x402 standard demo listening on http://localhost:${PORT}`);
});
