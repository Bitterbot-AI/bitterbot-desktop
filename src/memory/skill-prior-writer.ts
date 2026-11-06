import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { setImmediate as yieldLoop } from "node:timers/promises";
import { DEFAULT_PRIOR_CELL } from "../agents/skills/skill-prior-runtime.js";
import {
  emptyLedgerState,
  SkillPriorLedger,
  SKILL_PRIOR_DEFAULTS,
  type SkillPriorLedgerState,
} from "../agents/skills/skill-prior.js";
import { acquireFileLock } from "../infra/file-lock.js";
import type { SkillPriorCredit } from "./skill-prior-outcome.js";

export const LIVE_PRIOR_CAPACITY = 10_000;
const MAX_LEDGER_BYTES = 16 * 1024 * 1024;
export type WriterMode = "shadow" | "on" | "off";
export interface WriterOptions {
  discount: number;
  pseudoCount: number;
}
export interface LivePriorState extends SkillPriorLedgerState {
  scope: "live-skill-prior";
  liveWriter: { version: 1; options: WriterOptions; credits: SkillPriorCredit[] };
}
export interface WriterChange {
  runId: string;
  action: "insert" | "replace" | "duplicate" | "stale" | "capacity";
}
export class SkillPriorWriterRefusal extends Error {}
const queues = new Map<string, Promise<unknown>>();
const validated = new Map<string, { signature: string; state: LivePriorState }>();

export function writerOptions(config?: { discount?: number; pseudoCount?: number }): WriterOptions {
  return {
    discount: config?.discount ?? SKILL_PRIOR_DEFAULTS.discount,
    pseudoCount: config?.pseudoCount ?? SKILL_PRIOR_DEFAULTS.pseudoCount,
  };
}

function creditKey(credit: SkillPriorCredit): string {
  return credit.runId + "|" + credit.skill.name;
}

function validCredit(raw: unknown): raw is SkillPriorCredit {
  if (!raw || typeof raw !== "object") return false;
  const c = raw as SkillPriorCredit;
  return (
    typeof c.runId === "string" &&
    /^[A-Za-z0-9._:-]{1,128}$/.test(c.runId) &&
    typeof c.skill?.name === "string" &&
    c.skill.name.length > 0 &&
    c.skill.name.length <= 256 &&
    !/[|\r\n]/.test(c.skill.name) &&
    !["__proto__", "constructor", "prototype"].includes(c.skill.name) &&
    typeof c.skill.hash === "string" &&
    /^[a-f0-9]{64}$/.test(c.skill.hash) &&
    (c.outcome === 0 || c.outcome === 1) &&
    Number.isSafeInteger(c.startedAt) &&
    c.startedAt > 0 &&
    (c.source === "task-checks" || c.source === "owner-feedback") &&
    typeof c.revision === "string" &&
    c.revision.length > 0 &&
    c.revision.length <= 128 &&
    Number.isSafeInteger(c.signalOrder) &&
    c.signalOrder >= 0 &&
    ["model", "operator", "unknown"].includes(c.author)
  );
}

/** Canonicalize the existing parent without creating directories (shadow is read-only). */
async function canonicalFile(file: string): Promise<string> {
  const resolved = path.resolve(file);
  let parent = path.dirname(resolved);
  const suffix = [path.basename(resolved)];
  for (;;) {
    try {
      return path.join(await fs.realpath(parent), ...suffix);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      const next = path.dirname(parent);
      if (next === parent) throw err;
      suffix.unshift(path.basename(parent));
      parent = next;
    }
  }
}

