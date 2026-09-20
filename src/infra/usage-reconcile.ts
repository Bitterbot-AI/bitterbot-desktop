/**
 * PLAN-50: transcript reconciler.
 *
 * Every assistant turn the embedded pi runner produces is appended to a session transcript
 * (`<state>/agents/<id>/sessions/<sessionId>.jsonl`) with usage and cost. The live hook records
 * those turns as they happen; this pass is (a) the one-time backfill of history into the ledger
 * and (b) a periodic safety net for any path that writes a transcript without going through the
 * live hook (compaction, repairs, older builds). Rows dedupe on `<sessionId>:<message.timestamp>`
 * so the two sources never double count.
 *
 * Files are read incrementally from a per-file byte cursor kept in `usage_meta`.
 */

import fs from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { BitterbotConfig } from "../config/config.js";
import type { UsageLedger } from "./usage-ledger.js";
import { normalizeUsage, type UsageLike } from "../agents/usage.js";
import { resolveStateDir } from "../config/paths.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { classifyAgentFeature, USAGE_FEATURES } from "./usage-features.js";
import { resolveUsageEvent, type ResolvedUsageEvent } from "./usage-ledger.js";
import { relabelHeartbeatsV3 } from "./usage-relabel.js";
import {
  cacheTtlFor,
  HEARTBEAT_CHANNEL,
  HeartbeatTurnTracker,
  resolveHeartbeatPromptSet,
  type TtlMemo,
} from "./usage-transcript-classify.js";

const log = createSubsystemLogger("usage-reconcile");

const TRANSCRIPT_RE = /^(?<sessionId>.+?)\.jsonl(?:\.(?:deleted|reset)\..+)?$/;
const SYNTHETIC_PROVIDERS = new Set(["bitterbot", "openclaw"]);
const MAX_LINE_BYTES = 8 * 1024 * 1024;
const READ_CHUNK_BYTES = 1024 * 1024;
const YIELD_EVERY_LINES = 200;
/**
 * The live hook records a turn on an async queue right after the transcript line is written.
 * A reconcile pass that reads the line first would insert it with weaker attribution and the
 * live row would then be dropped by the dedupe key. Lines younger than this are left for the
 * next pass (the live queue settles in milliseconds; two minutes is a generous bound).
 */
export const RECONCILE_GRACE_MS = 2 * 60_000;

type Cursor = { offset: number; size: number; mtimeMs: number; deferred?: boolean };

export type ReconcileResult = { files: number; rows: number; skipped: number };

export function transcriptSessionId(fileName: string): string | null {
  const match = TRANSCRIPT_RE.exec(fileName);
  return match?.groups?.sessionId ?? null;
}

export function usageDedupeKey(sessionId: string, messageTimestamp: number | string): string {
  return `${sessionId}:${messageTimestamp}`;
}

type ParsedAssistantLine = {
  ts: number;
  dedupeKey: string;
  provider?: string;
  model?: string;
  api?: string;
  usage: ReturnType<typeof normalizeUsage>;
  cost?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
  };
  stopReason?: string;
  durationMs?: number;
  /** The raw assistant message, for content classification (heartbeat ack). */
  message: Record<string, unknown>;
};

