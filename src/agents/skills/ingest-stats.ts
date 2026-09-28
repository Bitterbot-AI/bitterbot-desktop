/**
 * What happened to skills received from peers since the gateway started.
 *
 * The orchestrator's `skills_received` counts gossip it let through; it cannot
 * know what the gateway then decided. These counters are the gateway's side:
 * distinct skills (author + name) versus raw messages, and how many were
 * accepted, held for review, or rejected, with reject reasons. Surfaced on the
 * `skills.network` RPC for the P2P dashboard. In-memory: resets on restart,
 * like the orchestrator's session counters it sits next to.
 */

import type { IngestResult, SkillEnvelope } from "./ingest.js";
import { normalizeSkillName } from "../../memory/skill-evolution/validation-summaries.js";

export type IngestOutcomeStats = {
  sinceMs: number;
  /** Skill messages the gateway processed (re-broadcasts included). */
  messages: number;
  /** Distinct skills: one per author + skill name. */
  distinctSkills: number;
  accepted: number;
  /** Quarantined for review or staged for the local validation gate. */
  heldForReview: number;
  retracted: number;
  rejected: number;
  /** Copies of an already-decided skill, dropped without re-processing. */
  repeatsIgnored: number;
  /** Our own skills echoed back by a peer. Not counted as received. */
  ownEchoesIgnored: number;
  rejectReasons: Record<string, number>;
};

/** Reasons that mean "we already decided about this exact skill". */
const REPEAT_REASONS = new Set([
  "duplicate content hash",
  "repeat of a rejected skill",
  "legacy dream crystal (repeat)",
]);
const MAX_DISTINCT = 10_000;
const MAX_REASONS = 50;

let state = fresh();
const distinct = new Set<string>();

function fresh(): IngestOutcomeStats {
  return {
    sinceMs: Date.now(),
    messages: 0,
    distinctSkills: 0,
    accepted: 0,
    heldForReview: 0,
    retracted: 0,
    rejected: 0,
    repeatsIgnored: 0,
    ownEchoesIgnored: 0,
    rejectReasons: {},
  };
}

/** ingest.ts's reason for our own skill echoed back. */
export const SELF_LOOPBACK_REASON = "self-loopback (own published skill)";

export function recordIngestOutcome(
  envelope: Pick<SkillEnvelope, "author_pubkey" | "name">,
  result: Pick<IngestResult, "action" | "reason"> | null,
): void {
  // Our own output is not something we received: keep it out of every count.
  if (result?.reason === SELF_LOOPBACK_REASON) {
    state.ownEchoesIgnored += 1;
    return;
  }
  state.messages += 1;
  const key = `${envelope.author_pubkey}\u0000${normalizeSkillName(envelope.name)}`;
  if (!distinct.has(key)) {
    if (distinct.size >= MAX_DISTINCT) {
      distinct.clear();
    }
    distinct.add(key);
    state.distinctSkills += 1;
  }

  const reason = result?.reason ?? (result ? undefined : "ingest error");
  if (result && result.action === "rejected" && reason && REPEAT_REASONS.has(reason)) {
    state.repeatsIgnored += 1;
    return;
  }
  switch (result?.action) {
    case "accepted":
      state.accepted += 1;
      return;
    case "quarantined":
    case "staged":
      state.heldForReview += 1;
      return;
    case "retracted":
      state.retracted += 1;
      return;
    default: {
      state.rejected += 1;
      const bucket = (reason ?? "unknown").slice(0, 80);
      if (bucket in state.rejectReasons || Object.keys(state.rejectReasons).length < MAX_REASONS) {
        state.rejectReasons[bucket] = (state.rejectReasons[bucket] ?? 0) + 1;
      }
    }
  }
}

export function getIngestOutcomeStats(): IngestOutcomeStats {
  return { ...state, rejectReasons: { ...state.rejectReasons } };
}

/** @internal */
export function resetIngestOutcomeStatsForTest(): void {
  state = fresh();
  distinct.clear();
}
