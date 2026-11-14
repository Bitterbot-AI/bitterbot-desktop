import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { KeyPair } from "../../../commerce/envelope.js";
import type { LearningCost } from "../../../memory/procedural-learning-contract.js";
import { ProceduralLearningStore } from "../../../memory/procedural-learning-store.js";
import {
  EnvironmentSchema,
  HashSchema,
  IdentitySchema,
  IdSchema,
  LearningCostSchema,
  OutcomeSchema,
  ReceiptSchema,
  ScopeSchema,
  learningHash,
  lineageId,
  type PackageSnapshot,
  type SkillRelease,
  type SkillExecutionReceipt,
} from "./contracts.js";
import type { SkillPolicyService } from "./policy.js";
import { CompletedProposalError } from "./proposal-context.js";
import { signRecord, verifyRecord } from "./signatures.js";
import type { CollectiveSkillStore } from "./store.js";

export const PeerEvidenceSchema = z
  .object({
    protocol: z.literal("bitterbot/skill-evidence/1"),
    packageHash: HashSchema,
    origin: IdentitySchema,
    executionId: IdSchema,
    kind: z.enum(["static-screen", "model-judgment", "source-execution", "recipient-execution"]),
    outcome: OutcomeSchema,
    failure: z.string().max(120),
    environment: EnvironmentSchema,
    conditions: z.record(IdSchema, z.string().max(200)),
    partition: z.enum(["acquisition", "selection"]),
    cost: LearningCostSchema.nullable(),
    scope: ScopeSchema,
    expiresAt: z.number().int().positive(),
    reproduction: z
      .object({
        fixtureId: IdSchema,
        input: z.record(
          IdSchema,
          z.union([z.string().max(400), z.number().finite(), z.boolean(), z.null()]),
        ),
      })
      .strict()
      .optional(),
    signature: z.string().regex(/^[a-f0-9]{128}$/),
  })
  .strict();
export type PeerEvidenceSummary = z.infer<typeof PeerEvidenceSchema>;

