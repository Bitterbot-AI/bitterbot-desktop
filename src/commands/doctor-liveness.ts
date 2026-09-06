/**
 * Artifact-liveness doctor section (born from the 2026-08-09 wired-but-dead
 * audit, docs/reviews/wired-but-dead-audit-2026-08-09.md).
 *
 * The defect class this section exists for: a loop runs on schedule, throws
 * nothing, and its OUTPUT artifact never appears — the skills economy and
 * curiosity loop were structurally dead end-to-end for months this way, and
 * unit tests camouflaged it (three of the audit fixes broke tests that
 * asserted the bug). These checks assert on the artifacts themselves, so a
 * regression is self-announcing instead of silent:
 *
 *   - skill crystals born uncategorized      (F3/F12 — creation-path leak)
 *   - guard chain that has never fired       (F4  — interceptor bindings)
 *   - peer trust that can never graduate     (F6  — review decisions absent)
 *   - curiosity targets that never resolve   (F9  — loop never closes)
 *   - progress keyed to dead region ids      (F8  — region identity churn)
 *   - doubled execution telemetry            (F2  — hook double-fire)
 *   - mature skills that never publish       (F5  — propagation dead)
 *   - dream modes that run but never yield   (the 11-of-12-silent lead)
 *
 * Severity contract: warn/info ONLY. A dead loop is degraded-but-usable
 * operator-attention state, never "this node must not receive an update" —
 * so nothing here may ever gate the update handoff.
 */

import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { BitterbotConfig } from "../config/config.js";
import { runEvidenceWhere } from "../memory/skill-execution-tracker.js";
import { renderSection, type CheckResult, ok, warn, info } from "./doctor-check.js";
import { resolveDoctorMemoryDbPath } from "./doctor-subsystems.js";

const SECTION = "Artifact liveness (skills economy / curiosity / guards)";

/** A curiosity loop that has produced targets but resolved none for this long is stuck. */
const CURIOSITY_STUCK_MS = 7 * 24 * 60 * 60_000;
/** Doubled execution rows younger than this indicate the F2 double-fire regressed. */
const RECENT_DOUBLE_MS = 7 * 24 * 60 * 60_000;
/** Peers must have offered at least this many skills before silence on review is a warn. */
const RECEIVED_REVIEW_THRESHOLD = 20;
/** A dream mode must have been selected this often before zero yield is a warn. */
const MODE_YIELD_MIN_RUNS = 5;
/** Skill-execution maturity gate for network publish (mirrors skill-network-bridge). */
const PUBLISH_MATURITY_EXECUTIONS = 3;

function tableExists(db: DatabaseSync, table: string): boolean {
  return Boolean(
    db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(table),
  );
}

function one<T>(db: DatabaseSync, sql: string, ...params: Array<string | number>): T {
  return db.prepare(sql).get(...params) as T;
}