async function readState(file: string, options: WriterOptions): Promise<LivePriorState> {
  let raw: string;
  let signature = "";
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_LEDGER_BYTES)
      throw new SkillPriorWriterRefusal("Ledger must be a regular file smaller than 16 MiB");
    signature = [
      stat.ino,
      stat.size,
      stat.mtimeMs,
      stat.ctimeMs,
      options.discount,
      options.pseudoCount,
    ].join(":");
    const cached = validated.get(file);
    if (cached?.signature === signature) return cached.state;
    raw = await fs.readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT")
      return {
        ...emptyLedgerState(),
        scope: "live-skill-prior",
        liveWriter: { version: 1, options, credits: [] },
      };
    throw err;
  }
  let parsed: LivePriorState;
  try {
    parsed = JSON.parse(raw) as LivePriorState;
  } catch {
    throw new SkillPriorWriterRefusal("Malformed skill prior ledger");
  }
  if (
    parsed.version !== 1 ||
    !parsed.cells ||
    typeof parsed.cells !== "object" ||
    Array.isArray(parsed.cells) ||
    !parsed.global ||
    typeof parsed.global !== "object" ||
    Array.isArray(parsed.global) ||
    !Array.isArray(parsed.seen)
  )
    throw new SkillPriorWriterRefusal("Unsupported skill prior ledger");
  if (
    !parsed.scope &&
    !parsed.liveWriter &&
    Object.keys(parsed.cells).length === 0 &&
    Object.keys(parsed.global).length === 0 &&
    parsed.seen.length === 0
  )
    return {
      ...emptyLedgerState(),
      scope: "live-skill-prior",
      liveWriter: { version: 1, options, credits: [] },
    };
  if (parsed.scope !== "live-skill-prior" || parsed.liveWriter?.version !== 1)
    throw new SkillPriorWriterRefusal(
      "Nonempty unscoped or benchmark ledger; move the file or set skills.prior.ledgerPath",
    );
  const writer = parsed.liveWriter;
  if (
    !Array.isArray(writer.credits) ||
    writer.credits.length > LIVE_PRIOR_CAPACITY ||
    !writer.credits.every(validCredit) ||
    new Set(writer.credits.map(creditKey)).size !== writer.credits.length ||
    new Set(writer.credits.map((c) => c.runId)).size !== writer.credits.length
  )
    throw new SkillPriorWriterRefusal("Invalid or duplicate durable credit history");
  if (
    writer.options?.discount !== options.discount ||
    writer.options?.pseudoCount !== options.pseudoCount
  )
    throw new SkillPriorWriterRefusal(
      "Writer parameters changed; use a new skills.prior.ledgerPath",
    );
  const replay = await rebuildLivePrior(writer.credits, options);
  if (
    JSON.stringify(parsed.cells) !== JSON.stringify(replay.cells) ||
    JSON.stringify(parsed.global) !== JSON.stringify(replay.global) ||
    JSON.stringify(parsed.seen) !== JSON.stringify(replay.seen)
  )
    throw new SkillPriorWriterRefusal(
      "Ledger projection disagrees with its durable credit history",
    );
  validated.set(file, { signature, state: parsed });
  if (validated.size > 8) validated.delete(validated.keys().next().value!);
  return parsed;
}

export async function readLivePriorCredits(
  file: string,
  options: WriterOptions,
): Promise<SkillPriorCredit[]> {
  return (await readState(await canonicalFile(file), options)).liveWriter.credits.map((credit) => ({
    ...credit,
    skill: { ...credit.skill },
  }));
}

/** Replay is exact for discounting and version resets; subtracting a count is not. */
export async function rebuildLivePrior(
  credits: readonly SkillPriorCredit[],
  options: WriterOptions,
): Promise<LivePriorState> {
  const ordered = credits.toSorted(
    (a, b) => a.startedAt - b.startedAt || a.runId.localeCompare(b.runId),
  );
  const ledger = new SkillPriorLedger(undefined, options);
  for (let i = 0; i < ordered.length; i++) {
    const c = ordered[i];
    ledger.update({
      cell: DEFAULT_PRIOR_CELL,
      skill: c.skill,
      outcome: c.outcome,
      runId: c.runId,
      gate: true,
      verified: true,
    });
    if (i % 100 === 99) await yieldLoop();
  }
  return {
    ...(JSON.parse(ledger.toJSON()) as SkillPriorLedgerState),
    scope: "live-skill-prior",
    liveWriter: { version: 1, options, credits: ordered },
  };
}

async function writeAtomic(
  file: string,
  state: SkillPriorLedgerState & { scope: string },
): Promise<void> {
  const body = JSON.stringify(state);
  if (Buffer.byteLength(body) > MAX_LEDGER_BYTES)
    throw new SkillPriorWriterRefusal("Ledger exceeds size bound");
  const temp = file + "." + randomUUID() + ".tmp";
  let previousMtime = 0;
  try {
    previousMtime = (await fs.stat(file)).mtimeMs;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const handle = await fs.open(temp, "wx", 0o600);
  try {
    await handle.writeFile(body, "utf8");
    // Reader caches by mtime. Force a change even on rapid same-tick corrections.
    const stamp = new Date(Math.max(Date.now(), Math.floor(previousMtime) + 2));
    await handle.utimes(stamp, stamp);
    await handle.sync();
    await handle.close();
    await fs.rename(temp, file);
    // Persist the directory entry on POSIX. Some filesystems cannot fsync directories.
    const directory = await fs.open(path.dirname(file), "r").catch(() => undefined);
    if (directory) {
      try {
        await directory.sync();
      } catch {
        /* unsupported directory fsync */
      } finally {
        await directory.close();
      }
    }
  } finally {
    await handle.close().catch(() => undefined);
    await fs.unlink(temp).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== "ENOENT") throw err;
    });
  }
}

