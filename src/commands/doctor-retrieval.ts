/**
 * Retrieval health doctor section (PLAN-27/28 observability, finally consumed).
 *
 * The project's signature failure mode is wired-but-dead retrieval: a layer
 * (vector, keyword, graph, canonical) silently contributing nothing while the
 * system looks healthy. PLAN-28 built the detector — per-layer dead-wire
 * counters behind `memory.retrievalHealth`, and a sampled `retrieval_trace`
 * table — but doctor never read either. This section does both:
 *
 *   - Gateway running → ask the live detector. It owns the nuanced logic
 *     (idle windows, activity baselines), so its verdict is authoritative.
 *   - Always → coarse offline sweep of recent `retrieval_trace` rows: a layer
 *     with ZERO hits across a meaningful sample is worth surfacing even when
 *     the gateway is down (and catches faults that predate this boot).
 *
 * Everything here is warn/info — retrieval state is data health, equally true
 * before and after an update, so it must never block the update gate.
 */

import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { BitterbotConfig } from "../config/config.js";
import { callGateway } from "../gateway/call.js";
import { renderSection, type CheckResult, ok, warn, info } from "./doctor-check.js";
import { resolveDoctorMemoryDbPath } from "./doctor-subsystems.js";

const SECTION = "Retrieval Health";
// Below this many sampled retrievals the zero-hit signal is noise.
const MIN_TRACE_SAMPLE = 20;
const TRACE_WINDOW_MS = 7 * 24 * 60 * 60_000;

type DeadWire = {
  layer: string;
  searchesSinceContribution: number;
  window: number;
  daysSinceContribution?: number;
};

type RetrievalHealthResp = {
  available?: boolean;
  layers?: { total: number; sinceContribution: Record<string, number> };
  deadWires?: DeadWire[];
};

async function liveDetectorResults(): Promise<CheckResult[] | null> {
  let resp: RetrievalHealthResp | null = null;
  try {
    resp = (await callGateway<RetrievalHealthResp>({
      method: "memory.retrievalHealth",
      params: {},
      timeoutMs: 5_000,
    })) as RetrievalHealthResp;
  } catch {
    return null; // gateway probe failed — offline sweep still runs
  }
  if (!resp || resp.available === false) {
    return [info("Live retrieval detector unavailable (memory manager not initialized).")];
  }
  const results: CheckResult[] = [];
  const dead = resp.deadWires ?? [];
  if (dead.length === 0) {
    results.push(
      ok(
        `No dead retrieval lanes (live detector, ${resp.layers?.total ?? 0} retrievals observed).`,
      ),
    );
  }
  for (const wire of dead) {
    const silence =
      wire.daysSinceContribution !== undefined
        ? `silent for ~${wire.daysSinceContribution} day(s)`
        : `${wire.searchesSinceContribution} retrievals since last contribution (window ${wire.window})`;
    results.push(
      warn(
        `Dead retrieval lane: "${wire.layer}" — ${silence}. ` +
          `This layer is wired but contributing nothing to recall.`,
      ),
    );
  }
  return results;
}

/**
 * Pure offline sweep of recent retrieval_trace rows — exported for tests.
 *
 * Kind semantics matter (see retrieval-trace.ts): on `kind='recall'` rows,
 * `keyword_hits` counts FTS-FALLBACK facts — nonzero exactly when the
 * embedding pipeline is degraded — so it folds into the VECTOR lane, and the
 * keyword lane is judged only on explicit `kind='search'` traffic. Summing
 * keyword across both kinds would perpetually flag healthy recall-dominated
 * nodes whose vector path works (keyword fallback correctly at 0).
 *
 * Per-lane warns also require at least one lane to have contributed: an
 * all-zero sample on a sparse/new memory is "nothing to retrieve yet", not
 * three dead wires — the live detector applies the same activity gate.
 */
