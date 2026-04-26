/**
 * Mobile Chat UI — served at GET /m, with a sibling avatar at GET /m/avatar.png.
 *
 * Designed for phone browsers paired with a local/Tailscale-reachable gateway.
 * Renders a minimal chat view that talks to the gateway via WebSocket using
 * chat.send + the broadcast `chat` event stream. Token auth is passed either
 * via Bearer header (if the client sets one) or via the ?t= query param
 * (for QR-code entry).
 *
 * Visual tokens mirror the desktop Control UI (Bitterbot purple palette,
 * Geist font fallback, streaming-style bubbles + 3-dot typing indicator).
 *
 * The brand title SVG is inlined (417 bytes — cheap). The avatar PNG is
 * served from the sibling /m/avatar.png route via getMobileAvatarBytes()
 * so the browser can cache it across reloads (and we avoid 18 KB of
 * base64 in every page response, which Chromium also chokes on for very
 * long data: URIs in screenshot contexts).
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// 1×1 transparent PNG so /m/avatar.png still answers if the docs/public
// asset is missing in some installation layout.
const FALLBACK_AVATAR = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);

let cachedAvatar: Buffer | null = null;

/**
 * Load the small bitterbot avatar from docs/public. Cached after first read.
 * Tries a few candidate paths so it works whether the gateway runs from
 * src/ in dev or the bundled dist/ in production.
 */
export function getMobileAvatarBytes(): Buffer {
  if (cachedAvatar) return cachedAvatar;
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, "..", "..", "docs", "public", "bitterbot_avatar_small.png"),
    join(here, "..", "..", "..", "docs", "public", "bitterbot_avatar_small.png"),
    join(here, "..", "docs", "public", "bitterbot_avatar_small.png"),
  ];
  for (const p of candidates) {
    try {
      cachedAvatar = readFileSync(p);
      return cachedAvatar;
    } catch {
      // try next
    }
  }
  cachedAvatar = FALLBACK_AVATAR;
  return cachedAvatar;
}

const TITLE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 360 56" width="120" height="22" aria-label="bitterbot"><text x="0" y="40" font-family="Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif" font-size="42" font-weight="800" letter-spacing="-1"><tspan fill="#f9fafb">bitter</tspan><tspan fill="#a855f7">bot</tspan></text></svg>`;

