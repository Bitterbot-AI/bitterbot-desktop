import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  learningHash,
  LearningCostSchema,
  HashSchema,
  EnvironmentSchema,
} from "../../src/agents/skills/collective/contracts.js";
import { ResearchBriefPublicationDateSchema } from "../../src/agents/skills/collective/research-brief-contract.js";
import { CONDITIONS } from "./study.js";

export const NODE_IDS = ["a", "b"] as const;
export const StudyTaskSchema = z
  .object({
    id: z.string().min(1).max(180),
    family: z.string().min(1).max(180),
    corpus: z.string().min(1).max(180),
    partition: z.enum(["acquisition", "selection", "final"]),
    node: z.enum(NODE_IDS),
    user: z.string().min(1).max(100),
    environment: z.string().min(1).max(100),
    newUser: z.boolean(),
    regression: z.boolean(),
    selectionPanel: z.number().int().nonnegative(),
    input: z
      .object({
        question: z.string().max(1000),
        followUpOwner: z.string().max(100),
        sources: z
          .array(
            z
              .object({
                id: z.string().max(100),
                publishedAt: ResearchBriefPublicationDateSchema,
                metric: z.string().max(100),
                value: z.number().finite(),
                status: z.enum(["current", "superseded"]),
              })
              .strict(),
          )
          .min(1)
          .max(32),
      })
      .strict(),
  })
  .strict();
export type StudyTask = z.infer<typeof StudyTaskSchema>;
export const CorpusSchema = z
  .object({
    schemaVersion: z.literal(1),
    provenance: z.enum(["authored-development-fixtures", "frozen-independent-corpus"]),
    tasks: z.array(StudyTaskSchema).min(1).max(10000),
  })
  .strict();
export type StudyCorpus = z.infer<typeof CorpusSchema>;
export const DeploymentSpecSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
    purpose: z.enum(["development-pilot", "efficacy-study"]),
    baseConfig: z.string().min(1),
    authAgentDirectory: z.string().min(1),
    model: z
      .string()
      .min(3)
      .refine((s) => s.includes("/")),
    sandboxImage: z.string().min(1),
    initialPackageDirectory: z.string().min(1),
    corpusFile: z.string().min(1),
    seed: z.number().int(),
    conditions: z
      .array(z.enum(CONDITIONS))
      .min(1)
      .max(4)
      .refine((a) => new Set(a).size === a.length),
    groupCeiling: LearningCostSchema,
    // Prevent a restarted pilot from silently repeating paid work or running forever.
    maxCanaryBatches: z.number().int().min(1).max(20).default(5),
    retentionHours: z.number().min(24).default(24),
  })
  .strict();
export type DeploymentSpec = z.infer<typeof DeploymentSpecSchema>;
export const FrozenDeploymentSchema = z
  .object({
    schemaVersion: z.literal(1),
    spec: DeploymentSpecSchema,
    createdAt: z.number().int().positive(),
    corpusHash: HashSchema,
    packageHash: HashSchema,
    sandboxImageId: z.string(),
    environments: z.record(z.string(), z.object({ a: EnvironmentSchema, b: EnvironmentSchema })),
    configHashes: z.record(z.string(), HashSchema),
    sourceHashes: z.record(z.string(), HashSchema),
    hash: HashSchema,
  })
  .strict();
export type FrozenDeployment = z.infer<typeof FrozenDeploymentSchema>;

export async function readJson(file: string): Promise<unknown> {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024 * 1024)
    throw new Error("Invalid bounded study input");
  return JSON.parse(await fs.readFile(file, "utf8"));
}
export async function writeNewJson(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await fs.writeFile(file, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
}
export function validateCorpus(input: unknown): StudyCorpus {
  const corpus = CorpusSchema.parse(input);
  const ids = new Set<string>(),
    content = new Set<string>();
  const families = new Map<string, string>(),
    sources = new Map<string, string>();
  for (const task of corpus.tasks) {
    if (ids.has(task.id)) throw new Error("Duplicate task ID");
    ids.add(task.id);
    const hash = learningHash(task.input);
    if (content.has(hash)) throw new Error("Duplicate task content across study instances");
    content.add(hash);
    for (const [map, key] of [
      [families, task.family],
      [sources, task.corpus],
    ] as const) {
      if (map.has(key) && map.get(key) !== task.partition)
        throw new Error("Corpus and task-family partitions must be disjoint");
      map.set(key, task.partition);
    }
    if (new Set(task.input.sources.map((s) => s.id)).size !== task.input.sources.length)
      throw new Error("Duplicate source identity");
    if (task.partition !== "final" && task.newUser)
      throw new Error("New users must be unseen during learning");
    if (task.regression && task.partition !== "selection")
      throw new Error("Regression cases belong to held-out selection only");
  }
  const knownUsers = new Set(
    corpus.tasks.filter((t) => t.partition !== "final").map((t) => t.user),
  );
  for (const task of corpus.tasks.filter((t) => t.partition === "final")) {
    if (task.newUser && knownUsers.has(task.user))
      throw new Error("A new user already appeared during learning");
    if (
      !task.newUser &&
      !corpus.tasks.some(
        (t) => t.partition !== "final" && t.node === task.node && t.user === task.user,
      )
    )
      throw new Error("Retention user was not previously seen on this node");
  }
  for (const node of NODE_IDS) {
    for (const partition of ["acquisition", "selection", "final"] as const)
      if (!corpus.tasks.some((t) => t.node === node && t.partition === partition))
        throw new Error(`Missing ${node}/${partition}`);
    const selection = corpus.tasks.filter((t) => t.node === node && t.partition === "selection");
    if (selection.filter((t) => !t.regression).length < 20 || !selection.some((t) => t.regression))
      throw new Error("Each node needs 20 selection cases and a fixed regression panel");
    if (!corpus.tasks.some((t) => t.node === node && t.partition === "final" && t.newUser))
      throw new Error("Missing new-user transfer cases");
    if (
      corpus.provenance === "frozen-independent-corpus" &&
      !corpus.tasks.some(
        (t) =>
          t.node === node &&
          t.partition === "final" &&
          !corpus.tasks.some(
            (known) => known.partition !== "final" && known.environment === t.environment,
          ),
      )
    )
      throw new Error("Independent efficacy corpus needs unseen final environments");
  }
  return corpus;
}
export function verifyFrozen(input: unknown): FrozenDeployment {
  const frozen = FrozenDeploymentSchema.parse(input);
  const { hash, ...body } = frozen;
  if (learningHash(body) !== hash) throw new Error("Frozen deployment changed");
  return frozen;
}
