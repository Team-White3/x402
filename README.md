# x402 TypeScript Standard Demo (Conflux eSpace)

**目标**：最小可运行的 x402 标准实现（HTTP 402 + `PAYMENT-REQUIRED` + `PAYMENT-SIGNATURE`），仅支持 **原生 CFX 转账**，不依赖任何合约。仅保留**浏览器端 demo**。

## 目录结构

```
./
├── src/index.ts      # Resource Server
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
- `PRICE_UNITS` 价格（wei，默认 `1e17` = `0.1` CFX）

## 环境变量

创建 `.env`（参考 `.env.example`）：

- `PORT` (默认 `3001`)
- `USE_TESTNET` (默认 `false`)
- `MAINNET_RPC_URL`
- `TESTNET_RPC_URL`
- `PAY_TO` (收款地址)
- `PRICE_UNITS` (默认 `100000000000000000` = 0.1 CFX, 18 decimals)
- `MAX_TIMEOUT_SECONDS` (默认 `3600`)

## 启动服务

```bash
npm run dev
```

## 浏览器演示

1. 访问 `http://localhost:3001/`
2. 点击 `Connect Wallet`
3. 输入问题并点击 `Pay & Request`

浏览器会自动完成：
`402 → 解析 PAYMENT-REQUIRED → 发起原生 CFX 转账 → 携带 PAYMENT‑SIGNATURE 重试`

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

服务端会校验交易哈希对应的 **原生 CFX 转账**（收款地址与金额匹配）。

PAYMENT-SIGNATURE（解码后示例）：

```json
{
  "x402Version": 2,
  "resource": { "url": "http://localhost:3001/api/answer" },
  "accepted": {
    "scheme": "exact",
    "network": "eip155:1030",
    "amount": "100",
    "asset": "0xaf37e8b6c9ed7f6318979f56fc287d76c30847ff",
    "payTo": "0xYourTreasuryAddress"
  },
  "payload": {
    "signature": "0x...",
    "authorization": {
      "from": "0xBuyerAddress",
      "to": "0xYourTreasuryAddress",
      "value": "100",
      "validAfter": 0,
      "validBefore": 1739999999,
      "nonce": "0x..."
    }
  }
}
```

## 说明

- 该实现遵循 x402 V2 的 HTTP 402 交互形态。
- `PAYMENT-REQUIRED` 与 `PAYMENT-RESPONSE` 均为 `base64(JSON)`。
- 浏览器端使用 `eth_signTypedData_v4` 进行 EIP‑712 签名。
- 由于链上结算依赖 relayer 私钥，请妥善保护 `RELAYER_PRIVATE_KEY`。

## TODO（如需增强）

- 记录支付日志（DB）
- Nonce 持久化（防重放）
- 速率限制与更严格的 CORS
- 更完整的 Bazaar 扩展与 Schema
