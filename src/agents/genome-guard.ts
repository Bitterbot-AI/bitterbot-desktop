/**
 * GENOME.md write guard.
 *
 * The Genome is the user's file: safety axioms, hormonal baselines, core
 * values. Until this guard it was protected only by a prompt instruction and
 * by the dream engine never writing it; an agent with file or shell tools
 * could edit it like any other workspace file.
 *
 * Two layers, both at the tool boundary:
 *
 * 1. The file tools (`write`, `edit`, `apply_patch`) are refused up front
 *    when they target a guarded Genome, so the model gets a clear error.
 * 2. Every tool call (and every CLI-backend run) is bracketed by a snapshot
 *    of the file. If the call left it created, changed, deleted, or replaced
 *    by something that is not a readable file (a shell redirect, a script, a
 *    plugin tool), the previous state is put back, the rejected version is
 *    kept under the state directory, and the tool result says what happened.
 *
 * The files guarded are the Genome of the run's own workspace and those of
 * the other configured agents, so one agent cannot rewrite another's.
 *
 * Not covered: a process the agent leaves running in the background that
 * writes the file after its tool call has returned. The guard brackets tool
 * calls; it does not watch the file. For the same reason an edit the user
 * saves in an external editor while a tool call is in flight looks like a
 * change made by that call and is undone (the user's version is kept with
 * the rejected ones). A save through the Control UI is recognised and kept.
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { BitterbotConfig } from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { listAgentIds, resolveAgentWorkspaceDir } from "./agent-scope.js";
import { carryToolMarkers, type AnyAgentTool } from "./agent-tools.types.js";
import { normalizeToolName } from "./tool-policy.js";
import { DEFAULT_GENOME_FILENAME } from "./workspace.js";

const log = createSubsystemLogger("agents/genome-guard");

const GENOME_GUARD_WRAPPED = Symbol("genomeGuardWrapped");

export const GENOME_READ_ONLY_MESSAGE =
  "GENOME.md is read-only for the agent. Only the user edits it; ask them to make the change.";

export const GENOME_RESTORED_NOTICE =
  "[genome-guard] This tool call changed GENOME.md. The file is read-only for the agent and has been restored to its previous content.";

/** A Genome is a page or two of Markdown. Anything larger is not read into memory. */
export const MAX_GENOME_BYTES = 1024 * 1024;

const PATH_PARAM_KEYS = ["path", "file_path", "filePath", "file"] as const;
const PATCH_PARAM_KEYS = ["input", "patch"] as const;
// The patch parser trims header lines, so an indented header counts too.
const PATCH_FILE_MARKER =
  /^[ \t]*\*\*\* (?:Add File|Update File|Delete File|Move to): (.+?)[ \t]*$/gm;
const CASE_INSENSITIVE_FS = process.platform === "darwin" || process.platform === "win32";

type Snapshot =
  | { kind: "absent" }
  | { kind: "file"; content: Buffer; mode: number; linkTarget?: string }
  /** A directory, a device, an unreadable or oversized file, a dangling link. */
  | { kind: "other"; detail: string };

async function snapshot(file: string): Promise<Snapshot> {
  let linkTarget: string | undefined;
  try {
    const link = await fs.lstat(file);
    if (link.isSymbolicLink()) {
      linkTarget = await fs.readlink(file);
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === "ENOENT" ? { kind: "absent" } : { kind: "other", detail: String(code) };
  }
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile()) {
      return { kind: "other", detail: "not a regular file" };
    }
    if (stat.size > MAX_GENOME_BYTES) {
      return { kind: "other", detail: `larger than ${MAX_GENOME_BYTES} bytes` };
    }
    const content = await fs.readFile(file);
    return {
      kind: "file",
      content,
      mode: stat.mode & 0o777,
      ...(linkTarget !== undefined ? { linkTarget } : {}),
    };
  } catch (err) {
    return { kind: "other", detail: String((err as NodeJS.ErrnoException).code ?? err) };
  }
}

function sameSnapshot(a: Snapshot, b: Snapshot): boolean {
  if (a.kind === "file" && b.kind === "file") {
    return a.linkTarget === b.linkTarget && a.content.equals(b.content);
  }
  return a.kind === "absent" && b.kind === "absent";
}

function expandHome(input: string): string {
  if (input === "~") {
    return os.homedir();
  }
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}

