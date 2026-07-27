/**
 * Agent-turn probe: ONE real end-to-end agent turn through the gateway.
 *
 * The Model Round-Trip section proves the PROVIDER path (createJudgeLlmCall
 * in-process in the doctor CLI) — it never touches the gateway. This section
 * proves the pipeline production actually uses: RPC ingress → session
 * resolution → dispatch → embedded runner (system prompt assembly, canonical
 * facts, endocrine modulation) → reply dispatcher. A gateway that answers
 * health checks but cannot run a turn is exactly the failure mode nothing
 * else catches.
 *
 * Design constraints (from the deferral scoping):
 *   - `agent` RPC with expectFinal (chat.send is fire-and-forget), on a
 *     throwaway `agent:<id>:doctor-probe-<rand>` session key — never the main
 *     key or "global", so nothing renders in the user's chat UI.
 *   - The probe session is reaped via sessions.delete in a finally, and a
 *     sweep at section start deletes orphans a killed doctor left behind.
 *   - Skipped in the PRE-restart update gate (BITTERBOT_UPDATE_IN_PROGRESS:
 *     the running gateway is still the OUTGOING build), but FORCED in the
 *     post-restart doctor, where the fresh build is live and this probe is
 *     the strongest verification the update flow has.
 *   - BURN-IN SEVERITY: failures are warn, never error. A full agent turn
 *     has more moving parts (send policy, session store, model, tools) than
 *     the model check; blocking every fleet update on a flaky probe would
 *     over-block the gate. Promote to error only after the probe has proven
 *     stable in the field.
 */

import crypto from "node:crypto";
import type { BitterbotConfig } from "../config/config.js";
import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import { callGateway, randomIdempotencyKey } from "../gateway/call.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../utils/message-channel.js";
import { renderSection, type CheckResult, ok, warn, info } from "./doctor-check.js";

const SECTION = "Agent Turn Probe";
const PROMPT = "Reply with the single word: OK";
// A full turn assembles the system prompt and may cold-start caches; the
// model check budgets 40s for a bare call, so give the pipeline headroom.
const PROBE_TIMEOUT_S = 60;
// +30s WS headroom over the server-side turn timeout (the agent-via-gateway
// convention); the reap must outwait sessions.delete's own abort-and-wait
// (up to 15s server-side) or the delete times out client-side and orphans
// the session until the next sweep.
const PROBE_TIMEOUT_MS = 90_000;
const REAP_TIMEOUT_MS = 20_000;
const PROBE_KEY_MARKER = ":doctor-probe-";

export type AgentTurnOutcome =
  | { kind: "ok"; latencyMs: number; sample: string }
  | { kind: "skipped"; reason: string }
  | { kind: "error"; message: string };

/**
 * Pure severity classifier — exported for tests. Warn-only on failure by
 * design (see burn-in note in the module doc).
 */
export function classifyAgentTurn(outcome: AgentTurnOutcome): CheckResult {
  if (outcome.kind === "ok") {
    return ok(
      `Agent turn round-trip succeeded in ${outcome.latencyMs}ms (reply: "${outcome.sample}") — ` +
        `the full gateway pipeline (RPC → session → runner → reply) works.`,
    );
  }
  if (outcome.kind === "skipped") {
    return info(`Agent turn probe skipped: ${outcome.reason}.`);
  }
  return warn(
    `Agent turn probe FAILED: ${outcome.message}. The gateway answers RPCs but could not run ` +
      `a real agent turn — chats and heartbeats may be broken even though health looks fine. ` +
      `(Warn-level during burn-in; does not block updates.)`,
  );
}

type AgentRpcResponse = {
  status?: string;
  summary?: string;
  result?: { payloads?: Array<{ text?: string }> };
};

type SessionsListResponse = {
  sessions?: Array<{ key?: string }>;
};

/** Probe-session keys among a sessions.list result — exported for tests. */
export function collectProbeOrphans(
  sessions: Array<{ key?: string }>,
  currentKey?: string,
): string[] {
  return sessions
    .map((s) => s.key)
    .filter((key): key is string => typeof key === "string" && key.includes(PROBE_KEY_MARKER))
    .filter((key) => key !== currentKey);
}