export class PeerEvidenceStore {
  constructor(readonly store: CollectiveSkillStore) {}
  import(input: unknown): string {
    const evidence = PeerEvidenceSchema.parse(input);
    if (
      JSON.stringify(evidence).length > 8000 ||
      Object.keys(evidence.conditions).length > 16 ||
      evidence.scope.kind === "private" ||
      evidence.expiresAt <= this.store.now() ||
      evidence.expiresAt > this.store.now() + 30 * 86400000 ||
      !verifyRecord(evidence.protocol, evidence, evidence.origin)
    )
      throw new Error("Invalid or expired peer evidence");
    const id = learningHash(evidence);
    const prior = this.store.db
      .prepare("SELECT id FROM collective_evidence WHERE origin=? AND execution=?")
      .get(evidence.origin, evidence.executionId) as { id: string } | undefined;
    if (prior && prior.id !== id) throw new Error("Conflicting execution evidence");
    const count = this.store.db.prepare("SELECT COUNT(*) AS n FROM collective_evidence").get() as {
      n: number;
    };
    if (!prior && count.n >= 10000) throw new Error("Peer evidence capacity reached");
    this.store.db
      .prepare("INSERT OR IGNORE INTO collective_evidence VALUES (?,?,?,?,?)")
      .run(
        id,
        evidence.origin,
        evidence.executionId,
        evidence.packageHash,
        JSON.stringify(evidence),
      );
    return id;
  }
  export(
    agent: string,
    release: SkillRelease,
    receiptId: string,
    policies: SkillPolicyService,
    key: KeyPair,
    description: Pick<PeerEvidenceSummary, "failure" | "conditions">,
    reproduction?: PeerEvidenceSummary["reproduction"],
  ): PeerEvidenceSummary {
    policies.authorize(agent, release, "evidence", "execution-summary");
    if (reproduction) policies.authorize(agent, release, "evidence", "minimal-reproduction");
    this.store.assertDisclosure(release.packageHash, release.scope);
    const row = this.store.db
      .prepare("SELECT body FROM collective_receipts WHERE id=?")
      .get(receiptId) as { body: string } | undefined;
    if (!row) throw new Error("No host execution receipt");
    const receipt = ReceiptSchema.parse(JSON.parse(row.body));
    if (
      receipt.packageHash !== release.packageHash ||
      !["acquisition", "selection"].includes(receipt.partition) ||
      receipt.node !== `ed25519:${key.publicKeyHex}`
    )
      throw new Error("Receipt is not eligible for disclosure");
    const value = PeerEvidenceSchema.parse(
      signRecord(
        "bitterbot/skill-evidence/1",
        {
          protocol: "bitterbot/skill-evidence/1",
          packageHash: release.packageHash,
          origin: receipt.node,
          executionId: receipt.id,
          kind: release.publisher === receipt.node ? "source-execution" : "recipient-execution",
          outcome: receipt.outcome,
          environment: receipt.environment,
          partition: receipt.partition,
          cost: receipt.cost,
          scope: release.scope,
          expiresAt: this.store.now() + 30 * 86400000,
          ...description,
          ...(reproduction ? { reproduction } : {}),
        },
        key,
      ),
    );
    policies.authorize(agent, release, "evidence", "execution-summary");
    if (reproduction) policies.authorize(agent, release, "evidence", "minimal-reproduction");
    return value;
  }
  select(release: SkillRelease): Array<{ id: string; evidence: PeerEvidenceSummary }> {
    const rows = this.store.db
      .prepare("SELECT id,body FROM collective_evidence WHERE hash=? ORDER BY id")
      .all(release.packageHash) as { id: string; body: string }[];
    const byOrigin = new Map<string, Array<{ id: string; evidence: PeerEvidenceSummary }>>();
    for (const row of rows) {
      const evidence = PeerEvidenceSchema.parse(JSON.parse(row.body));
      if (
        evidence.expiresAt <= this.store.now() ||
        learningHash(evidence.scope) !== learningHash(release.scope)
      )
        continue;
      const group = byOrigin.get(evidence.origin) ?? [];
      group.push({ id: row.id, evidence });
      byOrigin.set(evidence.origin, group);
    }
    const origins = [...byOrigin.keys()].toSorted().slice(0, 8);
    const selected: Array<{ id: string; evidence: PeerEvidenceSummary }> = [];
    let chars = 2;
    // Four inputs per origin prevent a prolific node filling unused slots.
    // Preserve distinct mechanisms/environments/outcomes before repeated observations.
    for (const [origin, reports] of byOrigin) {
      const groups = new Map<string, typeof reports>();
      for (const report of reports) {
        const key = learningHash({
          failure: report.evidence.failure,
          environment: report.evidence.environment,
          conditions: report.evidence.conditions,
          outcome: report.evidence.outcome,
          kind: report.evidence.kind,
        });
        const group = groups.get(key) ?? [];
        group.push(report);
        groups.set(key, group);
      }
      const diverse: typeof reports = [];
      for (let index = 0; index < 4; index++)
        for (const group of groups.values()) if (group[index]) diverse.push(group[index]);
      byOrigin.set(origin, diverse);
    }
    for (let index = 0; index < 4; index++)
      for (const origin of origins) {
        const entry = byOrigin.get(origin)![index];
        if (!entry) continue;
        const size = JSON.stringify(entry).length + (selected.length ? 1 : 0);
        if (selected.length < 32 && chars + size <= 16000) {
          selected.push(entry);
          chars += size;
        }
      }
    return selected;
  }
}

