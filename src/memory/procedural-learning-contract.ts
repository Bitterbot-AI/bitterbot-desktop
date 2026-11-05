import { createHash } from "node:crypto";
import { z } from "zod";

const id = z.string().trim().min(1).max(200);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const LearningScopeSchema = z
  .object({
    tool: id,
    version: id,
    operation: id,
    contractHash: hash,
  })
  .strict();
export const LearningCostSchema = z
  .object({
    providerUsd: z.number().finite().nonnegative(),
    toolCalls: z.number().int().nonnegative(),
    wallMs: z.number().finite().nonnegative(),
  })
  .strict();
export const LearningConfigSchema = z
  .object({
    mode: z.enum(["off", "shadow", "active"]).default("shadow"),
    maxEntries: z.number().int().min(1).max(10000).default(1000),
    maxResults: z.number().int().min(1).max(10).default(3),
    maxAgeDays: z.number().int().min(1).max(365).default(30),
    toolScopes: z.record(z.string().min(1), LearningScopeSchema).default({}),
    executionBudget: LearningCostSchema.default({ providerUsd: 0, toolCalls: 100, wallMs: 60000 }),
    automation: z
      .object({
        enabled: z.boolean().default(true),
        maxLlmCalls: z.number().int().min(1).max(256).default(64),
        maxAgentTurns: z.number().int().min(1).max(1000).default(240),
        maxWallMinutes: z.number().int().min(1).max(180).default(60),
      })
      .strict()
      .default({ enabled: true, maxLlmCalls: 64, maxAgentTurns: 240, maxWallMinutes: 60 }),
    experienceMemory: z
      .object({
        enabled: z.boolean().default(true),
        maxPromptChars: z.number().int().min(512).max(12000).default(6000),
        minSupport: z.number().int().min(2).max(10).default(2),
      })
      .strict()
      .default({ enabled: true, maxPromptChars: 6000, minSupport: 2 }),
  })
  .strict();
export const LearningCandidateSchema = z
  .object({
    schemaVersion: z.literal(1),
    scope: LearningScopeSchema,
    lesson: z.string().trim().min(1).max(4000),
    // Program data is interpreted only by a host-registered, versioned adapter.
    adapter: id,
    program: z.string().min(1).max(16000),
    counterexamples: z.array(z.string().min(1).max(1000)).min(1).max(20),
    parents: z.array(hash).max(16),
    sourceEpisodes: z.array(id).min(1).max(32),
    origin: z.enum(["experience", "dream", "peer"]),
    sharing: z.enum(["private", "shareable"]),
    expiresAt: z.number().int().positive(),
  })
  .strict();

export type LearningScope = z.infer<typeof LearningScopeSchema>;
export type LearningCost = z.infer<typeof LearningCostSchema>;
export type LearningCandidate = z.infer<typeof LearningCandidateSchema>;
export type LearningConfig = z.infer<typeof LearningConfigSchema>;
export type LearningConfigInput = z.input<typeof LearningConfigSchema>;

/** Omission enables the shadow service; malformed settings never opt into it. */
export function resolveLearningConfig(input: unknown): LearningConfig {
  return LearningConfigSchema.parse(input === undefined ? {} : input);
}

export const ZERO_LEARNING_COST: LearningCost = { providerUsd: 0, toolCalls: 0, wallMs: 0 };

/** Canonical hashes do not depend on JSON property order. Only JSON data is accepted. */
export function learningHash(value: unknown): string {
  const canonical = (item: unknown): string => {
    if (item === null || typeof item === "string" || typeof item === "boolean")
      return JSON.stringify(item);
    if (typeof item === "number" && Number.isFinite(item)) return JSON.stringify(item);
    if (Array.isArray(item)) return `[${item.map(canonical).join(",")}]`;
    if (typeof item === "object" && item && Object.getPrototypeOf(item) === Object.prototype) {
      return `{${Object.keys(item)
        .toSorted()
        .map((key) => `${JSON.stringify(key)}:${canonical((item as Record<string, unknown>)[key])}`)
        .join(",")}}`;
    }
    throw new Error("Learning evidence must be finite JSON data");
  };
  return createHash("sha256").update(canonical(value)).digest("hex");
}

export function addLearningCost(a: LearningCost, b: LearningCost): LearningCost {
  return LearningCostSchema.parse({
    providerUsd: a.providerUsd + b.providerUsd,
    toolCalls: a.toolCalls + b.toolCalls,
    wallMs: a.wallMs + b.wallMs,
  });
}
export function withinLearningBudget(cost: LearningCost, budget: LearningCost): boolean {
  return (
    cost.providerUsd <= budget.providerUsd &&
    cost.toolCalls <= budget.toolCalls &&
    cost.wallMs <= budget.wallMs
  );
}

export const LearningEpisodeSchema = z
  .object({
    id,
    scope: LearningScopeSchema,
    outcome: z.enum(["failure", "success", "unknown"]),
    // Raw arguments, outputs and credentials are deliberately not captured here.
    traceHash: hash,
    cost: LearningCostSchema.nullable(),
    partition: z.enum(["acquisition", "held-out"]),
    sharing: z.enum(["private", "shareable"]),
    occurredAt: z.number().int().positive(),
  })
  .strict();
export type LearningEpisode = z.infer<typeof LearningEpisodeSchema>;

export type LearningEntry = {
  hash: string;
  candidate: LearningCandidate;
  state: "candidate" | "verified" | "revoked";
  createdAt: number;
};

export const LearningVerdictSchema = z.enum([
  "pass",
  "candidate-failure",
  "verifier-invalid",
  "resource-exhausted",
  "interrupted",
  "legacy-unclassified",
]);
export type LearningVerdict = z.infer<typeof LearningVerdictSchema>;
export type LearningVerification = {
  passed: boolean;
  /** Omitted by legacy trusted adapters: false retains its historical candidate-failure meaning. */
  classification?: Exclude<LearningVerdict, "interrupted" | "legacy-unclassified">;
  cost: LearningCost;
};

/** This is a host capability, never deserialized from a model or peer message.
 * execute must be read-only or sandboxed; transactional live mutations need a separate
 * approved host integration. verify must inspect actual outcomes using a pinned oracle.
 * Both callbacks must honor AbortSignal and the reserved maximum cost. */
export interface LearningAdapter {
  id: string;
  scope: LearningScope;
  verifierHash: string;
  isolation: "read-only" | "sandbox";
  /** Host-authored boundary cases; at least two distinct cases, disjoint from evaluation. */
  qualificationCases: readonly unknown[];
  quote(program: string, input: unknown): LearningCost;
  execute(
    program: string,
    input: unknown,
    signal: AbortSignal,
  ): Promise<{ output: unknown; cost: LearningCost }>;
  verify(input: unknown, output: unknown, signal: AbortSignal): Promise<LearningVerification>;
  /** Optional pure, host-authored redaction/extraction. Never include credentials or
   * private raw payloads. Called only after a settled acquisition verification.
   * The receipt establishes the outcome, not the truth of explanatory prose. */
  describeExperience?(
    input: unknown,
    output: unknown,
  ): {
    cue: string;
    context: Record<string, string>;
    action: string;
    check: string;
    detail: string;
  };
}
