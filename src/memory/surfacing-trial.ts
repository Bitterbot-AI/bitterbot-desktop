/**
 * PLAN-59 Phase 2, shadow stage: eligibility and assignment for proactive
 * surfacing, without changing what the owner sees.
 *
 * Phase 2 asks whether proactively surfacing autonomously learned information
 * is useful to the owner. Before any live trial can withhold anything, the
 * instrument has to run in shadow: every eligible surfacing opportunity is
 * logged (`eligible`), assigned to an arm by a randomised block design
 * (`assigned`), and then delivered exactly as today (`delivered`, carrying the
 * assigned arm label instead of `legacy`). The arm changes nothing here; it is
 * recorded so the live stage, when it is decided on separately, starts from a
 * design whose balance, carry-over and baseline retrieval rates are known.
 *
 * Design:
 * - Block id = floor(now / blockMinutes). The arm for (kind, block) is drawn
 *   from HMAC-SHA256(seed, kind, blockId): balanced in expectation, stratified
 *   by surface kind, and independent from one block to the next (randomised
 *   blocks, not alternation).
 * - Carry-over: an item (same kind and ref id) assigned within `carryOverDays`
 *   keeps its arm, so a repeated appearance is consistent within the window.
 * - Exemptions: content the owner explicitly asked for (`curiosity.ask`
 *   answers) and essential warnings are not opportunities and are never logged
 *   as eligible. Only the four optional proactive surfaces are hooked.
 * - Shadow crossover marker: an explicit owner retrieval (`memory_search`) of a
 *   chunk that a `withhold`-assigned opportunity surfaced within the carry-over
 *   window labels that opportunity `explicit_retrieval` / `shadow_crossover`.
 *   In shadow nothing was withheld, so this is the baseline rate at which such
 *   items are retrieved anyway, not a crossover from a withheld condition.
 *
 * The seed is the configured string or, absent one, an HMAC of a fixed label
 * under the node's evidence digest key: deterministic per node and not
 * reconstructible from the logged rows. Every write is best-effort through the
 * evidence writer; a failure is debug-logged and never reaches the surface.
 */

import { createHmac } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type {
  CuriositySurfacingTrialConfig,
  CuriositySurfacingTrialMode,
} from "./curiosity-types.js";
import type {
  EvidenceLogger,
  EvidenceTelemetry,
  RecordSurfacingInput,
} from "./evidence-telemetry.js";

const defaultLog = createSubsystemLogger("memory/surfacing-trial");

export type SurfacingArm = "surface" | "withhold";

/** The four optional proactive surfaces the shadow stage observes. */
export type SurfacingKind =
  | "curiosity_finding"
  | "proactive_recall"
  | "dream_brief"
  | "dream_digest";

export type ResolvedSurfacingTrialConfig = {
  mode: CuriositySurfacingTrialMode;
  blockMinutes: number;
  carryOverDays: number;
  /** Configured seed, or null to derive one from the node's digest key. */
  seed: string | null;
};

export const SURFACING_TRIAL_DEFAULTS: ResolvedSurfacingTrialConfig = {
  mode: "shadow",
  blockMinutes: 240,
  carryOverDays: 7,
  seed: null,
};

const MODES: readonly CuriositySurfacingTrialMode[] = ["off", "shadow"];
const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;
/** Only the `memory_search` caller is an explicit owner retrieval. */
export const EXPLICIT_RETRIEVAL_CALLER = "memory_search";
const SEED_LABEL = "plan59:surfacing-trial:seed";
const ARM_PENDING = "unassigned";

/**
 * Coerce the raw `memory.curiosity.evidence.surfacingTrial` value with the same
 * fallback style as `resolveEvidenceConfig`: a bad mode falls back to `shadow`
 * with a warning; non-positive or non-numeric durations fall back to defaults;
 * a seed is kept only when it is a non-empty string.
 */
