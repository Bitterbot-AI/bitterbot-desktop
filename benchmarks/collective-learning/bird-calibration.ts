import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { z } from "zod";
import { learningHash, sha256 } from "../../src/agents/skills/collective/contracts.js";
import type { ResearchBriefHostOptions } from "../../src/agents/skills/collective/research-brief.js";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const BirdFixtureSchema = z.strictObject({
  schemaVersion: z.literal(1),
  upstreamRevision: z.string(),
  annotationSha256: hash,
  selectionSeed: z.string(),
  cases: z
    .array(
      z.strictObject({
        id: z.string().regex(/^bird-[0-9]+$/),
        family: z.string().regex(/^[a-z0-9_]+$/),
        difficulty: z.literal("challenging"),
        input: z.strictObject({
          question: z.string().min(1),
          evidence: z.string(),
          databaseFile: z.literal("database.sqlite"),
          dialect: z.literal("SQLite"),
          schema: z.array(z.string()),
          schemaDocumentation: z.string(),
        }),
        databaseSha256: hash,
        databaseBytes: z
          .number()
          .int()
          .positive()
          .max(1024 * 1024 * 1024),
        referenceSql: z.string().min(1).max(65536),
        referenceDigest: hash,
      }),
    )
    .length(22),
});
export type BirdFixture = z.infer<typeof BirdFixtureSchema>;
export const BirdGradeSchema = z.object({
  status: z.enum(["pass", "task-failure", "checker-invalid"]),
  bagMatch: z.boolean().optional(),
  setMatch: z.boolean().optional(),
  orderedMatch: z.boolean().optional(),
  reason: z.string().optional(),
  detail: z.string().optional(),
  expectedRows: z.number().optional(),
  actualRows: z.number().optional(),
  referenceDigest: hash.optional(),
  actualDigest: hash.optional(),
});
export type BirdGrade = z.infer<typeof BirdGradeSchema>;
export const BIRD_PROMPT = `Solve the database question in /workspace/sources.json using the supplied SQLite database /workspace/database.sqlite. The input includes the original question, evidence, actual table definitions, and official public schema documentation. Python 3 with the sqlite3 standard library is available through exec; you may inspect the database and test your query offline. No other source or network access is needed.
Write /workspace/brief.json containing exactly one field, "sql", whose value is a single read-only SQLite SELECT query (WITH is allowed) that answers the question. Write a short explanation in /workspace/brief.md. Do not return a hardcoded answer table. Preserve the requested output columns in the order requested; do not add extra identifiers or labels unless requested. Respect duplicates, missing values, units, date boundaries, exact tag matching and ties as stated in the question. Match the requested rounding. The primary checker compares exact result rows as a multiset, preserving duplicate counts and column order; row ordering is not scored. The upstream set-only result is reported separately. Write operations, extensions, ATTACH, PRAGMA and multiple statements are rejected by the checker. Each final query has a 30-second execution limit. The checker executes your SQL on a separate unchanged database, so editing your working copy cannot affect grading. Expected answers and reference queries are not available to you.`;

