/**
 * PLAN-44 Phase 2: the incumbent trial memo.
 *
 * Audit finding: every proposal re-ran the unchanged incumbent arm over
 * the whole corpus (72 real agent turns minimum, 180+ at the cap). The
 * incumbent's result on (task prompt, incumbent content, model, generator
 * version, trial index) does not change between proposals, so it is
 * memoized in `skill-wiki/.trial-cache.sqlite`. A create's incumbent is
 * "no skill", so the memo is shared by every create proposal on the same
 * model. Candidate arms are never cached. Rows older than TTL are pruned
 * on open; a model change simply never matches.
 */

import type { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import path from "node:path";
import { resolveWikiDir, type ImpactTrailOptions } from "../../agents/skills/impact-trail.js";
import { requireNodeSqlite } from "../sqlite.js";

export const TRIAL_CACHE_FILENAME = ".trial-cache.sqlite";
export const TRIAL_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface TrialCacheKey {
  taskId: string;
  /** SHA-1 of the task prompt: a canonical instance from another seed is a different task. */
  promptHash: string;
  incumbentHash: string;
  modelTag: string;
  generatorVersion: number;
  trialIndex: number;
  /** Runner/prompt-shape profile (gate-support.ts RUNNER_PROFILE); absent = legacy. */
  profile?: string;
}

export interface CachedTrial {
  score: 0 | 1;
  answer: string;
  skillRead: boolean | null;
  /** PLAN-45 2.5: cost of the original turn, replayed on a memo hit. */
  usage?: { input?: number; output?: number } | null;
  wallMs?: number | null;
  /** PLAN-45 4.5: egress attempts of the original trial. */
  egress?: Array<{ tool: string; host: string; declared: boolean }> | null;
}

function parseEgress(raw: string | null): CachedTrial["egress"] {
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter(
          (e): e is { tool: string; host: string; declared: boolean } =>
            !!e &&
            typeof e === "object" &&
            typeof (e as { tool?: unknown }).tool === "string" &&
            typeof (e as { host?: unknown }).host === "string" &&
            typeof (e as { declared?: unknown }).declared === "boolean",
        )
      : null;
  } catch {
    return null;
  }
}

export function promptHash(prompt: string): string {
  return createHash("sha1").update(prompt).digest("hex").slice(0, 16);
}

export function trialCacheKey(k: TrialCacheKey): string {
  return createHash("sha1")
    .update(
      [
        k.taskId,
        k.promptHash,
        k.incumbentHash,
        k.modelTag,
        k.generatorVersion,
        k.trialIndex,
        k.profile ?? "",
      ].join(" "),
    )
    .digest("hex");
}

export class TrialCache {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync, now = Date.now()) {
    this.db = db;
    this.db.exec(`CREATE TABLE IF NOT EXISTS trials (
      key TEXT PRIMARY KEY,
      score INTEGER NOT NULL,
      answer TEXT NOT NULL,
      skill_read INTEGER,
      at INTEGER NOT NULL
    )`);
    for (const col of [
      "input_tokens INTEGER",
      "output_tokens INTEGER",
      "wall_ms INTEGER",
      "egress_json TEXT",
    ]) {
      try {
        this.db.exec(`ALTER TABLE trials ADD COLUMN ${col}`);
      } catch {
        /* already there */
      }
    }
    this.db.prepare("DELETE FROM trials WHERE at < ?").run(now - TRIAL_CACHE_TTL_MS);
    // PLAN-45 Phase 2.1: per-(task, model) incumbent pass statistics across
    // seeds and days, for the gate's per-model calibration (a canonical
    // capability task this model always or never passes carries no signal).
    this.db.exec(`CREATE TABLE IF NOT EXISTS task_stats (
      task_id TEXT NOT NULL,
      model_tag TEXT NOT NULL,
      trials INTEGER NOT NULL,
      passes REAL NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (task_id, model_tag)
    )`);
  }

  /** Add one task's incumbent-arm result (fractional passes over `trials`). */
  recordIncumbentTaskStats(
    taskId: string,
    modelTag: string,
    passes: number,
    trials: number,
    now = Date.now(),
  ): void {
    if (trials <= 0) {
      return;
    }
    this.db
      .prepare(
        `INSERT INTO task_stats (task_id, model_tag, trials, passes, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(task_id, model_tag) DO UPDATE SET
           trials = trials + excluded.trials,
           passes = passes + excluded.passes,
           updated_at = excluded.updated_at`,
      )
      .run(taskId, modelTag, trials, passes, now);
  }

  /** Incumbent pass statistics per task id for one model. */
  incumbentTaskStats(modelTag: string): Map<string, { trials: number; passes: number }> {
    const rows = this.db
      .prepare(`SELECT task_id, trials, passes FROM task_stats WHERE model_tag = ?`)
      .all(modelTag) as Array<{ task_id: string; trials: number; passes: number }>;
    return new Map(rows.map((r) => [r.task_id, { trials: r.trials, passes: r.passes }]));
  }

  static open(opts: ImpactTrailOptions = {}): TrialCache {
    const { DatabaseSync } = requireNodeSqlite();
    return new TrialCache(new DatabaseSync(path.join(resolveWikiDir(opts), TRIAL_CACHE_FILENAME)));
  }

  static inMemory(): TrialCache {
    const { DatabaseSync } = requireNodeSqlite();
    return new TrialCache(new DatabaseSync(":memory:"));
  }

  get(k: TrialCacheKey): CachedTrial | null {
    const row = this.db
      .prepare(
        "SELECT score, answer, skill_read, input_tokens, output_tokens, wall_ms, egress_json FROM trials WHERE key = ?",
      )
      .get(trialCacheKey(k)) as
      | {
          score: number;
          answer: string;
          skill_read: number | null;
          input_tokens: number | null;
          output_tokens: number | null;
          wall_ms: number | null;
          egress_json: string | null;
        }
      | undefined;
    if (!row) {
      return null;
    }
    return {
      score: row.score ? 1 : 0,
      answer: row.answer,
      skillRead: row.skill_read === null ? null : row.skill_read === 1,
      usage:
        row.input_tokens === null && row.output_tokens === null
          ? null
          : { input: row.input_tokens ?? 0, output: row.output_tokens ?? 0 },
      wallMs: row.wall_ms,
      egress: parseEgress(row.egress_json),
    };
  }

  put(k: TrialCacheKey, value: CachedTrial, now = Date.now()): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO trials (key, score, answer, skill_read, at, input_tokens, output_tokens, wall_ms, egress_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        trialCacheKey(k),
        value.score,
        value.answer.slice(0, 4_000),
        value.skillRead === null ? null : value.skillRead ? 1 : 0,
        now,
        value.usage?.input ?? null,
        value.usage?.output ?? null,
        value.wallMs ?? null,
        value.egress ? JSON.stringify(value.egress.slice(0, 64)) : null,
      );
  }

  size(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM trials").get() as { n: number };
    return row.n;
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      // ignore
    }
  }
}
