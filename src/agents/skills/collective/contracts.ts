import { createHash } from "node:crypto";
import { z } from "zod";
import { learningHash, LearningCostSchema } from "../../../memory/procedural-learning-contract.js";

export const PACKAGE_LIMITS = {
  bytes: 10 * 1024 * 1024,
  files: 128,
  depth: 16,
  chunk: 24 * 1024,
} as const;
export const HashSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const IdentitySchema = z.string().regex(/^ed25519:[a-f0-9]{64}$/);
export const IdSchema = z.string().min(1).max(200);
export const RequirementsSchema = z
  .object({
    platforms: z.array(IdSchema).max(16).default([]),
    tools: z.record(IdSchema, IdSchema).default({}),
    capabilities: z.array(IdSchema).max(32).default([]),
    runtime: z.record(IdSchema, IdSchema).default({}),
  })
  .strict();
export const ManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    name: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
    description: z.string().min(1).max(2000),
    entrypoint: z.literal("SKILL.md"),
    requirements: RequirementsSchema,
    files: z
      .array(
        z
          .object({
            path: IdSchema,
            hash: HashSchema,
            size: z.number().int().nonnegative(),
            executable: z.boolean(),
          })
          .strict(),
      )
      .min(1)
      .max(PACKAGE_LIMITS.files),
  })
  .strict();
export type SkillPackageManifest = z.infer<typeof ManifestSchema>;
export type PackageSnapshot = {
  packageHash: string;
  manifest: SkillPackageManifest;
  files: ReadonlyMap<string, Buffer>;
  omitted: string[];
};
export const ScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("private") }).strict(),
  z.object({ kind: z.literal("circle"), circleId: IdSchema }).strict(),
  z.object({ kind: z.literal("public") }).strict(),
]);
export type SharingScope = z.infer<typeof ScopeSchema>;
export const ReleaseSchema = z
  .object({
    protocol: z.literal("bitterbot/skill-release/1"),
    publisher: IdentitySchema,
    skillId: IdSchema,
    version: z.number().int().positive(),
    packageHash: HashSchema,
    requirementsSummary: RequirementsSchema.optional(),
    previousRelease: HashSchema.nullable(),
    parents: z.array(HashSchema).max(16),
    scope: ScopeSchema,
    issuedAt: z.number().int().positive(),
    signature: z.string().regex(/^[a-f0-9]{128}$/),
  })
  .strict();
export type SkillRelease = z.infer<typeof ReleaseSchema>;
export const EnvironmentSchema = z
  .object({
    model: IdSchema,
    tools: z.record(IdSchema, IdSchema),
    runtime: z.record(IdSchema, IdSchema),
    checkerHash: HashSchema,
  })
  .strict();
export type SkillEnvironment = z.infer<typeof EnvironmentSchema>;
export const OutcomeSchema = z.enum([
  "pass",
  "task-failure",
  "infrastructure",
  "checker-invalid",
  "interrupted",
]);
export type SkillOutcome = z.infer<typeof OutcomeSchema>;
export const ReceiptSchema = z
  .object({
    id: IdSchema,
    packageHash: HashSchema.nullable(),
    node: IdSchema,
    runId: IdSchema,
    taskHash: HashSchema,
    family: IdSchema,
    environment: EnvironmentSchema,
    partition: z.enum(["acquisition", "selection", "held-out", "canary"]),
    outcome: OutcomeSchema,
    accessedFiles: z.array(IdSchema).max(PACKAGE_LIMITS.files),
    cost: LearningCostSchema.nullable(),
    occurredAt: z.number().int().positive(),
  })
  .strict();
export type SkillExecutionReceipt = z.infer<typeof ReceiptSchema>;
export type PackageState =
  | "candidate"
  | "screened"
  | "locally-validated"
  | "canary"
  | "stable"
  | "blocked"
  | "stale"
  | "rolled-back"
  | "revoked";
export const PolicySchema = z
  .object({
    id: IdSchema,
    scope: ScopeSchema,
    enabled: z.boolean(),
    agents: z.array(IdSchema).min(1).max(64),
    publishers: z.array(IdentitySchema).min(1).max(128),
    skillIds: z.array(IdSchema).min(1).max(128),
    operations: z.array(z.enum(["publish", "evidence", "evaluate", "adopt"])).max(4),
    categories: z
      .array(z.enum(["skill-package", "execution-summary", "minimal-reproduction"]))
      .max(3),
    capabilities: z.array(IdSchema).max(32),
    budget: LearningCostSchema,
    packageHashes: z.array(HashSchema).max(128).optional(),
    expiresAt: z.number().int().positive(),
  })
  .strict();
export type SkillSharingPolicy = z.infer<typeof PolicySchema>;
export const sha256 = (bytes: Uint8Array | string): string =>
  createHash("sha256").update(bytes).digest("hex");
export const packageHash = (manifest: SkillPackageManifest): string => learningHash(manifest);
export const lineageId = (release: Pick<SkillRelease, "publisher" | "skillId">): string =>
  `${release.publisher}/${release.skillId}`;
export { learningHash, LearningCostSchema };
