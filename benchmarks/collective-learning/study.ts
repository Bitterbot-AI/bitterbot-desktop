import { z } from "zod";
import { learningHash, LearningCostSchema } from "../../src/agents/skills/collective/contracts.js";

export const CONDITIONS = ["frozen", "local", "exchange", "pooled"] as const;
export const StudyManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    studyId: z.string(),
    model: z.string(),
    toolsHash: z.string(),
    initialLibraryHash: z.string(),
    privateMesh: z.literal(true),
    publicPublishing: z.literal(false),
    groupCeiling: LearningCostSchema,
    seed: z.number().int(),
    partitions: z.object({
      development: z.array(z.string()),
      acquisition: z.array(z.string()),
      selection: z.array(z.string()),
      final: z.array(z.string()),
    }),
    targetDelta: z.literal(0.05),
    power: z.literal(0.8),
    confidence: z.literal(0.95),
    minimumRetentionHours: z.literal(24),
    families: z.number().int().positive(),
    tasksPerFamily: z.number().int().positive(),
    pilotHash: z.string(),
    estimatedTotalGroupUsd: z.number().nonnegative(),
  })
  .strict();
export type StudyManifest = z.infer<typeof StudyManifestSchema>;
export type PairedObservation = {
  taskId: string;
  family: string;
  node: string;
  user: string;
  environment: string;
  condition: (typeof CONDITIONS)[number];
  phase: "acquisition" | "proposal" | "validation" | "retry" | "transfer" | "selection" | "final";
  success: boolean | null;
  checked: boolean;
  criticalFailure: boolean;
  retention: boolean;
  freshSession: boolean;
  elapsedHours: number;
  newUser: boolean;
  cost: { providerUsd: number; toolCalls: number; wallMs: number } | null;
  tokens: number;
  latencyMs: number;
  humanUsefulness: number | null;
  humanRecommendation: number | null;
};
export const ObservationSchema: z.ZodType<PairedObservation> = z
  .object({
    taskId: z.string().min(1).max(200),
    family: z.string().min(1).max(200),
    node: z.string().min(1).max(200),
    user: z.string().min(1).max(200),
    environment: z.string().min(1).max(200),
    condition: z.enum(CONDITIONS),
    phase: z.enum([
      "acquisition",
      "proposal",
      "validation",
      "retry",
      "transfer",
      "selection",
      "final",
    ]),
    success: z.boolean().nullable(),
    checked: z.boolean(),
    criticalFailure: z.boolean(),
    retention: z.boolean(),
    freshSession: z.boolean(),
    elapsedHours: z.number().finite().nonnegative(),
    newUser: z.boolean(),
    cost: LearningCostSchema.nullable(),
    tokens: z.number().int().nonnegative(),
    latencyMs: z.number().finite().nonnegative(),
    humanUsefulness: z.number().finite().nullable(),
    humanRecommendation: z.number().finite().nullable(),
  })
  .strict();
export function freezeStudy(input: unknown): { manifest: StudyManifest; hash: string } {
  const manifest = StudyManifestSchema.parse(input);
  const all = Object.values(manifest.partitions).flat();
  if (Object.values(manifest.partitions).some((p) => !p.length) || new Set(all).size !== all.length)
    throw new Error("Corpus/task-family partitions must be nonempty and disjoint");
  if (manifest.families < 20 || !/^[a-f0-9]{64}$/.test(manifest.pilotHash))
    throw new Error("A separate development pilot and at least 20 families are required");
  if (manifest.estimatedTotalGroupUsd > manifest.groupCeiling.providerUsd)
    throw new Error("Budget supports feasibility work only; efficacy study cannot be frozen");
  return { manifest, hash: learningHash(manifest) };
}
/** Planning approximation from independent development-pilot family deltas.
 * Confirm variance and costs before preregistration; these are not study results. */