export function resolveSurfacingTrialConfig(
  raw: unknown,
  log: EvidenceLogger = defaultLog,
): ResolvedSurfacingTrialConfig {
  const out = { ...SURFACING_TRIAL_DEFAULTS };
  if (!raw || typeof raw !== "object") {
    return out;
  }
  const r = raw as Record<string, unknown>;
  if (r.mode !== undefined) {
    if (typeof r.mode === "string" && (MODES as readonly string[]).includes(r.mode)) {
      out.mode = r.mode as CuriositySurfacingTrialMode;
    } else {
      log.warn(
        `memory.curiosity.evidence.surfacingTrial.mode ${JSON.stringify(r.mode)} is not one of ${MODES.join("|")}; using ${out.mode}`,
      );
    }
  }
  const block = Number(r.blockMinutes);
  if (r.blockMinutes !== undefined && Number.isFinite(block) && block > 0) {
    out.blockMinutes = block;
  }
  const carry = Number(r.carryOverDays);
  if (r.carryOverDays !== undefined && Number.isFinite(carry) && carry > 0) {
    out.carryOverDays = carry;
  }
  if (typeof r.seed === "string" && r.seed.trim().length > 0) {
    out.seed = r.seed;
  }
  return out;
}

/** The randomisation block an instant falls in. */
export function blockIdFor(now: number, blockMinutes: number): number {
  return Math.floor(now / (blockMinutes * MINUTE_MS));
}

/**
 * The arm for (kind, block): the first four bytes of
 * HMAC-SHA256(seed, "<kind>\n<blockId>") read as an unsigned integer, `surface`
 * when below 2^31 and `withhold` otherwise. Each block is an independent fair
 * draw; nothing about block n says anything about block n + 1.
 */
export function drawArm(seed: string, kind: string, blockId: number): SurfacingArm {
  const mac = createHmac("sha256", seed).update(`${kind}\n${blockId}`).digest();
  return mac.readUInt32BE(0) < 0x8000_0000 ? "surface" : "withhold";
}

export type SurfacingOpportunityInput = {
  /**
   * The delivered row's idempotency key (the Phase 0 event id, for example
   * `cf:<finding id>:<hour bucket>`). The eligible and assigned rows derive
   * theirs from it, so a repeated delivery in the same bucket is ignored as a
   * whole and never leaves a half-logged opportunity.
   */
  eventId: string;
  /** One of `SurfacingKind` for the hooked surfaces; open for later ones. */
  kind: string;
  refId: string;
  /**
   * Shared id of the opportunity across its three rows. Findings pass the
   * curiosity target id (the dismiss RPC labels by target id); other surfaces
   * leave it out and the event id serves.
   */
  opportunityId?: string;
  sessionKey?: string;
  costUsd?: number;
  now?: number;
};

export type SurfacingAssignment = {
  opportunityId: string;
  /** `legacy` when the trial is off (delivery is still recorded). */
  arm: SurfacingArm | "legacy";
  blockId: number | null;
  carryOver: boolean;
  /** True when eligible and assigned rows were written for this opportunity. */
  recorded: boolean;
};

export type SurfacingTrialKindStats = {
  eligible: number;
  assigned: number;
  surface: number;
  withhold: number;
  delivered: number;
  carryOver: number;
  crossover: number;
};

export type SurfacingTrialStats = {
  mode: CuriositySurfacingTrialMode;
  active: boolean;
  blockMinutes: number;
  carryOverDays: number;
  /** Distinct randomisation blocks in which an assignment was made. */
  blocks: number;
  byKind: Record<string, SurfacingTrialKindStats>;
  /** Share of assignments that drew `withhold`; null before any assignment. */
  balance: number | null;
};

export type ExplicitRetrievalInput = {
  chunkIds: readonly string[];
  caller?: string;
  now?: number;
};

type AssignedRow = { arm: string };
type CrossoverRow = { opportunity_id: string | null; event_id: string };

export class SurfacingTrial {
  private readonly telemetry: EvidenceTelemetry;
  private readonly cfg: ResolvedSurfacingTrialConfig;
  private readonly log: EvidenceLogger;
  private seed: string | null;
  private seedKeyOwner: DatabaseSync | null = null;