export function renderMobileUiPage(gatewayWsUrl: string, gatewayToken?: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"/>
<meta name="theme-color" content="#0a0a0f"/>
<meta name="apple-mobile-web-app-capable" content="yes"/>
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent"/>
<title>Bitterbot</title>
<link rel="icon" type="image/png" href="/m/avatar.png"/>
<style>
:root {
  /* Bitterbot palette — mirrors desktop/renderer/src/styles/bitterbot-theme.css */
  --bg: #0a0a0f;
  --card: rgba(17, 24, 39, 0.8);
  --card-solid: #111827;
  --border: rgba(139, 92, 246, 0.2);
  --border-strong: rgba(139, 92, 246, 0.35);
  --text: #f9fafb;
  --muted: #9ca3af;
  --primary: #8b5cf6;
  --primary-2: #7c3aed;
  --primary-hover: #7e22ce;
  --bounce: #a855f7;
  --green: #10b981;
  --red: #ef4444;
  --yellow: #f59e0b;
  --bg-subtle: rgba(255, 255, 255, 0.03);
}
* { margin:0; padding:0; box-sizing:border-box; }
html, body { height:100%; overscroll-behavior: none; -webkit-tap-highlight-color: transparent; }
body {
  font-family: "Geist", ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  background: var(--bg);
  color: var(--text);
  display: flex; flex-direction: column;
  font-size: 0.95rem;
  -webkit-font-smoothing: antialiased;
}
/* Faint radial purple glow behind the header — same idea as the desktop welcome screen */
body::before {
  content: "";
  position: fixed; inset: 0; pointer-events: none;
  background:
    radial-gradient(60% 35% at 50% 0%, rgba(139,92,246,0.18) 0%, transparent 70%),
    radial-gradient(50% 30% at 50% 100%, rgba(168,85,247,0.06) 0%, transparent 70%);
  z-index: 0;
}
.header {
  position: relative; z-index: 1;
  display: flex; align-items: center; justify-content: space-between;
  padding: calc(env(safe-area-inset-top, 0px) + 12px) 16px 12px;
  border-bottom: 1px solid var(--border);
  background: rgba(10, 10, 15, 0.85);
  backdrop-filter: saturate(140%) blur(12px);
  -webkit-backdrop-filter: saturate(140%) blur(12px);
}
.brand { display: flex; align-items: center; gap: 8px; }
.brand .title-svg { display: block; }
.pill {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 4px 10px;
  border-radius: 999px;
  background: rgba(255,255,255,0.04);
  border: 1px solid var(--border);
  font-size: 11px;
  color: var(--muted);
  letter-spacing: 0.01em;
}
.dot { width: 6px; height: 6px; border-radius: 999px; }
.dot.ok { background: var(--green); box-shadow: 0 0 6px rgba(16,185,129,.6); }
.dot.err { background: var(--red); box-shadow: 0 0 6px rgba(239,68,68,.6); }
.dot.wait { background: var(--yellow); animation: pulse 1.4s ease-in-out infinite; }
@keyframes pulse {
  0%, 100% { opacity: 0.5; }
  50% { opacity: 1; }
}
.scroll {
  position: relative; z-index: 1;
  flex: 1;
  overflow-y: auto;
  padding: 16px 12px 8px;
  display: flex; flex-direction: column; gap: 10px;
  scroll-behavior: smooth;
}
/* Welcome / empty state */
.empty {
  margin: auto; padding: 24px;
  display: flex; flex-direction: column; align-items: center; gap: 14px;
  color: var(--muted); font-size: 0.92rem; text-align: center;
}
.empty .avatar { width: 64px; height: 80px; }
.empty .hello {
  background: linear-gradient(135deg, #ffffff 0%, #e9d5ff 30%, #c084fc 60%, #a855f7 100%);
  -webkit-background-clip: text; background-clip: text;
  -webkit-text-fill-color: transparent;
  font-weight: 700; font-size: 1.05rem; letter-spacing: -0.01em;
}
/* Bubble row groups avatar + bubble */
.row { display: flex; align-items: flex-end; gap: 8px; max-width: 100%; }
.row.user { flex-direction: row-reverse; }
.row.agent + .row.agent .avatar-slot { visibility: hidden; }
.avatar-slot { width: 28px; flex: 0 0 28px; }
.avatar-slot img {
  width: 28px; height: 28px;
  border-radius: 8px;
  object-fit: cover; object-position: center 30%;
  border: 1px solid var(--border);
  background: var(--card-solid);
}
.user-avatar {
  width: 28px; height: 28px; border-radius: 8px;
  background: linear-gradient(135deg, var(--primary), var(--primary-2));
  display: flex; align-items: center; justify-content: center;
  color: #fff; font-size: 11px; font-weight: 700;
}
.bubble {
  max-width: 80%;
  padding: 10px 14px;
  border-radius: 16px;
  font-size: 0.92rem; line-height: 1.45;
  word-wrap: break-word; overflow-wrap: anywhere; white-space: pre-wrap;
}
.row.user .bubble {
  background: linear-gradient(135deg, var(--primary), var(--primary-2));
  color: #fff;
  border-bottom-right-radius: 6px;
  box-shadow: 0 4px 14px rgba(124, 58, 237, 0.25);
}
.row.agent .bubble {
  background: var(--card);
  color: var(--text);
  border: 1px solid var(--border);
  border-bottom-left-radius: 6px;
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
}
/* Inline code + code blocks (basic markdown lite) */
.bubble code {
  background: rgba(0,0,0,0.35); border: 1px solid var(--border);
  border-radius: 4px; padding: 1px 4px;
  font-family: "Geist Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.85em;
}
.bubble pre {
  background: rgba(0,0,0,0.45);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 12px; margin: 6px 0;
  font-family: "Geist Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.82em;
  overflow-x: auto;
  white-space: pre;
}
.bubble pre code { background: none; border: none; padding: 0; }
/* Typing dots — three bouncing purple circles */
.typing { display: inline-flex; align-items: center; gap: 4px; padding: 4px 0; }
.typing span {
  width: 6px; height: 6px; border-radius: 999px;
  background: var(--bounce);
  animation: bounce 1.0s ease-in-out infinite;
}
.typing span:nth-child(2) { animation-delay: 0.15s; }
.typing span:nth-child(3) { animation-delay: 0.30s; }
@keyframes bounce {
  0%, 80%, 100% { transform: translateY(0); opacity: 0.5; }
  40% { transform: translateY(-4px); opacity: 1; }
}
.error-toast {
  align-self: center;
  padding: 6px 12px; border-radius: 999px;
  background: rgba(239, 68, 68, 0.12);
  border: 1px solid rgba(239, 68, 68, 0.4);
  color: #fca5a5; font-size: 0.8rem;
}
/* Footer / composer */
.footer {
  position: relative; z-index: 1;
  border-top: 1px solid var(--border);
  padding: 10px 12px calc(env(safe-area-inset-bottom, 0px) + 10px);
  background: rgba(10, 10, 15, 0.92);
  backdrop-filter: saturate(140%) blur(12px);
  -webkit-backdrop-filter: saturate(140%) blur(12px);
  display: flex; gap: 8px; align-items: flex-end;
}
#input {
  flex: 1;
  background: var(--card-solid); color: var(--text);
  border: 1px solid var(--border);
  border-radius: 18px;
  padding: 10px 14px;
  font-size: 0.95rem;
  font-family: inherit;
  resize: none; max-height: 120px;
  line-height: 1.4;
  transition: border-color 0.15s;
}
#input::placeholder { color: var(--muted); }
#input:focus { outline: none; border-color: var(--primary); }
#send {
  flex: 0 0 auto;
  height: 40px; min-width: 64px;
  background: linear-gradient(135deg, var(--primary), var(--primary-2));
  color: #fff;
  border: none; border-radius: 999px;
  padding: 0 16px;
  font-size: 0.88rem; font-weight: 600;
  font-family: inherit;
  cursor: pointer;
  box-shadow: 0 4px 14px rgba(124, 58, 237, 0.3);
  transition: transform 0.1s, box-shadow 0.15s, opacity 0.15s;
}
#send:active { transform: scale(0.97); }
#send:disabled {
  opacity: 0.5; cursor: default; box-shadow: none;
  background: var(--card-solid);
}
</style>
</head>
<body>
<div class="header">
  <div class="brand">${TITLE_SVG}</div>
  <div class="pill"><span class="dot wait" id="dot"></span><span id="stext">Connecting…</span></div>