async function deleteProbeSession(key: string): Promise<void> {
  try {
    await callGateway({
      method: "sessions.delete",
      params: { key, deleteTranscript: true },
      timeoutMs: REAP_TIMEOUT_MS,
    });
  } catch {
    // Best-effort: an undeletable probe session is caught by the next sweep.
  }
}

/**
 * Delete probe sessions a previous killed doctor left behind. Doctor runs on
 * every update, so without this, orphans would accumulate forever.
 */
async function sweepProbeOrphans(currentKey: string): Promise<void> {
  try {
    const resp = (await callGateway<SessionsListResponse>({
      method: "sessions.list",
      params: { search: PROBE_KEY_MARKER, limit: 20 },
      timeoutMs: 10_000,
    })) as SessionsListResponse;
    for (const key of collectProbeOrphans(resp?.sessions ?? [], currentKey)) {
      await deleteProbeSession(key);
    }
  } catch {
    // Sweep is opportunistic; the probe itself still runs.
  }
}

function shouldSkipInTest(): boolean {
  return Boolean(process.env.VITEST) || process.env.NODE_ENV === "test";
}

/** Perform the live agent turn and return a structured outcome. */
export async function runAgentTurnRoundTrip(
  cfg: BitterbotConfig,
  opts?: { forceDuringUpdate?: boolean },
): Promise<AgentTurnOutcome> {
  if (shouldSkipInTest()) {
    return { kind: "skipped", reason: "test environment" };
  }
  if (process.env.BITTERBOT_UPDATE_IN_PROGRESS && !opts?.forceDuringUpdate) {
    // In the PRE-restart update gate, the live gateway is still the OUTGOING
    // build — probing it says nothing about the build being installed. The
    // post-restart doctor passes forceDuringUpdate so the fresh build gets
    // probed (see DoctorOptions.forceAgentTurnProbe).
    return {
      kind: "skipped",
      reason: "update in progress (the running gateway is still the outgoing build)",
    };
  }

  const agentId = resolveDefaultAgentId(cfg);
  const sessionKey = `agent:${agentId}:doctor-probe-${crypto.randomUUID().slice(0, 8)}`;

  await sweepProbeOrphans(sessionKey);

  const started = Date.now();
  try {
    const resp = (await callGateway<AgentRpcResponse>({
      method: "agent",
      params: {
        message: PROMPT,
        agentId,
        sessionKey,
        deliver: false,
        channel: INTERNAL_MESSAGE_CHANNEL,
        timeout: PROBE_TIMEOUT_S,
        idempotencyKey: randomIdempotencyKey(),
      },
      expectFinal: true,
      timeoutMs: PROBE_TIMEOUT_MS,
    })) as AgentRpcResponse;

    const latencyMs = Date.now() - started;
    if (resp?.status !== "ok") {
      return {
        kind: "error",
        message: `gateway returned status "${resp?.status ?? "none"}"${
          resp?.summary ? ` (${resp.summary})` : ""
        }`,
      };
    }
    const text = resp.result?.payloads?.find((p) => p.text?.trim())?.text?.trim();
    if (!text) {
      return { kind: "error", message: "turn completed but produced no text payload" };
    }
    // Model output goes into a finding message (terminal + --json): keep only
    // printable characters and collapse whitespace before embedding it.
    const sample = Array.from(text.slice(0, 40))
      .filter((ch) => ch.charCodeAt(0) >= 0x20 && ch.charCodeAt(0) !== 0x7f)
      .join("")
      .replace(/\s+/g, " ")
      .trim();
    return { kind: "ok", latencyMs, sample };
  } catch (err) {
    return { kind: "error", message: err instanceof Error ? err.message : String(err) };
  } finally {
    await deleteProbeSession(sessionKey);
  }
}

/** Doctor section: one live agent turn through the gateway. */
export async function runAgentTurnProbe(params: {
  config: BitterbotConfig;
  isGatewayRunning: boolean;
  forceDuringUpdate?: boolean;
}): Promise<void> {
  if (!params.isGatewayRunning) {
    renderSection(SECTION, [info("Gateway not running — agent turn probe needs a live gateway.")]);
    return;
  }
  const outcome = await runAgentTurnRoundTrip(params.config, {
    forceDuringUpdate: params.forceDuringUpdate,
  });
  renderSection(SECTION, [classifyAgentTurn(outcome)]);
}
