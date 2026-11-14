import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { z } from "zod";
import { learningHash, sha256 } from "../../src/agents/skills/collective/contracts.js";
import type { ResearchBriefHostOptions } from "../../src/agents/skills/collective/research-brief.js";
import { BIRD_PROMPT, BirdGradeSchema } from "./bird-calibration.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const SqlLearningCaseSchema = z.object({
  id: z.string(),
  family: z.string(),
  kind: z.string(),
  input: z.record(z.string(), z.unknown()),
  referenceSql: z.string(),
  snapshots: z
    .array(
      z.object({
        file: z.string().regex(/^[a-z0-9_-]+\.sqlite$/),
        sha256: digest,
        bytes: z.number().int().positive(),
        digest,
      }),
    )
    .min(1)
    .max(9),
});
export type SqlLearningCase = z.infer<typeof SqlLearningCaseSchema>;
export const SqlLearningFixtureSchema = z.object({
  schemaVersion: z.literal(1),
  purpose: z.string(),
  independentMechanisms: z.literal(1),
  vocabularyDomains: z.literal(6),
  cases: z.array(SqlLearningCaseSchema).length(24),
});
const GradeSchema = z.object({
  status: z.enum(["pass", "task-failure", "checker-invalid"]),
  snapshots: z.array(BirdGradeSchema).min(1).max(9),
});
export type SqlLearningGrade = z.infer<typeof GradeSchema>;
const audit = fileURLToPath(new URL("./benchmark-audit/", import.meta.url));
export const SQL_LEARNING_PROMPT =
  BIRD_PROMPT +
  " For the authored development tasks the same query is also checked on eight unseen database snapshots with the same schema and question contract. You receive only the first snapshot. The original BIRD acquisition tasks have one snapshot. A query must succeed on every applicable snapshot. No feedback from evaluation tasks is supplied to the procedure generator.";

export async function checkSqlLearning(
  item: SqlLearningCase,
  sql: string,
  root: string,
  image: string,
): Promise<SqlLearningGrade> {
  const name = `bitterbot-sql-learning-check-${randomUUID()}`;
  const args = [
    "run",
    "--rm",
    "--pull=never",
    "--name",
    name,
    "--network=none",
    "--read-only",
    "--memory=512m",
    "--cpus=1",
    "--pids-limit=32",
    "--cap-drop=ALL",
    "--user=65534:65534",
    "--tmpfs=/tmp:rw,noexec,nosuid,size=64m",
    "-v",
    `${root}:/data:ro`,
    "-v",
    `${path.join(audit, "sql_learning_check.py")}:/checker/sql_learning_check.py:ro`,
    "-v",
    `${path.join(audit, "bird_sql.py")}:/checker/bird_sql.py:ro`,
    "-i",
    image,
    "python3",
    "/checker/sql_learning_check.py",
  ];
  try {
    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "",
        stderr = "";
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("Checker timeout"));
      }, 90000);
      child.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.stdout.on("data", (data: Buffer) => {
        stdout += data.toString();
        if (stdout.length > 32768) {
          child.kill("SIGKILL");
          reject(new Error("Checker overflow"));
        }
      });
      child.stderr.on("data", (data: Buffer) => {
        stderr = (stderr + data.toString()).slice(0, 2000);
      });
      child.stdin.on("error", () => {});
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code !== 0) reject(new Error(`Checker failed: ${stderr}`));
        else resolve(stdout);
      });
      child.stdin.end(
        JSON.stringify({
          root: "/data",
          snapshots: item.snapshots,
          referenceSql: item.referenceSql,
          sql,
        }),
      );
    });
    return GradeSchema.parse(JSON.parse(output));
  } finally {
    await promisify(execFile)("docker", ["rm", "-f", name], { timeout: 15000 }).catch(() => {});
  }
}

export async function sqlLearningProtocol(
  cases: SqlLearningCase[],
  root: string,
  image: string,
  onGrade?: (grade: SqlLearningGrade) => void,
): Promise<NonNullable<ResearchBriefHostOptions["protocol"]>> {
  if (new Set(cases.map((c) => c.id)).size !== cases.length) throw new Error("Duplicate case");
  const hashes = new Set(cases.map((c) => learningHash(c.input)));
  const lookup = (id: string, input: unknown) => {
    const item = cases.find((c) => c.id === id && learningHash(c.input) === learningHash(input));
    if (!item) throw new Error("Unfrozen SQL task");
    return item;
  };
  return {
    id: "sql-learning-development",
    version: "sql-learning-multisnapshot-v1",
    prompt: SQL_LEARNING_PROMPT,
    checkerHash: learningHash({
      cases,
      image,
      checker: sha256(await fs.readFile(path.join(audit, "sql_learning_check.py"))),
      engine: sha256(await fs.readFile(path.join(audit, "bird_sql.py"))),
      protocol: sha256(await fs.readFile(fileURLToPath(import.meta.url))),
    }),
    inputFilesHash: learningHash(cases.map((c) => ({ id: c.id, visible: c.snapshots[0] }))),
    acceptsInput: (input) => hashes.has(learningHash(input)),
    inputFiles: async (task) => {
      const snapshot = lookup(task.id, task.input).snapshots[0];
      const file = path.join(root, snapshot.file),
        stat = await fs.lstat(file);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.nlink !== 1 ||
        stat.size !== snapshot.bytes
      )
        throw new Error("Invalid fixture file");
      return [{ name: "database.sqlite", bytes: await fs.readFile(file), sha256: snapshot.sha256 }];
    },
    checkDeliverables: async (task, output, markdown) => {
      const result = z.strictObject({ sql: z.string().min(1).max(65536) }).safeParse(output);
      if (!result.success || !markdown?.trim()) return false;
      const grade = await checkSqlLearning(
        lookup(task.id, task.input),
        result.data.sql,
        root,
        image,
      );
      onGrade?.(grade);
      if (grade.status === "checker-invalid") throw new Error("Invalid multi-snapshot checker");
      return grade.status === "pass";
    },
  };
}
