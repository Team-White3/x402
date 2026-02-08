import express from "express";
// import cors from "cors";
import dotenv from "dotenv";
import {
  createPublicClient,
  createWalletClient,
  recoverTypedDataAddress,
  parseAbi,
  http,
  getAddress,
  isHex,
  Hex
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

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
const CFX_PRICE_UNITS = process.env.CFX_PRICE_UNITS ?? "100000000000000000";
const USDT_PRICE_UNITS = process.env.USDT_PRICE_UNITS ?? "1000000";
const MAX_TIMEOUT_SECONDS = Number(process.env.MAX_TIMEOUT_SECONDS ?? 3600);
const PENDING_WAIT_MS = Number(process.env.PENDING_WAIT_MS ?? 5000);
const RETRY_AFTER_SECONDS = Number(process.env.RETRY_AFTER_SECONDS ?? 5);
const ENABLE_EIP3009 = (process.env.ENABLE_EIP3009 ?? "false").toLowerCase() === "true";
const TOKEN_ADDRESS = process.env.TOKEN_ADDRESS ?? "";
const TOKEN_NAME = process.env.TOKEN_NAME ?? "USDT";
const TOKEN_VERSION = process.env.TOKEN_VERSION ?? "1";
const TOKEN_DECIMALS = Number(process.env.TOKEN_DECIMALS ?? 6);
const RELAYER_PRIVATE_KEY = process.env.RELAYER_PRIVATE_KEY ?? "";

if (!RPC_URL) {
  // eslint-disable-next-line no-console
  console.warn("[x402] RPC_URL is empty. On-chain settlement will fail.");
}
if (!PAY_TO) {
  // eslint-disable-next-line no-console
  console.warn("[x402] PAY_TO is empty. Payment requirements will be invalid.");
}
if (ENABLE_EIP3009 && !TOKEN_ADDRESS) {
  // eslint-disable-next-line no-console
  console.warn("[x402] ENABLE_EIP3009 is true but TOKEN_ADDRESS is empty.");
}
if (ENABLE_EIP3009 && !RELAYER_PRIVATE_KEY) {
  // eslint-disable-next-line no-console
  console.warn("[x402] ENABLE_EIP3009 is true but RELAYER_PRIVATE_KEY is empty.");
}

const payToAddress = PAY_TO ? getAddress(PAY_TO) : "0x0000000000000000000000000000000000000000";
const tokenAddress = TOKEN_ADDRESS ? getAddress(TOKEN_ADDRESS) : null;

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
const usedAuthorizations = new Set<string>();

const relayerAccount = RELAYER_PRIVATE_KEY
  ? privateKeyToAccount(RELAYER_PRIVATE_KEY as Hex)
  : null;
const walletClient = relayerAccount
  ? createWalletClient({
      chain,
      transport: http(RPC_URL || "http://localhost"),
      account: relayerAccount
    })
  : null;

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
  asset: "CFX" | "USDT";
  payTo: string;
  maxTimeoutSeconds?: number;
  tokenAddress?: string;
  tokenSymbol?: string;
  tokenDecimals?: number;
  eip3009?: {
    name: string;
    version: string;
    chainId: number;
  };
};

type Eip3009Authorization = {
  from: string;
  to: string;
  value: string;
  validAfter: number;
  validBefore: number;
  nonce: Hex;
  signature: Hex;
};

type PaymentSignaturePayload = {
  x402Version: 2;
  resource?: { url?: string };
  accepted?: PaymentRequirement;
  scheme?: string;
  network?: string;
  transactionHash?: string;
  eip3009Authorization?: Eip3009Authorization;
};

function buildPaymentRequired(reqUrl: string) {
  const requirements: PaymentRequirement[] = [];
  requirements.push({
    scheme: "exact",
    network: config.network,
    amount: CFX_PRICE_UNITS,
    asset: "CFX",
    payTo: payToAddress,
    maxTimeoutSeconds: MAX_TIMEOUT_SECONDS
  });

  if (ENABLE_EIP3009 && tokenAddress) {
    requirements.push({
      scheme: "exact",
      network: config.network,
      amount: USDT_PRICE_UNITS,
      asset: "USDT",
      payTo: payToAddress,
      maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
      tokenAddress,
      tokenSymbol: "USDT",
      tokenDecimals: TOKEN_DECIMALS,
      eip3009: {
        name: TOKEN_NAME,
        version: TOKEN_VERSION,
        chainId: CHAIN_ID
      }
    });
  }

  return {
    x402Version: 2,
    error: "Payment required",
    resource: {
      url: reqUrl,
      description: "Paid API response",
      mimeType: "application/json"
    },
    accepts: requirements
  };
}