  constructor(
    telemetry: EvidenceTelemetry,
    config: ResolvedSurfacingTrialConfig | CuriositySurfacingTrialConfig | undefined,
    logger: EvidenceLogger = defaultLog,
  ) {
    this.telemetry = telemetry;
    this.log = logger;
    this.cfg = isResolved(config) ? config : resolveSurfacingTrialConfig(config, logger);
    this.seed = this.cfg.seed;
  }

  get mode(): CuriositySurfacingTrialMode {
    return this.cfg.mode;
  }

  get config(): ResolvedSurfacingTrialConfig {
    return { ...this.cfg };
  }

  /**
   * True when eligibility and assignment rows are written: the trial is in
   * shadow and the evidence layer is on with its tables present. The evidence
   * layer's `off` wins over the trial's own mode.
   */
  isActive(): boolean {
    return this.cfg.mode !== "off" && this.telemetry.isEnabled();
  }

  /**
   * Log one opportunity as `eligible` then `assigned`. Nothing is delivered
   * here; use `deliver` (or `surface` for all three). Inactive, it writes
   * nothing and returns a `legacy` assignment so the caller still records the
   * delivery as Phase 0 did.
   */
  assign(input: SurfacingOpportunityInput): SurfacingAssignment {
    return this.assignBatch([input])[0]!;
  }

  assignBatch(inputs: readonly SurfacingOpportunityInput[]): SurfacingAssignment[] {
    const out: SurfacingAssignment[] = [];
    const rows: RecordSurfacingInput[] = [];
    for (const input of inputs) {
      const plan = this.plan(input);
      out.push(plan.assignment);
      rows.push(...plan.rows);
    }
    if (rows.length > 0) {
      this.telemetry.recordSurfacingBatch(rows);
    }
    return out;
  }

  /** Record the delivery of an opportunity under its assigned arm. */
  deliver(input: SurfacingOpportunityInput, assignment: SurfacingAssignment): boolean {
    return this.telemetry.recordSurfacing(this.deliveredRow(input, assignment));
  }

  /** eligible, assigned and delivered for one opportunity, in one transaction. */
  surface(input: SurfacingOpportunityInput): SurfacingAssignment {
    return this.surfaceBatch([input])[0]!;
  }

  surfaceBatch(inputs: readonly SurfacingOpportunityInput[]): SurfacingAssignment[] {
    const out: SurfacingAssignment[] = [];
    const rows: RecordSurfacingInput[] = [];
    for (const input of inputs) {
      const plan = this.plan(input);
      out.push(plan.assignment);
      rows.push(...plan.rows, this.deliveredRow(input, plan.assignment));
    }
    if (rows.length > 0) {
      this.telemetry.recordSurfacingBatch(rows);
    }
    return out;
  }

