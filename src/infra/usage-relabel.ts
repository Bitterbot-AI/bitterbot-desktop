/**
 * PLAN-50 `relabel:v3`: main-session heartbeats imported as chat turns.
 *
 * Until 2026-09-19 the reconciler classified transcripts by session key, and heartbeats run in
 * the shared main session, so every backfilled heartbeat tick landed as `agent/turn`. This
 * one-time pass (keyed `relabel:v3:<agentId>` in `usage_meta`) re-walks the agent's transcripts,
 * classifies each assistant turn by content (heartbeat prompt / `HEARTBEAT_OK` ack), and sets
 * `feature = agent/heartbeat`, `channel = heartbeat` on the matching reconciled rows. Where the
 * transcript is gone, rows are matched by the heartbeat signature instead (a tiny reply, no
 * cache read, no session key). Live rows are never touched. Idempotent: every UPDATE is guarded
 * by `source = 'reconcile' AND feature = 'agent/turn'`.
 */

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import type { UsageLedger } from "./usage-ledger.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { USAGE_FEATURES } from "./usage-features.js";
import { HEARTBEAT_CHANNEL, HeartbeatTurnTracker } from "./usage-transcript-classify.js";

const log = createSubsystemLogger("usage-relabel");

export const RELABEL_V3_KEY_PREFIX = "relabel:v3:";
const TRANSCRIPT_RE = /^(?<sessionId>.+?)\.jsonl(?:\.(?:deleted|reset)\..+)?$/;
const KEY_CHUNK = 400;

export type RelabelV3Result = {
  /** Rows relabeled from transcript content. */
  byTranscript: number;
  /** Rows relabeled by signature because their transcript no longer exists. */
  bySignature: number;
  /** Transcript files walked. */
  files: number;
  /** False when the meta key already existed (nothing was done). */
  ran: boolean;
};

/** Dedupe keys of heartbeat assistant turns in one transcript file. */
export async function collectHeartbeatDedupeKeys(
  filePath: string,
  sessionId: string,
  heartbeatPrompts: readonly string[],
): Promise<string[]> {
  const keys: string[] = [];
  const tracker = new HeartbeatTurnTracker(heartbeatPrompts);
  const rl = readline.createInterface({
    input: fs.createReadStream(filePath, { encoding: "utf8" }),
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  for await (const line of rl) {
    const mayUser = HeartbeatTurnTracker.mayCarryUserTurn(line);
    const mayAssistant = line.includes('"usage"');
    if (!mayUser && !mayAssistant) {
      continue;
    }
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const message = entry.message as Record<string, unknown> | undefined;
    if (!message || typeof message !== "object") {
      continue;
    }
    if (message.role === "user") {
      tracker.noteEntry(entry);
      continue;
    }
    if (message.role !== "assistant" || !mayAssistant) {
      continue;
    }
    if (!tracker.isHeartbeatAssistant(message)) {
      continue;
    }
    const ts =
      typeof message.timestamp === "number"
        ? message.timestamp
        : typeof entry.timestamp === "string"
          ? Date.parse(entry.timestamp)
          : Number.NaN;
    if (Number.isFinite(ts)) {
      keys.push(`${sessionId}:${ts}`);
    }
  }
  return keys;
}

export async function relabelHeartbeatsV3(params: {
  ledger: UsageLedger;
  agentId: string;
  sessionsDir: string;
  heartbeatPrompts: readonly string[];
}): Promise<RelabelV3Result> {
  const { ledger, agentId, sessionsDir } = params;
  const metaKey = `${RELABEL_V3_KEY_PREFIX}${agentId}`;
  if (ledger.getMeta(metaKey) !== null) {
    return { byTranscript: 0, bySignature: 0, files: 0, ran: false };
  }
  let names: string[] = [];
  try {
    names = fs.readdirSync(sessionsDir);
  } catch {
    names = [];
  }
  const patch = { feature: USAGE_FEATURES.agentHeartbeat, channel: HEARTBEAT_CHANNEL };
  const walked = new Set<string>();
  let byTranscript = 0;
  let files = 0;
  for (const name of names) {
    const match = TRANSCRIPT_RE.exec(name);
    const sessionId = match?.groups?.sessionId;
    if (!sessionId) {
      continue;
    }
    files += 1;
    walked.add(sessionId);
    let keys: string[];
    try {
      keys = await collectHeartbeatDedupeKeys(
        path.join(sessionsDir, name),
        sessionId,
        params.heartbeatPrompts,
      );
    } catch (err) {
      log.debug(`relabel v3: skipped ${name}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    for (let i = 0; i < keys.length; i += KEY_CHUNK) {
      byTranscript += ledger.relabelReconciledByDedupeKeys(keys.slice(i, i + KEY_CHUNK), patch);
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  // Transcripts that were pruned since the backfill: fall back to the heartbeat signature.
  const orphaned = ledger
    .reconciledSessionIds(agentId, USAGE_FEATURES.agentTurn)
    .filter((id) => !walked.has(id));
  let bySignature = 0;
  for (let i = 0; i < orphaned.length; i += KEY_CHUNK) {
    bySignature += ledger.relabelHeartbeatSignature(
      agentId,
      orphaned.slice(i, i + KEY_CHUNK),
      patch,
    );
  }
  const total = byTranscript + bySignature;
  ledger.setMeta(metaKey, String(total));
  if (total > 0) {
    log.info(
      `usage relabel v3: ${total} main-session heartbeat rows relabeled for agent ${agentId} (${byTranscript} by transcript, ${bySignature} by signature)`,
    );
  }
  return { byTranscript, bySignature, files, ran: true };
}