</div>
<div class="scroll" id="scroll">
  <div class="empty" id="empty">
    <img class="avatar" src="/m/avatar.png" alt="bitterbot avatar"/>
    <div class="hello">Say hi to your agent.</div>
    <div>Messages stream live. Pull-to-refresh isn't a thing here — just type.</div>
  </div>
</div>
<div class="footer">
  <textarea id="input" rows="1" placeholder="Message Bitterbot"></textarea>
  <button id="send" disabled>Send</button>
</div>
<script>
const WS_URL = ${JSON.stringify(gatewayWsUrl)};
const URL_PARAMS = new URLSearchParams(location.search);
const TOKEN = URL_PARAMS.get("t") || ${JSON.stringify(gatewayToken ?? "")};
const SESSION_KEY = URL_PARAMS.get("s") || "mobile:default";
const AVATAR_SRC = "/m/avatar.png";

let ws = null;
let rpcId = 0;
const pending = new Map();
let connected = false;
let lastKnownMsgCount = 0;

// Live streaming state — keyed by run/seq so we can update a placeholder
// agent bubble as deltas arrive. Falls back to chat.history poll if the
// stream goes silent.
let streamBubble = null; // { row, bubble, text } | null
let streamingTimer = null;

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

function clearScroll() {
  document.getElementById("scroll").innerHTML = "";
}