export async function applySkillPriorCredits(params: {
  file: string;
  mode: WriterMode;
  options: WriterOptions;
  credits: readonly SkillPriorCredit[];
}): Promise<{ changes: WriterChange[]; written: boolean }> {
  if (params.mode === "off") return { changes: [], written: false };
  const file = await canonicalFile(params.file);
  const previous = queues.get(file) ?? Promise.resolve();
  const operation = previous
    .catch(() => undefined)
    .then(async () => {
      let lock: Awaited<ReturnType<typeof acquireFileLock>> | undefined;
      if (params.mode === "on") {
        lock = await acquireFileLock(file, {
          retries: { retries: 5, factor: 2, minTimeout: 20, maxTimeout: 300 },
          stale: 300_000,
        });
      }
      try {
        const existing = await readState(file, params.options);
        const byRun = new Map(existing.liveWriter.credits.map((c) => [c.runId, c]));
        const changes: WriterChange[] = [];
        let changed = false;
        for (const credit of params.credits) {
          if (!validCredit(credit)) throw new SkillPriorWriterRefusal("Invalid proposed credit");
          const old = byRun.get(credit.runId);
          let action: WriterChange["action"];
          if (
            old &&
            (creditKey(old) !== creditKey(credit) ||
              old.skill.hash !== credit.skill.hash ||
              old.startedAt !== credit.startedAt)
          )
            throw new SkillPriorWriterRefusal("A correction cannot change attribution");
          if (old && old.revision === credit.revision && old.source === credit.source)
            action = "duplicate";
          else if (
            old &&
            ((old.source === "owner-feedback" && credit.source !== "owner-feedback") ||
              (old.source === credit.source && old.signalOrder >= credit.signalOrder))
          )
            action = "stale";
          else if (!old && byRun.size >= LIVE_PRIOR_CAPACITY) action = "capacity";
          else {
            action = old ? "replace" : "insert";
            byRun.set(credit.runId, { ...credit, skill: { ...credit.skill } });
            changed = true;
          }
          changes.push({ runId: credit.runId, action });
        }
        if (changed && params.mode === "on")
          await writeAtomic(file, await rebuildLivePrior([...byRun.values()], params.options));
        return { changes, written: changed && params.mode === "on" };
      } finally {
        await lock?.release();
      }
    });
  queues.set(file, operation);
  try {
    return await operation;
  } finally {
    if (queues.get(file) === operation) queues.delete(file);
  }
}

/** Benchmarks use a separate, tagged ledger and cannot overwrite the configured live file. */
export async function writeBenchmarkSkillPriorLedger(
  target: string,
  ledger: SkillPriorLedger,
  liveFile: string,
): Promise<void> {
  const file = await canonicalFile(target);
  if (file === (await canonicalFile(liveFile)))
    throw new SkillPriorWriterRefusal("Benchmark output collides with the live skill prior ledger");
  const previous = queues.get(file) ?? Promise.resolve();
  const operation = previous
    .catch(() => undefined)
    .then(async () => {
      const lock = await acquireFileLock(file, {
        retries: { retries: 5, factor: 2, minTimeout: 20, maxTimeout: 300 },
        stale: 300_000,
      });
      try {
        try {
          const stat = await fs.lstat(file);
          if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_LEDGER_BYTES)
            throw new SkillPriorWriterRefusal("Unsafe benchmark output file");
          const existing = JSON.parse(await fs.readFile(file, "utf8")) as {
            scope?: string;
            liveWriter?: unknown;
          };
          if (existing.liveWriter || existing.scope === "live-skill-prior")
            throw new SkillPriorWriterRefusal("Benchmark output is a live writer ledger");
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        }
        await writeAtomic(file, {
          ...(JSON.parse(ledger.toJSON()) as SkillPriorLedgerState),
          scope: "benchmark",
        });
      } finally {
        await lock.release();
      }
    });
  queues.set(file, operation);
  try {
    await operation;
  } finally {
    if (queues.get(file) === operation) queues.delete(file);
  }
}
