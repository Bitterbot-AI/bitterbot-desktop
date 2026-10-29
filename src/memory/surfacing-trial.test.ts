/**
 * PLAN-59 Phase 2 shadow stage: the surfacing trial's config, arm draw,
 * assignment rows, carry-over, crossover marker, off switches and stats.
 *
 * Synthetic databases only (the migration chain on a scratch file or
 * in-memory); no owner data, no LLM or embedding calls.
 */

import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { EvidenceTelemetry } from "./evidence-telemetry.js";
import { ensureMemoryIndexSchema } from "./memory-schema.js";
import { LATEST_SCHEMA_VERSION, runMigrations } from "./migrations.js";
import {
  blockIdFor,
  drawArm,
  resolveSurfacingTrialConfig,
  SURFACING_TRIAL_DEFAULTS,
  SurfacingTrial,
  type SurfacingArm,
} from "./surfacing-trial.js";

const quiet = { debug: () => {}, warn: () => {} };

function openDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  ensureMemoryIndexSchema({
    db,
    embeddingCacheTable: "embedding_cache",
    ftsTable: "chunks_fts",
    ftsEnabled: false,
  });
  runMigrations(db);
  return db;
}

type Row = {
  id: number;
  event_id: string;
  kind: string;
  ref_id: string | null;
  arm: string;
  opportunity_id: string | null;
  session_digest: string | null;
  stage: string;
  outcome: string | null;
  label_provenance: string | null;
  details_json: string | null;
  created_at: number;
};

const rows = (db: DatabaseSync, where = "1 = 1"): Row[] =>
  db.prepare(`SELECT * FROM surfacing_events WHERE ${where} ORDER BY id`).all() as unknown as Row[];

const count = (db: DatabaseSync, where = "1 = 1"): number =>
  Number(
    (db.prepare(`SELECT COUNT(*) AS c FROM surfacing_events WHERE ${where}`).get() as { c: number })
      .c,
  );

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const T0 = Date.UTC(2026, 9, 29, 12, 0, 0);
const BLOCK_MIN = 240;

/** The first instant at or after `from`, stepping whole blocks, whose fresh draw is `arm`. */
function instantDrawing(
  seed: string,
  kind: string,
  arm: SurfacingArm,
  from: number,
  blockMinutes = BLOCK_MIN,
): number {
  for (let i = 0; i < 64; i++) {
    const t = from + i * blockMinutes * 60_000;
    if (drawArm(seed, kind, blockIdFor(t, blockMinutes)) === arm) {
      return t;
    }
  }
  throw new Error("no block drew the wanted arm in 64 tries");
}

function openTrial(
  evidenceMode: "off" | "observe" | "shadow" = "shadow",
  trial: Record<string, unknown> = {},
) {
  const db = openDb();
  const telemetry = new EvidenceTelemetry(db, { mode: evidenceMode }, quiet);
  const t = new SurfacingTrial(telemetry, resolveSurfacingTrialConfig(trial, quiet), quiet);
  return { db, telemetry, trial: t };
}