export function planSample(
  pilotFamilyDeltas: number[],
  usdPerFamily: number,
  authorizedUsd: number,
) {
  if (
    pilotFamilyDeltas.length < 20 ||
    pilotFamilyDeltas.some((d) => !Number.isFinite(d) || Math.abs(d) > 1) ||
    usdPerFamily < 0 ||
    !Number.isFinite(usdPerFamily) ||
    !Number.isFinite(authorizedUsd) ||
    authorizedUsd < 0
  )
    throw new Error("Need at least 20 valid independent pilot families and known costs");
  const mean = pilotFamilyDeltas.reduce((s, d) => s + d, 0) / pilotFamilyDeltas.length;
  const variance =
    pilotFamilyDeltas.reduce((s, d) => s + (d - mean) ** 2, 0) / (pilotFamilyDeltas.length - 1);
  // Floor avoids claiming power from an accidentally constant, tiny pilot.
  const families = Math.max(
    20,
    Math.ceil(((1.9599639845 + 0.8416212336) ** 2 * Math.max(variance, 0.0025)) / 0.05 ** 2),
  );
  return {
    families,
    estimatedTotalGroupUsd: families * usdPerFamily,
    feasible: families * usdPerFamily <= authorizedUsd,
    method: "normal-approximation-family-variance" as const,
  };
}
function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** Primary comparison: pooled vs exchange, paired within task/node/user/environment. */
export function analyzeStudy(
  rows: PairedObservation[],
  manifest: StudyManifest,
  bootstrapSamples = 10000,
) {
  rows = z.array(ObservationSchema).max(100000).parse(rows);
  manifest = freezeStudy(manifest).manifest;
  if (!Number.isInteger(bootstrapSamples) || bootstrapSamples < 100 || bootstrapSamples > 100000)
    throw new Error("Invalid bootstrap sample count");
  const seen = new Set<string>();
  for (const row of rows) {
    const key = `${row.condition}:${row.phase}:${row.node}:${row.taskId}:${row.user}:${row.environment}:${row.retention}`;
    if (seen.has(key)) throw new Error("Duplicate study observation");
    seen.add(key);
    if (row.retention && (!row.freshSession || row.elapsedHours < manifest.minimumRetentionHours))
      throw new Error("Retention requires a fresh session after 24 hours");
  }
  const totals = Object.fromEntries(
    CONDITIONS.map((condition) => {
      const group = rows.filter((r) => r.condition === condition);
      return [
        condition,
        {
          runs: group.length,
          tokens: group.reduce((s, r) => s + r.tokens, 0),
          dollars: group.reduce((s, r) => s + (r.cost?.providerUsd ?? 0), 0),
          toolCalls: group.reduce((s, r) => s + (r.cost?.toolCalls ?? 0), 0),
          wallMs: group.reduce((s, r) => s + (r.cost?.wallMs ?? 0), 0),
          unknownCosts: group.filter((r) => !r.cost).length,
          latencyMs: group.reduce((s, r) => s + r.latencyMs, 0),
          humanUsefulness: group.map((r) => r.humanUsefulness).filter((n) => n !== null),
          humanRecommendation: group.map((r) => r.humanRecommendation).filter((n) => n !== null),
        },
      ];
    }),
  );
  const compare = (subset: PairedObservation[]) => {
    const pairs = new Map<string, Partial<Record<"exchange" | "pooled", PairedObservation>>>();
    for (const row of subset)
      if (row.condition === "exchange" || row.condition === "pooled") {
        const key = `${row.node}:${row.taskId}:${row.user}:${row.environment}`;
        const pair = pairs.get(key) ?? {};
        pair[row.condition] = row;
        pairs.set(key, pair);
      }
    const families = new Map<string, number[]>();
    let incomplete = 0;
    for (const pair of pairs.values()) {
      if (
        !pair.exchange ||
        !pair.pooled ||
        !pair.exchange.checked ||
        !pair.pooled.checked ||
        pair.exchange.success === null ||
        pair.pooled.success === null
      ) {
        incomplete++;
        continue;
      }
      if (pair.exchange.family !== pair.pooled.family)
        throw new Error("Paired task family mismatch");
      const list = families.get(pair.exchange.family) ?? [];
      list.push(Number(pair.pooled.success) - Number(pair.exchange.success));
      families.set(pair.exchange.family, list);
    }
    if (families.size < 2)
      return { pairs: 0, families: families.size, incomplete, delta: null, interval: null };
    const groups = [...families.values()],
      flatten = groups.flat(),
      rng = random(manifest.seed);
    const estimates: number[] = [];
    for (let b = 0; b < bootstrapSamples; b++) {
      let sum = 0,
        n = 0;
      for (let i = 0; i < groups.length; i++) {
        const group = groups[Math.floor(rng() * groups.length)];
        sum += group.reduce((s, d) => s + d, 0);
        n += group.length;
      }
      estimates.push(sum / n);
    }
    const ordered = estimates.toSorted((a, b) => a - b);
    return {
      pairs: flatten.length,
      families: families.size,
      incomplete,
      delta: flatten.reduce((s, d) => s + d, 0) / flatten.length,
      interval: [
        ordered[Math.floor(bootstrapSamples * 0.025)],
        ordered[Math.ceil(bootstrapSamples * 0.975) - 1],
      ],
    };
  };
  const finalRows = rows.filter((r) => r.phase === "final");
  const primary = compare(finalRows.filter((r) => !r.retention));
  const retention = compare(finalRows.filter((r) => r.retention && !r.newUser));
  const newUserTransfer = compare(finalRows.filter((r) => !r.retention && r.newUser));
  const criticalFailures = rows.filter((r) => r.criticalFailure).length;
  const ceilings = Object.values(totals).every(
    (t) =>
      t.dollars <= manifest.groupCeiling.providerUsd &&
      t.toolCalls <= manifest.groupCeiling.toolCalls &&
      t.wallMs <= manifest.groupCeiling.wallMs &&
      t.unknownCosts === 0,
  );
  const complete =
    CONDITIONS.every((condition) =>
      ["acquisition", "selection", "final"].every((phase) =>
        rows.some((r) => r.condition === condition && r.phase === phase),
      ),
    ) &&
    primary.families >= manifest.families &&
    primary.pairs >= manifest.families * manifest.tasksPerFamily &&
    primary.incomplete === 0 &&
    retention.families >= manifest.families &&
    retention.incomplete === 0 &&
    newUserTransfer.families >= manifest.families &&
    newUserTransfer.incomplete === 0;
  return {
    manifestHash: learningHash(manifest),
    primary,
    retention,
    newUserTransfer,
    totals,
    criticalFailures,
    conclusion:
      complete &&
      ceilings &&
      criticalFailures === 0 &&
      primary.delta !== null &&
      primary.delta >= 0.05 &&
      primary.interval &&
      primary.interval[0] > 0
        ? "success"
        : "inconclusive-or-negative",
  };
}