/** Pure DB inspection — exported for tests. */
export function inspectArtifactLiveness(db: DatabaseSync, now: number = Date.now()): CheckResult[] {
  const results: CheckResult[] = [];

  // ── Skill crystal categorization (F3/F12) ──
  // Post-v57 every creation path stamps skill_category at insert; a NULL here
  // means a NEW ingest path leaked in without the stamp.
  if (tableExists(db, "chunks")) {
    try {
      const cat = one<{ nulls: number; total: number; cats: number }>(
        db,
        `SELECT SUM(CASE WHEN skill_category IS NULL OR skill_category = '' THEN 1 ELSE 0 END) AS nulls,
                COUNT(*) AS total,
                COUNT(DISTINCT skill_category) AS cats
           FROM chunks
          WHERE COALESCE(memory_type, '') = 'skill' OR COALESCE(semantic_type, '') = 'skill'`,
      );
      if (cat.total === 0) {
        results.push(info("No skill crystals yet."));
      } else if ((cat.nulls ?? 0) > 0) {
        results.push(
          warn(
            `${cat.nulls}/${cat.total} skill crystals have no skill_category — they are invisible ` +
              `to skills.metrics and skill_lifecycle. Every creation path should stamp the key at ` +
              `insert since migration v57; a NULL means a new path is leaking (audit F12 regression).`,
          ),
        );
      } else {
        results.push(
          ok(`All ${cat.total} skill crystals categorized (${cat.cats} distinct skill keys).`),
        );
      }
    } catch (err) {
      results.push(info(`Could not check skill categorization: ${String(err)}`));
    }
  }

  // ── Guard chain has fired at least once (F4) ──
  // intervention_records is append-only; tool traffic with zero rows EVER is
  // the exact signature of interceptors bound to phantom tool names.
  if (tableExists(db, "intervention_records") && tableExists(db, "skill_executions")) {
    try {
      const fired = one<{ c: number }>(db, `SELECT COUNT(*) AS c FROM intervention_records`).c;
      const traffic = one<{ c: number }>(db, `SELECT COUNT(*) AS c FROM skill_executions`).c;
      if (fired > 0) {
        results.push(ok(`Interceptor guard chain is live (${fired} intervention record(s)).`));
      } else if (traffic > 0) {
        results.push(
          warn(
            `intervention_records is empty despite ${traffic} recorded tool execution(s) — ` +
              `the PLAN-20 guard chain may be bound to tool names that no longer exist ` +
              `(audit F4 signature). Drive a confident outbound send via the message tool to verify.`,
          ),
        );
      } else {
        results.push(info("No tool traffic yet — guard-chain liveness unknown."));
      }
    } catch (err) {
      results.push(info(`Could not check guard chain: ${String(err)}`));
    }
  }

  // ── Peer trust graduation (F6) ──
  // Received skills pile up in quarantine; if no accept/reject decision has
  // EVER been recorded, no peer can leave manual review and auto-accept can
  // never arm. (An accept/reject writes skills_accepted / skills_rejected.)
  if (tableExists(db, "peer_reputation")) {
    try {
      const t = one<{ peers: number; recv: number; acc: number; rej: number }>(
        db,
        `SELECT COUNT(*) AS peers,
                COALESCE(SUM(skills_received), 0) AS recv,
                COALESCE(SUM(skills_accepted), 0) AS acc,
                COALESCE(SUM(skills_rejected), 0) AS rej
           FROM peer_reputation`,
      );
      if (t.recv === 0) {
        results.push(info("No peer skills received yet — trust graduation not applicable."));
      } else if (t.acc + t.rej === 0 && t.recv >= RECEIVED_REVIEW_THRESHOLD) {
        results.push(
          warn(
            `${t.peers} peer(s) have offered ${t.recv} skills but not one accept/reject decision ` +
              `has ever been recorded — no peer can graduate out of manual review, and the ` +
              `quarantine backlog only grows. Review via skills.incoming.list / .accept / .reject.`,
          ),
        );
      } else if (t.acc + t.rej === 0) {
        results.push(info(`${t.recv} peer skill(s) received, none reviewed yet.`));
      } else {
        results.push(
          ok(`Peer review is live: ${t.acc} accepted / ${t.rej} rejected across ${t.peers} peers.`),
        );
      }
    } catch (err) {
      results.push(info(`Could not check peer trust graduation: ${String(err)}`));
    }
  }

  // ── Curiosity target resolution (F9) ──
  if (tableExists(db, "curiosity_targets")) {
    try {
      const t = one<{ total: number; resolved: number; oldest: number | null }>(
        db,
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN resolved_at IS NOT NULL THEN 1 ELSE 0 END) AS resolved,
                MIN(created_at) AS oldest
           FROM curiosity_targets`,
      );
      if (t.total === 0) {
        results.push(info("No curiosity targets yet."));
      } else if (
        (t.resolved ?? 0) === 0 &&
        t.oldest != null &&
        now - t.oldest > CURIOSITY_STUCK_MS
      ) {
        results.push(
          warn(
            `0 of ${t.total} curiosity targets have EVER resolved (oldest is ` +
              `${Math.round((now - t.oldest) / 86_400_000)}d old) — targets only expire, so the ` +
              `curiosity loop never closes (audit F9; resolution semantics still undesigned).`,
          ),
        );
      } else if ((t.resolved ?? 0) === 0) {
        results.push(
          info(`${t.total} curiosity target(s) open, none resolved yet (loop is young).`),
        );
      } else {
        results.push(ok(`Curiosity loop closes: ${t.resolved}/${t.total} targets resolved.`));
      }
    } catch (err) {
      results.push(info(`Could not check curiosity targets: ${String(err)}`));
    }
  }

  // ── Curiosity region identity (F8) ──
  // Progress rows key learning to region ids. If EVERY row points at a dead
  // region, regions are being rebuilt with fresh UUIDs each cycle and
  // learning_progress can never accumulate. A legacy orphan tail from the
  // pre-fix era is expected and stays info.
  if (tableExists(db, "curiosity_progress") && tableExists(db, "curiosity_regions")) {
    try {
      const t = one<{ total: number; orphans: number }>(
        db,
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN region_id NOT IN (SELECT id FROM curiosity_regions) THEN 1 ELSE 0 END) AS orphans
           FROM curiosity_progress`,
      );
      if (t.total === 0) {
        results.push(info("No curiosity progress rows yet."));
      } else if ((t.orphans ?? 0) === t.total) {
        results.push(
          warn(
            `ALL ${t.total} curiosity progress rows point at region ids that no longer exist — ` +
              `regions are churning identity every rebuild, so learning progress resets forever ` +
              `(audit F8 regression).`,
          ),
        );
      } else if ((t.orphans ?? 0) > 0) {
        results.push(
          info(
            `${t.orphans}/${t.total} curiosity progress rows are orphaned legacy (pre-region-` +
              `stability era); ${t.total - (t.orphans ?? 0)} rows accrue against live regions.`,
          ),
        );
      } else {
        results.push(ok(`All ${t.total} curiosity progress rows key to live regions.`));
      }
    } catch (err) {
      results.push(info(`Could not check curiosity regions: ${String(err)}`));
    }
  }

  // ── Doubled execution telemetry (F2) ──
  if (tableExists(db, "skill_executions")) {
    try {
      const t = one<{ recent: number; legacy: number }>(
        db,
        `SELECT SUM(CASE WHEN started_at >= ? THEN 1 ELSE 0 END) AS recent,
                SUM(CASE WHEN started_at <  ? THEN 1 ELSE 0 END) AS legacy
           FROM (SELECT skill_crystal_id, started_at, COUNT(*) AS n
                   FROM skill_executions
                  GROUP BY skill_crystal_id, started_at
                 HAVING n > 1)`,
        now - RECENT_DOUBLE_MS,
        now - RECENT_DOUBLE_MS,
      );
      if ((t.recent ?? 0) > 0) {
        results.push(
          warn(
            `${t.recent} doubled skill-execution group(s) recorded in the last 7 days — the ` +
              `after_tool_call hook is firing twice per call again (audit F2 regression), ` +
              `corrupting telemetry and doubling hormonal reward.`,
          ),
        );
      } else if ((t.legacy ?? 0) > 0) {
        results.push(
          info(`${t.legacy} doubled execution group(s) remain from the pre-fix era (harmless).`),
        );
      } else {
        results.push(ok("No doubled execution telemetry."));
      }
    } catch (err) {
      results.push(info(`Could not check execution doubling: ${String(err)}`));
    }
  }

  // ── Mature-but-unpublished skills (F5) ──
  // The network publish gate needs ≥3 executions, but publish is only
  // attempted at crystallization time (when executions = 0) — nothing
  // re-attempts once a skill matures. Skills stuck here are the signature.
  if (tableExists(db, "skill_executions") && tableExists(db, "chunks")) {
    try {
      const t = one<{ c: number }>(
        db,
        `SELECT COUNT(*) AS c FROM (
           SELECT se.skill_crystal_id, COUNT(*) AS n
             FROM skill_executions se
             JOIN chunks c ON c.id = se.skill_crystal_id
            WHERE se.completed_at IS NOT NULL
              AND ${runEvidenceWhere("se")}
              AND c.published_at IS NULL
            GROUP BY se.skill_crystal_id
           HAVING n >= ${PUBLISH_MATURITY_EXECUTIONS})`,
      );
      if (t.c > 0) {
        results.push(
          warn(
            `${t.c} skill(s) passed the ${PUBLISH_MATURITY_EXECUTIONS}-execution maturity gate but ` +
              `were never published to the network — publish only triggers at crystallization ` +
              `(executions=0), so matured skills stay local forever (audit F5, unfixed).`,
          ),
        );
      } else {
        results.push(ok("No matured skills stuck unpublished."));
      }
    } catch (err) {
      results.push(info(`Could not check skill propagation: ${String(err)}`));
    }
  }

  // ── Dream mode yield (selection ≠ output) ──
  // The existing dream-liveness check proves modes get SELECTED; this one
  // proves selected modes produce insights. A mode chosen ≥5 times with zero
  // dream_insights rows ever is running as pure theater.
  if (tableExists(db, "dream_cycles") && tableExists(db, "dream_insights")) {
    try {
      const runs = new Map<string, number>();
      const cycles = db
        .prepare(`SELECT modes_used FROM dream_cycles WHERE modes_used IS NOT NULL`)
        .all() as Array<{ modes_used: string }>;
      for (const c of cycles) {
        try {
          for (const m of JSON.parse(c.modes_used) as string[]) {
            runs.set(m, (runs.get(m) ?? 0) + 1);
          }
        } catch {
          /* malformed row — skip */
        }
      }
      const yielded = new Set(
        (
          db.prepare(`SELECT DISTINCT mode FROM dream_insights`).all() as Array<{ mode: string }>
        ).map((r) => r.mode),
      );
      const silent = [...runs.entries()]
        .filter(([mode, n]) => n >= MODE_YIELD_MIN_RUNS && !yielded.has(mode))
        .map(([mode, n]) => `${mode} (${n} runs)`)
        .toSorted();
      if (runs.size === 0) {
        results.push(info("No dream cycles recorded yet."));
      } else if (silent.length > 0) {
        results.push(
          warn(
            `${silent.length} dream mode(s) run repeatedly but have NEVER produced an insight: ` +
              `${silent.join(", ")}. They execute as pure theater — each is either broken or ` +
              `mis-wired (the audit's untriaged coverage lead).`,
          ),
        );
      } else {
        results.push(ok(`Every repeatedly-selected dream mode has produced insights.`));
      }
    } catch (err) {
      results.push(info(`Could not check dream mode yield: ${String(err)}`));
    }
  }

  return results;
}