describe("resolveSurfacingTrialConfig", () => {
  it("defaults to shadow, 240-minute blocks, 7-day carry-over and a derived seed", () => {
    expect(SURFACING_TRIAL_DEFAULTS).toEqual({
      mode: "shadow",
      blockMinutes: 240,
      carryOverDays: 7,
      seed: null,
    });
    expect(resolveSurfacingTrialConfig(undefined, quiet)).toEqual(SURFACING_TRIAL_DEFAULTS);
    expect(resolveSurfacingTrialConfig({}, quiet)).toEqual(SURFACING_TRIAL_DEFAULTS);
    expect(resolveSurfacingTrialConfig("shadow", quiet)).toEqual(SURFACING_TRIAL_DEFAULTS);
  });

  it("accepts off and shadow, the two durations and a non-empty seed", () => {
    expect(resolveSurfacingTrialConfig({ mode: "off" }, quiet).mode).toBe("off");
    expect(
      resolveSurfacingTrialConfig({ blockMinutes: 60, carryOverDays: 3, seed: "abc" }, quiet),
    ).toEqual({ mode: "shadow", blockMinutes: 60, carryOverDays: 3, seed: "abc" });
    expect(resolveSurfacingTrialConfig({ blockMinutes: "90" }, quiet).blockMinutes).toBe(90);
  });

  it("falls back on a bad mode (with a warning), non-positive numbers and an empty seed", () => {
    const warnings: string[] = [];
    const log = { debug: () => {}, warn: (m: string) => warnings.push(m) };
    // `live` is deliberately not accepted yet: the withhold condition is its own PR.
    expect(resolveSurfacingTrialConfig({ mode: "live" }, log).mode).toBe("shadow");
    expect(resolveSurfacingTrialConfig({ mode: 3 }, log).mode).toBe("shadow");
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain("surfacingTrial.mode");
    expect(
      resolveSurfacingTrialConfig({ blockMinutes: 0, carryOverDays: -1, seed: "  " }, log),
    ).toEqual(SURFACING_TRIAL_DEFAULTS);
    expect(resolveSurfacingTrialConfig({ blockMinutes: "x", carryOverDays: NaN }, log)).toEqual(
      SURFACING_TRIAL_DEFAULTS,
    );
  });
});

describe("arm draw", () => {
  it("is deterministic in (seed, kind, block) and changes with each of them", () => {
    const a = drawArm("seed-a", "proactive_recall", 1234);
    expect(drawArm("seed-a", "proactive_recall", 1234)).toBe(a);
    const differsIn = (f: (i: number) => SurfacingArm) => {
      for (let i = 0; i < 64; i++) {
        if (f(i) !== drawArm("seed-a", "proactive_recall", i)) {
          return true;
        }
      }
      return false;
    };
    expect(differsIn((i) => drawArm("seed-b", "proactive_recall", i))).toBe(true);
    expect(differsIn((i) => drawArm("seed-a", "dream_brief", i))).toBe(true);
    expect(blockIdFor(T0, 240)).toBe(Math.floor(T0 / (240 * 60_000)));
    expect(blockIdFor(T0 + 239 * 60_000, 240)).toBe(blockIdFor(T0, 240));
    expect(blockIdFor(T0 + 240 * 60_000, 240)).toBe(blockIdFor(T0, 240) + 1);
  });

  it("is balanced over 2,000 consecutive blocks for every kind (45 to 55 percent withhold)", () => {
    for (const kind of ["curiosity_finding", "proactive_recall", "dream_brief", "dream_digest"]) {
      let withhold = 0;
      for (let b = 0; b < 2000; b++) {
        if (drawArm("balance-seed", kind, 58_000 + b) === "withhold") {
          withhold++;
        }
      }
      expect(withhold / 2000).toBeGreaterThanOrEqual(0.45);
      expect(withhold / 2000).toBeLessThanOrEqual(0.55);
    }
  });

  it("consecutive blocks are independent draws, not an alternation", () => {
    let same = 0;
    let prev = drawArm("indep-seed", "proactive_recall", 0);
    for (let b = 1; b <= 2000; b++) {
      const cur = drawArm("indep-seed", "proactive_recall", b);
      if (cur === prev) {
        same++;
      }
      prev = cur;
    }
    // An alternation would give 0 equal neighbours; a constant would give 2000.
    expect(same / 2000).toBeGreaterThanOrEqual(0.4);
    expect(same / 2000).toBeLessThanOrEqual(0.6);
  });
});

