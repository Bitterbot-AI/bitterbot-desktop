import type { DatabaseSync } from "node:sqlite";
import {
  LearningCandidateSchema,
  LearningConfigSchema,
  LearningEpisodeSchema,
  LearningCostSchema,
  LearningVerdictSchema,
  learningHash,
  type LearningConfig,
  type LearningConfigInput,
  type LearningCost,
  type LearningEntry,
  type LearningEpisode,
  type LearningScope,
  type LearningVerdict,
} from "./procedural-learning-contract.js";

type EntryRow = { hash: string; body: string; state: LearningEntry["state"]; created_at: number };

/** Separate durable tables: vector reindexing and dream text rewriting are not evidence. */
export class ProceduralLearningStore {
  readonly config: LearningConfig;
  constructor(
    readonly db: DatabaseSync,
    config: LearningConfigInput = {},
    readonly now = Date.now,
  ) {
    this.config = LearningConfigSchema.parse(config);
    db.exec(`
      CREATE TABLE IF NOT EXISTS learning_episodes (id TEXT PRIMARY KEY, body TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS learning_episode_costs (id TEXT PRIMARY KEY, cost TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS learning_entries (hash TEXT PRIMARY KEY, scope TEXT NOT NULL, body TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('candidate','verified','revoked')), created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS learning_scope ON learning_entries(scope,state,expires_at);
      CREATE TABLE IF NOT EXISTS learning_parents (child TEXT NOT NULL, parent TEXT NOT NULL, PRIMARY KEY(child,parent));
      CREATE TABLE IF NOT EXISTS learning_revocations (hash TEXT PRIMARY KEY, reason TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS learning_runs (id TEXT PRIMARY KEY, candidate TEXT NOT NULL, scope TEXT NOT NULL,
        input_hash TEXT NOT NULL, verifier TEXT NOT NULL, partition TEXT NOT NULL, status TEXT NOT NULL,
        quote TEXT NOT NULL, cost TEXT, predicted REAL NOT NULL, passed INTEGER, started_at INTEGER NOT NULL, finished_at INTEGER);
      CREATE INDEX IF NOT EXISTS learning_run_candidate ON learning_runs(candidate,partition,status);
      CREATE TABLE IF NOT EXISTS learning_audit (id INTEGER PRIMARY KEY, kind TEXT NOT NULL, subject TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS learning_verdicts (run_id TEXT PRIMARY KEY, category TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS learning_verifier_blocks (candidate TEXT NOT NULL, verifier TEXT NOT NULL, PRIMARY KEY(candidate,verifier));
      INSERT OR IGNORE INTO learning_verdicts SELECT id, CASE WHEN status='settled' AND passed=1 THEN 'pass' ELSE 'legacy-unclassified' END FROM learning_runs;
    `);
  }

