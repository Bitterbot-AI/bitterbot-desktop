import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
export const repo = fileURLToPath(new URL("../../..", import.meta.url));
export const root = "/home/vicmg/.local/share/bitterbot-studies/executable-transfer-20261114-v2";
export const suite = path.join(repo, "research/collective-learning/executable-transfer-v2");
export const exported = path.join(repo, "reports/collective-learning", path.basename(root));
export const prior = "/home/vicmg/.local/share/bitterbot-studies/executable-use-20261114-v3";
export const hash = "8a9db2fb33657ba8bb6fa9cf571d98bb4776dcb1881b2f130cd40405ac775eef";
export const cap = { providerUsd: 20, toolCalls: 3000, wallMs: 36000000 };
export const settings = {
  cpus: 0.75,
  memory: "384m",
  env: { TZ: "America/Toronto", LANG: "C.UTF-8", LC_ALL: "C.UTF-8" },
};
export const exec = promisify(execFile);
export const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
export const read = async <T>(file: string): Promise<T> =>
  JSON.parse(await fs.readFile(file, "utf8")) as T;
export const write = async (file: string, value: unknown) => {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
};
export const copyJson = async (name: string, value: unknown) => {
  await write(path.join(root, name), value);
  await write(path.join(exported, name), value);
};
export async function sources() {
  const files = ["package.json", "pnpm-lock.yaml"];
  for (const dir of [
    "src",
    "benchmarks/collective-learning",
    "research/collective-learning/executable-transfer-v2",
  ])
    for (const name of await fs.readdir(path.join(repo, dir), {
      recursive: dir !== "benchmarks/collective-learning",
    }))
      if (
        /\.(ts|js|json|py|docx)$/.test(name) &&
        !/\.(test|spec)\.ts$/.test(name) &&
        !name.includes("__pycache__")
      )
        files.push(dir + "/" + name.replaceAll(path.sep, "/"));
  const regressionRoot = "research/collective-learning/executable-learning/fixtures";
  files.push(regressionRoot + "/inventory.json");
  for (const name of await fs.readdir(path.join(repo, regressionRoot, "evaluation"), {
    recursive: true,
  }))
    if (/\.(json|docx)$/.test(name))
      files.push(regressionRoot + "/evaluation/" + name.replaceAll(path.sep, "/"));
  const pairs = await Promise.all(
    files.toSorted().map(async (f) => [f, sha256(await fs.readFile(path.join(repo, f)))]),
  );
  return Object.fromEntries(pairs) as Record<string, string>;
}