describe("SurfacingTrial assignment", () => {
  it("the migration adds details_json and the opportunity index", () => {
    const db = openDb();
    expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(80);
    const cols = (
      db.prepare(`PRAGMA table_info(surfacing_events)`).all() as Array<{ name: string }>
    ).map((c) => c.name);
    expect(cols).toContain("details_json");
    const idx = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'surfacing_events'`,
      )
      .all() as Array<{ name: string }>;
    expect(idx.map((i) => i.name)).toContain("idx_surfacing_events_opportunity");
  });

  it("logs eligible before assigned with the same opportunity id, kind, ref and session digest", () => {
    const { db, trial } = openTrial("shadow", { seed: "s" });
    const a = trial.assign({
      eventId: "cf:f1:1",
      kind: "curiosity_finding",
      refId: "f1",
      opportunityId: "target-1",
      sessionKey: "agent:main:s1",
      now: T0,
    });
    expect(a).toMatchObject({
      opportunityId: "target-1",
      blockId: blockIdFor(T0, 240),
      carryOver: false,
      recorded: true,
    });
    expect(["surface", "withhold"]).toContain(a.arm);
    expect(a.arm).toBe(drawArm("s", "curiosity_finding", blockIdFor(T0, 240)));
    const all = rows(db);
    expect(all.map((r) => r.stage)).toEqual(["eligible", "assigned"]);
    expect(all[0]!.id).toBeLessThan(all[1]!.id);
    expect(all[0]!.created_at).toBeLessThanOrEqual(all[1]!.created_at);
    for (const r of all) {
      expect(r).toMatchObject({
        kind: "curiosity_finding",
        ref_id: "f1",
        opportunity_id: "target-1",
        outcome: null,
      });
      expect(r.session_digest).toMatch(/^[0-9a-f]{32}$/);
    }
    expect(all[0]!.session_digest).toBe(all[1]!.session_digest);
    // the eligible row carries no arm (assignment has not happened yet)
    expect(all[0]!.arm).toBe("unassigned");
    expect(all[0]!.details_json).toBeNull();
    expect(all[1]!.arm).toBe(a.arm);
    expect(JSON.parse(all[1]!.details_json!)).toEqual({
      blockId: blockIdFor(T0, 240),
      blockMinutes: 240,
      carryOver: false,
    });
    // nothing was delivered by assign alone
    expect(count(db, "stage = 'delivered'")).toBe(0);
  });

  it("surface writes eligible, assigned and delivered, delivered carries the arm, repeats are ignored whole", () => {
    const { db, trial } = openTrial("shadow", { seed: "s" });
    const a = trial.surface({
      eventId: "pr:c1:100",
      kind: "proactive_recall",
      refId: "c1",
      sessionKey: "k",
      now: T0,
    });
    const all = rows(db);
    expect(all.map((r) => r.stage)).toEqual(["eligible", "assigned", "delivered"]);
    expect(all.map((r) => r.event_id)).toEqual([
      "eligible:pr:c1:100",
      "assigned:pr:c1:100",
      "pr:c1:100",
    ]);
    // without a caller-supplied opportunity id the event id is the opportunity
    expect(all.every((r) => r.opportunity_id === "pr:c1:100")).toBe(true);
    expect(all[2]!.arm).toBe(a.arm);
    expect(all[2]!.arm).not.toBe("legacy");
    expect(all[1]!.arm).toBe(all[2]!.arm);
    // same bucket again: the whole opportunity is a duplicate
    trial.surface({ eventId: "pr:c1:100", kind: "proactive_recall", refId: "c1", now: T0 + 1 });
    expect(count(db)).toBe(3);
    // a batch keeps per-opportunity order
    trial.surfaceBatch([
      { eventId: "pr:c2:100", kind: "proactive_recall", refId: "c2", now: T0 },
      { eventId: "pr:c3:100", kind: "proactive_recall", refId: "c3", now: T0 },
    ]);
    expect(rows(db).map((r) => `${r.stage}:${r.ref_id}`)).toEqual([
      "eligible:c1",
      "assigned:c1",
      "delivered:c1",
      "eligible:c2",
      "assigned:c2",
      "delivered:c2",
      "eligible:c3",
      "assigned:c3",
      "delivered:c3",
    ]);
  });

  it("reuses the arm of an assignment inside the carry-over window and draws fresh outside it", () => {
    const seed = "carry";
    const { db, trial } = openTrial("shadow", { seed, carryOverDays: 7 });
    const t1 = instantDrawing(seed, "proactive_recall", "withhold", T0);
    const first = trial.surface({
      eventId: `pr:c1:${Math.floor(t1 / HOUR)}`,
      kind: "proactive_recall",
      refId: "c1",
      now: t1,
    });
    expect(first.arm).toBe("withhold");
    expect(first.carryOver).toBe(false);
    // a later block within the window whose fresh draw would be `surface`
    const t2 = instantDrawing(seed, "proactive_recall", "surface", t1 + BLOCK_MIN * 60_000);
    expect(t2 - t1).toBeLessThan(7 * DAY);
    const second = trial.surface({
      eventId: `pr:c1:${Math.floor(t2 / HOUR)}`,
      kind: "proactive_recall",
      refId: "c1",
      now: t2,
    });
    expect(second.arm).toBe("withhold");
    expect(second.carryOver).toBe(true);
    const assigned = rows(db, "stage = 'assigned'");
    expect(JSON.parse(assigned[1]!.details_json!).carryOver).toBe(true);
    // a different item in the same block is not carried
    const other = trial.surface({
      eventId: `pr:c9:${Math.floor(t2 / HOUR)}`,
      kind: "proactive_recall",
      refId: "c9",
      now: t2,
    });
    expect(other.carryOver).toBe(false);
    expect(other.arm).toBe("surface");
    // the same ref under another kind is not carried either (stratified by kind)
    const otherKind = trial.surface({
      eventId: `db:c1:${Math.floor(t2 / HOUR)}`,
      kind: "dream_brief",
      refId: "c1",
      now: t2,
    });
    expect(otherKind.carryOver).toBe(false);
    // past the window: a fresh draw
    const t3 = instantDrawing(seed, "proactive_recall", "surface", t2 + 7 * DAY + HOUR);
    const third = trial.surface({
      eventId: `pr:c1:${Math.floor(t3 / HOUR)}`,
      kind: "proactive_recall",
      refId: "c1",
      now: t3,
    });
    expect(third.carryOver).toBe(false);
    expect(third.arm).toBe("surface");
  });

  it("the dismiss outcome still labels the delivered row of the finding's target, not eligible or assigned", () => {
    const { db, telemetry, trial } = openTrial("shadow", { seed: "s" });
    trial.surfaceBatch([
      { eventId: "cf:f1:1", kind: "curiosity_finding", refId: "f1", opportunityId: "t1", now: T0 },
      { eventId: "cf:f2:1", kind: "curiosity_finding", refId: "f2", opportunityId: "t2", now: T0 },
    ]);
    expect(
      telemetry.recordSurfacingOutcome({
        refId: "t1",
        outcome: "dismissed",
        provenance: "explicit",
        kind: "curiosity_target",
        now: T0 + 1,
      }),
    ).toBe(true);
    const labelled = rows(db, "outcome IS NOT NULL");
    expect(labelled).toHaveLength(1);
    expect(labelled[0]).toMatchObject({
      event_id: "cf:f1:1",
      stage: "delivered",
      outcome: "dismissed",
      label_provenance: "explicit",
    });
    expect(labelled[0]!.arm).not.toBe("legacy");
    expect(count(db, "stage = 'responded'")).toBe(0);
    // a target that was never delivered still gets its responded row
    telemetry.recordSurfacingOutcome({
      refId: "t-none",
      outcome: "dismissed",
      provenance: "explicit",
      kind: "curiosity_target",
    });
    expect(count(db, "stage = 'responded' AND ref_id = 't-none'")).toBe(1);
  });
});

describe("shadow crossover marker", () => {
  function withholdAt(seed: string, kind: string, from: number) {
    return instantDrawing(seed, kind, "withhold", from);
  }

  it("labels a withhold-assigned opportunity on an explicit memory_search of its chunk, inside the window only", () => {
    const seed = "x";
    const { db, trial } = openTrial("shadow", { seed, carryOverDays: 7 });
    const t = withholdAt(seed, "proactive_recall", T0);
    trial.surface({ eventId: "pr:c1:1", kind: "proactive_recall", refId: "c1", now: t });
    // wrong caller: nothing
    expect(
      trial.noteExplicitRetrieval({ chunkIds: ["c1"], caller: "deep_recall", now: t + 1 }),
    ).toBe(0);
    expect(trial.noteExplicitRetrieval({ chunkIds: ["c1"], now: t + 1 })).toBe(0);
    // unrelated chunk: nothing
    expect(
      trial.noteExplicitRetrieval({ chunkIds: ["c-other"], caller: "memory_search", now: t + 1 }),
    ).toBe(0);
    // the right caller inside the window labels the delivered row
    expect(
      trial.noteExplicitRetrieval({
        chunkIds: ["c-other", "c1"],
        caller: "memory_search",
        now: t + HOUR,
      }),
    ).toBe(1);
    const labelled = rows(db, "outcome IS NOT NULL");
    expect(labelled).toHaveLength(1);
    expect(labelled[0]).toMatchObject({
      event_id: "pr:c1:1",
      stage: "delivered",
      arm: "withhold",
      outcome: "explicit_retrieval",
      label_provenance: "shadow_crossover",
    });
    // a second retrieval does not relabel (idempotent, still one labelled row)
    expect(
      trial.noteExplicitRetrieval({ chunkIds: ["c1"], caller: "memory_search", now: t + 2 * HOUR }),
    ).toBe(0);
    expect(count(db, "outcome IS NOT NULL")).toBe(1);
    // past the carry-over window: a fresh opportunity would be needed
    const t2 = withholdAt(seed, "proactive_recall", T0 + 30 * DAY);
    trial.surface({ eventId: "pr:c2:2", kind: "proactive_recall", refId: "c2", now: t2 });
    expect(
      trial.noteExplicitRetrieval({
        chunkIds: ["c2"],
        caller: "memory_search",
        now: t2 + 7 * DAY + HOUR,
      }),
    ).toBe(0);
  });

  it("ignores surface-assigned items and never overwrites an owner's label", () => {
    const seed = "y";
    const { db, telemetry, trial } = openTrial("shadow", { seed });
    const tS = instantDrawing(seed, "proactive_recall", "surface", T0);
    trial.surface({ eventId: "pr:s1:1", kind: "proactive_recall", refId: "s1", now: tS });
    expect(
      trial.noteExplicitRetrieval({ chunkIds: ["s1"], caller: "memory_search", now: tS + 1 }),
    ).toBe(0);
    const tW = withholdAt(seed, "proactive_recall", T0);
    trial.surface({ eventId: "pr:w1:1", kind: "proactive_recall", refId: "w1", now: tW });
    telemetry.recordSurfacingOutcome({
      eventId: "pr:w1:1",
      outcome: "dismissed",
      provenance: "explicit",
      now: tW + 1,
    });
    expect(
      trial.noteExplicitRetrieval({ chunkIds: ["w1"], caller: "memory_search", now: tW + 2 }),
    ).toBe(0);
    expect(rows(db, "event_id = 'pr:w1:1'")[0]).toMatchObject({
      outcome: "dismissed",
      label_provenance: "explicit",
    });
  });

  it("reaches a curiosity finding through the chunk its target produced", () => {
    const seed = "z";
    const { db, trial } = openTrial("shadow", { seed });
    db.prepare(
      `INSERT INTO curiosity_findings
         (id, target_id, question, query_phrase, answer, confidence, chunk_id, created_at)
       VALUES ('cfind-1', 'target-7', 'q', 'q', 'a', 0.9, 'chunk-77', ?)`,
    ).run(T0);
    const t = withholdAt(seed, "curiosity_finding", T0);
    trial.surface({
      eventId: "cf:rf-1:1",
      kind: "curiosity_finding",
      refId: "rf-1",
      opportunityId: "target-7",
      now: t,
    });
    expect(
      trial.noteExplicitRetrieval({ chunkIds: ["chunk-77"], caller: "memory_search", now: t + 1 }),
    ).toBe(1);
    expect(rows(db, "event_id = 'cf:rf-1:1'")[0]).toMatchObject({
      outcome: "explicit_retrieval",
      label_provenance: "shadow_crossover",
    });
  });
});

describe("switches, seed and stats", () => {
  it("evidence off writes nothing in any trial mode; trial off writes delivered rows with the legacy arm", () => {
    const off = openTrial("off", { mode: "shadow", seed: "s" });
    expect(off.trial.isActive()).toBe(false);
    const a = off.trial.surface({
      eventId: "pr:c1:1",
      kind: "proactive_recall",
      refId: "c1",
      now: T0,
    });
    expect(a).toMatchObject({ arm: "legacy", recorded: false, carryOver: false, blockId: null });
    expect(
      off.trial.assign({ eventId: "pr:c2:1", kind: "proactive_recall", refId: "c2" }).recorded,
    ).toBe(false);
    expect(off.trial.noteExplicitRetrieval({ chunkIds: ["c1"], caller: "memory_search" })).toBe(0);
    expect(count(off.db)).toBe(0);
    expect(off.trial.stats()).toMatchObject({
      mode: "shadow",
      active: false,
      blocks: 0,
      balance: null,
    });

    const trialOff = openTrial("observe", { mode: "off" });
    expect(trialOff.trial.isActive()).toBe(false);
    const b = trialOff.trial.surface({
      eventId: "pr:c1:1",
      kind: "proactive_recall",
      refId: "c1",
      now: T0,
    });
    expect(b.arm).toBe("legacy");
    expect(rows(trialOff.db).map((r) => `${r.stage}:${r.arm}`)).toEqual(["delivered:legacy"]);
    expect(
      trialOff.trial.noteExplicitRetrieval({ chunkIds: ["c1"], caller: "memory_search" }),
    ).toBe(0);
  });

  it("derives a per-node seed from the digest key when none is configured, and never stores it", () => {
    const db = openDb();
    const telemetry = new EvidenceTelemetry(db, { mode: "shadow" }, quiet);
    const t1 = new SurfacingTrial(telemetry, {}, quiet);
    const t2 = new SurfacingTrial(telemetry, {}, quiet);
    const arms1: string[] = [];
    const arms2: string[] = [];
    for (let i = 0; i < 12; i++) {
      const now = T0 + i * BLOCK_MIN * 60_000;
      arms1.push(t1.assign({ eventId: `a:${i}`, kind: "dream_brief", refId: `r${i}`, now }).arm);
      arms2.push(t2.assign({ eventId: `b:${i}`, kind: "dream_brief", refId: `q${i}`, now }).arm);
    }
    expect(arms2).toEqual(arms1);
    expect(new Set(arms1).size).toBeGreaterThan(1);
    // the configured seed takes precedence and is a different sequence from the derived one
    const t3 = new SurfacingTrial(telemetry, { seed: "configured" }, quiet);
    const arms3 = Array.from(
      { length: 12 },
      (_, i) =>
        t3.assign({
          eventId: `c:${i}`,
          kind: "dream_brief",
          refId: `p${i}`,
          now: T0 + i * BLOCK_MIN * 60_000,
        }).arm,
    );
    expect(arms3).toEqual(
      Array.from({ length: 12 }, (_, i) =>
        drawArm("configured", "dream_brief", blockIdFor(T0 + i * BLOCK_MIN * 60_000, BLOCK_MIN)),
      ),
    );
    // neither the digest key nor the derived seed appears in any row
    const key = (
      db.prepare(`SELECT value FROM evidence_meta WHERE key = 'digest_key'`).get() as {
        value: string;
      }
    ).value;
    const derived = telemetry.digest("plan59:surfacing-trial:seed")!;
    const dump = JSON.stringify(rows(db));
    expect(dump).not.toContain(key);
    expect(dump).not.toContain(derived);
    expect(dump).not.toContain("configured");
  });

  it("a database without the tables makes the trial inert and never throws", () => {
    const db = new DatabaseSync(":memory:");
    const telemetry = new EvidenceTelemetry(db, { mode: "shadow" }, quiet);
    const trial = new SurfacingTrial(telemetry, {}, quiet);
    expect(trial.isActive()).toBe(false);
    expect(trial.surface({ eventId: "e", kind: "dream_digest", refId: "r" }).arm).toBe("legacy");
    expect(trial.noteExplicitRetrieval({ chunkIds: ["r"], caller: "memory_search" })).toBe(0);
    expect(trial.stats()).toMatchObject({ active: false, blocks: 0, byKind: {}, balance: null });
  });

  it("stats match COUNT(*) per kind, the block count and the withhold share", () => {
    const seed = "stats";
    const { db, telemetry, trial } = openTrial("shadow", { seed, blockMinutes: 60 });
    // 6 recall opportunities over 6 hourly blocks, one of them a carry-over repeat
    for (let i = 0; i < 6; i++) {
      trial.surface({
        eventId: `pr:c${i}:${i}`,
        kind: "proactive_recall",
        refId: i === 5 ? "c0" : `c${i}`,
        now: T0 + i * HOUR,
      });
    }
    // 2 findings in one block, one later dismissed
    trial.surfaceBatch([
      { eventId: "cf:f1:0", kind: "curiosity_finding", refId: "f1", opportunityId: "t1", now: T0 },
      { eventId: "cf:f2:0", kind: "curiosity_finding", refId: "f2", opportunityId: "t2", now: T0 },
    ]);
    telemetry.recordSurfacingOutcome({ refId: "t1", outcome: "dismissed", provenance: "explicit" });
    // a legacy delivered row (Phase 0 data) is not counted under the trial
    telemetry.recordSurfacing({
      eventId: "legacy:1",
      kind: "dream_digest",
      refId: "d",
      stage: "delivered",
    });
    // one digest assigned but not (yet) delivered
    trial.assign({ eventId: "dd:k", kind: "dream_digest", refId: "k", now: T0 });

    const s = trial.stats();
    const n = (where: string) => count(db, where);
    expect(s.byKind.proactive_recall).toEqual({
      eligible: n("kind = 'proactive_recall' AND stage = 'eligible'"),
      assigned: n("kind = 'proactive_recall' AND stage = 'assigned'"),
      surface: n("kind = 'proactive_recall' AND stage = 'assigned' AND arm = 'surface'"),
      withhold: n("kind = 'proactive_recall' AND stage = 'assigned' AND arm = 'withhold'"),
      delivered: n("kind = 'proactive_recall' AND stage = 'delivered' AND arm != 'legacy'"),
      carryOver: n(
        "kind = 'proactive_recall' AND stage = 'assigned' AND json_extract(details_json, '$.carryOver') = 1",
      ),
      crossover: 0,
    });
    expect(s.byKind.proactive_recall.eligible).toBe(6);
    expect(s.byKind.proactive_recall.assigned).toBe(6);
    expect(s.byKind.proactive_recall.surface + s.byKind.proactive_recall.withhold).toBe(6);
    expect(s.byKind.proactive_recall.delivered).toBe(6);
    expect(s.byKind.proactive_recall.carryOver).toBe(1);
    expect(s.byKind.curiosity_finding).toMatchObject({ eligible: 2, assigned: 2, delivered: 2 });
    expect(s.byKind.dream_digest).toMatchObject({ eligible: 1, assigned: 1, delivered: 0 });
    expect(Object.keys(s.byKind).toSorted()).toEqual([
      "curiosity_finding",
      "dream_digest",
      "proactive_recall",
    ]);
    const assignedAll = n("stage = 'assigned'");
    const withholdAll = n("stage = 'assigned' AND arm = 'withhold'");
    expect(assignedAll).toBe(9);
    expect(s.balance).toBe(withholdAll / assignedAll);
    expect(s.blocks).toBe(
      Number(
        (
          db
            .prepare(
              `SELECT COUNT(DISTINCT json_extract(details_json, '$.blockId')) AS c
                 FROM surfacing_events WHERE stage = 'assigned'`,
            )
            .get() as { c: number }
        ).c,
      ),
    );
    expect(s.blocks).toBe(6);
    expect(s).toMatchObject({ mode: "shadow", active: true, blockMinutes: 60, carryOverDays: 7 });
    // the crossover counter follows the marker
    const tW = instantDrawing(seed, "dream_brief", "withhold", T0, 60);
    trial.surface({ eventId: "db:b1:1", kind: "dream_brief", refId: "b1", now: tW });
    trial.noteExplicitRetrieval({ chunkIds: ["b1"], caller: "memory_search", now: tW + 1 });
    expect(trial.stats().byKind.dream_brief.crossover).toBe(1);
  });
});
