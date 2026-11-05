import {
  LearningStrategySchema,
  type LearningStrategy,
  type StrategyEvaluation,
} from "./learning-strategy-contract.js";
import { learningHash } from "./procedural-learning-contract.js";
import type { ProceduralLearningStore } from "./procedural-learning-store.js";

/** A search archive in the existing database; no strategy is an active skill. */
export class LearningStrategyArchive {
  constructor(readonly store: ProceduralLearningStore) {
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS strategy_entries(hash TEXT PRIMARY KEY, body TEXT NOT NULL, origin TEXT NOT NULL,
        revoked INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS strategy_parents(child TEXT NOT NULL,parent TEXT NOT NULL,PRIMARY KEY(child,parent));
      CREATE TABLE IF NOT EXISTS strategy_panels(id TEXT PRIMARY KEY,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS strategy_cases(panel TEXT NOT NULL,id TEXT NOT NULL,input_hash TEXT NOT NULL,
        partition TEXT NOT NULL,PRIMARY KEY(panel,id));
      CREATE TABLE IF NOT EXISTS strategy_batches(id TEXT PRIMARY KEY,strategy TEXT NOT NULL,panel TEXT NOT NULL,
        result TEXT,created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS strategy_trials(run_id TEXT PRIMARY KEY,batch TEXT NOT NULL,case_id TEXT NOT NULL,feedback TEXT);
      CREATE TABLE IF NOT EXISTS strategy_proposals(run_id TEXT PRIMARY KEY,parent TEXT NOT NULL,child TEXT);
      CREATE TABLE IF NOT EXISTS strategy_seals(scope TEXT PRIMARY KEY,candidates TEXT NOT NULL);
    `);
  }
  requireShadow(): void {
    if (this.store.config.mode !== "shadow") throw new Error("Strategy lab is shadow-only");
  }
  get(hash: string): LearningStrategy | null {
    const blocked = this.store.db
      .prepare(`WITH RECURSIVE ancestors(hash) AS (SELECT ? UNION
      SELECT p.parent FROM strategy_parents p JOIN ancestors a ON p.child=a.hash)
      SELECT 1 FROM ancestors a LEFT JOIN strategy_entries e ON e.hash=a.hash
      WHERE e.hash IS NULL OR e.revoked=1 OR json_extract(e.body,'$.expiresAt')<=? LIMIT 1`)
      .get(hash, this.store.now());
    if (blocked) return null;
    const row = this.store.db
      .prepare("SELECT body,revoked FROM strategy_entries WHERE hash=?")
      .get(hash) as { body: string; revoked: number } | undefined;
    if (!row || row.revoked) return null;
    const strategy = LearningStrategySchema.parse(JSON.parse(row.body));
    return strategy.expiresAt > this.store.now() ? strategy : null;
  }
  isSealed(scope: LearningStrategy["scope"]): boolean {
    return !!this.store.db
      .prepare("SELECT 1 FROM strategy_seals WHERE scope=?")
      .get(learningHash(scope));
  }
  add(input: unknown, origin: "host" | "proposal" | "peer" = "host"): string {
    this.requireShadow();
    const strategy = LearningStrategySchema.parse(input),
      hash = learningHash(strategy);
    if (this.isSealed(strategy.scope)) throw new Error("Search is sealed");
    if (
      strategy.expiresAt <= this.store.now() ||
      strategy.expiresAt > this.store.now() + this.store.config.maxAgeDays * 86400000
    )
      throw new Error("Invalid strategy lifetime");
    if (new Set(strategy.parents).size !== strategy.parents.length)
      throw new Error("Duplicate strategy parents");
    if (origin !== "peer")
      for (const parentHash of strategy.parents) {
        const parent = this.get(parentHash);
        if (!parent || learningHash(parent.scope) !== learningHash(strategy.scope))
          throw new Error("Unavailable strategy parent");
        if (strategy.sharing === "shareable" && parent.sharing !== "shareable")
          throw new Error("Private strategy ancestry");
      }
    const existing = this.store.db
      .prepare("SELECT hash FROM strategy_entries WHERE hash=?")
      .get(hash);
    if (existing) {
      if (!this.get(hash)) throw new Error("Strategy was withdrawn");
      return hash;
    }
    const count = this.store.db.prepare("SELECT COUNT(*) AS n FROM strategy_entries").get() as {
      n: number;
    };
    if (count.n >= this.store.config.maxEntries)
      throw new Error("Strategy archive capacity reached");
    this.store.db.exec("SAVEPOINT strategy_add");
    try {
      this.store.db
        .prepare("INSERT INTO strategy_entries(hash,body,origin,created_at) VALUES (?,?,?,?)")
        .run(hash, JSON.stringify(strategy), origin, this.store.now());
      for (const parent of strategy.parents)
        this.store.db.prepare("INSERT INTO strategy_parents VALUES (?,?)").run(hash, parent);
      this.store.db.exec("RELEASE strategy_add");
    } catch (error) {
      this.store.db.exec("ROLLBACK TO strategy_add; RELEASE strategy_add");
      throw error;
    }
    this.store.audit("strategy-candidate", hash);
    return hash;
  }
  revoke(hash: string): void {
    this.store.db
      .prepare(`WITH RECURSIVE descendants(hash) AS (SELECT ? UNION
      SELECT p.child FROM strategy_parents p JOIN descendants d ON p.parent=d.hash)
      UPDATE strategy_entries SET revoked=1 WHERE hash IN descendants`)
      .run(hash);
    this.store.audit("strategy-revoked", hash);
  }
  rank(panel: string): StrategyEvaluation[] {
    const metadata = this.store.db
      .prepare("SELECT body FROM strategy_panels WHERE id=?")
      .get(panel) as { body: string } | undefined;
    if (!metadata || JSON.parse(metadata.body).partition !== "development")
      throw new Error("Selection requires development evidence");
    const rows = this.store.db
      .prepare(
        "SELECT result FROM strategy_batches WHERE panel=? AND result IS NOT NULL ORDER BY rowid DESC",
      )
      .all(panel) as { result: string }[];
    const seen = new Set<string>();
    return rows
      .map((row) => JSON.parse(row.result) as StrategyEvaluation)
      .filter((result) => {
        if (seen.has(result.strategy) || !this.get(result.strategy)) return false;
        seen.add(result.strategy);
        return true;
      })
      .toSorted(
        (a, b) =>
          b.score - a.score ||
          a.cost.providerUsd - b.cost.providerUsd ||
          a.strategy.localeCompare(b.strategy),
      );
  }
  feedback(panel: string, hash: string): string[] {
    const result = this.rank(panel).find((entry) => entry.strategy === hash);
    if (!result) throw new Error("No complete local development evaluation");
    return (
      this.store.db
        .prepare("SELECT feedback FROM strategy_trials WHERE batch=? ORDER BY rowid")
        .all(result.batch) as { feedback: string }[]
    ).map((row) => row.feedback);
  }
  seal(scope: LearningStrategy["scope"], hashes: string[]): void {
    this.requireShadow();
    const costs = this.store.costs();
    if (costs.unknownRuns || costs.unknownAcquisitions)
      throw new Error("Cannot seal unresolved operations");
    if (
      !hashes.length ||
      hashes.length > 32 ||
      new Set(hashes).size !== hashes.length ||
      hashes.some(
        (hash) => !this.get(hash) || learningHash(this.get(hash)!.scope) !== learningHash(scope),
      )
    )
      throw new Error("Invalid evaluation seal");
    this.store.db
      .prepare("INSERT INTO strategy_seals VALUES (?,?)")
      .run(learningHash(scope), JSON.stringify(hashes));
  }
}