/**
 * PLAN-40: the dream-utility funnel + hold wake counters, via the SAME
 * shared query module the dream.utility RPC uses (one implementation).
 * Exported for tests.
 */
export async function inspectDreamUtility(db: DatabaseSync): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  try {
    const { getDreamUtilityFunnel, getDreamHoldCounters } =
      await import("../memory/dream-utility.js");
    const funnel = getDreamUtilityFunnel(db, { windowDays: 28 });
    const lanes = funnel.filter((f) => f.lane !== "legacy");
    const produced = lanes.reduce((s, l) => s + l.produced, 0);
    const consumed = lanes.reduce((s, l) => s + l.consumed, 0);
    if (produced === 0) {
      results.push(info("Dream utility funnel: no lane artifacts in the last 28d."));
    } else if (consumed === 0) {
      results.push(
        warn(
          `Dream lanes produced ${produced} artifact(s) in 28d and NOT ONE was ever consumed ` +
            `(retrieved/executed/surfaced) — the engine is spending compute on unread output ` +
            `again. Per-lane: ${lanes.map((l) => `${l.lane} 0/${l.produced}`).join(", ")}.`,
        ),
      );
    } else {
      results.push(
        ok(
          `Dream utility (28d): ${consumed}/${produced} artifacts consumed — ` +
            lanes.map((l) => `${l.lane} ${l.consumed}/${l.produced}`).join(", ") +
            ".",
        ),
      );
    }
    for (const h of getDreamHoldCounters(db)) {
      if (h.current < 0) continue;
      results.push(
        info(
          `Hold wake counter — ${h.hold}: ${h.current}/${h.wakeAt}` +
            (h.current >= h.wakeAt ? " — WAKE THRESHOLD REACHED, re-enable the mode." : "."),
        ),
      );
    }
  } catch (err) {
    results.push(info(`Could not read dream utility funnel: ${String(err)}`));
  }
  return results;
}

