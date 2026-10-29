/**
 * PLAN-59 Phase 1 pilot: shared helpers.
 *
 * Everything here is pure or touches only the paths it is handed. The one
 * safety rule every entry point shares lives here: nothing under ~/.bitterbot
 * is ever written except the private question/partition files that the
 * live-recall tooling already keeps there with mode 0600.
 */
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const sha256 = (s: string | Buffer | Uint8Array): string =>
  createHash("sha256").update(s).digest("hex");

export const sha256File = (path: string): string => sha256(readFileSync(path));

/** One generated question, exactly as benchmarks/live-recall/make-questions.mts writes it. */
export type Question = {
  chunkId: string;
  path: string;
  source: string;
  startLine: number;
  endLine: number;
  textSha256?: string;
  question: string;
};

/** The family a question belongs to: the gold chunk's file path. */
export const familyOf = (q: Pick<Question, "path">): string => q.path;

export function loadQuestions(path: string): { questions: Question[]; raw: string } {
  const raw = readFileSync(path, "utf-8");
  const questions = raw
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Question);
  return { questions, raw };
}

// ── ~/.bitterbot guard ───────────────────────────────────────────────────────

export function bitterbotHome(): string {
  return resolve(join(homedir(), ".bitterbot"));
}

export function isUnderBitterbotHome(p: string, home = bitterbotHome()): boolean {
  const r = resolve(p);
  return r === home || r.startsWith(`${home}/`);
}

/** The one directory under ~/.bitterbot a private question or partition file may land in. */
export function isPrivateBenchmarkPath(p: string, home = bitterbotHome()): boolean {
  const allowed = join(home, "benchmarks", "live-recall");
  const r = resolve(p);
  return r.startsWith(`${allowed}/`);
}

export function refuseUnderBitterbotHome(p: string, what: string): void {
  if (isUnderBitterbotHome(p)) {
    throw new Error(`refusing to write ${what} under ~/.bitterbot: ${p}`);
  }
}

// ── snapshots and forks ──────────────────────────────────────────────────────

/**
 * Copy a SQLite file with `VACUUM INTO` through a READ-ONLY connection. The
 * source is never modified (no WAL is created on a read-only open); the
 * destination must not exist and must not be under ~/.bitterbot.
 */
export function vacuumInto(src: string, dest: string): { ms: number; bytes: number } {
  refuseUnderBitterbotHome(dest, "a database copy");
  if (existsSync(dest)) {
    throw new Error(`destination exists: ${dest}`);
  }
  const t0 = performance.now();
  const ro = new DatabaseSync(resolve(src), { readOnly: true });
  try {
    // The copy is a scratch fork; syncing every page to disk made a 370 MB
    // VACUUM INTO take 40 s on the pilot box against 7 s without.
    ro.exec("PRAGMA synchronous = OFF");
    ro.exec(`VACUUM INTO '${resolve(dest).replace(/'/g, "''")}'`);
  } finally {
    ro.close();
  }
  return { ms: performance.now() - t0, bytes: statSync(dest).size };
}

/** Remove a database copy and its WAL/SHM side files. */
export function removeDbFiles(path: string): void {
  refuseUnderBitterbotHome(path, "a delete");
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    rmSync(`${path}${suffix}`, { force: true });
  }
}

/** Size of a database including any WAL that has not been checkpointed. */
export function dbBytes(path: string): number {
  let total = 0;
  for (const suffix of ["", "-wal"]) {
    try {
      total += statSync(`${path}${suffix}`).size;
    } catch {
      // absent side file
    }
  }
  return total;
}

export function gitCommit(cwd?: string): string | null {
  try {
    const head = execSync("git rev-parse --short HEAD", { encoding: "utf-8", cwd }).trim();
    const dirty = execSync("git status --porcelain --untracked-files=no", {
      encoding: "utf-8",
      cwd,
    }).trim();
    return dirty ? `${head}+dirty` : head;
  } catch {
    return null;
  }
}

// ── seeded randomness ────────────────────────────────────────────────────────

/**
 * Deterministic PRNG (sfc32) seeded from a string through SHA-256. Every
 * random choice in the pilot (random arm, shuffled batch, bootstrap resamples)
 * goes through one of these so a run is reproducible from its recorded seed.
 */
export function seededRandom(seed: string): () => number {
  const h = createHash("sha256").update(seed).digest();
  let a = h.readUInt32LE(0);
  let b = h.readUInt32LE(4);
  let c = h.readUInt32LE(8);
  let d = h.readUInt32LE(12);
  const next = () => {
    a >>>= 0;
    b >>>= 0;
    c >>>= 0;
    d >>>= 0;
    let t = (a + b) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    d = (d + 1) | 0;
    t = (t + d) | 0;
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
  for (let i = 0; i < 12; i++) {
    next();
  }
  return next;
}

/** Fisher-Yates shuffle with a seeded generator; returns a new array. */
export function seededShuffle<T>(items: readonly T[], seed: string): T[] {
  const rnd = seededRandom(seed);
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

export const DAY_MS = 86_400_000;

export const round = (x: number, digits = 4): number => Number(x.toFixed(digits));

export const mean = (xs: readonly number[]): number =>
  xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