/** Parse one transcript line into a ledger candidate; null for anything that is not a priced assistant turn. */
export function parseTranscriptLine(line: string, sessionId: string): ParsedAssistantLine | null {
  let entry: Record<string, unknown>;
  try {
    entry = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  const message = entry.message as Record<string, unknown> | undefined;
  if (!message || typeof message !== "object" || message.role !== "assistant") {
    return null;
  }
  const usageRaw = (message.usage ?? entry.usage) as UsageLike | undefined;
  const usage = normalizeUsage(usageRaw);
  if (!usage) {
    return null;
  }
  const provider = typeof message.provider === "string" ? message.provider : undefined;
  if (provider && SYNTHETIC_PROVIDERS.has(provider)) {
    return null;
  }
  const model = typeof message.model === "string" ? message.model : undefined;
  const api = typeof message.api === "string" ? message.api : undefined;
  const msgTs =
    typeof message.timestamp === "number"
      ? message.timestamp
      : typeof entry.timestamp === "string"
        ? Date.parse(entry.timestamp)
        : undefined;
  const entryTs = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : undefined;
  const ts = Number.isFinite(msgTs)
    ? (msgTs as number)
    : Number.isFinite(entryTs)
      ? (entryTs as number)
      : Date.now();
  const costRaw = (usageRaw as { cost?: Record<string, unknown> } | undefined)?.cost;
  const cost =
    costRaw && typeof costRaw === "object"
      ? {
          input: typeof costRaw.input === "number" ? costRaw.input : undefined,
          output: typeof costRaw.output === "number" ? costRaw.output : undefined,
          cacheRead: typeof costRaw.cacheRead === "number" ? costRaw.cacheRead : undefined,
          cacheWrite: typeof costRaw.cacheWrite === "number" ? costRaw.cacheWrite : undefined,
          total: typeof costRaw.total === "number" ? costRaw.total : undefined,
        }
      : undefined;
  return {
    ts,
    dedupeKey: usageDedupeKey(sessionId, Number.isFinite(msgTs) ? (msgTs as number) : ts),
    provider,
    model,
    api,
    usage,
    cost,
    stopReason: typeof message.stopReason === "string" ? message.stopReason : undefined,
    durationMs: typeof message.durationMs === "number" ? message.durationMs : undefined,
    message,
  };
}

function listAgentSessionDirs(stateDir: string): Array<{ agentId: string; dir: string }> {
  const agentsDir = path.join(stateDir, "agents");
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(agentsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: Array<{ agentId: string; dir: string }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const dir = path.join(agentsDir, entry.name, "sessions");
    if (fs.existsSync(dir)) {
      out.push({ agentId: entry.name, dir });
    }
  }
  return out;
}

function readCursor(ledger: UsageLedger, filePath: string): Cursor | null {
  const raw = ledger.getMeta(`reconcile:file:${filePath}`);
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Cursor;
    if (typeof parsed.offset === "number" && typeof parsed.size === "number") {
      return parsed;
    }
  } catch {
    // corrupt cursor — start over
  }
  return null;
}

export type SessionAttribution = { sessionKey: string; channel: string | null; feature: string };

/**
 * Map transcript ids to session keys, channels and features from the agent's `sessions.json`
 * (a flat map of session key -> entry). Heartbeat sessions are recognised by their origin.
 */
export function loadSessionAttribution(sessionsDir: string): Map<string, SessionAttribution> {
  const map = new Map<string, SessionAttribution>();
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(sessionsDir, "sessions.json"), "utf8");
  } catch {
    return map;
  }
  let store: Record<string, Record<string, unknown>>;
  try {
    store = JSON.parse(raw) as Record<string, Record<string, unknown>>;
  } catch {
    return map;
  }
  for (const [sessionKey, entry] of Object.entries(store ?? {})) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const sessionId = typeof entry.sessionId === "string" ? entry.sessionId : null;
    if (!sessionId) {
      continue;
    }
    const origin = (entry.origin ?? {}) as Record<string, unknown>;
    const channel =
      (typeof entry.lastChannel === "string" && entry.lastChannel) ||
      (typeof entry.channel === "string" && entry.channel) ||
      (typeof origin.provider === "string" && origin.provider) ||
      null;
    // Heartbeats share the main session by default, where user turns and heartbeats are
    // indistinguishable in the transcript (live rows carry the runtime flag instead). Only a
    // dedicated heartbeat session (heartbeat.session) is classified as heartbeat here.
    const isMainSession = /^agent:[^:]+:main$/.test(sessionKey) || sessionKey === "global";
    const isHeartbeat =
      !isMainSession && (origin.provider === "heartbeat" || entry.lastTo === "heartbeat");
    map.set(sessionId, {
      sessionKey,
      channel,
      feature: classifyAgentFeature(sessionKey, { isHeartbeat }),
    });
  }
  return map;
}

