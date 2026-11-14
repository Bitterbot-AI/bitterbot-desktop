import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { z } from "zod";
import { learningHash, sha256 } from "../../src/agents/skills/collective/contracts.js";
import type { ResearchBriefHostOptions } from "../../src/agents/skills/collective/research-brief.js";

export const VariedCaseSchema = z.object({
  id: z.string(),
  family: z.string(),
  mode: z.number().int(),
  partition: z.string(),
  replica: z.number().int(),
  input: z.record(z.string(), z.unknown()),
  tests: z
    .array(z.object({ input: z.unknown(), expected: z.unknown() }))
    .min(3)
    .max(200),
});
export type VariedCase = z.infer<typeof VariedCaseSchema>;
export function assertExactJsonIntegers(value: unknown): void {
  if (typeof value === "number" && !Number.isSafeInteger(value))
    throw new Error(
      "Task integers must round-trip exactly through JSON; encode large integers as strings",
    );
  if (Array.isArray(value)) value.forEach(assertExactJsonIntegers);
  else if (value !== null && typeof value === "object")
    Object.values(value).forEach(assertExactJsonIntegers);
}
export type VariedGrade = {
  status: "pass" | "task-failure";
  reason: string;
  passed: number;
  total: number;
  failures: number[];
  actual: unknown;
};
export const VARIED_PROMPT =
  'Read sources.json and the applicable procedure at skill/SKILL.md. Implement the complete public contract as a Python 3 standard-library function solve(x). Test your implementation locally against the supplied examples and your own edge cases. Write brief.json as exactly {"code":"<complete self-contained Python source>"} and brief.md with a short explanation. The code must define solve, accept a JSON-compatible argument and return a JSON-compatible result. It will be executed without your workspace files or skill helpers on 40 frozen inputs, including the two public examples and 38 hidden inputs. All must be correct. The execution has 15 seconds, one CPU, 256 MiB memory, no network, and no external packages. It must not depend on files or state from other tasks. Do not merely output answers for the examples. No evaluation feedback or expected hidden outputs are available in this workspace.';
const entrypoint = fileURLToPath(new URL("./benchmark-audit/varied_execute.py", import.meta.url));

export function compareVaried(item: VariedCase, actual: unknown): VariedGrade {
  const failures = item.tests.flatMap((test, i) =>
    !Array.isArray(actual) ||
    actual.length !== item.tests.length ||
    learningHash(actual[i]) !== learningHash(test.expected)
      ? [i]
      : [],
  );
  return {
    status: failures.length ? "task-failure" : "pass",
    reason: failures.length ? "output-mismatch" : "all-inputs-correct",
    passed: item.tests.length - failures.length,
    total: item.tests.length,
    failures,
    actual,
  };
}

export async function checkVaried(
  item: VariedCase,
  code: string,
  image: string,
): Promise<VariedGrade> {
  const name = `bitterbot-varied-check-${randomUUID()}`;
  const args = [
    "run",
    "--rm",
    "--pull=never",
    "--name",
    name,
    "--network=none",
    "--read-only",
    "--memory=256m",
    "--cpus=1",
    "--pids-limit=32",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--user=65534:65534",
    "--tmpfs=/tmp:rw,noexec,nosuid,size=16m",
    "-v",
    `${entrypoint}:/runner.py:ro`,
    "-i",
    image,
    "timeout",
    "15",
    "python3",
    "-I",
    "/runner.py",
  ];
  try {
    const result = await new Promise<{ code: number | null; stdout: string; overflow: boolean }>(
      (resolve, reject) => {
        const child = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] });
        let stdout = "",
          overflow = false;
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error("Checker infrastructure deadline"));
        }, 120000);
        child.on("error", (e) => {
          clearTimeout(timer);
          reject(e);
        });
        child.stdout.on("data", (data: Buffer) => {
          if (stdout.length + data.length > 2 * 1024 * 1024) {
            overflow = true;
            child.kill("SIGKILL");
          } else stdout += data.toString();
        });
        child.stderr.on("data", () => {});
        child.stdin.on("error", () => {});
        child.on("close", (exitCode) => {
          clearTimeout(timer);
          resolve({ code: exitCode, stdout, overflow });
        });
        // Expected answers, contracts, source paths and checker identities are NEVER sent.
        child.stdin.end(JSON.stringify({ code, inputs: item.tests.map((test) => test.input) }));
      },
    );
    if (
      !result.overflow &&
      (result.code === 125 || result.code === 126 || result.code === 127 || result.code === null)
    )
      throw new Error("Candidate executor infrastructure unavailable");
    let actual: unknown = null;
    try {
      if (result.code === 0 && !result.overflow) actual = JSON.parse(result.stdout);
    } catch {
      /* Invalid output is a checked task failure. */
    }
    const grade = compareVaried(item, actual);
    if (result.overflow || result.code !== 0)
      grade.reason = result.overflow
        ? "output-limit"
        : result.code === 124 || result.code === 137
          ? "execution-resource-limit"
          : "execution-error";
    return grade;
  } finally {
    await promisify(execFile)("docker", ["rm", "-f", name], { timeout: 15000 }).catch(() => {});
  }
}

export async function variedProtocol(
  cases: VariedCase[],
  image: string,
  onGrade?: (g: VariedGrade) => void,
): Promise<NonNullable<ResearchBriefHostOptions["protocol"]>> {
  assertExactJsonIntegers(cases);
  if (new Set(cases.map((c) => c.id)).size !== cases.length)
    throw new Error("Duplicate varied task");
  const hashes = new Set(cases.map((c) => learningHash(c.input)));
  const lookup = (id: string, input: unknown) => {
    const task = cases.find((c) => c.id === id && learningHash(c.input) === learningHash(input));
    if (!task) throw new Error("Unfrozen varied task");
    return task;
  };
  return {
    id: "varied-executable-development",
    version: "varied-v2-five-minute-agent",
    prompt: VARIED_PROMPT,
    maxOutputBytes: 200000,
    agentTimeoutMs: 300000,
    checkerHash: learningHash({
      cases,
      image,
      executor: sha256(await fs.readFile(entrypoint)),
      protocol: sha256(await fs.readFile(fileURLToPath(import.meta.url))),
    }),
    acceptsInput: (input) => hashes.has(learningHash(input)),
    checkDeliverables: async (task, output, markdown) => {
      const item = lookup(task.id, task.input);
      const parsed = z.strictObject({ code: z.string().min(1).max(100000) }).safeParse(output);
      if (!parsed.success || !markdown?.trim()) return false;
      const grade = await checkVaried(item, parsed.data.code, image);
      onGrade?.(grade);
      return grade.status === "pass";
    },
  };
}