export function inspectRetrievalTrace(db: DatabaseSync, now: number = Date.now()): CheckResult[] {
  const hasTable = Boolean(
    db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='retrieval_trace'`)
      .get(),
  );
  if (!hasTable) {
    return [info("retrieval_trace table absent (pre-v21 DB) — offline sweep skipped.")];
  }
  let row:
    | { n: number; nSearch: number; vec: number; kw: number; graph: number; fused: number }
    | undefined;
  try {
    row = db
      .prepare(
        `SELECT COUNT(*) AS n,
                COALESCE(SUM(CASE WHEN kind = 'search' THEN 1 ELSE 0 END), 0) AS nSearch,
                COALESCE(SUM(CASE WHEN kind = 'recall'
                                  THEN vector_hits + keyword_hits
                                  ELSE vector_hits END), 0) AS vec,
                COALESCE(SUM(CASE WHEN kind = 'search' THEN keyword_hits ELSE 0 END), 0) AS kw,
                COALESCE(SUM(graph_hits), 0) AS graph,
                COALESCE(SUM(fused), 0)      AS fused
           FROM retrieval_trace WHERE created_at > ?`,
      )
      .get(now - TRACE_WINDOW_MS) as typeof row;
  } catch (err) {
    return [info(`Could not read retrieval_trace: ${String(err)}`)];
  }
  if (!row || row.n === 0) {
    return [info("No sampled retrievals in the last 7 days — offline sweep has nothing to check.")];
  }
  if (row.n < MIN_TRACE_SAMPLE) {
    return [info(`Only ${row.n} sampled retrievals in the last 7 days — too few to judge layers.`)];
  }
  const anyContribution = row.vec > 0 || row.kw > 0 || row.graph > 0;
  if (!anyContribution) {
    return [
      info(
        `No retrieval layer produced hits across ${row.n} sampled retrievals — memory may ` +
          `simply be sparse. The live detector (gateway up) is the authoritative dead-wire check.`,
      ),
    ];
  }
  const results: CheckResult[] = [];
  const lanes: Array<[string, number, number]> = [
    ["vector", row.vec, row.n],
    ["keyword", row.kw, row.nSearch],
    ["graph", row.graph, row.n],
  ];
  for (const [lane, hits, sample] of lanes) {
    if (sample < MIN_TRACE_SAMPLE) continue; // not enough traffic of the right kind
    if (hits === 0) {
      results.push(
        warn(
          `Retrieval lane "${lane}" had 0 hits across ${sample} sampled retrievals in the last ` +
            `7 days — likely wired-but-dead.`,
        ),
      );
    }
  }
  if (row.fused === 0) {
    results.push(
      warn(
        `Fusion produced 0 results across ${row.n} sampled retrievals — recall is returning ` +
          `nothing at all.`,
      ),
    );
  }
  if (results.length === 0) {
    results.push(
      ok(
        `Retrieval lanes contributed over the last ${row.n} sampled retrievals ` +
          `(vector ${row.vec}, keyword ${row.kw} across ${row.nSearch} searches, graph ${row.graph}).`,
      ),
    );
  }
  return results;
}

export async function runRetrievalChecks(params: {
  config: BitterbotConfig;
  isGatewayRunning: boolean;
}): Promise<void> {
  const results: CheckResult[] = [];

  if (params.isGatewayRunning) {
    const live = await liveDetectorResults();
    if (live) results.push(...live);
  }

  const dbPath = resolveDoctorMemoryDbPath(params.config);
  if (dbPath && fs.existsSync(dbPath)) {
    let db: DatabaseSync | null = null;
    try {
      db = new DatabaseSync(dbPath, { open: true, readOnly: true });
      results.push(...inspectRetrievalTrace(db));
    } catch (err) {
      results.push(info(`Could not open memory DB for the offline sweep: ${String(err)}`));
    } finally {
      try {
        db?.close();
      } catch {
        /* ignore */
      }
    }
  } else if (results.length === 0) {
    results.push(info("Memory DB not initialized yet — retrieval checks skipped."));
  }

  renderSection(SECTION, results);
}
