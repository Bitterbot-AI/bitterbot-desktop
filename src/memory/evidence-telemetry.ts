/**
 * PLAN-59 Phase 0: evidence telemetry for the curiosity/dream system.
 *
 * An observational layer that changes no behaviour. It records three things:
 *
 * - `retrieval_hits`: the top-K of what an owner memory search returned (chunk
 *   id, rank, fused score, per-channel ranks), under a keyed digest of the
 *   query. The query text itself is never stored.
 * - `surfacing_events`: what the agent proactively surfaced (a curiosity
 *   finding voiced in the prompt, a proactive-recall fact, a dream brief) and,
 *   as a separate step, what the owner did about it. Exposure and outcome are
 *   kept apart on purpose: a surfaced item is `delivered`; usefulness is only
 *   `explicit` when the owner acted (dismissed, answered, corrected). Silence
 *   is `unknown`, never "ignored".
 * - `decision_traces` (shadow mode only): what a "GCCRF as diagnostic only"
 *   routing would have decided in the dream engine next to what the legacy
 *   routing actually decided. The legacy decision is always the one used.
 *
 * Digests are HMAC-SHA256 under a node-local random key generated once and kept
 * in `evidence_meta`, so two nodes never share a digest and a digest cannot be
 * reversed without the key. Retention is bounded (default 90 days) and pruning
 * is chunked with event-loop yields. Every write is best-effort: a telemetry
 * failure is caught and debug-logged, never surfaced to search or dreaming.
 */

