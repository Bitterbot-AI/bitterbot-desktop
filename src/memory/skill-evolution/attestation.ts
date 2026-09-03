/**
 * PLAN-43 Phase 3 (§3.4, §3.6): receiver-side verified-outcome attestations.
 *
 * Trust in a skill must never rest on the SELLER's reported scores (their
 * corpus can be arbitrarily easy). Instead the RECEIVING node re-scores
 * the skill itself: real rollouts of the skill (candidate arm) vs the
 * agent as it is today (incumbent arm) over the seeded canonical
 * regression suite PLUS this node's own private capability suite — an
 * adversary cannot overfit what it cannot see. The verdict is signed with
 * this node's device identity as an ATTESTATION keyed by the skill's
 * content SHA-256, stored locally, and (chunk 3c) exchanged with peers and
 * aggregated with a reputation-weighted trimmed mean.
 *
 * Identity note (honest): JS holds the DEVICE Ed25519 identity (same key
 * the circles envelopes use); the P2P node key lives in the Rust
 * orchestrator with no raw-sign bridge, so `node_pubkey` is a claim, not a
 * proof, until the orchestrator exposes signing. Weighting therefore keys
 * on the attester's device pubkey.
 */

import type { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
import type { ImpactTrailOptions } from "../../agents/skills/impact-trail.js";
import { pubkeyId, type KeyPair } from "../../commerce/envelope.js";
import { canonicalJson, type JsonValue } from "../../commerce/sku.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { scanSkillForInjection } from "../../security/skill-injection-scanner.js";
import {
  CANONICAL_GENERATOR_VERSION,
  loadEffectiveCorpus,
  randomCanonicalSeed,
} from "./canonical-corpus.js";
import { loadTaskCorpus } from "./task-corpus.js";
import { type AgentTurnFn, makeInjectedSkillRunner } from "./task-runner.js";
import { validateAgainstTasks } from "./validate-tasks.js";

const log = createSubsystemLogger("skill-evolution/attestation");

export const ATTEST_PROTOCOL = "attest/v1";
export const MAX_ATTESTATION_BYTES = 8_192;
/** Attestations older than this are ignored for aggregation (stale evidence). */
export const ATTESTATION_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
/** Attestations dated further in the future than this are rejected (clock skew allowance). */
export const ATTESTATION_MAX_FUTURE_MS = 5 * 60 * 1000;
/**
 * Verdicts that carry MEASUREMENT (real rollouts happened). Anything else —
 * `no-capability-tasks`, `insufficient-tasks`, `runner-failed`, ... — is a
 * hold: it is never signed, stored, or aggregated as evidence, because a
 * hold scored as 0 would drag every skill's aggregate toward 0 on the most
 * common node state (no private suite yet).
 */
export const MEASURED_VERDICTS: ReadonlySet<string> = new Set([
  "accepted",
  "no-improvement",
  "insufficient-evidence",
  "regression",
]);
export function isMeasuredVerdict(verdict: string): boolean {
  return MEASURED_VERDICTS.has(verdict);
}
const ATTESTATION_KEYS: ReadonlySet<string> = new Set([
  "protocol",
  "content_sha256",
  "corpus_version",
  "corpus_seed",
  "private_suite_sha256",
  "verdict",
  "wins",
  "losses",
  "ties",
  "p_value",
  "regressions",
  "trials_per_task",
  "model",
  "attested_at",
  "attester_pubkey",
  "node_pubkey",
  "signature",
]);
const NON_NEGATIVE_INT = (v: unknown): boolean =>
  typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 1_000_000;

export interface SkillAttestation {
  protocol: string;
  /** Content address of the attested skill text. */
  content_sha256: string;
  corpus_version: string;
  corpus_seed: number;
  /** SHA-256 over the attester's private capability suite (null = none). Reveals nothing about its tasks. */
  private_suite_sha256: string | null;
  verdict: string;
  wins: number;
  losses: number;
  ties: number;
  p_value: number;
  regressions: number;
  trials_per_task: number;
  model: string | null;
  attested_at: number;
  attester_pubkey: string;
  node_pubkey: string | null;
  signature?: string;
}

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function publicKeyFromHex(hex: string): crypto.KeyObject {
  return crypto.createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(hex, "hex")]),
    format: "der",
    type: "spki",
  });
}