function normalizeRequirement(payload: PaymentSignaturePayload): PaymentRequirement | null {
  if (payload.accepted) return payload.accepted;
  if (payload.scheme && payload.network) {
    return {
      scheme: "exact",
      network: payload.network,
      amount: CFX_PRICE_UNITS,
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
  if (getAddress(requirement.payTo) !== payToAddress) {
    throw new Error("payTo mismatch");
  }
  const expectedAmount =
    requirement.asset === "USDT" ? USDT_PRICE_UNITS : CFX_PRICE_UNITS;
  if (requirement.amount !== expectedAmount) {
    throw new Error("Amount mismatch");
  }

  if (requirement.asset === "CFX") {
    return await verifyAndSettleNative(payment);
  }
  if (requirement.asset === "USDT") {
    return await verifyAndSettleEip3009(payment, requirement);
  }

  throw new Error("Unsupported asset");
}

async function verifyAndSettleNative(payment: PaymentSignaturePayload) {
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
  if (tx.value !== BigInt(CFX_PRICE_UNITS)) {
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

function parseSignature(signature: Hex) {
  if (!isHex(signature) || signature.length !== 132) {
    throw new Error("Invalid signature format");
  }
  const r = (`0x${signature.slice(2, 66)}`) as Hex;
  const s = (`0x${signature.slice(66, 130)}`) as Hex;
  let v = parseInt(signature.slice(130, 132), 16);
  if (v < 27) v += 27;
  return { r, s, v };
}

async function verifyAndSettleEip3009(
  payment: PaymentSignaturePayload,
  requirement: PaymentRequirement
) {
  if (!ENABLE_EIP3009 || !tokenAddress) {
    throw new Error("EIP-3009 not enabled");
  }
  if (!walletClient) {
    throw new Error("Relayer not configured");
  }
  if (requirement.tokenAddress && getAddress(requirement.tokenAddress) !== tokenAddress) {
    throw new Error("Token address mismatch");
  }

  const auth = payment.eip3009Authorization;
  if (!auth) {
    throw new Error("Missing EIP-3009 authorization");
  }

  if (getAddress(auth.to) !== payToAddress) {
    throw new Error("Authorization recipient mismatch");
  }
  if (auth.value !== requirement.amount) {
    throw new Error("Authorization amount mismatch");
  }
  if (!isHex(auth.nonce) || auth.nonce.length !== 66) {
    throw new Error("Invalid authorization nonce");
  }

  const now = nowSeconds();
  if (now < auth.validAfter) {
    throw new Error("Authorization not yet valid");
  }
  if (now > auth.validBefore) {
    throw new Error("Authorization expired");
  }

  const domain = {
    name: TOKEN_NAME,
    version: TOKEN_VERSION,
    chainId: CHAIN_ID,
    verifyingContract: tokenAddress
  } as const;
  const types = {
    TransferWithAuthorization: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" }
    ]
  } as const;
  const message = {
    from: auth.from,
    to: auth.to,
    value: BigInt(auth.value),
    validAfter: BigInt(auth.validAfter),
    validBefore: BigInt(auth.validBefore),
    nonce: auth.nonce
  } as const;

  const signer = await recoverTypedDataAddress({
    domain,
    types,
    primaryType: "TransferWithAuthorization",
    message,
    signature: auth.signature
  });
  if (getAddress(signer) !== getAddress(auth.from)) {
    throw new Error("Authorization signer mismatch");
  }

  const authKey = `${auth.from.toLowerCase()}:${auth.nonce.toLowerCase()}`;
  if (usedAuthorizations.has(authKey)) {
    throw new Error("Authorization already used");
  }

  const authUsedAbi = parseAbi([
    "function authorizationUsed(address from, bytes32 nonce) view returns (bool)"
  ]);
  const alreadyUsedOnchain = await publicClient.readContract({
    address: tokenAddress,
    abi: authUsedAbi,
    functionName: "authorizationUsed",
    args: [getAddress(auth.from), auth.nonce]
  });
  if (alreadyUsedOnchain) {
    usedAuthorizations.add(authKey);
    return {
      transactionHash: "0x0000000000000000000000000000000000000000000000000000000000000000",
      payer: getAddress(auth.from)
    };
  }

  const { r, s, v } = parseSignature(auth.signature);
  const transferAbi = parseAbi([
    "function transferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce,uint8 v,bytes32 r,bytes32 s)"
  ]);

  const txHash = await walletClient.writeContract({
    address: tokenAddress,
    abi: transferAbi,
    functionName: "transferWithAuthorization",
    args: [
      getAddress(auth.from),
      payToAddress,
      BigInt(auth.value),
      BigInt(auth.validAfter),
      BigInt(auth.validBefore),
      auth.nonce,
      v,
      r,
      s
    ]
  });

  let receipt;
  try {
    receipt = await publicClient.waitForTransactionReceipt({
      hash: txHash as Hex,
      confirmations: 1,
      timeout: PENDING_WAIT_MS
    });
  } catch {
    throw new PendingTransactionError(
      "Authorization pending confirmation",
      RETRY_AFTER_SECONDS
    );
  }

  if (receipt.status !== "success") {
    throw new Error("Authorization settlement failed");
  }

  usedAuthorizations.add(authKey);

  return {
    transactionHash: txHash,
    payer: getAddress(auth.from)
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