function samePath(a: string, b: string): boolean {
  return CASE_INSENSITIVE_FS ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** The Genome of a workspace. */
export function genomeFileOf(workspaceDir: string): string {
  return path.resolve(workspaceDir, DEFAULT_GENOME_FILENAME);
}

/**
 * The Genome of every configured agent's workspace. A run guards its own
 * workspace's file and these, so `exec` in one agent's run cannot rewrite
 * another agent's Genome by absolute path.
 */
export function otherAgentGenomeFiles(cfg: BitterbotConfig | undefined): string[] {
  if (!cfg) {
    return [];
  }
  const files: string[] = [];
  for (const agentId of listAgentIds(cfg)) {
    try {
      files.push(genomeFileOf(resolveAgentWorkspaceDir(cfg, agentId)));
    } catch {
      // An agent whose workspace cannot be resolved has no Genome to guard.
    }
  }
  return files;
}

/** True when a path a file tool was given (relative to `cwd`) names a guarded Genome. */
export function targetsGenome(
  candidate: string,
  cwd: string,
  genomeFiles: readonly string[] = [genomeFileOf(cwd)],
): boolean {
  // The file tools drop a leading "@" before opening the path.
  const trimmed = candidate.trim().replace(/^@/, "");
  if (!trimmed) {
    return false;
  }
  const resolved = path.resolve(cwd, expandHome(trimmed));
  return genomeFiles.some((genome) => samePath(resolved, genome));
}

/** The up-front refusal for the file tools. Returns the reason, or undefined. */
export function genomeWriteRefusal(
  toolName: string,
  params: unknown,
  cwd: string,
  genomeFiles: readonly string[] = [genomeFileOf(cwd)],
): string | undefined {
  if (!params || typeof params !== "object") {
    return undefined;
  }
  const record = params as Record<string, unknown>;
  const name = normalizeToolName(toolName);
  if (name === "write" || name === "edit") {
    for (const key of PATH_PARAM_KEYS) {
      const value = record[key];
      if (typeof value === "string" && targetsGenome(value, cwd, genomeFiles)) {
        return GENOME_READ_ONLY_MESSAGE;
      }
    }
    return undefined;
  }
  if (name === "apply_patch") {
    for (const key of PATCH_PARAM_KEYS) {
      const value = record[key];
      if (typeof value !== "string") {
        continue;
      }
      for (const match of value.matchAll(PATCH_FILE_MARKER)) {
        if (targetsGenome(match[1] ?? "", cwd, genomeFiles)) {
          return GENOME_READ_ONLY_MESSAGE;
        }
      }
    }
  }
  return undefined;
}

// ── Saves the user makes through the gateway ────────────────────────────────

const USER_WRITE_TTL_MS = 60 * 60_000;
const userWrites = new Map<string, { digest: string; at: number }>();

const digestOf = (content: Buffer | string) =>
  crypto.createHash("sha256").update(content).digest("hex");

/**
 * Record that the user saved this content to a Genome (the Control UI's file
 * editor). A tool call that is in flight during the save then finds content
 * the user wrote, and leaves it.
 */
export function noteGenomeWrittenByUser(file: string, content: Buffer | string): void {
  const now = Date.now();
  for (const [key, entry] of userWrites) {
    if (now - entry.at > USER_WRITE_TTL_MS) {
      userWrites.delete(key);
    }
  }
  userWrites.set(path.resolve(file), { digest: digestOf(content), at: now });
}

function writtenByUser(file: string, after: Snapshot): boolean {
  if (after.kind !== "file") {
    return false;
  }
  const entry = userWrites.get(path.resolve(file));
  return Boolean(
    entry && Date.now() - entry.at <= USER_WRITE_TTL_MS && entry.digest === digestOf(after.content),
  );
}

// ── Undo ────────────────────────────────────────────────────────────────────

async function keepRejected(after: Snapshot): Promise<string | undefined> {
  if (after.kind !== "file") {
    return undefined;
  }
  try {
    const dir = path.join(resolveStateDir(), "genome-guard");
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const file = path.join(
      dir,
      `rejected-${Date.now()}-${digestOf(after.content).slice(0, 12)}.md`,
    );
    await fs.writeFile(file, after.content, { mode: 0o600 });
    return file;
  } catch (err) {
    log.warn(`could not keep the rejected GENOME.md: ${String(err)}`);
    return undefined;
  }
}

async function restore(file: string, before: Exclude<Snapshot, { kind: "other" }>): Promise<void> {
  // Whatever is there now (a changed file, a directory, a device link) goes.
  // `rm` on a symlink removes the link, never what it points at.
  await fs.rm(file, { recursive: true, force: true });
  if (before.kind === "absent") {
    return;
  }
  if (before.linkTarget !== undefined) {
    // The Genome was a link: put the link back and the content behind it.
    await fs.symlink(before.linkTarget, file);
    await fs.writeFile(file, before.content);
    await fs.chmod(file, before.mode).catch(() => {});
    return;
  }
  // Write beside the file and rename, so a reader never sees a partial Genome.
  const temp = `${file}.genome-guard-${process.pid}-${crypto.randomUUID()}`;
  try {
    await fs.writeFile(temp, before.content, { mode: before.mode });
    await fs.chmod(temp, before.mode);
    await fs.rename(temp, file);
  } catch (err) {
    await fs.rm(temp, { force: true });
    throw err;
  }
}

/**
 * Compare a Genome with its state before the call and undo any change.
 * Returns true when something was undone.
 */
async function undoIfChanged(file: string, before: Snapshot, label: string): Promise<boolean> {
  if (before.kind === "other") {
    return false;
  }
  const after = await snapshot(file);
  if (sameSnapshot(before, after) || writtenByUser(file, after)) {
    return false;
  }
  const kept = await keepRejected(after);
  await restore(file, before);
  const what =
    after.kind === "absent"
      ? "deleted"
      : after.kind === "other"
        ? `replaced (${after.detail})`
        : before.kind === "absent"
          ? "created"
          : "changed";
  log.warn(
    `${label} ${what} ${file}; restored` + (kept ? ` (rejected version kept at ${kept})` : ""),
  );
  return true;
}

const warnedUnreadable = new Set<string>();

/**
 * Run `fn` with the given Genome files guarded: whatever it does to them is
 * undone afterwards, whether it returns or throws. `undone` tells the caller
 * to say so.
 */
export async function withGenomeGuard<T>(
  genomeFiles: readonly string[],
  label: string,
  fn: () => Promise<T>,
): Promise<{ result: T; undone: boolean }> {
  const before = await Promise.all(
    genomeFiles.map(async (file) => ({ file, state: await snapshot(file) })),
  );
  for (const { file, state } of before) {
    if (state.kind === "other" && !warnedUnreadable.has(file)) {
      // Not something a guarded call can have produced: such a change is
      // undone. The user (or a background process) left it this way.
      warnedUnreadable.add(file);
      log.warn(`${file} cannot be snapshotted (${state.detail}); it is not guarded until fixed`);
    }
  }
  const undoAll = async (): Promise<boolean> => {
    let undone = false;
    for (const { file, state } of before) {
      try {
        undone = (await undoIfChanged(file, state, label)) || undone;
      } catch (err) {
        log.error(`could not restore ${file} after ${label}: ${String(err)}`);
      }
    }
    return undone;
  };
  let result: T;
  try {
    result = await fn();
  } catch (err) {
    // A failed call can still have written the file on the way.
    await undoAll();
    throw err;
  }
  return { result, undone: await undoAll() };
}

function withNotice(result: unknown): unknown {
  if (
    result &&
    typeof result === "object" &&
    Array.isArray((result as { content?: unknown }).content)
  ) {
    const typed = result as { content: unknown[] };
    return {
      ...typed,
      content: [...typed.content, { type: "text", text: GENOME_RESTORED_NOTICE }],
    };
  }
  return { content: [{ type: "text", text: GENOME_RESTORED_NOTICE }], details: result };
}

export function wrapToolWithGenomeGuard(
  tool: AnyAgentTool,
  workspaceDir?: string,
  /** Genomes of other agents' workspaces, guarded as well. */
  otherGenomeFiles: readonly string[] = [],
): AnyAgentTool {
  const execute = tool.execute;
  if (!workspaceDir || !execute) {
    return tool;
  }
  if ((tool as unknown as Record<symbol, unknown>)[GENOME_GUARD_WRAPPED]) {
    return tool;
  }
  const genomeFiles = [...new Set([genomeFileOf(workspaceDir), ...otherGenomeFiles])];
  const wrapped: AnyAgentTool = carryToolMarkers<AnyAgentTool>(tool, {
    ...tool,
    execute: async (toolCallId, params, signal, onUpdate) => {
      const refusal = genomeWriteRefusal(tool.name, params, workspaceDir, genomeFiles);
      if (refusal) {
        throw new Error(refusal);
      }
      const { result, undone } = await withGenomeGuard(genomeFiles, `tool "${tool.name}"`, () =>
        execute(toolCallId, params, signal, onUpdate),
      );
      return (undone ? withNotice(result) : result) as Awaited<ReturnType<typeof execute>>;
    },
  });
  Object.defineProperty(wrapped, GENOME_GUARD_WRAPPED, { value: true, enumerable: false });
  return wrapped;
}
