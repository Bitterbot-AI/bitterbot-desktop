/**
 * PLAN-44 Phase 5a: the USAGE SIGNAL. Did the agent open a live skill?
 *
 * Until this module existed the loop ended at "available": a promoted
 * SKILL.md appeared in the runtime index, but nothing recorded whether the
 * agent ever read it. The lifecycle store's usage counters had no runtime
 * caller and the execution tracker matches tool names to memory crystals,
 * not files. The only read detection lived inside the validation gate.
 *
 * This pass runs in housekeeping: it scans journal runs since a cursor,
 * finds `read` (or exec) tool calls whose path is a live skill's SKILL.md,
 * records one event per (run, skill) in `<wiki>/skill-reads.jsonl` with
 * the run's outcome, and credits the lifecycle store (usage / success
 * counts, last_used_at: the numbers the SICA regression gate already
 * reads). `summarizeSkillReads` folds the ledger into per-skill windowed
 * rates for status and, later, retirement (D-5).
 */

import type { DatabaseSync } from "node:sqlite";
import fs from "node:fs/promises";
import path from "node:path";
import type { EventJournal } from "../../infra/event-journal.js";
import { resolveWikiDir, type ImpactTrailOptions } from "../../agents/skills/impact-trail.js";
import {
  liveSkillPath,
  resolveStorageRoots,
  type StorageRoots,
} from "../../agents/skills/skill-storage.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { SkillLifecycleStore } from "../skill-lifecycle.js";
import { atomicWriteJson } from "./fs-atomic.js";
import { classifyRunOrigin } from "./run-origin.js";
import { listRunsSinceDetailed, runHasTerminal } from "./run-scan.js";
import { DEFAULT_EXCLUDED_SESSION_PATTERNS } from "./sampler.js";
import { reconstructTrace } from "./traces.js";

const log = createSubsystemLogger("skill-evolution/skill-reads");

export const SKILL_READS_FILENAME = "skill-reads.jsonl";
export const SKILL_READS_STATE_FILENAME = "skill-reads-state.json";
/** Runs scanned per pass. */
const MAX_RUNS_PER_PASS = 500;
/** Incomplete runs remembered for a later pass. */
const MAX_PENDING = 200;
const PENDING_TTL_MS = 3 * 24 * 60 * 60 * 1000;
/** (run, skill) keys remembered to keep the ledger append-only and idempotent. */
const MAX_SEEN = 4_000;

export interface SkillReadEvent {
  runId: string;
  skill: string;
  ts: number;
  /** Run ended without a lifecycle error and reached a terminal event. */
  success: boolean;
  origin: string;
  sessionKey: string | null;
}

interface SkillReadsState {
  cursorSeq: number;
  pending: Array<{ runId: string; firstSeq: number; seenAt: number }>;
  seen: string[];
}

export function skillReadsPath(opts: ImpactTrailOptions = {}): string {
  return path.join(resolveWikiDir(opts), SKILL_READS_FILENAME);
}
function statePath(opts: ImpactTrailOptions): string {
  return path.join(resolveWikiDir(opts), SKILL_READS_STATE_FILENAME);
}

async function readState(opts: ImpactTrailOptions): Promise<SkillReadsState> {
  try {
    const parsed = JSON.parse(
      await fs.readFile(statePath(opts), "utf-8"),
    ) as Partial<SkillReadsState>;
    return {
      cursorSeq: typeof parsed.cursorSeq === "number" ? parsed.cursorSeq : 0,
      pending: Array.isArray(parsed.pending) ? parsed.pending : [],
      seen: Array.isArray(parsed.seen) ? parsed.seen : [],
    };
  } catch {
    return { cursorSeq: 0, pending: [], seen: [] };
  }
}

/** Which live skills a run opened: `read` of `<liveRoot>/<name>/SKILL.md`, or an exec naming it. */
export function skillsReadInRun(
  journal: EventJournal,
  runId: string,
  roots: StorageRoots,
  liveNames: string[],
): string[] {
  const targets = new Map<string, string>();
  for (const name of liveNames) {
    targets.set(path.resolve(liveSkillPath(roots, name)), name);
  }
  if (targets.size === 0) {
    return [];
  }
  const rows = journal.query({ runId, streams: ["tool"], limit: 2_000 });
  const found = new Set<string>();
  for (const row of rows) {
    if (row.data.phase !== "start") {
      continue;
    }
    const args = (row.data.args ?? {}) as Record<string, unknown>;
    if (row.data.name === "read") {
      const p = [args.path, args.file_path, args.filePath].find((v) => typeof v === "string") as
        | string
        | undefined;
      if (p && path.isAbsolute(p)) {
        const hit = targets.get(path.resolve(p));
        if (hit) {
          found.add(hit);
        }
      }
      continue;
    }
    if (row.data.name === "exec" && typeof args.command === "string") {
      for (const [target, name] of targets) {
        if (args.command.includes(target)) {
          found.add(name);
        }
      }
    }
  }
  return [...found].toSorted();
}

function isExcludedSession(sessionKey: string | null | undefined): boolean {
  if (!sessionKey) {
    return false;
  }
  return DEFAULT_EXCLUDED_SESSION_PATTERNS.some((p) => sessionKey.includes(p));
}

export interface CreditSkillReadsResult {
  scannedRuns: number;
  credited: number;
  events: SkillReadEvent[];
  cursorSeq: number;
}

/**
 * Scan new runs, record skill reads, credit the lifecycle store. Safe to
 * call every housekeeping pass: the cursor and a seen-set make it
 * idempotent; incomplete runs are retried until they end or expire.
 */
