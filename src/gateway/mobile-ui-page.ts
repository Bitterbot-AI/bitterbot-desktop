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

// Animated eyes overlay for the welcome avatar — direct port of
// desktop/renderer/.../BitterBotAvatar.tsx ThinkingEyes (same wander +
// blink timings: 2.5s wander cycle, 3.5s blink cycle, eyes positioned
// at ~33% / ~67% x and ~37% y of the upper square portion of the
// avatar). Pure SVG so it works in the inline page without React.
const EYES_SVG = (() => {
  const size = 96;
  const eyeR = size * 0.09;
  const pupilR = size * 0.05;
  const lx = (size * 0.335).toFixed(1);
  const rx = (size * 0.665).toFixed(1);
  const ey = (size * 0.37).toFixed(1);
  const t = (f: number) => (size * f).toFixed(1);
  const wander = `0,0; ${t(0.02)},0; ${t(0.02)},${t(-0.01)}; ${t(-0.01)},${t(0.01)}; ${t(-0.02)},0; 0,${t(-0.01)}; ${t(0.01)},${t(0.01)}; 0,0`;
  const wT = "0; 0.15; 0.3; 0.45; 0.6; 0.75; 0.9; 1";
  const blinkE = `${eyeR}; ${eyeR}; ${(eyeR * 0.1).toFixed(2)}; ${eyeR}; ${eyeR}`;
  const blinkP = `${pupilR}; ${pupilR}; ${(pupilR * 0.1).toFixed(2)}; ${pupilR}; ${pupilR}`;
  const bT = "0; 0.85; 0.9; 0.95; 1";
  const eye = (cx: string, color: string, r: number, blink: string) =>
    `<ellipse cx="${cx}" cy="${ey}" rx="${r}" ry="${r}" fill="${color}" opacity="${color === "#e9d5ff" ? "0.9" : "1"}">` +
    `<animateTransform attributeName="transform" type="translate" values="${wander}" keyTimes="${wT}" dur="2.5s" repeatCount="indefinite"/>` +
    `<animate attributeName="ry" values="${blink}" keyTimes="${bT}" dur="3.5s" repeatCount="indefinite"/>` +
    `</ellipse>`;
  return (
    `<svg class="eyes" viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg">` +
    eye(lx, "#e9d5ff", eyeR, blinkE) +
    eye(lx, "#4c1d95", pupilR, blinkP) +
    eye(rx, "#e9d5ff", eyeR, blinkE) +
    eye(rx, "#4c1d95", pupilR, blinkP) +
    `</svg>`
  );
})();

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
/* Faint custom scrollbar that matches the chrome — mostly invisible until hover */
.scroll::-webkit-scrollbar { width: 6px; }
.scroll::-webkit-scrollbar-track { background: transparent; }
.scroll::-webkit-scrollbar-thumb { background: rgba(139,92,246,0.15); border-radius: 999px; }
.scroll::-webkit-scrollbar-thumb:hover { background: rgba(139,92,246,0.35); }