export interface PackageProposalHost {
  quote: LearningCost;
  readonly taskContractHash?: string;
  /** Setup latency is reported separately, not hidden as a model-task speedup. */
  readonly preflightWallMs?: number;
  /** Treat summaries as untrusted observations; output is always a staged candidate. */
  propose(
    input: {
      parent: PackageSnapshot;
      evidence: Array<{ id: string; evidence: PeerEvidenceSummary }>;
    },
    signal: AbortSignal,
  ): Promise<{ snapshot: PackageSnapshot; cost: LearningCost; tokens?: number }>;
}
export async function proposeFromEvidence(
  store: CollectiveSkillStore,
  release: SkillRelease,
  evidence: PeerEvidenceStore,
  host: PackageProposalHost,
  budget: LearningCost,
  signal: AbortSignal,
): Promise<string> {
  const selected = evidence.select(release);
  const origins = new Set(selected.map((e) => e.evidence.origin));
  const localFailure = selected.some(({ evidence: e }) => {
    const row = store.db
      .prepare("SELECT body FROM collective_receipts WHERE id=?")
      .get(e.executionId) as { body: string } | undefined;
    if (!row) return false;
    const receipt = ReceiptSchema.parse(JSON.parse(row.body));
    return (
      receipt.node === e.origin &&
      receipt.packageHash === release.packageHash &&
      receipt.outcome === "task-failure" &&
      receipt.partition !== "held-out"
    );
  });
  if (origins.size < 2 && !localFailure)
    throw new Error("Not enough independent evidence to propose");
  const lineage = lineageId(release),
    day = Math.floor(store.now() / 86400000);
  const ids = selected.map((e) => e.id);
  const ledger = new ProceduralLearningStore(store.db, {}, store.now);
  const run = randomUUID();
  const parent = await store.read(release.packageHash);
  store.transaction(() => {
    store.db.prepare("INSERT INTO collective_proposals VALUES (?,?,'reserved',?)").run(
      lineage,
      day,
      JSON.stringify({
        parent: release.packageHash,
        evidence: ids,
        run,
        taskContractHash: host.taskContractHash ?? null,
        preflightWallMs: host.preflightWallMs ?? null,
      }),
    );
    ledger.reserve(
      {
        id: run,
        candidate: release.packageHash,
        scope: {
          tool: "skill-package",
          operation: "evidence-proposal",
          version: "1",
          contractHash: host.taskContractHash ?? learningHash(parent.manifest.requirements),
        },
        inputHash: learningHash(ids),
        verifier: learningHash("proposal-generation-is-not-validation"),
        partition: "acquisition",
        quote: LearningCostSchema.parse(host.quote),
        predicted: 0,
      },
      budget,
    );
  });
  let cost: LearningCost | null = null;
  try {
    const result = await host.propose({ parent, evidence: selected }, signal);
    cost = LearningCostSchema.parse(result.cost);
    ledger.finish(run, false, cost, "legacy-unclassified");
    if (
      cost.providerUsd > host.quote.providerUsd ||
      cost.toolCalls > host.quote.toolCalls ||
      cost.wallMs > host.quote.wallMs
    )
      throw new Error("Proposal exceeded budget");
    if (result.snapshot.packageHash === parent.packageHash)
      throw new Error("Proposal made no change");
    await store.install(result.snapshot);
    store.inheritOrigins(result.snapshot.packageHash, parent.packageHash);
    store.db
      .prepare("UPDATE collective_proposals SET state='staged',body=? WHERE lineage=? AND day=?")
      .run(
        JSON.stringify({
          parent: parent.packageHash,
          candidate: result.snapshot.packageHash,
          evidence: ids,
          run,
          taskContractHash: host.taskContractHash ?? null,
          preflightWallMs: host.preflightWallMs ?? null,
        }),
        lineage,
        day,
      );
    return result.snapshot.packageHash;
  } catch (error) {
    if (!cost && error instanceof CompletedProposalError) {
      cost = LearningCostSchema.parse(error.cost);
      ledger.finish(run, false, cost, "legacy-unclassified");
    }
    if (!cost) ledger.finish(run, false, null, "interrupted");
    store.db
      .prepare("UPDATE collective_proposals SET state='failed' WHERE lineage=? AND day=?")
      .run(lineage, day);
    throw error;
  }
}

/** An external tool trace is not a host receipt. Never call this to upgrade peer evidence. */
export function evidenceLevel(
  receipt: SkillExecutionReceipt | null,
): "local-execution" | "unverified" {
  return receipt && receipt.cost && ["pass", "task-failure"].includes(receipt.outcome)
    ? "local-execution"
    : "unverified";
}