import { createHmac, randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { CuriosityEvidenceConfig, CuriosityEvidenceMode } from "./curiosity-types.js";
import { yieldToEventLoop } from "./event-loop.js";
import { GCCRF_SCORING_VERSION } from "./gccrf-state.js";

const defaultLog = createSubsystemLogger("memory/evidence");

export type EvidenceLogger = {
  debug: (msg: string) => void;
  warn: (msg: string) => void;
};

export type ResolvedEvidenceConfig = {
  mode: CuriosityEvidenceMode;
  retentionDays: number;
  topK: number;
};

export const EVIDENCE_DEFAULTS: ResolvedEvidenceConfig = {
  mode: "shadow",
  retentionDays: 90,
  topK: 10,
};

const MODES: readonly CuriosityEvidenceMode[] = ["off", "observe", "shadow"];
const PRUNE_CHUNK = 2000;
const MAX_TOP_K = 200;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Coerce the raw `memory.curiosity.evidence` value. The config schema keeps
 * `memory` passthrough, so anything can arrive here: a typo in `mode` falls
 * back to the default (shadow) rather than silently disabling the traces; non-positive or non-numeric retention/topK fall back too.
 */
export function resolveEvidenceConfig(
  raw: unknown,
  log: EvidenceLogger = defaultLog,
): ResolvedEvidenceConfig {
  const out = { ...EVIDENCE_DEFAULTS };
  if (!raw || typeof raw !== "object") {
    return out;
  }
  const r = raw as Record<string, unknown>;
  if (r.mode !== undefined) {
    if (typeof r.mode === "string" && (MODES as readonly string[]).includes(r.mode)) {
      out.mode = r.mode as CuriosityEvidenceMode;
    } else {
      log.warn(
        `memory.curiosity.evidence.mode ${JSON.stringify(r.mode)} is not one of ${MODES.join("|")}; using ${out.mode}`,
      );
    }
  }
  const days = Number(r.retentionDays);
  if (r.retentionDays !== undefined && Number.isFinite(days) && days > 0) {
    out.retentionDays = days;
  }
  const k = Number(r.topK);
  if (r.topK !== undefined && Number.isFinite(k) && k >= 1) {
    out.topK = Math.min(MAX_TOP_K, Math.floor(k));
  }
  return out;
}

export type RetrievalHitInput = {
  chunkId: string;
  /** 1-based position in the list the caller returns. */
  rank: number;
  /** The fused score as returned; absent when the caller has none. */
  score?: number;
  /** Per-channel 1-based ranks (vector, keyword, graph) where in scope. */
  channelRanks?: Record<string, number>;
};

export type RecordRetrievalInput = {
  query: string;
  sessionKey?: string;
  caller?: string;
  results: RetrievalHitInput[];
  embeddingModel?: string;
  scoringVersion?: string;
  now?: number;
};

export type SurfacingStage = "eligible" | "assigned" | "delivered" | "visible" | "responded";
export type SurfacingOutcome =
  | "useful"
  | "corrected"
  | "dismissed"
  | "answered"
  | "engaged_weak"
  /**
   * PLAN-59 Phase 2: the owner retrieved the item through an explicit memory
   * search. In the shadow stage this is a baseline rate, not a crossover from
   * a withheld condition (nothing is withheld in shadow).
   */
  | "explicit_retrieval"
  | "unknown";
export type LabelProvenance =
  | "explicit"
  | "inferred"
  /** PLAN-59 Phase 2: set by the shadow crossover marker, never by the owner. */
  | "shadow_crossover"
  | "unknown";

export type RecordSurfacingInput = {
  /** Idempotency key: the same event id is written once (INSERT OR IGNORE). */
  eventId: string;
  kind: string;
  refId?: string;
  arm?: string;
  opportunityId?: string;
  sessionKey?: string;
  stage: SurfacingStage;
  costUsd?: number;
  /**
   * PLAN-59 Phase 2: small JSON payload for the stage (the surfacing trial
   * stores the randomisation block id and the carry-over flag on `assigned`
   * rows). Never content, never a query.
   */
  details?: Record<string, unknown>;
  now?: number;
};

export type RecordSurfacingOutcomeInput = {
  refId?: string;
  eventId?: string;
  outcome: SurfacingOutcome;
  provenance: LabelProvenance;
  /** Kind for the `responded` row created when no delivered row matches. */
  kind?: string;
  /**
   * PLAN-59 Phase 2: leave a row alone when it already carries an outcome, so
   * an inferred marker never overwrites what the owner said. Also skips the
   * `responded` fallback row.
   */
  onlyIfUnlabelled?: boolean;
  now?: number;
};

export type RecordDecisionTraceInput = {
  kind: string;
  legacy: unknown;
  proposed: unknown;
  scoringVersion?: string;
  /**
   * When given, `diverged` compares only this key of `legacy` and `proposed`
   * (the decision), so auxiliary fields such as the weights that produced it
   * can ride along without every row counting as a divergence.
   */
  decisionKey?: string;
  now?: number;
};

export type EvidenceStats = {
  mode: CuriosityEvidenceMode;
  available: boolean;
  retrievalHits: number;
  surfacingEvents: number;
  decisionTraces: number;
  oldestAt: number | null;
};

export type PruneResult = {
  retrievalHits: number;
  surfacingEvents: number;
  decisionTraces: number;
};

const REQUIRED_TABLES = ["retrieval_hits", "surfacing_events", "decision_traces", "evidence_meta"];

/** JSON with object keys sorted at every depth, so equal values compare equal. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).toSorted()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

export class EvidenceTelemetry {
  private db: DatabaseSync;
  private readonly cfg: ResolvedEvidenceConfig;
  private readonly log: EvidenceLogger;
  private available: boolean;
  private digestKey: Buffer | null = null;
  private scoringVersion: string;
  private maintenanceTimer: ReturnType<typeof setInterval> | null = null;
  private maintenanceRun: Promise<void> | null = null;

  constructor(
    db: DatabaseSync,
    config: ResolvedEvidenceConfig | CuriosityEvidenceConfig | undefined,
    logger: EvidenceLogger = defaultLog,
  ) {
    this.db = db;
    this.log = logger;
    this.cfg = isResolved(config) ? config : resolveEvidenceConfig(config, logger);
    this.available = this.tablesPresent();
    if (!this.available) {
      this.log.debug("evidence telemetry tables missing; telemetry is a no-op on this database");
    }
    this.scoringVersion = this.readScoringVersion();
  }

  get mode(): CuriosityEvidenceMode {
    return this.cfg.mode;
  }

  /** Retention is independent of consolidation and still applies when collection is off. */
  startMaintenance(): void {
    if (this.maintenanceTimer) return;
    const tick = () => {
      if (this.maintenanceRun) return;
      this.maintenanceRun = this.prune()
        .then(() => {})
        .catch((err) => this.log.debug(`evidence maintenance failed: ${String(err)}`))
        .finally(() => {
          this.maintenanceRun = null;
        });
    };
    this.maintenanceTimer = setInterval(tick, 30 * 60_000);
    this.maintenanceTimer.unref();
    tick();
  }

  /** Drain in-flight pruning before the owner closes its database connection. */
  async stopMaintenance(): Promise<void> {
    if (this.maintenanceTimer) clearInterval(this.maintenanceTimer);
    this.maintenanceTimer = null;
    await this.maintenanceRun;
  }

  /**
   * Point the writer at a new connection after the manager swapped its
   * database file (atomic reindex). The tables ride the generic auxiliary
   * carry-over, so the digest key survives; it is re-read from the new file.
   */
  rebind(db: DatabaseSync): void {
    this.db = db;
    this.digestKey = null;
    this.available = this.tablesPresent();
    this.scoringVersion = this.readScoringVersion();
  }

  get config(): ResolvedEvidenceConfig {
    return { ...this.cfg };
  }

  /**
   * The live connection, or null when the tables are missing. For the
   * surfacing trial's own lookups (carry-over, crossover, counts): it reads
   * through this accessor on every call, so a rebind after a database swap is
   * picked up without the trial holding a handle of its own.
   */
  connection(): DatabaseSync | null {
    return this.available ? this.db : null;
  }

  /** True when rows can be written at all (mode not off, tables present). */
  isEnabled(): boolean {
    return this.available && this.cfg.mode !== "off";
  }

  /** True when decision traces are recorded. */
  isShadow(): boolean {
    return this.available && this.cfg.mode === "shadow";
  }

  /** HMAC-SHA256 hex (first 32 chars) of `value` under the node-local key. */
  digest(value: string): string | null {
    const key = this.ensureDigestKey();
    if (!key) {
      return null;
    }
    return createHmac("sha256", key).update(value).digest("hex").slice(0, 32);
  }

  /**
   * Write at most topK rows for one search in a single transaction and return
   * the query id, or null when nothing was written.
   */
  recordRetrieval(input: RecordRetrievalInput): string | null {
    if (!this.isEnabled()) {
      return null;
    }
    try {
      const rows = input.results.slice(0, this.cfg.topK);
      if (rows.length === 0) {
        return null;
      }
      const queryDigest = this.digest(input.query.trim());
      if (!queryDigest) {
        return null;
      }
      const sessionDigest = this.sessionDigest(input.sessionKey);
      const queryId = randomBytes(8).toString("hex");
      const now = input.now ?? Date.now();
      const stmt = this.db.prepare(
        `INSERT INTO retrieval_hits
           (query_id, query_digest, session_digest, caller, query_len, chunk_id, rank,
            fused_score, channel_ranks_json, injected, cited, embedding_model,
            scoring_version, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)`,
      );
      this.inTransaction(() => {
        for (const r of rows) {
          stmt.run(
            queryId,
            queryDigest,
            sessionDigest,
            input.caller ?? null,
            input.query.length,
            r.chunkId,
            r.rank,
            typeof r.score === "number" && Number.isFinite(r.score) ? r.score : null,
            r.channelRanks ? JSON.stringify(r.channelRanks) : null,
            input.embeddingModel ?? null,
            input.scoringVersion ?? this.scoringVersion,
            now,
          );
        }
      });
      return queryId;
    } catch (err) {
      this.log.debug(`recordRetrieval failed: ${String(err)}`);
      return null;
    }
  }

  /** Insert one surfacing event; a repeated event id is ignored. Returns true when inserted. */
  recordSurfacing(input: RecordSurfacingInput): boolean {
    return this.recordSurfacingBatch([input]) > 0;
  }

  /** Insert several surfacing events in one transaction. Returns how many were new. */
  recordSurfacingBatch(inputs: RecordSurfacingInput[]): number {
    if (!this.isEnabled() || inputs.length === 0) {
      return 0;
    }
    try {
      const stmt = this.db.prepare(
        `INSERT OR IGNORE INTO surfacing_events
           (event_id, kind, ref_id, arm, opportunity_id, session_digest, stage, cost_usd,
            details_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      let inserted = 0;
      this.inTransaction(() => {
        for (const e of inputs) {
          const res = stmt.run(
            e.eventId,
            e.kind,
            e.refId ?? null,
            e.arm ?? "legacy",
            e.opportunityId ?? null,
            this.sessionDigest(e.sessionKey),
            e.stage,
            typeof e.costUsd === "number" && Number.isFinite(e.costUsd) ? e.costUsd : null,
            e.details ? canonicalJson(e.details) : null,
            e.now ?? Date.now(),
          );
          inserted += Number(res.changes);
        }
      });
      return inserted;
    } catch (err) {
      this.log.debug(`recordSurfacing failed: ${String(err)}`);
      return 0;
    }
  }

  /**
   * Label the latest matching surfacing row (by event id, or by ref id /
   * opportunity id, preferring a `delivered` row). When nothing matches, a
   * `responded` row is created so the owner's action is kept.
   */
  recordSurfacingOutcome(input: RecordSurfacingOutcomeInput): boolean {
    if (!this.isEnabled()) {
      return false;
    }
    if (!input.refId && !input.eventId) {
      return false;
    }
    try {
      const now = input.now ?? Date.now();
      const target = input.eventId
        ? (this.db
            .prepare(`SELECT id, outcome FROM surfacing_events WHERE event_id = ? LIMIT 1`)
            .get(input.eventId) as { id: number; outcome: string | null } | undefined)
        : (this.db
            .prepare(
              `SELECT id, outcome FROM surfacing_events
                WHERE (ref_id = ? OR opportunity_id = ?)
                ORDER BY CASE WHEN stage = 'delivered' THEN 0 ELSE 1 END, created_at DESC, id DESC
                LIMIT 1`,
            )
            .get(input.refId!, input.refId!) as { id: number; outcome: string | null } | undefined);
      if (target) {
        if (input.onlyIfUnlabelled && target.outcome !== null) {
          return false;
        }
        this.db
          .prepare(
            `UPDATE surfacing_events SET outcome = ?, label_provenance = ?, outcome_at = ? WHERE id = ?`,
          )
          .run(input.outcome, input.provenance, now, target.id);
        return true;
      }
      if (input.onlyIfUnlabelled) {
        return false;
      }
      const ref = input.refId ?? input.eventId!;
      this.db
        .prepare(
          `INSERT OR IGNORE INTO surfacing_events
             (event_id, kind, ref_id, arm, stage, outcome, label_provenance, created_at, outcome_at)
           VALUES (?, ?, ?, 'legacy', 'responded', ?, ?, ?, ?)`,
        )
        .run(
          `resp:${ref}:${now}`,
          input.kind ?? "unknown",
          ref,
          input.outcome,
          input.provenance,
          now,
          now,
        );
      return true;
    } catch (err) {
      this.log.debug(`recordSurfacingOutcome failed: ${String(err)}`);
      return false;
    }
  }

  /** Shadow mode only: store a legacy/proposed decision pair. Returns the diverged flag or null. */
  recordDecisionTrace(input: RecordDecisionTraceInput): boolean | null {
    if (!this.isShadow()) {
      return null;
    }
    try {
      const pick = (v: unknown): unknown =>
        input.decisionKey && v && typeof v === "object"
          ? (v as Record<string, unknown>)[input.decisionKey]
          : v;
      const diverged = canonicalJson(pick(input.legacy)) !== canonicalJson(pick(input.proposed));
      this.db
        .prepare(
          `INSERT INTO decision_traces
             (kind, legacy_json, proposed_json, diverged, scoring_version, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.kind,
          canonicalJson(input.legacy),
          canonicalJson(input.proposed),
          diverged ? 1 : 0,
          input.scoringVersion ?? this.scoringVersion,
          input.now ?? Date.now(),
        );
      return diverged;
    } catch (err) {
      this.log.debug(`recordDecisionTrace failed: ${String(err)}`);
      return null;
    }
  }

  /**
   * Delete rows older than the retention window, 2000 at a time with an
   * event-loop yield between chunks. Runs in every mode (so switching to `off`
   * still drains old rows) and never throws.
   */
  async prune(now: number = Date.now()): Promise<PruneResult> {
    const out: PruneResult = { retrievalHits: 0, surfacingEvents: 0, decisionTraces: 0 };
    if (!this.available) {
      return out;
    }
    const cutoff = now - this.cfg.retentionDays * DAY_MS;
    out.retrievalHits = await this.pruneTable("retrieval_hits", cutoff);
    out.surfacingEvents = await this.pruneTable("surfacing_events", cutoff);
    out.decisionTraces = await this.pruneTable("decision_traces", cutoff);
    return out;
  }

  stats(): EvidenceStats {
    const out: EvidenceStats = {
      mode: this.cfg.mode,
      available: this.available,
      retrievalHits: 0,
      surfacingEvents: 0,
      decisionTraces: 0,
      oldestAt: null,
    };
    if (!this.available) {
      return out;
    }
    try {
      const count = (table: string): number =>
        Number((this.db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c);
      out.retrievalHits = count("retrieval_hits");
      out.surfacingEvents = count("surfacing_events");
      out.decisionTraces = count("decision_traces");
      const oldest = this.db
        .prepare(
          `SELECT MIN(t) AS t FROM (
             SELECT MIN(created_at) AS t FROM retrieval_hits
             UNION ALL SELECT MIN(created_at) FROM surfacing_events
             UNION ALL SELECT MIN(created_at) FROM decision_traces)`,
        )
        .get() as { t: number | null } | undefined;
      out.oldestAt = typeof oldest?.t === "number" ? oldest.t : null;
    } catch (err) {
      this.log.debug(`stats failed: ${String(err)}`);
    }
    return out;
  }

  // ── internals ──

  private tablesPresent(): boolean {
    try {
      const placeholders = REQUIRED_TABLES.map(() => "?").join(",");
      const row = this.db
        .prepare(
          `SELECT COUNT(*) AS c FROM sqlite_master WHERE type = 'table' AND name IN (${placeholders})`,
        )
        .get(...REQUIRED_TABLES) as { c: number } | undefined;
      return Number(row?.c ?? 0) === REQUIRED_TABLES.length;
    } catch {
      return false;
    }
  }

  private readScoringVersion(): string {
    try {
      const row = this.db
        .prepare(`SELECT value FROM gccrf_state WHERE key = 'scoring_version'`)
        .get() as { value: string | null } | undefined;
      if (row?.value) {
        return row.value;
      }
    } catch {
      // gccrf_state absent: the scorer has not persisted yet
    }
    return GCCRF_SCORING_VERSION;
  }

  private ensureDigestKey(): Buffer | null {
    if (this.digestKey) {
      return this.digestKey;
    }
    if (!this.available) {
      return null;
    }
    try {
      const fresh = randomBytes(32).toString("hex");
      this.db
        .prepare(`INSERT OR IGNORE INTO evidence_meta (key, value) VALUES ('digest_key', ?)`)
        .run(fresh);
      const row = this.db
        .prepare(`SELECT value FROM evidence_meta WHERE key = 'digest_key'`)
        .get() as { value: string } | undefined;
      if (!row?.value) {
        return null;
      }
      this.digestKey = Buffer.from(row.value, "hex");
      return this.digestKey;
    } catch (err) {
      this.log.debug(`digest key unavailable: ${String(err)}`);
      return null;
    }
  }

  private sessionDigest(sessionKey: string | undefined): string | null {
    const key = sessionKey?.trim();
    return key ? this.digest(key) : null;
  }

  /** Run `fn` inside a transaction when one can be opened; plain statements otherwise. */
  private inTransaction(fn: () => void): void {
    let began = false;
    try {
      this.db.exec("BEGIN");
      began = true;
    } catch {
      // Already inside a caller's transaction: the statements join it.
    }
    try {
      fn();
      if (began) {
        this.db.exec("COMMIT");
      }
    } catch (err) {
      if (began) {
        try {
          this.db.exec("ROLLBACK");
        } catch {
          // nothing to roll back
        }
      }
      throw err;
    }
  }

  private async pruneTable(table: string, cutoff: number): Promise<number> {
    let total = 0;
    try {
      const stmt = this.db.prepare(
        `DELETE FROM ${table} WHERE id IN
           (SELECT id FROM ${table} WHERE created_at < ? ORDER BY created_at LIMIT ?)`,
      );
      for (;;) {
        const changes = Number(stmt.run(cutoff, PRUNE_CHUNK).changes);
        total += changes;
        if (changes < PRUNE_CHUNK) {
          break;
        }
        await yieldToEventLoop();
      }
    } catch (err) {
      this.log.debug(`prune ${table} failed: ${String(err)}`);
    }
    return total;
  }
}

function isResolved(
  config: ResolvedEvidenceConfig | CuriosityEvidenceConfig | undefined,
): config is ResolvedEvidenceConfig {
  return Boolean(
    config &&
    typeof config.mode === "string" &&
    (MODES as readonly string[]).includes(config.mode) &&
    typeof config.retentionDays === "number" &&
    Number.isFinite(config.retentionDays) &&
    config.retentionDays > 0 &&
    typeof config.topK === "number" &&
    Number.isInteger(config.topK) &&
    config.topK >= 1 &&
    config.topK <= MAX_TOP_K,
  );
}