  /**
   * Shadow crossover marker. For an explicit owner retrieval (`memory_search`
   * caller only), label every returned chunk that a `withhold`-assigned
   * opportunity surfaced within the carry-over window. Labels the opportunity's
   * delivered row (falling back to its assigned row) and never overwrites an
   * outcome the owner gave. Returns how many opportunities were labelled.
   */
  noteExplicitRetrieval(input: ExplicitRetrievalInput): number {
    if (
      input.caller !== EXPLICIT_RETRIEVAL_CALLER ||
      !this.isActive() ||
      input.chunkIds.length === 0
    ) {
      return 0;
    }
    const db = this.telemetry.connection();
    if (!db) {
      return 0;
    }
    const now = input.now ?? Date.now();
    const since = now - this.cfg.carryOverDays * DAY_MS;
    let labelled = 0;
    try {
      // A finding's delivered ref is the research_findings row; the chunk the
      // owner retrieves is the world_fact the same target produced, joined
      // through curiosity_findings. Proactive recall refs are chunk ids.
      const find = db.prepare(
        `SELECT a.opportunity_id, a.event_id FROM surfacing_events a
          WHERE a.stage = 'assigned' AND a.arm = 'withhold'
            AND a.created_at >= ? AND a.created_at <= ?
            AND (a.ref_id = ?
                 OR (a.kind = 'curiosity_finding' AND a.opportunity_id IN
                       (SELECT target_id FROM curiosity_findings WHERE chunk_id = ?)))
          ORDER BY a.created_at DESC, a.id DESC LIMIT 1`,
      );
      const delivered = db.prepare(
        `SELECT event_id FROM surfacing_events
          WHERE opportunity_id = ? AND stage = 'delivered'
          ORDER BY created_at DESC, id DESC LIMIT 1`,
      );
      const seen = new Set<string>();
      for (const chunkId of input.chunkIds) {
        const hit = find.get(since, now, chunkId, chunkId) as CrossoverRow | undefined;
        if (!hit || !hit.opportunity_id || seen.has(hit.opportunity_id)) {
          continue;
        }
        seen.add(hit.opportunity_id);
        const target =
          (delivered.get(hit.opportunity_id) as { event_id: string } | undefined)?.event_id ??
          hit.event_id;
        if (
          this.telemetry.recordSurfacingOutcome({
            eventId: target,
            outcome: "explicit_retrieval",
            provenance: "shadow_crossover",
            onlyIfUnlabelled: true,
            now,
          })
        ) {
          labelled++;
        }
      }
    } catch (err) {
      this.log.debug(`crossover marker failed: ${String(err)}`);
    }
    return labelled;
  }

  stats(): SurfacingTrialStats {
    const out: SurfacingTrialStats = {
      mode: this.cfg.mode,
      active: this.isActive(),
      blockMinutes: this.cfg.blockMinutes,
      carryOverDays: this.cfg.carryOverDays,
      blocks: 0,
      byKind: {},
      balance: null,
    };
    const db = this.telemetry.connection();
    if (!db) {
      return out;
    }
    try {
      const rows = db
        .prepare(
          `SELECT kind,
                  SUM(stage = 'eligible') AS eligible,
                  SUM(stage = 'assigned') AS assigned,
                  SUM(stage = 'assigned' AND arm = 'surface') AS surface,
                  SUM(stage = 'assigned' AND arm = 'withhold') AS withhold,
                  SUM(stage = 'delivered' AND arm IN ('surface', 'withhold')) AS delivered,
                  SUM(stage = 'assigned'
                      AND json_valid(details_json)
                      AND json_extract(details_json, '$.carryOver') = 1) AS carryOver,
                  SUM(label_provenance = 'shadow_crossover') AS crossover
             FROM surfacing_events
            WHERE stage IN ('eligible', 'assigned') OR arm IN ('surface', 'withhold')
            GROUP BY kind ORDER BY kind`,
        )
        .all() as unknown as Array<
        { kind: string } & Record<keyof SurfacingTrialKindStats, number>
      >;
      let assigned = 0;
      let withhold = 0;
      for (const r of rows) {
        out.byKind[r.kind] = {
          eligible: Number(r.eligible),
          assigned: Number(r.assigned),
          surface: Number(r.surface),
          withhold: Number(r.withhold),
          delivered: Number(r.delivered),
          carryOver: Number(r.carryOver),
          crossover: Number(r.crossover),
        };
        assigned += Number(r.assigned);
        withhold += Number(r.withhold);
      }
      out.balance = assigned > 0 ? withhold / assigned : null;
      const blocks = db
        .prepare(
          `SELECT COUNT(DISTINCT json_extract(details_json, '$.blockId')) AS c
             FROM surfacing_events
            WHERE stage = 'assigned' AND json_valid(details_json)`,
        )
        .get() as { c: number } | undefined;
      out.blocks = Number(blocks?.c ?? 0);
    } catch (err) {
      this.log.debug(`stats failed: ${String(err)}`);
    }
    return out;
  }

  // ── internals ──