  audit(kind: string, subject: string): void {
    this.db
      .prepare("INSERT INTO learning_audit(kind,subject,at) VALUES (?,?,?)")
      .run(kind, subject, this.now());
    this.db
      .prepare("DELETE FROM learning_audit WHERE id <= (SELECT MAX(id)-? FROM learning_audit)")
      .run(this.config.maxEntries * 100);
  }
  recordEpisode(input: unknown): LearningEpisode {
    const episode = LearningEpisodeSchema.parse(input);
    if (episode.occurredAt > this.now()) throw new Error("Future episode");
    const existing = this.db
      .prepare("SELECT body FROM learning_episodes WHERE id=?")
      .get(episode.id) as { body: string } | undefined;
    if (existing) {
      if (learningHash(JSON.parse(existing.body)) !== learningHash(episode))
        throw new Error("Episode identity collision");
      return episode;
    }
    this.checkCapacity("learning_episodes", this.config.maxEntries * 32);
    this.db
      .prepare("INSERT INTO learning_episodes VALUES (?,?,?)")
      .run(episode.id, JSON.stringify(episode), this.now());
    return episode;
  }
  private checkCapacity(
    table: "learning_entries" | "learning_episodes" | "learning_runs",
    limit: number,
  ): void {
    const { n } = this.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
    if (n >= limit) throw new Error(`Learning capacity reached: ${table}`);
  }
  episode(id: string): LearningEpisode | null {
    const row = this.db.prepare("SELECT body FROM learning_episodes WHERE id=?").get(id) as
      | { body: string }
      | undefined;
    return row ? LearningEpisodeSchema.parse(JSON.parse(row.body)) : null;
  }
  propose(input: unknown, imported = false): LearningEntry {
    const candidate = LearningCandidateSchema.parse(input);
    if (
      candidate.expiresAt <= this.now() ||
      candidate.expiresAt > this.now() + this.config.maxAgeDays * 86400000
    )
      throw new Error("Invalid lesson lifetime");
    if (
      new Set(candidate.parents).size !== candidate.parents.length ||
      new Set(candidate.sourceEpisodes).size !== candidate.sourceEpisodes.length
    )
      throw new Error("Duplicate provenance");
    if (!imported) {
      for (const id of candidate.sourceEpisodes) {
        const episode = this.episode(id);
        if (
          !episode ||
          episode.partition !== "acquisition" ||
          learningHash(episode.scope) !== learningHash(candidate.scope)
        )
          throw new Error("Missing, held-out or unrelated source episode");
        if (candidate.sharing === "shareable" && episode.sharing !== "shareable")
          throw new Error("Private source cannot be shared");
      }
      for (const parent of candidate.parents) {
        const entry = this.get(parent);
        if (!entry || !this.usable(parent)) throw new Error("Unavailable parent");
        if (candidate.sharing === "shareable" && entry.candidate.sharing !== "shareable")
          throw new Error("Private ancestor cannot be shared");
      }
    } else if (candidate.sharing !== "shareable") {
      throw new Error("Invalid peer candidate");
    }
    const hash = learningHash(candidate);
    if (
      candidate.parents.includes(hash) ||
      this.revoked(hash) ||
      candidate.parents.some((p) => this.revoked(p))
    )
      throw new Error("Revoked or circular lineage");
    const existing = this.get(hash);
    if (existing) return existing;
    this.checkCapacity("learning_entries", this.config.maxEntries);
    this.db.exec("SAVEPOINT learning_propose");
    try {
      this.db
        .prepare("INSERT INTO learning_entries VALUES (?,?,?,?,?,?)")
        .run(
          hash,
          learningHash(candidate.scope),
          JSON.stringify(candidate),
          "candidate",
          this.now(),
          candidate.expiresAt,
        );
      const insert = this.db.prepare("INSERT INTO learning_parents VALUES (?,?)");
      for (const parent of candidate.parents) insert.run(hash, parent);
      this.audit(imported ? "peer-quarantine" : "propose", hash);
      this.db.exec("RELEASE learning_propose");
    } catch (error) {
      this.db.exec("ROLLBACK TO learning_propose; RELEASE learning_propose");
      throw error;
    }
    return this.get(hash)!;
  }
  get(hash: string): LearningEntry | null {
    const row = this.db.prepare("SELECT * FROM learning_entries WHERE hash=?").get(hash) as
      | EntryRow
      | undefined;
    return row
      ? {
          hash: row.hash,
          candidate: LearningCandidateSchema.parse(JSON.parse(row.body)),
          state: row.state,
          createdAt: row.created_at,
        }
      : null;
  }
  revoked(hash: string): boolean {
    return Boolean(
      this.db
        .prepare(`WITH RECURSIVE ancestors(hash) AS (
      SELECT ? UNION SELECT p.parent FROM learning_parents p JOIN ancestors a ON p.child=a.hash
    ) SELECT 1 FROM ancestors a JOIN learning_revocations r ON r.hash=a.hash LIMIT 1`)
        .get(hash),
    );
  }
  usable(hash: string): boolean {
    const entry = this.get(hash);
    if (
      !entry ||
      entry.state === "revoked" ||
      entry.candidate.expiresAt <= this.now() ||
      this.revoked(hash)
    )
      return false;
    // Missing ancestry on a recipient remains quarantine, never an implicit trust grant.
    return !this.db
      .prepare(`WITH RECURSIVE ancestors(hash) AS (
      SELECT parent FROM learning_parents WHERE child=? UNION
      SELECT p.parent FROM learning_parents p JOIN ancestors a ON p.child=a.hash
    ) SELECT 1 FROM ancestors a LEFT JOIN learning_entries e ON e.hash=a.hash
      WHERE e.hash IS NULL OR e.expires_at<=? OR e.state='revoked' LIMIT 1`)
      .get(hash, this.now());
  }
  retrieve(scope: LearningScope, includeShadow = false): LearningEntry[] {
    if (this.config.mode === "off" || (this.config.mode === "shadow" && !includeShadow)) return [];
    const rows = this.db
      .prepare(
        "SELECT hash FROM learning_entries WHERE scope=? AND state='verified' AND expires_at>? ORDER BY created_at DESC,hash LIMIT ?",
      )
      .all(learningHash(scope), this.now(), this.config.maxEntries) as { hash: string }[];
    return rows
      .filter((row) => this.usable(row.hash))
      .slice(0, this.config.maxResults)
      .map((row) => this.get(row.hash)!);
  }
  revoke(hash: string, reason: string): void {
    if (!/^[a-f0-9]{64}$/.test(hash) || !reason.trim() || reason.length > 200)
      throw new Error("Invalid revocation");
    this.db.exec("SAVEPOINT learning_revoke");
    try {
      this.db
        .prepare("INSERT OR IGNORE INTO learning_revocations VALUES (?,?,?)")
        .run(hash, reason, this.now());
      this.db
        .prepare(`WITH RECURSIVE descendants(hash) AS (SELECT ? UNION
        SELECT p.child FROM learning_parents p JOIN descendants d ON p.parent=d.hash)
        UPDATE learning_entries SET state='revoked' WHERE hash IN descendants`)
        .run(hash);
      this.audit("revoke", hash);
      this.db.exec("RELEASE learning_revoke");
    } catch (error) {
      this.db.exec("ROLLBACK TO learning_revoke; RELEASE learning_revoke");
      throw error;
    }
  }
  /** Invalid evidence withdraws availability, not the procedure's semantic reputation. */
  dequalify(hash: string, verifier?: string): void {
    this.db.exec("SAVEPOINT learning_dequalify");
    try {
      if (verifier)
        this.db
          .prepare("INSERT OR IGNORE INTO learning_verifier_blocks VALUES (?,?)")
          .run(hash, verifier);
      this.db
        .prepare(`WITH RECURSIVE descendants(hash) AS (SELECT ? UNION
        SELECT p.child FROM learning_parents p JOIN descendants d ON p.parent=d.hash)
        UPDATE learning_entries SET state='candidate' WHERE hash IN descendants AND state!='revoked'`)
        .run(hash);
      this.audit("verification-withdrawn", hash);
      this.db.exec("RELEASE learning_dequalify");
    } catch (error) {
      this.db.exec("ROLLBACK TO learning_dequalify; RELEASE learning_dequalify");
      throw error;
    }
  }
  verifierBlocked(candidate: string, verifier: string): boolean {
    return Boolean(
      this.db
        .prepare("SELECT 1 FROM learning_verifier_blocks WHERE candidate=? AND verifier=?")
        .get(candidate, verifier),
    );
  }
  maintain(): { expired: number } {
    const result = this.db
      .prepare(
        "UPDATE learning_entries SET state='revoked' WHERE expires_at<=? AND state!='revoked'",
      )
      .run(this.now());
    // Maintenance never creates verification receipts or duplicates source evidence.
    return { expired: Number(result.changes) };
  }
  reserve(
    run: {
      id: string;
      candidate: string;
      scope: LearningScope;
      inputHash: string;
      verifier: string;
      partition: "acquisition" | "held-out";
      quote: LearningCost;
      predicted: number;
    },
    budget: LearningCost,
  ): void {
    this.checkCapacity("learning_runs", this.config.maxEntries * 100);
    this.db.exec("SAVEPOINT learning_reserve");
    try {
      const spent = this.costs();
      if (spent.unknownRuns > 0 || spent.unknownAcquisitions > 0)
        throw new Error("Unresolved cost ledger; reconcile before further execution");
      if (
        spent.providerUsd + run.quote.providerUsd > budget.providerUsd ||
        spent.toolCalls + run.quote.toolCalls > budget.toolCalls ||
        spent.wallMs + run.quote.wallMs > budget.wallMs
      )
        throw new Error("Total learning budget exhausted");
      this.db
        .prepare("INSERT INTO learning_runs VALUES (?,?,?,?,?,?,?,?,?,?,NULL,?,NULL)")
        .run(
          run.id,
          run.candidate,
          learningHash(run.scope),
          run.inputHash,
          run.verifier,
          run.partition,
          "pending",
          JSON.stringify(run.quote),
          null,
          run.predicted,
          this.now(),
        );
      this.db.exec("RELEASE learning_reserve");
    } catch (error) {
      this.db.exec("ROLLBACK TO learning_reserve; RELEASE learning_reserve");
      throw error;
    }
  }
  finish(
    id: string,
    passed: boolean,
    cost: LearningCost | null,
    category: LearningVerdict = passed ? "pass" : "legacy-unclassified",
  ): void {
    LearningVerdictSchema.parse(category);
    if ((category === "pass") !== passed || (passed && cost === null))
      throw new Error("Inconsistent verification evidence");
    this.db.exec("SAVEPOINT learning_finish");
    try {
      const run = this.db
        .prepare("SELECT candidate,partition,status FROM learning_runs WHERE id=?")
        .get(id) as { candidate: string; partition: string; status: string } | undefined;
      if (!run || run.status !== "pending") throw new Error("Run not pending");
      this.db
        .prepare("UPDATE learning_runs SET status=?,cost=?,passed=?,finished_at=? WHERE id=?")
        .run(
          cost ? "settled" : "unknown",
          cost ? JSON.stringify(cost) : null,
          passed ? 1 : 0,
          this.now(),
          id,
        );
      this.db.prepare("INSERT OR REPLACE INTO learning_verdicts VALUES (?,?)").run(id, category);
      this.audit(`outcome:${category}`, run.candidate);
      this.db.exec("RELEASE learning_finish");
    } catch (error) {
      this.db.exec("ROLLBACK TO learning_finish; RELEASE learning_finish");
      throw error;
    }
  }
  costs(): LearningCost & { unknownRuns: number; unknownAcquisitions: number } {
    // Aggregate inside SQLite instead of materializing and reparsing the complete
    // execution history (or performing an episode lookup per candidate) on every call.
    const row = this.db
      .prepare(`WITH acquisitions AS (
      SELECT COALESCE(c.cost,json_extract(e.body,'$.cost')) AS cost
      FROM learning_episodes e LEFT JOIN learning_episode_costs c ON c.id=e.id
    ), costs AS (
      SELECT cost FROM acquisitions UNION ALL SELECT COALESCE(cost,quote) FROM learning_runs
    ) SELECT COALESCE(SUM(json_extract(cost,'$.providerUsd')),0) AS providerUsd,
      COALESCE(SUM(json_extract(cost,'$.toolCalls')),0) AS toolCalls,
      COALESCE(SUM(json_extract(cost,'$.wallMs')),0) AS wallMs,
      (SELECT COUNT(*) FROM learning_runs WHERE status!='settled') AS unknownRuns,
      (SELECT COUNT(*) FROM acquisitions WHERE cost IS NULL) +
      (SELECT COUNT(DISTINCT source.value) FROM learning_entries candidate,
        json_each(candidate.body,'$.sourceEpisodes') source
        LEFT JOIN learning_episodes episode ON episode.id=source.value
        WHERE episode.id IS NULL) AS unknownAcquisitions FROM costs`)
      .get() as LearningCost & { unknownRuns: number; unknownAcquisitions: number };
    return {
      ...LearningCostSchema.parse({
        providerUsd: row.providerUsd,
        toolCalls: row.toolCalls,
        wallMs: row.wallMs,
      }),
      unknownRuns: row.unknownRuns,
      unknownAcquisitions: row.unknownAcquisitions,
    };
  }

  /** Host-only reconciliation from provider/tool receipts; never infer zero after interruption. */
  reconcileRun(id: string, cost: LearningCost): void {
    LearningCostSchema.parse(cost);
    const row = this.db.prepare("SELECT status FROM learning_runs WHERE id=?").get(id) as
      | { status: string }
      | undefined;
    if (!row || row.status === "settled") throw new Error("Run is not unresolved");
    // Reconciliation accounts for spending only; it cannot manufacture a passing outcome.
    this.db
      .prepare("UPDATE learning_runs SET cost=?,status='settled',passed=0,finished_at=? WHERE id=?")
      .run(JSON.stringify(cost), this.now(), id);
    this.audit("cost-reconciled", id);
  }

  reconcileEpisode(id: string, cost: LearningCost): void {
    LearningCostSchema.parse(cost);
    const episode = this.episode(id);
    if (!episode || episode.cost) throw new Error("Episode is not awaiting cost reconciliation");
    this.db
      .prepare("INSERT INTO learning_episode_costs VALUES (?,?)")
      .run(id, JSON.stringify(cost));
    this.audit("acquisition-cost-reconciled", id);
  }
}
