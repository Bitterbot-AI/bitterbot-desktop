/**
 * Self-contained HTML page for wallet funding via Stripe Crypto Onramp.
 * Served at GET /wallet/fund by the gateway HTTP server.
 */
export function renderWalletFundingPage(gatewayWsUrl: string, gatewayToken?: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Fund Wallet — Bitterbot</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background: #0a0a0f;
      color: #e0e0e0;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      padding: 1rem;
    }
    .card {
      background: #15151f;
      border: 1px solid #2a2a3a;
      border-radius: 12px;
      padding: 2rem;
      max-width: 480px;
      width: 100%;
    }
    h1 { font-size: 1.4rem; margin-bottom: 1.5rem; color: #fff; }
    .info-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 0.6rem 0;
      border-bottom: 1px solid #1e1e2e;
      font-size: 0.9rem;
    }
    .info-row .label { color: #888; }
    .info-row .value {
      font-family: "SF Mono", "Fira Code", monospace;
      font-size: 0.85rem;
      word-break: break-all;
      text-align: right;
      max-width: 60%;
    }
    .btn {
      display: inline-block;
      width: 100%;
      padding: 0.75rem 1.5rem;
      margin-top: 1.5rem;
      border: none;
      border-radius: 8px;
      font-size: 1rem;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.15s;
    }
    .btn-primary { background: #5b5bf7; color: #fff; }
    .btn-primary:hover { background: #4a4ae0; }
    .btn-primary:disabled { background: #3a3a5a; cursor: not-allowed; color: #777; }
    .btn-secondary {
      background: transparent;
      border: 1px solid #3a3a5a;
      color: #aaa;
      margin-top: 0.75rem;
    }
    .btn-secondary:hover { border-color: #5b5bf7; color: #ccc; }
    #onramp-container { margin-top: 1.5rem; min-height: 400px; }
    .status {
      text-align: center;
      padding: 2rem 0;
      color: #888;
      font-size: 0.9rem;
    }
    .status.error { color: #f55; }
    .status.success { color: #5f5; }
    .hidden { display: none; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Fund Wallet</h1>

    <div id="wallet-info">
      <div class="info-row">
        <span class="label">Address</span>
        <span class="value" id="wallet-address">Loading…</span>
      </div>
      <div class="info-row">
        <span class="label">Network</span>
        <span class="value" id="wallet-network">—</span>
      </div>
      <div class="info-row">
        <span class="label">USDC Balance</span>
        <span class="value" id="wallet-balance">—</span>
      </div>
    </div>

    <button class="btn btn-primary" id="fund-btn" disabled>Fund with Card (Stripe)</button>
    <a id="faucet-link" class="btn btn-secondary hidden" target="_blank" rel="noopener">Use Testnet Faucet</a>

    <div id="onramp-container" class="hidden"></div>
    <div id="status-msg" class="status hidden"></div>
  </div>

  <script src="https://js.stripe.com/v3/"></script>
  <script src="https://crypto-js.stripe.com/crypto-onramp-outer.js"></script>
  <script>
    const WS_URL = ${JSON.stringify(gatewayWsUrl)};
    const GW_TOKEN = ${JSON.stringify(gatewayToken ?? "")};
    let ws;
    let rpcId = 0;
    const pending = new Map();
    let stripeEnabled = false;
    let wsConnected = false;

    function rpc(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = String(++rpcId);
        pending.set(id, { resolve, reject });
        if (ws?.readyState === 1 && wsConnected) ws.send(JSON.stringify({ type: "req", id, method, params }));
        else reject(new Error("not connected"));
        setTimeout(() => {
          if (pending.has(id)) {
            pending.delete(id);
            reject(new Error("RPC timeout"));
          }
        }, 30000);
      });
    }

    function showStatus(msg, type) {
      const el = document.getElementById("status-msg");
      el.textContent = msg;
      el.className = "status " + (type || "");
      el.classList.remove("hidden");
    }

    function hideStatus() {
      document.getElementById("status-msg").classList.add("hidden");
    }

    async function loadWalletInfo() {
      try {
        const [addrResp, balResp, configResp] = await Promise.all([
          rpc("wallet.getAddress"),
          rpc("wallet.getBalance", { token: "USDC" }),
          rpc("wallet.getConfig"),
        ]);
        document.getElementById("wallet-address").textContent = addrResp.address || "—";
        document.getElementById("wallet-network").textContent = addrResp.network || "—";
        document.getElementById("wallet-balance").textContent =
          (balResp.balance ?? "—") + " USDC";

        stripeEnabled = configResp.stripeOnrampEnabled;
        const network = addrResp.network || "";

        // Onramp is always available (local keys, custom endpoint, or hosted service)
        document.getElementById("fund-btn").disabled = false;

        // Show faucet link for testnet
        if (network.includes("sepolia")) {
          const faucetResp = await rpc("wallet.fund");
          const faucetLink = document.getElementById("faucet-link");
          faucetLink.href = faucetResp.fundingUrl;
          faucetLink.classList.remove("hidden");
        }
      } catch (err) {
        showStatus("Failed to load wallet info: " + err.message, "error");
      }
    }

    async function startOnramp() {
      hideStatus();
      const btn = document.getElementById("fund-btn");
      btn.disabled = true;
      btn.textContent = "Loading…";

      try {
        const resp = await rpc("wallet.stripeOnramp");
        const container = document.getElementById("onramp-container");
        container.classList.remove("hidden");
        container.innerHTML = "";

        const stripe = Stripe(resp.publishableKey);
        const onramp = stripe.createCryptoOnrampSession({
          clientSecret: resp.clientSecret,
          appearance: { theme: "dark" },
        });
        onramp.mount("#onramp-container");

        onramp.addEventListener("onramp_session_updated", async (e) => {
          if (e.payload?.status === "fulfillment_complete") {
            showStatus("Funding complete! Refreshing balance…", "success");
            // Refresh balance after a short delay for chain confirmation
            setTimeout(async () => {
              try {
                const bal = await rpc("wallet.getBalance", { token: "USDC" });
                document.getElementById("wallet-balance").textContent =
                  (bal.balance ?? "—") + " USDC";
              } catch {}
            }, 5000);
          }
        });

        btn.textContent = "Fund with Card (Stripe)";
        btn.disabled = false;
      } catch (err) {
        showStatus("Failed to start Stripe Onramp: " + err.message, "error");
        btn.textContent = "Fund with Card (Stripe)";
        btn.disabled = false;
      }
    }

    function connectWs() {
      wsConnected = false;
      ws = new WebSocket(WS_URL);
      ws.onopen = () => {};
      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === "event" && msg.event === "connect.challenge") {
            const connId = String(++rpcId);
            pending.set(connId, {
              resolve: () => { wsConnected = true; loadWalletInfo(); },
              reject: () => { wsConnected = true; loadWalletInfo(); }
            });
            ws.send(JSON.stringify({
              type: "req", id: connId, method: "connect",
              params: {
                minProtocol: 1, maxProtocol: 1,
                client: { id: "bitterbot-control-ui", version: "1.0.0", platform: "browser", mode: "ui" },
                auth: GW_TOKEN ? { token: GW_TOKEN } : undefined
              }
            }));
            return;
          }
          if (msg.type === "res" && msg.id && pending.has(msg.id)) {
            const { resolve, reject } = pending.get(msg.id);
            pending.delete(msg.id);
            if (msg.ok === false) {
              reject(new Error(msg.error?.message || "RPC error"));
            } else {
              resolve(msg.payload ?? {});
            }
          }
        } catch {}
      };
      ws.onerror = () => showStatus("WebSocket error", "error");
      ws.onclose = () => { wsConnected = false; showStatus("Disconnected from gateway", "error"); };
    }

    document.getElementById("fund-btn").addEventListener("click", startOnramp);
    connectWs();
  </script>
</body>
</html>`;
}
