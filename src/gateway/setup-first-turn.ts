/**
 * Setup's first reply (PLAN-56 Phase 4): one real turn on the model setup just
 * configured, through the normal `agent` RPC path (session resolution, the
 * embedded runner, the usage ledger), so time-to-first-value is measured on
 * exactly what the user will chat with, and its cost is recorded like any
 * other turn. Runs in-process: no WebSocket round trip, no gateway token.
 *
 * The turn runs in a dedicated session (`agent:<id>:setup`), never the main
 * chat: a "Say hello" retry cannot pile test turns into the user's
 * transcript or the main session's memory. A turn that outlives its budget
 * is aborted before setup offers Retry, so two paid turns never run at once. Provider errors are
 * shown through the log redaction (src/logging/redact.ts): a key echoed in an
 * error message is masked before it reaches the browser.
 */

import { randomUUID } from "node:crypto";
import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import type { BitterbotConfig } from "../config/config.js";
import { redactSensitiveText } from "../logging/redact.js";
import { buildAgentMainSessionKey } from "../routing/session-key.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../utils/message-channel.js";
import type { GatewayRequestContext, GatewayRequestHandler } from "./server-methods/types.js";

export const SETUP_FIRST_TURN_PROMPT = "Say hello and tell me one thing you can do.";

/** Server-side budget for the turn, in seconds (cold caches, slow providers). */
const TURN_TIMEOUT_S = 90;
/** Grace on top of the turn's own timeout before setup gives up and aborts it. */
const TURN_GRACE_S = 30;

/** The session the setup greeting runs in (kept out of the main chat). */
export const SETUP_SESSION_MAIN_KEY = "setup";

export function resolveSetupSessionKey(agentId: string): string {
  return buildAgentMainSessionKey({ agentId, mainKey: SETUP_SESSION_MAIN_KEY });
}

/** Provider error text for the browser: printable, bounded, secrets masked. */
export function presentTurnError(text: string): string {
  return sanitizeReply(redactSensitiveText(text, { mode: "tools" }), 600);
}

/** Abort whatever run the setup session has in flight. */
async function abortSetupSessionRun(sessionKey: string): Promise<void> {
  try {
    const { loadSessionEntry } = await import("./session-utils.js");
    const { abortEmbeddedPiRun } = await import("../agents/embedded-runner/runs.js");
    const sessionId = loadSessionEntry(sessionKey).entry?.sessionId;
    if (sessionId) {
      abortEmbeddedPiRun(sessionId);
    }
  } catch {
    // Nothing to abort.
  }
}

export type FirstTurnOutcome =
  | { ok: true; latencyMs: number; reply: string; model?: string }
  | { ok: false; latencyMs: number; error: string };

type AgentFinalPayload = {
  status?: string;
  summary?: string;
  result?: {
    payloads?: Array<{ text?: string; isError?: boolean }>;
    meta?: { agentMeta?: { model?: string; provider?: string } };
  };
};

/** Printable text only, bounded; it is shown in the browser and the terminal. */
export function sanitizeReply(text: string, max = 1200): string {
  const cleaned = Array.from(text)
    .filter((ch) => {
      const code = ch.charCodeAt(0);
      return code === 0x0a || (code >= 0x20 && code !== 0x7f);
    })
    .join("")
    .trim();
  return cleaned.length > max ? `${cleaned.slice(0, max)}...` : cleaned;
}

export async function runSetupFirstTurn(params: {
  cfg: BitterbotConfig;
  context: GatewayRequestContext;
  /** The `agent` handler (injected so this module does not import the handler table). */
  agentHandler: GatewayRequestHandler;
  now?: () => number;
  /** Test seams. */
  timeoutMs?: number;
  abortRun?: (sessionKey: string) => Promise<void> | void;
}): Promise<FirstTurnOutcome> {
  const now = params.now ?? Date.now;
  const agentId = resolveDefaultAgentId(params.cfg);
  const sessionKey = resolveSetupSessionKey(agentId);
  const started = now();
  const reqId = `setup-first-turn-${randomUUID()}`;
  const budgetMs = params.timeoutMs ?? (TURN_TIMEOUT_S + TURN_GRACE_S) * 1000;
  const requestParams = {
    message: SETUP_FIRST_TURN_PROMPT,
    agentId,
    sessionKey,
    deliver: false,
    channel: INTERNAL_MESSAGE_CHANNEL,
    timeout: TURN_TIMEOUT_S,
    idempotencyKey: reqId,
  };
  const final = await new Promise<{ ok: boolean; payload?: unknown; error?: string }>((resolve) => {
    let settled = false;
    const settle = (value: { ok: boolean; payload?: unknown; error?: string }) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      // Stop the run before offering Retry: never two paid turns at once.
      void Promise.resolve((params.abortRun ?? abortSetupSessionRun)(sessionKey))
        .catch(() => undefined)
        .finally(() =>
          settle({ ok: false, error: `no reply within ${Math.round(budgetMs / 1000)}s` }),
        );
    }, budgetMs);
    void Promise.resolve(
      params.agentHandler({
        req: { type: "req", id: reqId, method: "agent", params: requestParams },
        params: requestParams,
        // In-process caller: the setup session already passed its own auth.
        client: null,
        isWebchatConnect: () => false,
        context: params.context,
        respond: (ok, payload, error) => {
          const status = (payload as { status?: string } | undefined)?.status;
          if (ok && status === "accepted") {
            return; // the ack; wait for the final frame
          }
          settle({ ok, payload, error: error?.message });
        },
      }),
    ).catch((err: unknown) =>
      settle({ ok: false, error: err instanceof Error ? err.message : String(err) }),
    );
  });
  const latencyMs = Math.max(0, now() - started);
  const payload = final.payload as AgentFinalPayload | undefined;
  if (!final.ok || payload?.status !== "ok") {
    return {
      ok: false,
      latencyMs,
      error: presentTurnError(final.error ?? payload?.summary ?? "the turn did not complete"),
    };
  }
  const payloads = payload.result?.payloads ?? [];
  const errorText = payloads.find((p) => p.isError && p.text?.trim())?.text;
  const text = payloads.find((p) => !p.isError && p.text?.trim())?.text;
  if (!text) {
    return {
      ok: false,
      latencyMs,
      error: presentTurnError(errorText ?? "the model returned no text"),
    };
  }
  const meta = payload.result?.meta?.agentMeta;
  return {
    ok: true,
    latencyMs,
    reply: sanitizeReply(text),
    model: meta?.provider && meta?.model ? `${meta.provider}/${meta.model}` : meta?.model,
  };
}