function ensureEmptyHidden() {
  const empty = document.getElementById("empty");
  if (empty) empty.remove();
}

// Light-touch markdown: fenced code, inline code. Anything richer is left
// to the agent's text formatting. Renders into the element safely — no
// innerHTML on user-controlled text.
function renderTextInto(el, text) {
  el.textContent = "";
  if (!text) return;
  const fenceRe = /\\\`\\\`\\\`([\\s\\S]*?)\\\`\\\`\\\`/g;
  let last = 0;
  let m;
  while ((m = fenceRe.exec(text)) !== null) {
    if (m.index > last) appendInline(el, text.slice(last, m.index));
    const pre = document.createElement("pre");
    const code = document.createElement("code");
    code.textContent = m[1].replace(/^\\n/, "");
    pre.appendChild(code);
    el.appendChild(pre);
    last = m.index + m[0].length;
  }
  if (last < text.length) appendInline(el, text.slice(last));
}

function appendInline(el, text) {
  const inlineRe = /\\\`([^\\\`]+)\\\`/g;
  let last = 0;
  let m;
  while ((m = inlineRe.exec(text)) !== null) {
    if (m.index > last) el.appendChild(document.createTextNode(text.slice(last, m.index)));
    const code = document.createElement("code");
    code.textContent = m[1];
    el.appendChild(code);
    last = m.index + m[0].length;
  }
  if (last < text.length) el.appendChild(document.createTextNode(text.slice(last)));
}

function makeRow(role) {
  const row = document.createElement("div");
  row.className = "row " + role;
  const slot = document.createElement("div");
  slot.className = "avatar-slot";
  if (role === "agent") {
    const img = document.createElement("img");
    img.src = AVATAR_SRC;
    img.alt = "bitterbot";
    slot.appendChild(img);
  } else {
    const u = document.createElement("div");
    u.className = "user-avatar";
    u.textContent = "U";
    slot.appendChild(u);
  }
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  row.appendChild(slot);
  row.appendChild(bubble);
  return { row, bubble };
}

function appendMessage(role, text) {
  ensureEmptyHidden();
  const scroll = document.getElementById("scroll");
  const { row, bubble } = makeRow(role);
  renderTextInto(bubble, text);
  scroll.appendChild(row);
  scroll.scrollTop = scroll.scrollHeight;
  return { row, bubble };
}

function appendTyping() {
  ensureEmptyHidden();
  const scroll = document.getElementById("scroll");
  const { row, bubble } = makeRow("agent");
  bubble.innerHTML = '<span class="typing"><span></span><span></span><span></span></span>';
  row.id = "typing-row";
  scroll.appendChild(row);
  scroll.scrollTop = scroll.scrollHeight;
}

function clearTyping() {
  const el = document.getElementById("typing-row");
  if (el) el.remove();
}

function renderMessages(messages) {
  clearScroll();
  if (!messages || messages.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.id = "empty";
    empty.innerHTML =
      '<img class="avatar" src="' + AVATAR_SRC + '" alt="bitterbot avatar"/>' +
      '<div class="hello">Say hi to your agent.</div>' +
      "<div>Messages stream live. Pull-to-refresh isn't a thing here — just type.</div>";
    document.getElementById("scroll").appendChild(empty);
    return;
  }
  for (const m of messages) {
    const role = m.role === "user" || m.role === "human" ? "user" : "agent";
    appendMessage(role, extractText(m));
  }
}

async function refreshHistory() {
  try {
    const resp = await rpc("chat.history", { sessionKey: SESSION_KEY, limit: 50 });
    const messages = resp?.messages ?? [];
    renderMessages(messages);
    lastKnownMsgCount = messages.length;
  } catch {
    // ignore — non-fatal; the next event will rebuild state
  }
}

// Streaming entry point. Called when a 'chat' broadcast arrives.
function handleChatEvent(payload) {
  if (!payload || payload.sessionKey !== SESSION_KEY) return;
  const state = payload.state;
  const msg = payload.message;
  if (!msg || msg.role !== "assistant") return;
  const text = extractText(msg);
  if (state === "delta") {
    if (!streamBubble) {
      clearTyping();
      const { row, bubble } = appendMessage("agent", "");
      streamBubble = { row, bubble, text: "" };
    }
    streamBubble.text = (streamBubble.text || "") + (text || "");
    renderTextInto(streamBubble.bubble, streamBubble.text);
    document.getElementById("scroll").scrollTop = 1e9;
  } else if (state === "final") {
    clearTyping();
    if (streamBubble) {
      // Replace partial content with the final canonical text.
      streamBubble.text = text || streamBubble.text;
      renderTextInto(streamBubble.bubble, streamBubble.text);
      streamBubble = null;
    } else {
      appendMessage("agent", text || "");
    }
    lastKnownMsgCount += 1;
  } else if (state === "aborted" || state === "error") {
    clearTyping();
    streamBubble = null;
    const t = document.createElement("div");
    t.className = "error-toast";
    t.textContent = state === "aborted" ? "Reply aborted." : "Reply failed.";
    document.getElementById("scroll").appendChild(t);
  }
}

function extractText(message) {
  if (!message) return "";
  if (typeof message.body === "string") return message.body;
  if (typeof message.text === "string") return message.text;
  const content = message.content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (typeof p === "string" ? p : (p?.text ?? "")))
      .filter(Boolean)
      .join("");
  }
  if (typeof content === "string") return content;
  return "";
}

async function send() {
  const input = document.getElementById("input");
  const btn = document.getElementById("send");
  const text = input.value.trim();
  if (!text || !connected) return;
  input.value = "";
  input.style.height = "auto";
  btn.disabled = true;

  appendMessage("user", text);
  appendTyping();
  streamBubble = null;

  try {
    await rpc("chat.send", {
      sessionKey: SESSION_KEY,
      message: text,
      idempotencyKey: "m-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8),
    }, 60000);
    // Streaming events take it from here. Belt-and-braces: in case the
    // stream goes silent for any reason, refresh history once after a
    // generous timeout.
    if (streamingTimer) clearTimeout(streamingTimer);
    streamingTimer = setTimeout(() => {
      if (!streamBubble) {
        clearTyping();
        refreshHistory();
      }
    }, 90_000);
  } catch (err) {
    clearTyping();
    streamBubble = null;
    const t = document.createElement("div");
    t.className = "error-toast";
    t.textContent = "Send failed: " + (err?.message || "unknown");
    document.getElementById("scroll").appendChild(t);
  } finally {
    btn.disabled = false;
    input.focus();
  }
}

function connect() {
  setStatus("wait", "Connecting…");
  try {
    ws = new WebSocket(WS_URL);
  } catch {
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
      reject: () => {
        setStatus("err", "Auth failed");
        document.getElementById("send").disabled = true;
      },
    });
    ws.send(JSON.stringify({
      type: "req", id, method: "connect",
      params: {
        minProtocol: 3, maxProtocol: 3,
        client: { id: "webchat-ui", version: "1.0.0", platform: "browser", mode: "ui" },
        role: "operator",
        scopes: ["operator.read", "operator.admin"],
        auth: TOKEN ? { token: TOKEN } : undefined,
      },
    }));
  };
  ws.onmessage = (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }
    if (msg.type === "event") {
      if (msg.event === "chat") handleChatEvent(msg.payload);
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
