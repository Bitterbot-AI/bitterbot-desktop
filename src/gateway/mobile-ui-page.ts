/**
 * Mobile Chat UI — self-contained HTML page served at GET /m.
 *
 * Designed for phone browsers paired with a local/Tailscale-reachable gateway.
 * Renders a minimal chat view that talks to the gateway via WebSocket using
 * chat.send + chat.history. Token auth is passed either via Bearer header
 * (if the client sets one) or via the ?t= query param (for QR-code entry).
 *
 * Note: this page does not use event streaming in v1; it polls chat.history
 * after each send. Event-based streaming is a follow-on.
 */

export function renderMobileUiPage(gatewayWsUrl: string, gatewayToken?: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"/>
<meta name="theme-color" content="#0a0a14"/>
<title>Bitterbot</title>
<style>
:root {
  --bg: #0a0a14; --card: #12122a; --border: #2a2a5a;
  --text: #e2e8f0; --muted: #94a3b8;
  --primary: #6366f1; --primary-dim: rgba(99,102,241,.15);
  --user: #6366f1; --agent: #1a1a3a;
  --green: #22c55e; --red: #ef4444;
}
* { margin:0; padding:0; box-sizing:border-box; }
html, body { height: 100%; overscroll-behavior: none; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: var(--bg); color: var(--text); display: flex; flex-direction: column; }
.header { display: flex; align-items: center; justify-content: space-between; padding: env(safe-area-inset-top,12px) 16px 8px; border-bottom: 1px solid var(--border); background: var(--bg); }
.title { font-size: 1rem; font-weight: 600; }
.status { font-size: 0.75rem; color: var(--muted); display: flex; align-items: center; gap: 6px; }
.dot { width: 8px; height: 8px; border-radius: 50%; }
.dot.ok { background: var(--green); } .dot.err { background: var(--red); } .dot.wait { background: var(--muted); }
.scroll { flex: 1; overflow-y: auto; padding: 12px; display: flex; flex-direction: column; gap: 8px; }
.msg { max-width: 82%; padding: 10px 14px; border-radius: 14px; font-size: 0.92rem; line-height: 1.4; word-wrap: break-word; white-space: pre-wrap; }
.msg.user { align-self: flex-end; background: var(--user); color: white; border-bottom-right-radius: 4px; }
.msg.agent { align-self: flex-start; background: var(--agent); border: 1px solid var(--border); border-bottom-left-radius: 4px; }
.msg.thinking { align-self: flex-start; color: var(--muted); font-style: italic; font-size: 0.85rem; padding: 4px 8px; }
.footer { border-top: 1px solid var(--border); padding: 10px 12px env(safe-area-inset-bottom,12px); background: var(--bg); display: flex; gap: 8px; }
#input { flex: 1; background: var(--card); color: var(--text); border: 1px solid var(--border); border-radius: 20px; padding: 10px 14px; font-size: 0.95rem; resize: none; max-height: 120px; font-family: inherit; }
#input:focus { outline: none; border-color: var(--primary); }
#send { background: var(--primary); border: none; color: white; padding: 0 18px; border-radius: 20px; font-size: 0.9rem; font-weight: 600; cursor: pointer; }
#send:disabled { opacity: 0.5; cursor: default; }
.empty { margin: auto; color: var(--muted); font-size: 0.9rem; text-align: center; padding: 20px; }
</style>
</head>
<body>
<div class="header">
  <div class="title">Bitterbot</div>
  <div class="status"><span class="dot wait" id="dot"></span><span id="stext">Connecting…</span></div>
</div>
<div class="scroll" id="scroll">
  <div class="empty" id="empty">Say something to get started.</div>
</div>
<div class="footer">
  <textarea id="input" rows="1" placeholder="Message"></textarea>
  <button id="send" disabled>Send</button>
</div>
<script>
const WS_URL = ${JSON.stringify(gatewayWsUrl)};
const URL_PARAMS = new URLSearchParams(location.search);
const TOKEN = URL_PARAMS.get("t") || ${JSON.stringify(gatewayToken ?? "")};
const SESSION_KEY = URL_PARAMS.get("s") || "mobile:default";

let ws = null;
let rpcId = 0;
const pending = new Map();
let connected = false;
let lastKnownMsgCount = 0;

function setStatus(state, text) {
  document.getElementById("dot").className = "dot " + state;
  document.getElementById("stext").textContent = text;
}

function rpc(method, params = {}, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    if (!connected || ws?.readyState !== 1) {
      reject(new Error("not connected"));
      return;
    }
    const id = "m-" + (++rpcId);
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ type: "req", id, method, params }));
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error("timeout"));
      }
    }, timeoutMs);
  });
}

function renderMessages(messages) {
  const scroll = document.getElementById("scroll");
  scroll.innerHTML = "";
  if (!messages || messages.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "Say something to get started.";
    scroll.appendChild(empty);
    return;
  }
  for (const m of messages) {
    const role = m.role === "user" || m.role === "human" ? "user" : "agent";
    const div = document.createElement("div");
    div.className = "msg " + role;
    div.textContent = typeof m.body === "string" ? m.body : (m.text || m.content || "");
    scroll.appendChild(div);
  }
  scroll.scrollTop = scroll.scrollHeight;
}

