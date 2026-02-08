const API_URL = "/api/answer";

const logEl = document.getElementById("log");
const connectBtn = document.getElementById("connect");
const payBtn = document.getElementById("pay");
const queryEl = document.getElementById("query");
let pendingPayment = null;
let pendingTimer = null;

function log(value, isError = false) {
  logEl.textContent = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  logEl.className = isError ? "error" : "";
}

function setPendingUi(isPending) {
  payBtn.disabled = isPending;
  payBtn.textContent = isPending ? "Waiting for confirmation..." : "Pay & Request";
}

function clearPendingPayment() {
  if (pendingTimer) {
    clearTimeout(pendingTimer);
    pendingTimer = null;
  }
  pendingPayment = null;
  setPendingUi(false);
}

function scheduleRetry(paymentSignature, q, delayMs) {
  if (pendingTimer) clearTimeout(pendingTimer);
  pendingTimer = setTimeout(() => {
    retryWithSignature(paymentSignature, q).catch((err) =>
      log(err?.message || String(err), true)
    );
  }, delayMs);
}

function base64Decode(value) {
  const json = atob(value);
  return JSON.parse(json);
}

function base64Encode(value) {
  return btoa(JSON.stringify(value));
}

async function connectWallet() {
  if (!window.ethereum) {
    log("No injected wallet found", true);
    return;
  }
  const accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
  log({ connected: accounts[0] });
}

async function retryWithSignature(paymentSignature, q) {
  const res = await fetch(`${API_URL}?q=${encodeURIComponent(q)}`, {
    headers: {
      "PAYMENT-SIGNATURE": base64Encode(paymentSignature)
    }
  });

  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }

  if (res.status === 402 && body && body.status === "pending") {
    const retryAfterHeader = res.headers.get("Retry-After");
    const retryAfterSeconds = Number(retryAfterHeader || body.retryAfterSeconds || 5);
    log(`Payment detected. Waiting for confirmation... retrying in ${retryAfterSeconds}s`);
    scheduleRetry(paymentSignature, q, retryAfterSeconds * 1000);
    return;
  }

  if (res.status === 200) {
    clearPendingPayment();
    log({
      status: res.status,
      paymentResponse: res.headers.get("PAYMENT-RESPONSE"),
      body
    });
    return;
  }

  clearPendingPayment();
  log({ status: res.status, body }, true);
}

async function requestWithPayment() {
  if (!window.ethereum) {
    log("No injected wallet found", true);
    return;
  }

  const q = queryEl.value || "";
  if (pendingPayment) {
    if (pendingPayment.q === q) {
      log("Payment already sent. Checking confirmation...");
      await retryWithSignature(pendingPayment.paymentSignature, q);
      return;
    }
    clearPendingPayment();
  }

  const first = await fetch(`${API_URL}?q=${encodeURIComponent(q)}`);
  if (first.status !== 402) {
    log({ status: first.status, body: await first.text() });
    return;
  }

  const paymentRequiredHeader = first.headers.get("PAYMENT-REQUIRED");
  if (!paymentRequiredHeader) {
    log("Missing PAYMENT-REQUIRED header", true);
    return;
  }

  const paymentRequired = base64Decode(paymentRequiredHeader);
  const requirement = paymentRequired.accepts[0];

  const accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
  const from = accounts[0];

  const valueHex = "0x" + BigInt(requirement.amount).toString(16);
  const transactionHash = await window.ethereum.request({
    method: "eth_sendTransaction",
    params: [
      {
        from,
        to: requirement.payTo,
        value: valueHex
      }
    ]
  });

  const paymentSignature = {
    x402Version: 2,
    resource: { url: paymentRequired.resource?.url || window.location.origin + API_URL },
    accepted: requirement,
    transactionHash
  };

  pendingPayment = { paymentSignature, q, startedAt: Date.now() };
  setPendingUi(true);
  log("Payment sent. Waiting for confirmation...");
  await retryWithSignature(paymentSignature, q);
}

connectBtn.addEventListener("click", () => {
  connectWallet().catch((err) => log(err?.message || String(err), true));
});

payBtn.addEventListener("click", () => {
  requestWithPayment().catch((err) => log(err?.message || String(err), true));
});