  private plan(input: SurfacingOpportunityInput): {
    assignment: SurfacingAssignment;
    rows: RecordSurfacingInput[];
  } {
    const opportunityId = input.opportunityId ?? input.eventId;
    const now = input.now ?? Date.now();
    if (!this.isActive()) {
      return {
        assignment: {
          opportunityId,
          arm: "legacy",
          blockId: null,
          carryOver: false,
          recorded: false,
        },
        rows: [],
      };
    }
    const seed = this.ensureSeed();
    if (!seed) {
      return {
        assignment: {
          opportunityId,
          arm: "legacy",
          blockId: null,
          carryOver: false,
          recorded: false,
        },
        rows: [],
      };
    }
    const blockId = blockIdFor(now, this.cfg.blockMinutes);
    const carried = this.carriedArm(input.kind, input.refId, now);
    const arm: SurfacingArm = carried ?? drawArm(seed, input.kind, blockId);
    const common = {
      kind: input.kind,
      refId: input.refId,
      opportunityId,
      sessionKey: input.sessionKey,
      costUsd: input.costUsd,
      now,
    };
    return {
      assignment: { opportunityId, arm, blockId, carryOver: carried !== null, recorded: true },
      rows: [
        { ...common, eventId: `eligible:${input.eventId}`, stage: "eligible", arm: ARM_PENDING },
        {
          ...common,
          eventId: `assigned:${input.eventId}`,
          stage: "assigned",
          arm,
          details: {
            blockId,
            blockMinutes: this.cfg.blockMinutes,
            carryOver: carried !== null,
          },
        },
      ],
    };
  }

  private deliveredRow(
    input: SurfacingOpportunityInput,
    assignment: SurfacingAssignment,
  ): RecordSurfacingInput {
    return {
      eventId: input.eventId,
      kind: input.kind,
      refId: input.refId,
      opportunityId: assignment.opportunityId,
      arm: assignment.arm,
      sessionKey: input.sessionKey,
      costUsd: input.costUsd,
      stage: "delivered",
      now: input.now,
    };
  }

  /** The arm of the most recent assignment of (kind, refId) inside the carry-over window. */
  private carriedArm(kind: string, refId: string, now: number): SurfacingArm | null {
    const db = this.telemetry.connection();
    if (!db) {
      return null;
    }
    try {
      const row = db
        .prepare(
          `SELECT arm FROM surfacing_events
            WHERE ref_id = ? AND stage = 'assigned' AND kind = ?
              AND created_at >= ? AND created_at <= ?
            ORDER BY created_at DESC, id DESC LIMIT 1`,
        )
        .get(refId, kind, now - this.cfg.carryOverDays * DAY_MS, now) as AssignedRow | undefined;
      return row?.arm === "surface" || row?.arm === "withhold" ? row.arm : null;
    } catch (err) {
      this.log.debug(`carry-over lookup failed: ${String(err)}`);
      return null;
    }
  }

  /**
   * The configured seed, or one derived once per connection from the node's
   * digest key. Re-derived after a database swap (same key, same seed).
   */
  private ensureSeed(): string | null {
    if (this.cfg.seed) {
      return this.cfg.seed;
    }
    const db = this.telemetry.connection();
    if (this.seed && this.seedKeyOwner === db) {
      return this.seed;
    }
    const derived = this.telemetry.digest(SEED_LABEL);
    if (!derived) {
      return null;
    }
    this.seed = derived;
    this.seedKeyOwner = db;
    return derived;
  }
}

function isResolved(
  config: ResolvedSurfacingTrialConfig | CuriositySurfacingTrialConfig | undefined,
): config is ResolvedSurfacingTrialConfig {
  return Boolean(
    config &&
    typeof config.mode === "string" &&
    (MODES as readonly string[]).includes(config.mode) &&
    typeof config.blockMinutes === "number" &&
    Number.isFinite(config.blockMinutes) &&
    config.blockMinutes > 0 &&
    typeof config.carryOverDays === "number" &&
    Number.isFinite(config.carryOverDays) &&
    config.carryOverDays > 0 &&
    "seed" in config &&
    (config.seed === null || typeof config.seed === "string"),
  );
}