/* Welcome / empty state */
.empty {
  margin: auto; padding: 24px;
  display: flex; flex-direction: column; align-items: center; gap: 16px;
  color: var(--muted); font-size: 0.92rem; text-align: center;
  max-width: 360px;
}
.welcome-avatar {
  position: relative;
  width: 96px; height: 120px;
}
.welcome-avatar img { width: 96px; height: 120px; object-fit: contain; }
.welcome-avatar svg.eyes {
  position: absolute; inset: 0;
  width: 96px; height: 96px;
  /* Eyes overlay sits within the upper-square portion of the 96×120 avatar */
  pointer-events: none;
}
.empty .hello {
  background: linear-gradient(135deg, #ffffff 0%, #e9d5ff 30%, #c084fc 60%, #a855f7 100%);
  -webkit-background-clip: text; background-clip: text;
  -webkit-text-fill-color: transparent;
  font-weight: 700; font-size: 1.25rem; letter-spacing: -0.01em;
  line-height: 1.2;
}
.empty .sub { font-size: 0.85rem; color: var(--muted); line-height: 1.5; }
.suggestions {
  display: flex; flex-wrap: wrap; gap: 8px;
  justify-content: center;
  margin-top: 6px;
}
.suggestions button {
  background: var(--card);
  border: 1px solid var(--border);
  color: var(--text);
  border-radius: 999px;
  padding: 8px 14px;
  font-size: 0.82rem;
  font-family: inherit;
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s, transform 0.1s;
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
}
.suggestions button:hover { border-color: var(--border-strong); background: rgba(139,92,246,0.12); }
.suggestions button:active { transform: scale(0.97); }
/* Bubble row groups avatar + bubble */
.row {
  display: flex; align-items: flex-end; gap: 8px; max-width: 100%;
  animation: row-in 0.22s cubic-bezier(0.2, 0, 0, 1);
}
@keyframes row-in {
  from { opacity: 0; transform: translateY(6px); }
  to   { opacity: 1; transform: translateY(0); }
}
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
/* Markdown niceties: only the things people actually paste — bold,
   italic, links, lists, headings, blockquote, hr. Everything else falls
   through to plain text via white-space: pre-wrap on .bubble. */
.bubble strong { font-weight: 700; }
.bubble em { font-style: italic; }
.bubble a { color: #c4b5fd; text-decoration: underline; text-underline-offset: 2px; }
.row.user .bubble a { color: #fff; opacity: 0.95; }
.bubble h1, .bubble h2, .bubble h3 {
  font-weight: 700; line-height: 1.25; margin: 4px 0 2px;
  letter-spacing: -0.01em;
}
.bubble h1 { font-size: 1.05em; }
.bubble h2 { font-size: 1.0em; }
.bubble h3 { font-size: 0.95em; color: var(--muted); }
.bubble ul, .bubble ol { margin: 4px 0; padding-left: 1.25em; }
.bubble li { margin: 2px 0; }
.bubble blockquote {
  border-left: 3px solid var(--primary);
  padding-left: 10px; margin: 6px 0;
  color: var(--muted); font-style: italic;
}
.bubble hr {
  border: none;
  border-top: 1px solid var(--border);
  margin: 8px 0;
}
/* When a bubble holds Markdown blocks, drop pre-wrap so HTML elements
   control spacing themselves. .md mode is set by the renderer when
   any block-level markdown is detected. */
.bubble.md { white-space: normal; }

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
    <div class="welcome-avatar">
      <img src="/m/avatar.png" alt="bitterbot"/>
      ${EYES_SVG}
    </div>
    <div class="hello">Say hi to your agent.</div>
    <div class="sub">Messages stream live. Tap a suggestion below or just start typing.</div>
    <div class="suggestions">
      <button data-prompt="What can you help me with right now?">What can you help with?</button>
      <button data-prompt="Show me what skills you have available.">Show me your skills</button>
      <button data-prompt="What's on my schedule today?">What's on today?</button>
    </div>
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

// Markdown-lite renderer. Handles the formats agents actually produce:
// fenced code, inline code, **bold**, *italic*, [link](url), - and 1.
// lists, # headings, > blockquote, ---. Built around document.createElement
// so user content never touches innerHTML.
function renderTextInto(el, text) {
  el.textContent = "";
  el.classList.remove("md");
  if (!text) return;
  // Fast path: short string with no block-level markdown markers.
  // Render as plain pre-wrap text + inline-only formatting.
  const hasBlocks = /(^|\\n)(\\\`\\\`\\\`|#{1,3} |[-*] |\\d+\\. |> |---)/.test(text);
  if (!hasBlocks) {
    appendInline(el, text);
    return;
  }
  el.classList.add("md");
  // Block parser — split on blank lines + fenced code, then dispatch.
  const lines = text.split("\\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    // Fenced code block
    if (/^\\\`\\\`\\\`/.test(line)) {
      const buf = [];
      i++;
      while (i < lines.length && !/^\\\`\\\`\\\`/.test(lines[i])) { buf.push(lines[i]); i++; }
      i++; // closing fence
      const pre = document.createElement("pre");
      const code = document.createElement("code");
      code.textContent = buf.join("\\n");
      pre.appendChild(code);
      el.appendChild(pre);
      continue;
    }
    // Heading
    const h = line.match(/^(#{1,3}) +(.+)$/);
    if (h) {
      const tag = "h" + h[1].length;
      const node = document.createElement(tag);
      appendInline(node, h[2]);
      el.appendChild(node);
      i++;
      continue;
    }
    // Horizontal rule
    if (/^---+$/.test(line.trim())) {
      el.appendChild(document.createElement("hr"));
      i++;
      continue;
    }
    // Blockquote (collect consecutive > lines)
    if (/^> /.test(line)) {
      const buf = [];
      while (i < lines.length && /^> /.test(lines[i])) { buf.push(lines[i].slice(2)); i++; }
      const bq = document.createElement("blockquote");
      appendInline(bq, buf.join("\\n"));
      el.appendChild(bq);
      continue;
    }
    // Unordered list
    if (/^[-*] +/.test(line)) {
      const ul = document.createElement("ul");
      while (i < lines.length && /^[-*] +/.test(lines[i])) {
        const li = document.createElement("li");
        appendInline(li, lines[i].replace(/^[-*] +/, ""));
        ul.appendChild(li);
        i++;
      }
      el.appendChild(ul);
      continue;
    }
    // Ordered list
    if (/^\\d+\\. +/.test(line)) {
      const ol = document.createElement("ol");
      while (i < lines.length && /^\\d+\\. +/.test(lines[i])) {
        const li = document.createElement("li");
        appendInline(li, lines[i].replace(/^\\d+\\. +/, ""));
        ol.appendChild(li);
        i++;
      }
      el.appendChild(ol);
      continue;
    }
    // Blank line — preserve paragraph spacing
    if (line.trim() === "") {
      // collapse runs of blanks; rely on default block margins
      while (i < lines.length && lines[i].trim() === "") i++;
      continue;
    }
    // Paragraph — gather contiguous non-block lines
    const buf = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !/^\\\`\\\`\\\`|^#{1,3} |^[-*] |^\\d+\\. |^> |^---+$/.test(lines[i])
    ) {
      buf.push(lines[i]);
      i++;
    }
    const p = document.createElement("p");
    p.style.margin = "4px 0";
    appendInline(p, buf.join("\\n"));
    el.appendChild(p);
  }
}

// Inline formatting: \\\`code\\\`, **bold**, *italic*, [text](url). Order
// matters — code first so its contents aren't re-parsed. Splits the
// remaining text on alternating tokens and emits text nodes / elements.
function appendInline(el, text) {
  // Tokens: code, bold, italic, link. Keep in priority order.
  const re = /(\\\`[^\\\`]+\\\`)|(\\*\\*[^*]+\\*\\*)|(\\*[^*\\n]+\\*)|(\\[[^\\]]+\\]\\([^)]+\\))/g;
  let last = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) el.appendChild(document.createTextNode(text.slice(last, m.index)));
    const tok = m[0];
    if (tok.startsWith("\\\`")) {
      const c = document.createElement("code");
      c.textContent = tok.slice(1, -1);
      el.appendChild(c);
    } else if (tok.startsWith("**")) {
      const s = document.createElement("strong");
      s.textContent = tok.slice(2, -2);
      el.appendChild(s);
    } else if (tok.startsWith("*")) {
      const s = document.createElement("em");
      s.textContent = tok.slice(1, -1);
      el.appendChild(s);
    } else {
      // [text](url)
      const lm = tok.match(/^\\[([^\\]]+)\\]\\(([^)]+)\\)$/);
      if (lm) {
        const a = document.createElement("a");
        a.textContent = lm[1];
        a.href = lm[2];
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        el.appendChild(a);
      } else {
        el.appendChild(document.createTextNode(tok));
      }
    }
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
    // Re-create the welcome state. The original copy lives in the page
    // template; we mirror its structure here so a chat.history that
    // returns empty (e.g. fresh session) still gets the suggestion chips.
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.id = "empty";
    empty.innerHTML =
      '<div class="welcome-avatar">' +
      '<img src="' + AVATAR_SRC + '" alt="bitterbot"/>' +
      ${JSON.stringify(EYES_SVG)} +
      "</div>" +
      '<div class="hello">Say hi to your agent.</div>' +
      '<div class="sub">Messages stream live. Tap a suggestion below or just start typing.</div>' +
      '<div class="suggestions">' +
      '<button data-prompt="What can you help me with right now?">What can you help with?</button>' +
      '<button data-prompt="Show me what skills you have available.">Show me your skills</button>' +
      '<button data-prompt="What\\'s on my schedule today?">What\\'s on today?</button>' +
      "</div>";
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
// Suggestion chips on the welcome screen — tap drops the prompt into
// the composer and focuses it. Delegated so chips that come and go
// (when history reloads to empty) keep working.
document.getElementById("scroll").addEventListener("click", (e) => {
  const btn = e.target.closest(".suggestions button");
  if (!btn) return;
  const input = document.getElementById("input");
  input.value = btn.dataset.prompt || btn.textContent || "";
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 120) + "px";
  input.focus();
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