/** Domain-prefixed JCS preimage: `attest/v1\n` + canonical JSON of the unsigned record. */
export function attestationPreimage(att: SkillAttestation): Buffer {
  const { signature: _omit, ...unsigned } = att;
  return Buffer.from(
    `${ATTEST_PROTOCOL}\n${canonicalJson(unsigned as unknown as JsonValue)}`,
    "utf8",
  );
}

export function signAttestation(
  att: Omit<SkillAttestation, "signature" | "attester_pubkey">,
  key: KeyPair,
): SkillAttestation {
  const full: SkillAttestation = { ...att, attester_pubkey: pubkeyId(key) };
  full.signature = crypto.sign(null, attestationPreimage(full), key.privateKey).toString("hex");
  return full;
}

/** Structural + signature verification. Rejects anything malformed, oversized, or unsigned. */
export function verifyAttestation(att: unknown, now: number = Date.now()): att is SkillAttestation {
  if (!att || typeof att !== "object" || Array.isArray(att)) {
    return false;
  }
  const a = att as Record<string, unknown>;
  // Closed schema: an unknown key is either padding or a parser-differential
  // vector (a consumer reading a field the signer never meant).
  for (const k of Object.keys(a)) {
    if (!ATTESTATION_KEYS.has(k)) {
      return false;
    }
  }
  if (
    a.protocol !== ATTEST_PROTOCOL ||
    typeof a.content_sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(a.content_sha256) ||
    typeof a.corpus_version !== "string" ||
    a.corpus_version.length > 64 ||
    !(
      typeof a.corpus_seed === "number" &&
      Number.isSafeInteger(a.corpus_seed) &&
      a.corpus_seed >= 0
    ) ||
    (a.private_suite_sha256 !== null &&
      !(
        typeof a.private_suite_sha256 === "string" && /^[0-9a-f]{64}$/.test(a.private_suite_sha256)
      )) ||
    typeof a.verdict !== "string" ||
    !isMeasuredVerdict(a.verdict) ||
    !NON_NEGATIVE_INT(a.wins) ||
    !NON_NEGATIVE_INT(a.losses) ||
    !NON_NEGATIVE_INT(a.ties) ||
    typeof a.p_value !== "number" ||
    !(a.p_value >= 0 && a.p_value <= 1) ||
    !NON_NEGATIVE_INT(a.regressions) ||
    !NON_NEGATIVE_INT(a.trials_per_task) ||
    (a.model !== null && !(typeof a.model === "string" && a.model.length <= 128)) ||
    typeof a.attested_at !== "number" ||
    !Number.isFinite(a.attested_at) ||
    a.attested_at > now + ATTESTATION_MAX_FUTURE_MS ||
    typeof a.attester_pubkey !== "string" ||
    (a.node_pubkey !== null &&
      !(typeof a.node_pubkey === "string" && /^[A-Za-z0-9:_-]{1,128}$/.test(a.node_pubkey))) ||
    typeof a.signature !== "string"
  ) {
    return false;
  }
  if (Buffer.byteLength(JSON.stringify(a), "utf8") > MAX_ATTESTATION_BYTES) {
    return false;
  }
  const match = /^ed25519:([0-9a-f]{64})$/.exec(a.attester_pubkey);
  if (!match || !/^[0-9a-f]{128}$/.test(a.signature)) {
    return false;
  }
  try {
    return crypto.verify(
      null,
      attestationPreimage(a as unknown as SkillAttestation),
      publicKeyFromHex(match[1] as string),
      Buffer.from(a.signature, "hex"),
    );
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

export function ensureAttestationSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS skill_attestations (
      content_sha256 TEXT NOT NULL,
      attester_pubkey TEXT NOT NULL,
      source TEXT NOT NULL,
      verdict TEXT NOT NULL,
      score REAL NOT NULL,
      attested_at INTEGER NOT NULL,
      received_at INTEGER NOT NULL,
      record_json TEXT NOT NULL,
      PRIMARY KEY (content_sha256, attester_pubkey)
    );
    CREATE INDEX IF NOT EXISTS idx_skill_attestations_sha ON skill_attestations(content_sha256);
  `);
}

/**
 * A single attestation's score in [-1, 1]: any new failure is a hard -1
 * (a skill that breaks the baseline is worthless whatever else it wins);
 * otherwise the net win rate over the capability tasks it was scored on.
 */
export function attestationScore(
  att: Pick<SkillAttestation, "wins" | "losses" | "ties" | "regressions">,
): number {
  if (att.regressions > 0) {
    return -1;
  }
  const n = att.wins + att.losses + att.ties;
  const raw = n > 0 ? (att.wins - att.losses) / n : 0;
  return Math.max(-1, Math.min(1, raw));
}

/**
 * Store an attestation. Callers verify signatures (`verifyAttestation`)
 * before calling for peer records; this function only refuses hold
 * verdicts (never evidence). Newer attestations from the same attester
 * replace older ones.
 */
export function storeAttestation(
  db: DatabaseSync,
  att: SkillAttestation,
  source: "local" | "peer",
): boolean {
  if (!isMeasuredVerdict(att.verdict)) {
    return false;
  }
  ensureAttestationSchema(db);
  const existing = db
    .prepare(
      `SELECT attested_at FROM skill_attestations WHERE content_sha256 = ? AND attester_pubkey = ?`,
    )
    .get(att.content_sha256, att.attester_pubkey) as { attested_at: number } | undefined;
  if (existing && existing.attested_at >= att.attested_at) {
    return false;
  }
  db.prepare(
    `INSERT INTO skill_attestations
       (content_sha256, attester_pubkey, source, verdict, score, attested_at, received_at, record_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(content_sha256, attester_pubkey) DO UPDATE SET
       source = excluded.source, verdict = excluded.verdict, score = excluded.score,
       attested_at = excluded.attested_at, received_at = excluded.received_at,
       record_json = excluded.record_json`,
  ).run(
    att.content_sha256,
    att.attester_pubkey,
    source,
    att.verdict,
    attestationScore(att),
    att.attested_at,
    Date.now(),
    JSON.stringify(att),
  );
  return true;
}

/** Store caps (3c adversarial): the verbs are auth-exempt, so growth must be bounded. */
export const MAX_ATTESTERS_PER_SHA = 64;
export const MAX_ATTESTATION_ROWS = 50_000;

/** Drop evidence older than ATTESTATION_MAX_AGE_MS (aggregation ignores it anyway). */
export function pruneStaleAttestations(db: DatabaseSync, now: number = Date.now()): number {
  ensureAttestationSchema(db);
  const r = db
    .prepare(`DELETE FROM skill_attestations WHERE attested_at < ?`)
    .run(now - ATTESTATION_MAX_AGE_MS) as { changes: number };
  return r.changes;
}

/**
 * Admission check for PEER records: refuse when the per-hash attester cap
 * or the global row cap is reached (an existing (sha, attester) row may
 * still be updated).
 */
export function attestationStoreHasRoom(db: DatabaseSync, att: SkillAttestation): boolean {
  ensureAttestationSchema(db);
  const existing = db
    .prepare(`SELECT 1 FROM skill_attestations WHERE content_sha256 = ? AND attester_pubkey = ?`)
    .get(att.content_sha256, att.attester_pubkey);
  if (existing) {
    return true;
  }
  const perSha = db
    .prepare(`SELECT COUNT(*) AS c FROM skill_attestations WHERE content_sha256 = ?`)
    .get(att.content_sha256) as { c: number };
  if (perSha.c >= MAX_ATTESTERS_PER_SHA) {
    return false;
  }
  const total = db.prepare(`SELECT COUNT(*) AS c FROM skill_attestations`).get() as { c: number };
  return total.c < MAX_ATTESTATION_ROWS;
}

export function listAttestations(db: DatabaseSync, contentSha256: string): SkillAttestation[] {
  ensureAttestationSchema(db);
  const rows = db
    .prepare(
      `SELECT record_json FROM skill_attestations WHERE content_sha256 = ? ORDER BY attested_at DESC`,
    )
    .all(contentSha256) as Array<{ record_json: string }>;
  const out: SkillAttestation[] = [];
  for (const r of rows) {
    try {
      out.push(JSON.parse(r.record_json) as SkillAttestation);
    } catch {
      /* skip corrupt row */
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Aggregation (chunk 3c consumes this; defined with the record it scores)
// ---------------------------------------------------------------------------

export interface AttestationAggregate {
  /** Reputation-weighted trimmed mean of per-attester scores, or null with no evidence. */
  score: number | null;
  attesters: number;
  /** Attesters whose evidence survived trimming. */
  counted: number;
  regressions: number;
  /** Attesters below trusted weight (their evidence is bounded, and alone it never scores). */
  unverified: number;
}

/**
 * Reputation-weighted TRIMMED mean (drop the top and bottom 20% by score
 * once there are >= 5 attesters) — a Sybil ring that piles on extreme
 * scores is discarded before it can move the aggregate (gossip trimmed
 * means; Gemini/research recommendation). One attestation per attester
 * (newest wins), stale ones ignored.
 */
/** Weight at which an attester counts as TRUSTED (own node or configured list). */
export const TRUSTED_ATTESTER_WEIGHT = 1;
/** Collective weight of non-trusted attesters may not exceed this fraction of the trusted weight present. */
export const UNKNOWN_MASS_CAP = 0.25;

export function aggregateAttestations(
  atts: SkillAttestation[],
  weightOf: (attesterPubkey: string) => number,
  now: number = Date.now(),
  opts: { corpusVersionPrefix?: string } = {},
): AttestationAggregate {
  const byAttester = new Map<string, SkillAttestation>();
  for (const a of atts) {
    if (
      now - a.attested_at > ATTESTATION_MAX_AGE_MS ||
      a.attested_at > now + ATTESTATION_MAX_FUTURE_MS
    ) {
      continue;
    }
    // Holds are not evidence; a stale-corpus verdict is not evidence for today's suite.
    if (!isMeasuredVerdict(a.verdict)) {
      continue;
    }
    if (opts.corpusVersionPrefix && !a.corpus_version.startsWith(opts.corpusVersionPrefix)) {
      continue;
    }
    const prev = byAttester.get(a.attester_pubkey);
    if (!prev || prev.attested_at < a.attested_at) {
      byAttester.set(a.attester_pubkey, a);
    }
  }
  const scored = [...byAttester.values()]
    .map((a) => ({
      score: attestationScore(a),
      weight: Math.max(0, weightOf(a.attester_pubkey)),
      regressions: a.regressions,
    }))
    .filter((s) => s.weight > 0);
  // Unknown-mass cap: minted device identities are free, so however many
  // unknown attesters show up, together they may weigh at most a fixed
  // fraction of the trusted weight in the room (trusted-only when trusted
  // evidence exists and unknowns would otherwise dominate).
  const trustedMass = scored
    .filter((s) => s.weight >= TRUSTED_ATTESTER_WEIGHT)
    .reduce((a, s) => a + s.weight, 0);
  const unknownMass = scored
    .filter((s) => s.weight < TRUSTED_ATTESTER_WEIGHT)
    .reduce((a, s) => a + s.weight, 0);
  if (trustedMass > 0 && unknownMass > trustedMass * UNKNOWN_MASS_CAP) {
    const scale = (trustedMass * UNKNOWN_MASS_CAP) / unknownMass;
    for (const s of scored) {
      if (s.weight < TRUSTED_ATTESTER_WEIGHT) {
        s.weight *= scale;
      }
    }
  }
  scored.sort((x, y) => x.score - y.score);
  if (scored.length === 0) {
    return { score: null, attesters: byAttester.size, counted: 0, regressions: 0, unverified: 0 };
  }
  if (trustedMass <= 0) {
    // Unknown-only evidence never produces a ranked score: without a
    // trusted (own or configured) measurement there is nothing a Sybil
    // ring could not have fabricated. Surface the count, not a number.
    return {
      score: null,
      attesters: byAttester.size,
      counted: 0,
      regressions: 0,
      unverified: scored.length,
    };
  }
  // WEIGHT-aware trimming: drop the lowest-scoring 20% of total weight and
  // the highest-scoring 20%. Trimming by count instead would let a Sybil
  // ring of many low-weight attesters push the few high-weight honest
  // attesters into the trimmed tail; trimming by weight makes a ring worth
  // exactly its reputation, no matter how many keys it mints.
  const totalWeight = scored.reduce((a, s) => a + s.weight, 0);
  // Trim only once there are >= 5 TRUSTED attesters: gating on total count
  // would let unknowns activate the band and have it eat trusted mass.
  const trustedCount = scored.filter((s) => s.weight >= TRUSTED_ATTESTER_WEIGHT).length;
  const band = trustedCount >= 5 ? totalWeight * 0.2 : 0;
  let cumulative = 0;
  let keptWeight = 0;
  let keptScore = 0;
  let counted = 0;
  for (const s of scored) {
    const lo = cumulative;
    const hi = cumulative + s.weight;
    cumulative = hi;
    // Portion of this entry inside the kept band [band, totalWeight - band].
    const keptPortion = Math.max(0, Math.min(hi, totalWeight - band) - Math.max(lo, band));
    if (keptPortion > 0) {
      keptWeight += keptPortion;
      keptScore += s.score * keptPortion;
      counted += 1;
    }
  }
  const score = keptWeight > 0 ? keptScore / keptWeight : null;
  return {
    score,
    attesters: byAttester.size,
    counted,
    regressions: scored.filter((s) => s.regressions > 0).length,
    unverified: scored.length - trustedCount,
  };
}

// ---------------------------------------------------------------------------
// Receiver-side re-scoring
// ---------------------------------------------------------------------------

export function skillContentSha256(text: string): string {
  return crypto.createHash("sha256").update(text, "utf-8").digest("hex");
}

/**
 * Re-score a skill on THIS node: seeded canonical regression suite + the
 * node's private capability suite, candidate (skill injected) vs incumbent
 * (no injection). Returns the signed attestation; stores it when a db is
 * given. Never throws on runner failure — the verdict records it.
 */
export async function rescoreSkill(params: {
  content: string;
  agentTurn: AgentTurnFn;
  keyPair: KeyPair;
  storeOpts?: ImpactTrailOptions;
  trialsPerTask?: number;
  model?: string;
  nodePubkey?: string;
  db?: DatabaseSync;
}): Promise<RescoreResult> {
  const seed = randomCanonicalSeed();
  const corpus = await loadEffectiveCorpus(params.storeOpts ?? {}, seed);
  if (!corpus) {
    log.warn("rescore: no corpus available");
    return { attestation: null, verdict: "no-corpus" };
  }
  const grown = await loadTaskCorpus(params.storeOpts ?? {});
  const privateSuiteSha256 = grown
    ? crypto.createHash("sha256").update(JSON.stringify(grown.tasks)).digest("hex")
    : null;
  const verdict = await validateAgainstTasks({
    corpus,
    runTask: makeInjectedSkillRunner(params.agentTurn, params.content, null),
    ...(params.trialsPerTask !== undefined ? { trialsPerTask: params.trialsPerTask } : {}),
  });
  if (!isMeasuredVerdict(verdict.reason)) {
    // A hold (no capability tasks, runner failure, ...) is sweep state,
    // never signed evidence.
    log.info(
      `rescore hold for ${skillContentSha256(params.content).slice(0, 12)}: ${verdict.reason}`,
    );
    return { attestation: null, verdict: verdict.reason };
  }
  const att = signAttestation(
    {
      protocol: ATTEST_PROTOCOL,
      content_sha256: skillContentSha256(params.content),
      corpus_version: verdict.corpusVersion,
      corpus_seed: seed,
      private_suite_sha256: privateSuiteSha256,
      verdict: verdict.reason,
      wins: verdict.wins ?? 0,
      losses: verdict.losses ?? 0,
      ties: verdict.ties ?? 0,
      p_value: verdict.pValue ?? 1,
      regressions: verdict.regressions?.length ?? 0,
      trials_per_task: verdict.trialsPerTask ?? 1,
      model: params.model ?? null,
      attested_at: Date.now(),
      node_pubkey: params.nodePubkey ?? null,
    },
    params.keyPair,
  );
  if (params.db) {
    storeAttestation(params.db, att, "local");
  }
  log.info(
    `attested ${att.content_sha256.slice(0, 12)}: ${att.verdict} wins=${att.wins} losses=${att.losses} regressions=${att.regressions} p=${att.p_value.toFixed(3)}`,
  );
  return { attestation: att, verdict: att.verdict };
}

export interface RescoreResult {
  /** Signed evidence, or null on a hold verdict (see MEASURED_VERDICTS). */
  attestation: SkillAttestation | null;
  verdict: string;
}

/**
 * Housekeeping sweep: attest accepted peer-origin skill crystals that this
 * node has not scored yet (bounded per pass — each attestation costs real
 * rollouts). Non-destructive: verdicts are recorded and surfaced; whether a
 * regression verdict deactivates a skill is an operator decision.
 */
export async function runAttestationSweep(params: {
  db: DatabaseSync;
  agentTurn: AgentTurnFn;
  keyPair: KeyPair;
  storeOpts?: ImpactTrailOptions;
  trialsPerTask?: number;
  model?: string;
  nodePubkey?: string;
  maxPerPass?: number;
  /** Injection pre-scan; anything at or above `medium` is never executed. Default: the skills scanner. */
  scan?: (text: string) => { severity: string };
}): Promise<{ attested: number; skipped: number; held: number }> {
  ensureAttestationSchema(params.db);
  pruneStaleAttestations(params.db);
  const mine = pubkeyId(params.keyPair);
  const max = Math.max(0, params.maxPerPass ?? 1);
  if (max === 0) {
    return { attested: 0, skipped: 0, held: 0 };
  }
  // Nothing to measure without a private capability suite: every rollout
  // would end in a hold. Short-circuit before spending a single turn.
  const grown = await loadTaskCorpus(params.storeOpts ?? {});
  const capabilityCount = grown?.tasks.filter((t) => t.suite === "capability").length ?? 0;
  if (capabilityCount === 0) {
    return { attested: 0, skipped: 0, held: 0 };
  }
  const privateSuiteSha256 = crypto
    .createHash("sha256")
    .update(JSON.stringify(grown?.tasks ?? []))
    .digest("hex");
  const rows = params.db
    .prepare(
      `SELECT c.id, c.text, c.governance_json, c.updated_at FROM chunks c
        WHERE c.semantic_type IN ('skill', 'task_pattern')
          AND COALESCE(c.lifecycle_state, 'active') = 'active'
          AND c.governance_json LIKE '%"peerOrigin"%'
        ORDER BY c.updated_at ASC LIMIT 2000`,
    )
    .all() as unknown as Array<{ id: string; text: string; governance_json: string | null }>;
  let attested = 0;
  let skipped = 0;
  let held = 0;
  const scan = params.scan ?? defaultScan;
  const peersServed = new Set<string>();
  for (const row of rows) {
    if (attested >= max) {
      break;
    }
    const sha = skillContentSha256(row.text);
    const have = params.db
      .prepare(
        `SELECT record_json FROM skill_attestations WHERE content_sha256 = ? AND attester_pubkey = ?`,
      )
      .get(sha, mine) as { record_json: string } | undefined;
    if (have) {
      // Re-attest only when the evidence base changed (private suite or corpus generation).
      let stale = false;
      try {
        const prev = JSON.parse(have.record_json) as SkillAttestation;
        stale =
          prev.private_suite_sha256 !== privateSuiteSha256 ||
          !prev.corpus_version.startsWith(currentCorpusVersionPrefix());
      } catch {
        stale = true;
      }
      if (!stale) {
        skipped += 1;
        continue;
      }
    }
    // Round-robin by author: one skill per peer per pass, so a peer pushing
    // fresh edits every day cannot own the rollout budget.
    let author = "";
    try {
      const g = JSON.parse(row.governance_json ?? "{}") as { peerOrigin?: unknown };
      author = typeof g.peerOrigin === "string" ? g.peerOrigin : "";
    } catch {
      /* ignore */
    }
    if (author && peersServed.has(author)) {
      skipped += 1;
      continue;
    }
    // Peer text executes in real turns: refuse anything the injection scanner flags.
    let severity = "none";
    try {
      severity = scan(row.text).severity;
    } catch {
      severity = "critical";
    }
    if (severity !== "ok" && severity !== "low") {
      log.warn(`attestation sweep: skipping ${row.id} (injection scan ${severity})`);
      held += 1;
      continue;
    }
    try {
      const res = await rescoreSkill({ ...params, content: row.text });
      if (author) {
        peersServed.add(author);
      }
      if (res.attestation) {
        attested += 1;
      } else {
        held += 1;
      }
    } catch (err) {
      log.warn(`attestation sweep failed for ${row.id}: ${String(err)}`);
      held += 1;
    }
  }
  return { attested, skipped, held };
}

function currentCorpusVersionPrefix(): string {
  // loadEffectiveCorpus versions read `canonical-g<N>-s<seed>[+<grown>]`.
  return `canonical-g${CANONICAL_GENERATOR_VERSION}-`;
}

/** Current-generation prefix for aggregation consumers (3c marketplace ranking). */
export function currentAttestationCorpusPrefix(): string {
  return currentCorpusVersionPrefix();
}

function defaultScan(text: string): { severity: string } {
  return scanSkillForInjection(text);
}
