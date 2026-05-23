/**
 * PLAN-20: per-session ring buffer of recent observables that interceptors
 * consult to build a StepContext without going through async RPC calls.
 *
 * Lives entirely in-process. Tracks:
 *  - tool history (toolName, success, ts) — populated from the runner on
 *    every non-NOOP firing and from the gateway tool-event broadcaster.
 *  - recent turns (role, preview) — populated from the assistant-text and
 *    inbound-message paths.
 *  - turn counter — increments on each user-role push.
 *
 * Sized small (8 turns, 12 tool entries per session) to keep memory bounded.
 * Sessions never explicitly close here; the LRU eviction below caps total
 * sessions at 200.
 */

import type { ChannelKind, StepContext } from "./interceptor.js";

const MAX_SESSIONS = 200;
const MAX_TURNS_PER_SESSION = 8;
const MAX_TOOLS_PER_SESSION = 12;

interface TurnEntry {
  role: "user" | "assistant" | "system" | "tool";
  preview: string;
  ts: number;
}

interface ToolEntry {
  tool: string;
  success: boolean;
  ts: number;
}

interface SessionState {
  channel?: ChannelKind;
  turns: TurnEntry[];
  tools: ToolEntry[];
  turnCount: number;
  lastTouchedAt: number;
}

const sessions = new Map<string, SessionState>();

function ensureSession(sessionKey: string): SessionState {
  let s = sessions.get(sessionKey);
  if (!s) {
    if (sessions.size >= MAX_SESSIONS) {
      // Evict the least-recently-touched session.
      let oldestKey: string | null = null;
      let oldestTs = Infinity;
      for (const [k, v] of sessions) {
        if (v.lastTouchedAt < oldestTs) {
          oldestTs = v.lastTouchedAt;
          oldestKey = k;
        }
      }
      if (oldestKey) sessions.delete(oldestKey);
    }
    s = { turns: [], tools: [], turnCount: 0, lastTouchedAt: Date.now() };
    sessions.set(sessionKey, s);
  }
  s.lastTouchedAt = Date.now();
  return s;
}

const PII_RX = /\b(?:\d{3}-\d{2}-\d{4}|\d{16}|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g;

function redactPreview(text: string, max = 80): string {
  if (!text) return "";
  const scrubbed = text.replaceAll(PII_RX, "[redacted]");
  if (scrubbed.length <= max) return scrubbed;
  return `${scrubbed.slice(0, max - 1)}…`;
}

export function recordTurn(
  sessionKey: string,
  role: TurnEntry["role"],
  text: string | undefined,
): void {
  if (!sessionKey) return;
  const s = ensureSession(sessionKey);
  s.turns.push({ role, preview: redactPreview(text ?? ""), ts: Date.now() });
  if (s.turns.length > MAX_TURNS_PER_SESSION) {
    s.turns.shift();
  }
  if (role === "user") s.turnCount += 1;
}

export function recordTool(sessionKey: string, tool: string, success: boolean): void {
  if (!sessionKey) return;
  const s = ensureSession(sessionKey);
  s.tools.push({ tool, success, ts: Date.now() });
  if (s.tools.length > MAX_TOOLS_PER_SESSION) {
    s.tools.shift();
  }
}

export function setSessionChannel(sessionKey: string, channel: ChannelKind): void {
  if (!sessionKey) return;
  const s = ensureSession(sessionKey);
  s.channel = channel;
}

const KNOWN_CHANNELS: ReadonlyArray<ChannelKind> = [
  "discord",
  "telegram",
  "whatsapp",
  "signal",
  "slack",
  "googlechat",
  "irc",
  "webchat",
  "voice",
  "internal",
];

export function channelFromSessionKey(sessionKey: string): ChannelKind {
  if (!sessionKey) return "internal";
  // sessionKey shapes observed in the codebase:
  //   "<provider>:<scope>:<id>:<thread?>"  (most channel adapters)
  //   "internal/<...>" or "internal:<...>"
  //   "main"                                (default agent direct chat)
  //   "voice:<id>"
  // Tokenize on both : and / and check the head.
  const head = sessionKey.split(/[:\/]/, 1)[0]?.toLowerCase() ?? "internal";
  if ((KNOWN_CHANNELS as readonly string[]).includes(head)) {
    return head as ChannelKind;
  }
  return "internal";
}

export function getRecentTurns(sessionKey: string, limit: number): StepContext["recentTurns"] {
  const s = sessions.get(sessionKey);
  if (!s) return [];
  const tail = s.turns.slice(-limit);
  return tail.map((t) => ({ role: t.role, preview: t.preview }));
}

export function getToolHistory(sessionKey: string, limit: number): StepContext["toolHistory"] {
  const s = sessions.get(sessionKey);
  if (!s) return [];
  const now = Date.now();
  const tail = s.tools.slice(-limit);
  return tail.map((t) => ({
    tool: t.tool,
    success: t.success,
    tsDelta: now - t.ts,
  }));
}

export function getTurnNumber(sessionKey: string): number {
  return sessions.get(sessionKey)?.turnCount ?? 0;
}

export function getSessionChannel(sessionKey: string): ChannelKind {
  const stored = sessions.get(sessionKey)?.channel;
  if (stored) return stored;
  return channelFromSessionKey(sessionKey);
}

/** Test helper. */
export function resetSessionContextTrackerForTest(): void {
  sessions.clear();
}

export const __testing = {
  MAX_SESSIONS,
  MAX_TURNS_PER_SESSION,
  MAX_TOOLS_PER_SESSION,
  sessions,
};