async function reconcileFile(params: {
  ledger: UsageLedger;
  filePath: string;
  agentId: string;
  cfg?: BitterbotConfig;
  attribution?: Map<string, SessionAttribution>;
  heartbeatPrompts: readonly string[];
  ttlMemo: TtlMemo;
  nowMs: number;
}): Promise<{ rows: number; skipped: number }> {
  const { ledger, filePath, agentId } = params;
  const sessionId = transcriptSessionId(path.basename(filePath));
  if (!sessionId) {
    return { rows: 0, skipped: 0 };
  }
  const stat = fs.statSync(filePath);
  const prev = readCursor(ledger, filePath);
  let offset = prev && prev.offset <= stat.size ? prev.offset : 0;
  if (prev && !prev.deferred && prev.size === stat.size && prev.mtimeMs === stat.mtimeMs) {
    return { rows: 0, skipped: 0 };
  }
  if (stat.size <= offset) {
    ledger.setMeta(
      `reconcile:file:${filePath}`,
      JSON.stringify({
        offset: stat.size,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
      } satisfies Cursor),
    );
    return { rows: 0, skipped: 0 };
  }

  const fd = fs.openSync(filePath, "r");
  let rows = 0;
  let skipped = 0;
  const tracker = new HeartbeatTurnTracker(params.heartbeatPrompts);
  const graceCutoff = params.nowMs - RECONCILE_GRACE_MS;
  try {
    const length = stat.size - offset;
    const buffer = Buffer.alloc(Math.min(length, READ_CHUNK_BYTES));
    const decoder = new StringDecoder("utf8");
    let carry = "";
    let consumed = 0;
    // Bytes after the last newline seen so far (a torn tail); the cursor never advances past it.
    let tailBytes = 0;
    // Bytes of complete lines handled so far, and where the current turn's user line starts, so
    // a deferred (too-young) assistant line re-reads its own user turn next time.
    let processedBytes = 0;
    let turnStartBytes = 0;
    let deferred = false;
    let linesSinceYield = 0;
    const pending: Array<ResolvedUsageEvent & { dedupeKey: string }> = [];
    while (consumed < length && !deferred) {
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, offset + consumed);
      if (bytesRead <= 0) {
        break;
      }
      consumed += bytesRead;
      const lastNewline = buffer.lastIndexOf(0x0a, bytesRead - 1);
      tailBytes = lastNewline >= 0 ? bytesRead - lastNewline - 1 : tailBytes + bytesRead;
      if (tailBytes > MAX_LINE_BYTES) {
        // A single line larger than the cap is not a transcript we can use; skip the rest.
        log.debug(
          `reconcile: line over ${MAX_LINE_BYTES} bytes in ${filePath}; stopping at cursor`,
        );
        break;
      }
      const chunk = carry + decoder.write(buffer.subarray(0, bytesRead));
      const lines = chunk.split("\n");
      carry = lines.pop() ?? "";
      for (const line of lines) {
        linesSinceYield += 1;
        if (linesSinceYield >= YIELD_EVERY_LINES) {
          linesSinceYield = 0;
          // Keep the gateway event loop responsive during a large first-run backfill.
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
        const lineBytes = Buffer.byteLength(line, "utf8") + 1;
        if (HeartbeatTurnTracker.mayCarryUserTurn(line)) {
          try {
            tracker.noteEntry(JSON.parse(line) as Record<string, unknown>);
            turnStartBytes = processedBytes;
          } catch {
            // not a transcript entry
          }
        }
        if (!line.trim() || !line.includes('"usage"')) {
          processedBytes += lineBytes;
          continue;
        }
        const parsed = parseTranscriptLine(line, sessionId);
        if (!parsed) {
          processedBytes += lineBytes;
          continue;
        }
        if (parsed.ts > graceCutoff) {
          deferred = true;
          break;
        }
        processedBytes += lineBytes;
        const attribution = params.attribution?.get(sessionId);
        const isHeartbeat = tracker.isHeartbeatAssistant(parsed.message);
        const resolved = await resolveUsageEvent({
          ts: parsed.ts,
          kind: "chat",
          feature: isHeartbeat
            ? USAGE_FEATURES.agentHeartbeat
            : (attribution?.feature ?? USAGE_FEATURES.agentTurn),
          provider: parsed.provider,
          model: parsed.model,
          api: parsed.api,
          agentId,
          sessionId,
          sessionKey: attribution?.sessionKey,
          channel: isHeartbeat ? HEARTBEAT_CHANNEL : attribution?.channel,
          usage: parsed.usage,
          cost: parsed.cost,
          stopReason: parsed.stopReason,
          durationMs: parsed.durationMs,
          status: parsed.stopReason === "error" ? "error" : "ok",
          cacheTtl: cacheTtlFor(params.ttlMemo, params.cfg, parsed.provider, parsed.model),
          source: "reconcile",
          config: params.cfg,
        });
        if (!resolved) {
          skipped += 1;
          continue;
        }
        pending.push({ ...resolved, dedupeKey: parsed.dedupeKey });
      }
      if (pending.length > 0) {
        const batch = pending.splice(0, pending.length);
        ledger.transaction(() => {
          for (const row of batch) {
            if (ledger.insert(row) === null) {
              skipped += 1;
            } else {
              rows += 1;
            }
          }
        });
      }
    }
    if (deferred) {
      // Stop before the young turn (its user line included) and come back after the grace.
      ledger.setMeta(
        `reconcile:file:${filePath}`,
        JSON.stringify({
          offset: offset + Math.min(processedBytes, turnStartBytes),
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          deferred: true,
        } satisfies Cursor),
      );
      return { rows, skipped };
    }
    // Persist the cursor at the last complete line so a torn tail is re-read next time.
    offset = offset + consumed - tailBytes;
    ledger.setMeta(
      `reconcile:file:${filePath}`,
      JSON.stringify({ offset, size: stat.size, mtimeMs: stat.mtimeMs } satisfies Cursor),
    );
  } finally {
    fs.closeSync(fd);
  }
  return { rows, skipped };
}

