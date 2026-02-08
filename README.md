# x402 TypeScript Standard Demo (Conflux eSpace)

**目标**：最小可运行的 x402 标准实现（HTTP 402 + `PAYMENT-REQUIRED` + `PAYMENT-SIGNATURE`），默认支持 **原生 CFX 转账**，并可选启用 **EIP-3009（USDT 无需用户出 gas）**。仅保留**浏览器端 demo**。

## 目录结构

```
./
├── src/index.ts      # Resource Server
├── public/index.html # Browser Demo
├── public/app.js     # Browser Demo logic
├── package.json
├── tsconfig.json
└── README.md
```

## 安装

```bash
cd x402-ts-standard-demo
npm install
```

## 全局配置（主网/测试网）

### 服务端（`.env`）

- `USE_TESTNET`：`false` 使用 1030 主网，`true` 使用 71 测试网
- `MAINNET_RPC_URL` / `TESTNET_RPC_URL`
- `PAY_TO` 收款地址
- `PRICE_UNITS` 价格（最小单位，默认 `1e17` = `0.1` CFX）

## 环境变量

创建 `.env`（参考 `.env.example`）：

- `PORT` (默认 `3001`)
- `USE_TESTNET` (默认 `false`)
- `MAINNET_RPC_URL`
- `TESTNET_RPC_URL`
- `PAY_TO` (收款地址)
- `CFX_PRICE_UNITS` (默认 `100000000000000000` = 0.1 CFX, 18 decimals)
- `ENABLE_EIP3009` (默认 `false`，启用 USDT EIP-3009 支付)
- `TOKEN_ADDRESS` (USDT 合约地址)
- `TOKEN_NAME` (EIP-712 name，默认 `USDT`)
- `TOKEN_VERSION` (EIP-712 version，默认 `1`)
- `TOKEN_DECIMALS` (默认 `6`)
- `USDT_PRICE_UNITS` (默认 `1000000` = 1 USDT, 6 decimals)
- `RELAYER_PRIVATE_KEY` (EIP-3009 结算用，服务端代付 gas)
- `MAX_TIMEOUT_SECONDS` (默认 `3600`)
- `PENDING_WAIT_MS` (默认 `5000`，等待链上确认的单次超时)
- `RETRY_AFTER_SECONDS` (默认 `5`，pending 时客户端重试间隔)

## 启动服务

```bash
npm run dev
```

## 浏览器演示

1. 访问 `http://localhost:3001/`
2. 点击 `Connect Wallet`
3. 输入问题并点击 `Pay & Request`

浏览器会自动完成：
`402 → 解析 PAYMENT-REQUIRED → (CFX 直转 / USDT EIP-3009 签名) → 携带 PAYMENT‑SIGNATURE 重试`

## 接口说明

### 1) 请求 API（未支付）

```
GET /api/answer?q=hello
```

返回：`402` + `PAYMENT-REQUIRED` header (base64 JSON)

示例（解码后）：

```json
{
  "x402Version": 2,
  "error": "Payment required",
  "resource": {
    "url": "http://localhost:3001/api/answer",
    "description": "Paid API response",
    "mimeType": "application/json"
  },
  "accepts": [
    {
      "scheme": "exact",
      "network": "eip155:1030",
      "amount": "100000000000000000",
      "asset": "CFX",
      "payTo": "0xYourTreasuryAddress",
      "maxTimeoutSeconds": 3600
    },
    {
      "scheme": "exact",
      "network": "eip155:1030",
      "amount": "1000000",
      "asset": "USDT",
      "payTo": "0xYourTreasuryAddress",
      "maxTimeoutSeconds": 3600,
      "tokenAddress": "0xYourUsdtAddress",
      "tokenSymbol": "USDT",
      "tokenDecimals": 6,
      "eip3009": {
        "name": "USDT",
        "version": "1",
        "chainId": 1030
      }
    }
  ]
}
```

### 2) 支付（浏览器完成签名后）

浏览器构造 `PAYMENT-SIGNATURE` header，并再次请求：

```
GET /api/answer?q=hello
PAYMENT-SIGNATURE: base64(JSON)
```

服务端会校验：
- CFX：交易哈希对应的 **原生 CFX 转账**（收款地址与金额匹配）。
- USDT：EIP-3009 授权签名 + relayer 代付提交 `transferWithAuthorization`。

PAYMENT-SIGNATURE（解码后示例）：

```json
{
  "x402Version": 2,
  "resource": { "url": "http://localhost:3001/api/answer" },
  "accepted": {
    "scheme": "exact",
    "network": "eip155:1030",
    "amount": "1000000",
    "asset": "USDT",
    "payTo": "0xYourTreasuryAddress",
    "tokenAddress": "0xYourUsdtAddress",
    "tokenSymbol": "USDT",
    "tokenDecimals": 6,
    "eip3009": { "name": "USDT", "version": "1", "chainId": 1030 }
  },
  "eip3009Authorization": {
    "from": "0xBuyerAddress",
    "to": "0xYourTreasuryAddress",
    "value": "1000000",
    "validAfter": 1700000000,
    "validBefore": 1700003600,
    "nonce": "0x...",
    "signature": "0x..."
  }
}
```

## 说明

- 该实现遵循 x402 V2 的 HTTP 402 交互形态。
- `PAYMENT-REQUIRED` 与 `PAYMENT-RESPONSE` 均为 `base64(JSON)`。
- 浏览器端使用 `eth_signTypedData_v4` 进行 EIP‑712 签名。
- 仅当 USDT 合约实现 `transferWithAuthorization` 时，EIP-3009 才可用。
- 启用 EIP-3009 后，服务端用 relayer 账户代付 gas，请妥善保护 `RELAYER_PRIVATE_KEY`。

## TODO（如需增强）

- 记录支付日志（DB）
- Nonce 持久化（防重放）
- 速率限制与更严格的 CORS
- 更完整的 Bazaar 扩展与 Schema
