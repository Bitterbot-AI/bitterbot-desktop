/** Host-only sandbox execution. Candidate code never receives the verifier mount. */
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { sha256 } from "../../../src/agents/skills/collective/contracts.js";

const exec = promisify(execFile);
export type Grade = {
  status: "pass" | "task-failure" | "checker-invalid";
  issues: string[];
  details: unknown;
};
export async function inputHashes(folder: string) {
  return Object.fromEntries(
    await Promise.all(
      ["offer_letter_template.docx", "employee_data.json"].map(async (name) => [
        name,
        sha256(await fs.readFile(path.join(folder, name))),
      ]),
    ),
  );
}
export async function copyInputs(source: string, target: string) {
  await fs.mkdir(target, { recursive: true, mode: 0o700 });
  for (const name of ["offer_letter_template.docx", "employee_data.json"])
    await fs.copyFile(path.join(source, name), path.join(target, name), 1);
}
export async function dockerPython(
  image: string,
  mounts: Array<{ source: string; target: string; write?: boolean }>,
  args: string[],
  signal?: AbortSignal,
) {
  const name = "executable-learning-" + crypto.randomUUID();
  const argv = [
    "run",
    "--init",
    "--rm",
    "--pull",
    "never",
    "--name",
    name,
    "--label",
    "bitterbot.executable-study=1",
    "--network",
    "none",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--memory",
    "384m",
    "--cpus",
    "0.75",
    "--pids-limit",
    "64",
    "--user",
    String(process.getuid!()) + ":" + String(process.getgid!()),
    "--tmpfs",
    "/tmp:rw,nosuid,size=256m",
    "--env",
    "HOME=/tmp",
    "--env",
    "TZ=America/Toronto",
    "--env",
    "LANG=C.UTF-8",
    "--env",
    "LC_ALL=C.UTF-8",
  ];
  for (const mount of mounts) {
    if (/[,:]/.test(mount.source)) throw new Error("Invalid mount path");
    argv.push(
      "--mount",
      "type=bind,src=" + mount.source + ",dst=" + mount.target + (mount.write ? "" : ",readonly"),
    );
  }
  argv.push("--entrypoint", "python3", image, "-I", "-X", "utf8", ...args);
  const started = Date.now();
  try {
    const result = await exec("docker", argv, { timeout: 60000, maxBuffer: 32768, signal });
    return {
      exitCode: 0,
      stdout: result.stdout,
      stderr: result.stderr,
      wallMs: Date.now() - started,
      invocation: argv,
    };
  } catch (error) {
    const e = error as Error & {
      code?: number | string;
      stdout?: string;
      stderr?: string;
      killed?: boolean;
    };
    if (typeof e.code !== "number" || e.killed || signal?.aborted)
      throw new Error("Unresolved local sandbox execution: " + e.name);
    return {
      exitCode: e.code,
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? "",
      wallMs: Date.now() - started,
      invocation: argv,
    };
  } finally {
    const inspected = await exec("docker", ["inspect", name], { timeout: 10000 }).catch(() => null);
    if (inspected) {
      const info = JSON.parse(inspected.stdout)[0];
      if (
        info.Name !== "/" + name ||
        info.Image !== image ||
        info.Config.Labels["bitterbot.executable-study"] !== "1"
      )
        throw new Error("Sandbox cleanup identity mismatch");
      await exec("docker", ["rm", "-f", name], { timeout: 15000 });
    }
  }
}
export async function gradeOutput(
  image: string,
  suite: string,
  source: string,
  output: string,
  signal?: AbortSignal,
) {
  const started = Date.now();
  const execution = await dockerPython(
    image,
    [
      { source: suite, target: "/checker" },
      { source, target: "/inputs" },
      { source: path.dirname(output), target: "/output" },
    ],
    ["/checker/checker.py", "/inputs", "/output/" + path.basename(output)],
    signal,
  );
  if (execution.exitCode !== 0) throw new Error("Host checker infrastructure error");
  const grade = JSON.parse(execution.stdout) as Grade;
  if (
    !["pass", "task-failure", "checker-invalid"].includes(grade.status) ||
    !Array.isArray(grade.issues)
  )
    throw new Error("Invalid checker response");
  return { grade, wallMs: Date.now() - started };
}