function showThinking() {
  const scroll = document.getElementById("scroll");
  const div = document.createElement("div");
  div.className = "msg thinking";
  div.id = "thinking-indicator";
  div.textContent = "thinking…";
  scroll.appendChild(div);
  scroll.scrollTop = scroll.scrollHeight;
}

function clearThinking() {
  const el = document.getElementById("thinking-indicator");
  if (el) el.remove();
}

async function refreshHistory() {
  try {
    const resp = await rpc("chat.history", { sessionKey: SESSION_KEY, limit: 50 });
    const messages = resp?.messages ?? [];
    renderMessages(messages);
    lastKnownMsgCount = messages.length;
  } catch (err) {
    // ignore; retry on next send
  }
}

async function waitForReply(sinceCount, deadlineMs) {
  const start = Date.now();
  while (Date.now() - start < deadlineMs) {
    await new Promise((r) => setTimeout(r, 1200));
    try {
      const resp = await rpc("chat.history", { sessionKey: SESSION_KEY, limit: 50 });
      const messages = resp?.messages ?? [];
      if (messages.length > sinceCount) {
        const last = messages[messages.length - 1];
        const role = last?.role ?? "";
        if (role !== "user" && role !== "human") {
          renderMessages(messages);
          lastKnownMsgCount = messages.length;
          return;
        }
      }
    } catch {}
  }
}

async function send() {
  const input = document.getElementById("input");
  const btn = document.getElementById("send");
  const text = input.value.trim();
  if (!text || !connected) return;
  input.value = "";
  btn.disabled = true;
  try {
    // Optimistic render of the user message
    const scroll = document.getElementById("scroll");
    const empty = document.getElementById("empty");
    if (empty) empty.remove();
    const user = document.createElement("div");
    user.className = "msg user";
    user.textContent = text;
    scroll.appendChild(user);
    scroll.scrollTop = scroll.scrollHeight;
    showThinking();

    await rpc("chat.send", {
      sessionKey: SESSION_KEY,
      message: text,
      idempotencyKey: "m-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8),
    });

    await waitForReply(lastKnownMsgCount + 1, 120_000);
    clearThinking();
  } catch (err) {
    clearThinking();
    const scroll = document.getElementById("scroll");
    const e = document.createElement("div");
    e.className = "msg thinking";
    e.textContent = "Error: " + (err?.message || "send failed");
    scroll.appendChild(e);
  } finally {
    btn.disabled = false;
    input.focus();
  }
}

function connect() {
  setStatus("wait", "Connecting…");
  try {
    ws = new WebSocket(WS_URL);
  } catch (err) {
    setStatus("err", "Invalid URL");
    return;
  }
  ws.onopen = () => {
    const id = "m-connect";
    pending.set(id, {
      resolve: () => {
        connected = true;
        setStatus("ok", "Connected");
        document.getElementById("send").disabled = false;
        refreshHistory();
      },
      reject: (err) => {
        setStatus("err", "Auth failed");
        console.warn("connect rejected", err);
      },
    });
    ws.send(JSON.stringify({
      type: "req", id, method: "connect",
      params: {
        minProtocol: 3, maxProtocol: 3,
        client: { id: "bitterbot-mobile-ui", version: "1.0.0", platform: "browser", mode: "ui" },
        auth: TOKEN ? { token: TOKEN } : undefined,
      },
    }));
  };
  ws.onmessage = (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }
    if (msg.type === "event" && msg.event === "connect.challenge") {
      const id = "m-connect";
      pending.set(id, {
        resolve: () => {
          connected = true;
          setStatus("ok", "Connected");
          document.getElementById("send").disabled = false;
          refreshHistory();
        },
        reject: () => setStatus("err", "Auth failed"),
      });
      ws.send(JSON.stringify({
        type: "req", id, method: "connect",
        params: {
          minProtocol: 3, maxProtocol: 3,
          client: { id: "bitterbot-mobile-ui", version: "1.0.0", platform: "browser", mode: "ui" },
          auth: TOKEN ? { token: TOKEN } : undefined,
        },
      }));
      return;
    }
    if (msg.type === "res" && msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.ok === false) reject(new Error(msg.error?.message || "RPC error"));
      else resolve(msg.payload ?? msg.result ?? {});
    }
  };
  ws.onclose = () => {
    connected = false;
    setStatus("err", "Disconnected");
    document.getElementById("send").disabled = true;
    setTimeout(connect, 3000);
  };
  ws.onerror = () => {
    setStatus("err", "Connection error");
  };
}

document.getElementById("send").addEventListener("click", send);
document.getElementById("input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    send();
  }
});
document.getElementById("input").addEventListener("input", (e) => {
  e.target.style.height = "auto";
  e.target.style.height = Math.min(e.target.scrollHeight, 120) + "px";
});

connect();
</script>
</body>
</html>`;
}

export function buildMobilePairingUrl(
  gatewayHttpUrl: string,
  token: string,
  sessionKey?: string,
): string {
  const base = gatewayHttpUrl.replace(/\/+$/, "");
  const params = new URLSearchParams();
  if (token) params.set("t", token);
  if (sessionKey) params.set("s", sessionKey);
  const qs = params.toString();
  return qs ? `${base}/m?${qs}` : `${base}/m`;
}
