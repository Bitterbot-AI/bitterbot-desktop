import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { LearningCostSchema, learningHash } from "../../src/agents/skills/collective/contracts.js";
import type { PairedObservation } from "./study.js";
import { ObservationSchema } from "./study.js";

type Cost = z.infer<typeof LearningCostSchema>;
export const ChargeSchema = z
  .object({
    id: z.string(),
    condition: z.enum(["frozen", "local", "exchange", "pooled"]),
    node: z.enum(["a", "b"]),
    phase: z.enum([
      "acquisition",
      "proposal",
      "validation",
      "retry",
      "transfer",
      "selection",
      "final",
    ]),
    quote: LearningCostSchema,
  })
  .strict();
export type Charge = z.infer<typeof ChargeSchema>;
/** Authoritative group totals; node qualification ledgers are not summed a second time. */
export class StudyLedger {
  constructor(
    readonly db: DatabaseSync,
    readonly ceiling: Cost,
  ) {
    LearningCostSchema.parse(ceiling);
    db.exec(`
      CREATE TABLE IF NOT EXISTS study_charges(id TEXT PRIMARY KEY, condition TEXT NOT NULL, node TEXT NOT NULL, body TEXT NOT NULL, state TEXT NOT NULL, cost TEXT, observation TEXT, artifact TEXT);
      CREATE TABLE IF NOT EXISTS study_commands(id TEXT PRIMARY KEY, input_hash TEXT NOT NULL, state TEXT NOT NULL, result TEXT);
      CREATE TABLE IF NOT EXISTS study_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
  }
  reserve(input: unknown): void {
    const charge = ChargeSchema.parse(input);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const prior = this.db.prepare("SELECT body FROM study_charges WHERE id=?").get(charge.id) as
        | { body: string }
        | undefined;
      if (prior) {
        if (learningHash(JSON.parse(prior.body)) !== learningHash(charge))
          throw new Error("Conflicting charge identity");
      } else {
        const costs = this.db
          .prepare("SELECT body,cost FROM study_charges WHERE condition=?")
          .all(charge.condition) as Array<{ body: string; cost: string | null }>;
        const total = costs.reduce(
          (sum, row) => {
            const c = row.cost
              ? LearningCostSchema.parse(JSON.parse(row.cost))
              : ChargeSchema.parse(JSON.parse(row.body)).quote;
            return {
              providerUsd: sum.providerUsd + c.providerUsd,
              toolCalls: sum.toolCalls + c.toolCalls,
              wallMs: sum.wallMs + c.wallMs,
            };
          },
          { providerUsd: 0, toolCalls: 0, wallMs: 0 },
        );
        if (
          Object.keys(total).some(
            (key) =>
              total[key as keyof Cost] + charge.quote[key as keyof Cost] >
              this.ceiling[key as keyof Cost],
          )
        )
          throw new Error("Study group ceiling exhausted");
        this.db
          .prepare("INSERT INTO study_charges VALUES (?,?,?,?, 'reserved',NULL,NULL,NULL)")
          .run(charge.id, charge.condition, charge.node, JSON.stringify(charge));
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  finish(id: string, input: unknown, artifact: unknown): void {
    const row = this.db
      .prepare("SELECT body,state,observation,artifact FROM study_charges WHERE id=?")
      .get(id) as
      | { body: string; state: string; observation: string | null; artifact: string | null }
      | undefined;
    if (!row) throw new Error("Unreserved study charge");
    const observation = ObservationSchema.parse(input),
      charge = ChargeSchema.parse(JSON.parse(row.body));
    if (
      observation.condition !== charge.condition ||
      observation.node !== charge.node ||
      observation.phase !== charge.phase
    )
      throw new Error("Charge binding mismatch");
    const body = JSON.stringify(observation),
      detail = JSON.stringify(artifact ?? null);
    if (row.state !== "reserved") {
      if (row.observation !== body || row.artifact !== detail)
        throw new Error("Conflicting charge settlement");
      return;
    }
    this.db
      .prepare("UPDATE study_charges SET state=?,cost=?,observation=?,artifact=? WHERE id=?")
      .run(
        observation.cost ? "settled" : "unknown",
        observation.cost ? JSON.stringify(observation.cost) : null,
        body,
        detail,
        id,
      );
  }
  observations(): PairedObservation[] {
    return (
      this.db
        .prepare(
          "SELECT observation FROM study_charges WHERE observation IS NOT NULL ORDER BY rowid",
        )
        .all() as { observation: string }[]
    ).map((row) => ObservationSchema.parse(JSON.parse(row.observation)));
  }
  unresolved(): number {
    return (
      this.db.prepare("SELECT COUNT(*) AS n FROM study_charges WHERE state!='settled'").get() as {
        n: number;
      }
    ).n;
  }
  startCommand(id: string, input: unknown): unknown {
    const hash = learningHash(input),
      prior = this.db
        .prepare("SELECT input_hash,state,result FROM study_commands WHERE id=?")
        .get(id) as { input_hash: string; state: string; result: string | null } | undefined;
    if (prior) {
      if (prior.input_hash !== hash)
        throw new Error("Command identity reused with different input");
      if (prior.state === "done") return JSON.parse(prior.result!);
      throw new Error(`Uncertain command ${id}; reconcile its worker journal before retrying`);
    }
    this.db.prepare("INSERT INTO study_commands VALUES (?,?,'running',NULL)").run(id, hash);
    return undefined;
  }
  finishCommand(id: string, result: unknown): void {
    this.db
      .prepare("UPDATE study_commands SET state='done',result=? WHERE id=?")
      .run(JSON.stringify(result), id);
  }
}