export async function reconcileTranscripts(params: {
  ledger: UsageLedger;
  cfg?: BitterbotConfig;
  stateDir?: string;
  /** Test hook: "now" for the young-line grace window. */
  nowMs?: number;
}): Promise<ReconcileResult> {
  const stateDir = params.stateDir ?? resolveStateDir();
  const result: ReconcileResult = { files: 0, rows: 0, skipped: 0 };
  const nowMs = params.nowMs ?? Date.now();
  const heartbeatPrompts = resolveHeartbeatPromptSet(params.cfg);
  const ttlMemo: TtlMemo = new Map();
  for (const { agentId, dir } of listAgentSessionDirs(stateDir)) {
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    const attribution = loadSessionAttribution(dir);
    // One-time relabel of rows imported before attribution existed (Phase 6).
    const relabelKey = `relabel:v2:${agentId}`;
    if (params.ledger.getMeta(relabelKey) === null) {
      let relabeled = 0;
      params.ledger.transaction(() => {
        for (const [sessionId, attr] of attribution) {
          relabeled += params.ledger.relabelReconciled(sessionId, agentId, {
            feature: attr.feature,
            sessionKey: attr.sessionKey,
            channel: attr.channel,
          });
        }
      });
      params.ledger.setMeta(relabelKey, String(relabeled));
      if (relabeled > 0) {
        log.info(`usage reconcile: relabeled ${relabeled} imported rows for agent ${agentId}`);
      }
    }
    // One-time relabel of main-session heartbeats imported as chat turns (relabel:v3).
    try {
      await relabelHeartbeatsV3({
        ledger: params.ledger,
        agentId,
        sessionsDir: dir,
        heartbeatPrompts,
      });
    } catch (err) {
      log.debug(
        `usage reconcile: heartbeat relabel failed for ${agentId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    for (const name of names) {
      if (!TRANSCRIPT_RE.test(name)) {
        continue;
      }
      const filePath = path.join(dir, name);
      try {
        const res = await reconcileFile({
          ledger: params.ledger,
          filePath,
          agentId,
          cfg: params.cfg,
          attribution,
          heartbeatPrompts,
          ttlMemo,
          nowMs,
        });
        result.files += 1;
        result.rows += res.rows;
        result.skipped += res.skipped;
      } catch (err) {
        log.debug(
          `reconcile skipped ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }
  params.ledger.setMeta("reconcile:lastAt", String(Date.now()));
  params.ledger.setMeta("reconcile:lastRows", String(result.rows));
  return result;
}