/** All cost phases are charged by the host ledger, including failed candidates and retries. */
export interface StudyDriver {
  configure(
    condition: (typeof CONDITIONS)[number],
    options: {
      localLearning: boolean;
      exchange: boolean;
      synthesis: boolean;
      publicPublishing: false;
    },
  ): Promise<void>;
  run(
    condition: (typeof CONDITIONS)[number],
    partition: "acquisition" | "selection" | "final",
    sources: readonly string[],
    signal: AbortSignal,
  ): Promise<PairedObservation[]>;
}
export async function runStudy(
  frozen: ReturnType<typeof freezeStudy>,
  driver: StudyDriver,
  signal: AbortSignal,
): Promise<PairedObservation[]> {
  if (learningHash(frozen.manifest) !== frozen.hash) throw new Error("Frozen manifest changed");
  const rows: PairedObservation[] = [];
  for (const condition of CONDITIONS) {
    signal.throwIfAborted();
    await driver.configure(condition, {
      localLearning: condition !== "frozen",
      exchange: condition === "exchange" || condition === "pooled",
      synthesis: condition === "pooled",
      publicPublishing: false,
    });
    for (const partition of ["acquisition", "selection", "final"] as const) {
      const outcomes = await driver.run(
        condition,
        partition,
        frozen.manifest.partitions[partition],
        signal,
      );
      rows.push(...outcomes);
    }
  }
  return rows;
}