/**
 * Is the daily health sweep actually running, and what did it last find?
 *
 * The sweep exists because correct checks that never run are worthless. That
 * argument applies to the sweep itself: for its first week it produced ZERO
 * rows, because the timer only schedules the next wall-clock window from
 * process start and the machine was down at 08:00. A watchdog with no watcher
 * is the same bug one level up, so its own liveness is a doctor check.
 * Exported for tests.
 */
export function inspectHealthSweep(db: DatabaseSync, now: number = Date.now()): CheckResult[] {
  const results: CheckResult[] = [];
  if (!tableExists(db, "health_sweeps")) {
    return results;
  }
  try {
    const last = one<{ at: number | null; new_count: number | null; total: number }>(
      db,
      `SELECT (SELECT MAX(swept_at) FROM health_sweeps) AS at,
              (SELECT new_count FROM health_sweeps ORDER BY swept_at DESC LIMIT 1) AS new_count,
              COUNT(*) AS total
         FROM health_sweeps`,
    );
    if (!last.at) {
      results.push(
        warn(
          "Daily health sweep has NEVER run — the scheduled self-check that is " +
            "supposed to catch silent failures is itself silent.",
        ),
      );
      return results;
    }
    const hoursAgo = Math.round((now - last.at) / 3_600_000);
    if (hoursAgo > 36) {
      results.push(
        warn(
          `Daily health sweep last ran ${hoursAgo}h ago (${last.total} on record) — ` +
            "it should run daily; the window is being missed.",
        ),
      );
    } else if ((last.new_count ?? 0) > 0) {
      results.push(
        warn(
          `Last health sweep (${hoursAgo}h ago) found ${last.new_count} NEW issue(s). ` +
            "They were queued for surfacing; see the sections above for detail.",
        ),
      );
    } else {
      results.push(
        ok(`Daily health sweep ran ${hoursAgo}h ago, no new issues (${last.total} on record).`),
      );
    }
  } catch (err) {
    results.push(info(`Could not read health sweep history: ${String(err)}`));
  }
  return results;
}

export async function runLivenessChecks(params: { config: BitterbotConfig }): Promise<void> {
  const results: CheckResult[] = [];
  const dbPath = resolveDoctorMemoryDbPath(params.config);
  if (dbPath && fs.existsSync(dbPath)) {
    let db: DatabaseSync | null = null;
    try {
      db = new DatabaseSync(dbPath, { open: true, readOnly: true });
      results.push(...inspectArtifactLiveness(db));
      results.push(...(await inspectDreamUtility(db)));
      results.push(...inspectHealthSweep(db));
    } catch (err) {
      results.push(info(`Could not open memory DB for liveness checks: ${String(err)}`));
    } finally {
      try {
        db?.close();
      } catch {
        /* ignore */
      }
    }
  } else {
    results.push(info("Memory DB not found — artifact liveness not applicable."));
  }
  renderSection(SECTION, results);
}