/** Trusted orchestration only: checker and reference query go to a separate offline container. */
export async function checkBirdSql(
  item: BirdFixture["cases"][number],
  predicted: string,
  databaseRoot: string,
  image: string,
  checkerFile: string,
): Promise<BirdGrade> {
  const database = path.join(databaseRoot, `${item.family}.sqlite`);
  if (sha256(await fs.readFile(database)) !== item.databaseSha256)
    throw new Error("Original checker database changed");
  const name = `bitterbot-bird-check-${randomUUID()}`;
  const args = [
    "run",
    "--rm",
    "--pull=never",
    "-i",
    "--name",
    name,
    "--label",
    "bitterbot.study=bird-calibration",
    "--network=none",
    "--read-only",
    "--tmpfs",
    "/tmp:rw,nosuid,nodev,size=64m",
    "--memory=512m",
    "--cpus=1",
    "--pids-limit=32",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--user=65534:65534",
    "--mount",
    `type=bind,src=${database},dst=/data/database.sqlite,readonly`,
    "--mount",
    `type=bind,src=${checkerFile},dst=/checker.py,readonly`,
    "--entrypoint",
    "python3",
    image,
    "/checker.py",
  ];
  try {
    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "",
        stderr = "";
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("SQL checker timed out"));
      }, 75000);
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.stdout.on("data", (data: Buffer) => {
        stdout += data.toString();
        if (stdout.length > 16384) {
          child.kill("SIGKILL");
          reject(new Error("Checker output overflow"));
        }
      });
      child.stderr.on("data", (data: Buffer) => {
        stderr = (stderr + data.toString()).slice(0, 4096);
      });
      child.stdin.on("error", () => {
        /* Exit status diagnoses a failed checker container. */
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code !== 0) reject(new Error(`SQL checker failed: ${stderr}`));
        else resolve(stdout);
      });
      child.stdin.end(
        JSON.stringify({
          database: "/data/database.sqlite",
          reference: item.referenceSql,
          predicted,
          referenceDigest: item.referenceDigest,
        }),
      );
    });
    return BirdGradeSchema.parse(JSON.parse(output));
  } finally {
    // This UUID name was created by this invocation; never sweep unrelated containers.
    await promisify(execFile)("docker", ["rm", "-f", name], { timeout: 15000 }).catch(() => {});
  }
}

export async function birdProtocol(
  fixture: BirdFixture,
  databaseRoot: string,
  image: string,
  onGrade?: (id: string, grade: BirdGrade) => void,
): Promise<NonNullable<ResearchBriefHostOptions["protocol"]>> {
  const checkerFile = fileURLToPath(new URL("./benchmark-audit/bird_sql.py", import.meta.url));
  const inputHashes = new Set(fixture.cases.map((c) => learningHash(c.input)));
  if (
    new Set(fixture.cases.map((c) => c.id)).size !== 22 ||
    new Set(fixture.cases.map((c) => c.family)).size !== 11
  )
    throw new Error("Malformed BIRD calibration panel");
  return {
    id: "bird-sqlite-calibration",
    version: "bird-sqlite-bag-v1",
    prompt: BIRD_PROMPT,
    checkerHash: learningHash({
      fixture,
      checker: sha256(await fs.readFile(checkerFile)),
      protocol: sha256(await fs.readFile(fileURLToPath(import.meta.url))),
      image,
    }),
    inputFilesHash: learningHash(
      fixture.cases.map((c) => ({ id: c.id, database: c.databaseSha256 })),
    ),
    inputFiles: async (task) => {
      const item = fixture.cases.find(
        (c) => c.id === task.id && learningHash(c.input) === learningHash(task.input),
      );
      if (!item) throw new Error("Unfrozen BIRD task");
      const file = path.join(databaseRoot, `${item.family}.sqlite`);
      const stat = await fs.lstat(file);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.nlink !== 1 ||
        stat.size !== item.databaseBytes
      )
        throw new Error("Invalid source database");
      return [
        { name: "database.sqlite", bytes: await fs.readFile(file), sha256: item.databaseSha256 },
      ];
    },
    acceptsInput: (input) => inputHashes.has(learningHash(input)),
    checkDeliverables: async (task, output, markdown) => {
      const answer = z.strictObject({ sql: z.string().min(1).max(65536) }).safeParse(output);
      if (!answer.success || !markdown?.trim()) return false;
      const item = fixture.cases.find(
        (c) => c.id === task.id && learningHash(c.input) === learningHash(task.input),
      );
      if (!item) throw new Error("Unfrozen BIRD task");
      const grade = await checkBirdSql(item, answer.data.sql, databaseRoot, image, checkerFile);
      onGrade?.(item.id, grade);
      if (grade.status === "checker-invalid") throw new Error("Invalid SQL reference checker");
      return grade.status === "pass";
    },
  };
}