export async function creditSkillReads(params: {
  journal: EventJournal;
  db?: DatabaseSync | null;
  storeOpts?: ImpactTrailOptions;
  now?: number;
}): Promise<CreditSkillReadsResult> {
  const opts = params.storeOpts ?? {};
  const now = params.now ?? Date.now();
  const roots = resolveStorageRoots(opts.configDir ? { configDir: opts.configDir } : {});
  let liveNames: string[];
  try {
    liveNames = (await fs.readdir(roots.liveRoot, { withFileTypes: true }))
      .filter((d) => d.isDirectory() && !d.name.startsWith("."))
      .map((d) => d.name);
  } catch {
    liveNames = [];
  }
  const state = await readState(opts);
  const seen = new Set(state.seen);
  const scan = await listRunsSinceDetailed(params.journal, {
    sinceSeq: state.cursorSeq,
    maxRuns: MAX_RUNS_PER_PASS,
  });
  const candidates = new Map<string, number>();
  for (const p of state.pending) {
    if (now - p.seenAt <= PENDING_TTL_MS) {
      candidates.set(p.runId, p.firstSeq);
    }
  }
  for (const run of scan.runs) {
    candidates.set(run.runId, run.firstSeq);
  }
  const pending: SkillReadsState["pending"] = [];
  const events: SkillReadEvent[] = [];
  const store = params.db ? new SkillLifecycleStore(params.db) : null;
  for (const [runId, firstSeq] of candidates) {
    const summary = scan.runs.find((r) => r.runId === runId);
    const complete = summary
      ? runHasTerminal(params.journal, summary)
      : params.journal.queryMeta({ runId, streams: ["lifecycle"], limit: 50 }).length > 1;
    if (!complete) {
      if (pending.length < MAX_PENDING) {
        pending.push({ runId, firstSeq, seenAt: now });
      }
      continue;
    }
    if (liveNames.length === 0) {
      continue;
    }
    const read = skillsReadInRun(params.journal, runId, roots, liveNames);
    if (read.length === 0) {
      continue;
    }
    const trace = await reconstructTrace(params.journal, runId);
    if (!trace) {
      continue;
    }
    if (isExcludedSession(trace.sessionKey)) {
      continue; // validation rollouts and probes open skills by construction
    }
    const success = !trace.endedWithError && trace.isComplete;
    for (const skill of read) {
      const key = `${runId} ${skill}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      const event: SkillReadEvent = {
        runId,
        skill,
        ts: trace.endedAt ?? trace.startedAt ?? now,
        success,
        origin: trace.task?.origin ?? classifyRunOrigin(trace.sessionKey),
        sessionKey: trace.sessionKey ?? null,
      };
      events.push(event);
      try {
        store?.recordUsage({ skillName: skill, success, timestamp: event.ts });
      } catch (err) {
        log.debug(`lifecycle credit failed for ${skill}: ${String(err)}`);
      }
    }
  }
  if (events.length > 0) {
    const file = skillReadsPath(opts);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.appendFile(file, `${events.map((e) => JSON.stringify(e)).join("\n")}\n`, "utf-8");
  }
  const nextCursor = Math.max(state.cursorSeq, scan.horizonSeq);
  const seenList = [...seen];
  await atomicWriteJson(statePath(opts), {
    cursorSeq: nextCursor,
    pending,
    seen: seenList.slice(Math.max(0, seenList.length - MAX_SEEN)),
  } satisfies SkillReadsState);
  if (events.length > 0) {
    log.info(
      `skill reads: credited ${events.length} read(s) across ${new Set(events.map((e) => e.runId)).size} run(s)`,
    );
  }
  return { scannedRuns: scan.runs.length, credited: events.length, events, cursorSeq: nextCursor };
}

export interface SkillReadSummary {
  name: string;
  reads: number;
  successes: number;
  /** successes / reads over the window; null when no reads. */
  successRate: number | null;
  lastReadAt: number | null;
  /** Distinct runs that opened the skill. */
  runs: number;
}

/** Per-skill read counts over the last `windowDays` (default 14), for every name in `liveNames` plus any skill in the ledger. */
export async function summarizeSkillReads(params: {
  storeOpts?: ImpactTrailOptions;
  liveNames?: string[];
  windowDays?: number;
  now?: number;
}): Promise<SkillReadSummary[]> {
  const now = params.now ?? Date.now();
  const since = now - (params.windowDays ?? 14) * 24 * 60 * 60 * 1000;
  let raw = "";
  try {
    raw = await fs.readFile(skillReadsPath(params.storeOpts ?? {}), "utf-8");
  } catch {
    raw = "";
  }
  const acc = new Map<string, SkillReadSummary & { runIds: Set<string> }>();
  const ensure = (name: string) => {
    let s = acc.get(name);
    if (!s) {
      s = {
        name,
        reads: 0,
        successes: 0,
        successRate: null,
        lastReadAt: null,
        runs: 0,
        runIds: new Set(),
      };
      acc.set(name, s);
    }
    return s;
  };
  for (const name of params.liveNames ?? []) {
    ensure(name);
  }
  for (const line of raw.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    let e: SkillReadEvent;
    try {
      e = JSON.parse(line) as SkillReadEvent;
    } catch {
      continue;
    }
    if (typeof e.ts !== "number" || e.ts < since || typeof e.skill !== "string") {
      continue;
    }
    const s = ensure(e.skill);
    s.reads += 1;
    if (e.success) {
      s.successes += 1;
    }
    s.lastReadAt = Math.max(s.lastReadAt ?? 0, e.ts);
    s.runIds.add(e.runId);
  }
  return [...acc.values()]
    .map(({ runIds, ...s }) => ({
      ...s,
      runs: runIds.size,
      successRate: s.reads > 0 ? s.successes / s.reads : null,
    }))
    .toSorted((a, b) => b.reads - a.reads || a.name.localeCompare(b.name));
}
