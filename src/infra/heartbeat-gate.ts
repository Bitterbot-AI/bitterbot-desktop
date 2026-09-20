/**
 * Heartbeat cost gates (token-efficiency build, 2026-09-19).
 *
 * Verified baseline: the interval heartbeat fired every 30m in the shared main
 * session with the full ~54k-token prompt on the primary model, replied
 * HEARTBEAT_OK 1,021 / 1,021 times, and cost ~$16 per idle day (92% of all
 * spend). This module holds the three gates that turn that into ~$0:
 *
 * 1. `skipWhenUnchanged` (content-hash gate): an interval tick whose inputs
 *    hash to the same value as the last completed tick never calls the model.
 * 2. `isolatedSession`: when a tick does run, it runs in `<mainKey>:heartbeat`
 *    with a fresh transcript, never dragging the main history along.
 * 3. `lightContext`: minimal prompt mode, HEARTBEAT.md as the only injected
 *    workspace file, thinking pinned low, cheap-tier model by default.
 *
 * Kept as a sibling of heartbeat-runner.ts (already over the 500-line cap) so
 * the runner only grows by the call sites.
 */

import { createHash } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { ThinkLevel } from "../auto-reply/thinking.js";
import type { BitterbotConfig } from "../config/config.js";
import type { AgentDefaultsConfig } from "../config/types.agent-defaults.js";
import { resolveAgentConfig, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { DEFAULT_HEARTBEAT_FILENAME } from "../agents/workspace.js";
import { parseAgentSessionKey, normalizeAgentId } from "../routing/session-key.js";
import { CONFIG_DIR } from "../utils.js";

type HeartbeatConfig = AgentDefaultsConfig["heartbeat"];

/** Thinking level pinned for light heartbeat runs (research item J: pin per lane, never per turn). */
export const HEARTBEAT_LIGHT_THINK_LEVEL: ThinkLevel = "low";

const STATE_DIR_NAME = "heartbeat";
const HASH_FILE_PREFIX = "last-input-hash-";
const HASH_FILE_SUFFIX = ".json";

// ── Config resolution (defaults + per-agent override; all default ON) ──

function mergedHeartbeatConfig(
  cfg: BitterbotConfig | undefined,
  agentId: string | undefined,
): HeartbeatConfig | undefined {
  const defaults = cfg?.agents?.defaults?.heartbeat;
  if (!cfg || !agentId) {
    return defaults;
  }
  const overrides = resolveAgentConfig(cfg, agentId)?.heartbeat;
  if (!defaults && !overrides) {
    return undefined;
  }
  return { ...defaults, ...overrides };
}

function resolveAgentIdForHeartbeat(
  cfg: BitterbotConfig | undefined,
  ref: { agentId?: string; sessionKey?: string } | undefined,
): string | undefined {
  const explicit = ref?.agentId?.trim();
  if (explicit) {
    return normalizeAgentId(explicit);
  }
  const parsed = parseAgentSessionKey(ref?.sessionKey);
  if (parsed?.agentId) {
    return normalizeAgentId(parsed.agentId);
  }
  return cfg ? resolveDefaultAgentId(cfg) : undefined;
}

export function resolveHeartbeatSkipWhenUnchanged(heartbeat?: HeartbeatConfig): boolean {
  return heartbeat?.skipWhenUnchanged !== false;
}

/**
 * Light-context flag for a heartbeat run. Accepts either an explicit agent id
 * or a session key (the embedded runner has only the latter at bootstrap time).
 */
export function resolveHeartbeatLightContext(
  cfg: BitterbotConfig | undefined,
  ref?: { agentId?: string; sessionKey?: string },
): boolean {
  const agentId = resolveAgentIdForHeartbeat(cfg, ref);
  return mergedHeartbeatConfig(cfg, agentId)?.lightContext !== false;
}

// ── Reasons ──

/**
 * The hash gate applies only to schedule-driven ticks. Every other reason
 * carries new input by definition (an exec completion, a cron payload, a
 * hook/wake request, an operator's manual `heartbeat now`).
 */
export function isHashGatedHeartbeatReason(reason: string | undefined): boolean {
  if (!reason) {
    return true;
  }
  return reason === "interval" || reason === "cache-warm";
}

// ── Content hash ──

/**
 * Normalize HEARTBEAT.md so cosmetic edits (CRLF, trailing spaces, extra blank
 * lines) do not count as "changed". Content edits do.
 */
export function normalizeHeartbeatContent(content: string | undefined | null): string {
  if (typeof content !== "string") {
    return "";
  }
  return content
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export type HeartbeatHashInput = {
  /** Raw HEARTBEAT.md content, or undefined/null when the file is missing. */
  heartbeatContent: string | undefined | null;
  /** The resolved heartbeat prompt body (config-driven; a prompt change must re-run). */
  prompt: string;
  /** Text of the system events queued for the heartbeat session (exec/cron/hook/wake payloads). */
  pendingEvents: string[];
};

/**
 * Stable SHA-256 over exactly three inputs, documented in docs/gateway/heartbeat.md:
 *   1. normalized HEARTBEAT.md content ("" when the file is missing, tagged so a
 *      missing file and an empty file hash differently),
 *   2. the resolved heartbeat prompt body,
 *   3. the pending system-event texts for the session, in queue order.
 * Nothing else: not the clock, not the model, not the delivery target. A
 * changed delivery channel is not new input for the agent to act on.
 */
export function computeHeartbeatInputHash(input: HeartbeatHashInput): string {
  const filePart =
    input.heartbeatContent === undefined || input.heartbeatContent === null
      ? "missing"
      : `present\n${normalizeHeartbeatContent(input.heartbeatContent)}`;
  const payload = JSON.stringify({
    v: 1,
    file: filePart,
    prompt: input.prompt.trim(),
    events: input.pendingEvents.map((event) => event.trim()),
  });
  return createHash("sha256").update(payload).digest("hex");
}

// ── Last-hash state (memory + disk) ──

export type HeartbeatHashRecord = { hash: string; at: number };

const lastHashByAgent = new Map<string, HeartbeatHashRecord>();

function hashFileFor(agentId: string): string {
  const safe = normalizeAgentId(agentId).replace(/[^a-z0-9_-]/gi, "_");
  return path.join(CONFIG_DIR, STATE_DIR_NAME, `${HASH_FILE_PREFIX}${safe}${HASH_FILE_SUFFIX}`);
}

/** Read the last committed hash for an agent: memory first, then disk (survives restarts). */
export async function loadLastHeartbeatHash(
  agentId: string,
): Promise<HeartbeatHashRecord | undefined> {
  const key = normalizeAgentId(agentId);
  const cached = lastHashByAgent.get(key);
  if (cached) {
    return cached;
  }
  try {
    const raw = await fs.readFile(hashFileFor(key), "utf-8");
    const parsed = JSON.parse(raw) as Partial<HeartbeatHashRecord>;
    if (typeof parsed?.hash === "string" && typeof parsed?.at === "number") {
      const record = { hash: parsed.hash, at: parsed.at };
      lastHashByAgent.set(key, record);
      return record;
    }
  } catch {
    // Missing or unreadable state: treat as "never ran" (the tick runs).
  }
  return undefined;
}

/**
 * Commit the hash of a tick whose model call completed. Called once, right
 * after the reply resolves, so a failed call never advances the gate.
 */
export async function commitHeartbeatHash(
  agentId: string,
  hash: string,
  at = Date.now(),
): Promise<void> {
  const key = normalizeAgentId(agentId);
  const record = { hash, at };
  lastHashByAgent.set(key, record);
  const filePath = hashFileFor(key);
  try {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(record), "utf-8");
  } catch {
    // Best-effort persistence; the in-memory record still gates this process.
  }
}

/** @internal Clears memory and on-disk hash state (tests run many ticks with identical inputs). */
export function __resetHeartbeatHashStateForTest(): void {
  lastHashByAgent.clear();
  const dir = path.join(CONFIG_DIR, STATE_DIR_NAME);
  try {
    for (const entry of fsSync.readdirSync(dir)) {
      if (entry.startsWith(HASH_FILE_PREFIX) && entry.endsWith(HASH_FILE_SUFFIX)) {
        fsSync.unlinkSync(path.join(dir, entry));
      }
    }
  } catch {
    // No state dir yet.
  }
}

export type HeartbeatHashGateResult = {
  /** Hash of this tick's inputs; undefined when the gate does not apply (flag off or non-interval reason). */
  inputHash?: string;
  /** Set when the hash matches the last completed tick: the caller must skip the model call. */
  unchanged?: HeartbeatHashRecord;
};

/**
 * Gate order in the runner: enabled -> activeHours -> busy -> empty-file -> THIS -> run.
 * Returns the hash to commit after a completed model call, and the previous
 * record when the inputs are unchanged.
 */
export async function evaluateHeartbeatHashGate(params: {
  agentId: string;
  heartbeat?: HeartbeatConfig;
  reason: string | undefined;
  input: HeartbeatHashInput;
}): Promise<HeartbeatHashGateResult> {
  if (
    !resolveHeartbeatSkipWhenUnchanged(params.heartbeat) ||
    !isHashGatedHeartbeatReason(params.reason)
  ) {
    return {};
  }
  const inputHash = computeHeartbeatInputHash(params.input);
  const last = await loadLastHeartbeatHash(params.agentId);
  if (last?.hash === inputHash) {
    return { inputHash, unchanged: last };
  }
  return { inputHash };
}

// ── Light context ──

/** Keep only HEARTBEAT.md from a list of workspace-file-like entries. */
export function filterHeartbeatOnlyFiles<T extends { path: string }>(files: T[]): T[] {
  return files.filter((file) => path.basename(file.path) === DEFAULT_HEARTBEAT_FILENAME);
}

/**
 * Cheap-tier model for light heartbeats when `heartbeat.model` is unset.
 * Mirrors the memory lanes' env-only rule (resolveCheapLlmSpec in
 * src/memory/manager.ts) without importing the manager: ANTHROPIC key ->
 * Haiku 4.5, OPENAI key -> gpt-4o-mini. Unlike the memory rule it returns
 * undefined when neither key is present so the run keeps the agent's default
 * model instead of pointing at a provider with no credentials.
 */
export function resolveCheapHeartbeatModelSpec(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (env.ANTHROPIC_API_KEY?.trim()) {
    return "anthropic/claude-haiku-4-5";
  }
  if (env.OPENAI_API_KEY?.trim()) {
    return "openai/gpt-4o-mini";
  }
  return undefined;
}
