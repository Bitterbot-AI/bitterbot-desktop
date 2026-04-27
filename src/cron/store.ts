import fs from "node:fs/promises";
import path from "node:path";
import type { CronJob, CronRun, CronRunStatus, CronStoreFile } from "./types.js";
import { resolveStateDir } from "../config/paths.js";
import { expandHomePrefix } from "../infra/home-dir.js";

const FILE_VERSION = 1 as const;
const DEFAULT_RUN_HISTORY_LIMIT = 200;

export type CronStoreOptions = {
  storePath?: string;
  // Override the state-dir lookup for tests / out-of-tree deployments.
  stateDir?: string;
};

export type CronStorePaths = {
  jobsFile: string;
  runsDir: string;
};

function expand(input: string, stateDir: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    return path.join(stateDir, "cron", "jobs.json");
  }
  if (trimmed.startsWith("~")) {
    const expanded = expandHomePrefix(trimmed, { env: process.env });
    return path.resolve(expanded);
  }
  if (path.isAbsolute(trimmed)) {
    return path.resolve(trimmed);
  }
  return path.resolve(stateDir, trimmed);
}

export function resolveCronPaths(opts: CronStoreOptions = {}): CronStorePaths {
  const stateDir = opts.stateDir ?? resolveStateDir();
  const jobsFile = opts.storePath
    ? expand(opts.storePath, stateDir)
    : path.join(stateDir, "cron", "jobs.json");
  const runsDir = path.join(path.dirname(jobsFile), "runs");
  return { jobsFile, runsDir };
}

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  await ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const body = JSON.stringify(value, null, 2);
  await fs.writeFile(tmp, body, "utf8");
  await fs.rename(tmp, filePath);
}

function emptyFile(): CronStoreFile {
  return { version: FILE_VERSION, jobs: [] };
}

export async function loadJobsFile(jobsFile: string): Promise<CronStoreFile> {
  try {
    const raw = await fs.readFile(jobsFile, "utf8");
    if (!raw.trim()) {
      return emptyFile();
    }
    const parsed = JSON.parse(raw) as Partial<CronStoreFile>;
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.jobs)) {
      return emptyFile();
    }
    // Coerce to v1 shape; tolerate missing required fields by dropping bad rows.
    const jobs = parsed.jobs.filter((job): job is CronJob => {
      return Boolean(job && typeof job === "object" && typeof (job as CronJob).jobId === "string");
    });
    return { version: FILE_VERSION, jobs };
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      return emptyFile();
    }
    throw err;
  }
}

export async function saveJobsFile(jobsFile: string, file: CronStoreFile): Promise<void> {
  await atomicWriteJson(jobsFile, file);
}

// JSONL run-history per job. Trimmed to keep a bounded tail.
export async function appendRun(
  runsDir: string,
  run: CronRun,
  limit = DEFAULT_RUN_HISTORY_LIMIT,
): Promise<void> {
  await ensureDir(runsDir);
  const file = path.join(runsDir, `${sanitizeId(run.jobId)}.jsonl`);
  const line = `${JSON.stringify(run)}\n`;
  await fs.appendFile(file, line, "utf8");
  // Cheap rotation: when the file grows past 4× limit, rewrite tail.
  try {
    const stat = await fs.stat(file);
    if (stat.size > 4 * limit * 256) {
      const raw = await fs.readFile(file, "utf8");
      const lines = raw.split("\n").filter(Boolean);
      const tail = lines.slice(-limit).join("\n");
      await fs.writeFile(file, `${tail}\n`, "utf8");
    }
  } catch {
    // Rotation is best-effort.
  }
}

export async function readRuns(runsDir: string, jobId: string, limit = 50): Promise<CronRun[]> {
  const file = path.join(runsDir, `${sanitizeId(jobId)}.jsonl`);
  let raw = "";
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      return [];
    }
    throw err;
  }
  const lines = raw.split("\n").filter((line) => line.trim().length > 0);
  const cap = Math.max(1, Math.min(limit, 1000));
  const slice = lines.slice(-cap);
  const out: CronRun[] = [];
  for (const line of slice) {
    try {
      const parsed = JSON.parse(line) as CronRun;
      if (parsed && typeof parsed === "object" && parsed.jobId === jobId) {
        out.push(parsed);
      }
    } catch {
      // skip malformed line
    }
  }
  return out;
}

export type CronRunStatusCounts = Partial<Record<CronRunStatus, number>>;

function sanitizeId(jobId: string): string {
  return String(jobId).replace(/[^a-zA-Z0-9_.-]/g, "_");
}
