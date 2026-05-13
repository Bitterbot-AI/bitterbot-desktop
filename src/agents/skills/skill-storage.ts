/**
 * Skill storage layout: live directory, staging directory, version archive.
 *
 * Implements the SICA-style staging-gate pattern for PLAN-15 Phase 2. Skill
 * mutations from the agent's self-edit tool land in the staging directory
 * first. A separate publish step moves them to live after the behavioural
 * gate (Phase 2c). Every transition through live snapshots the previous
 * content into the archive so we can roll back to any prior version.
 *
 * Layout under CONFIG_DIR:
 *
 *   skills/<name>/SKILL.md                       — live, agent-visible
 *   skills-staging/<name>/SKILL.md               — staged edit, not yet live
 *   skills-staging/<name>/.staging-meta.json     — per-stage metadata
 *   skills-archive/<name>/v<N>/SKILL.md          — historical snapshots
 *   skills-archive/<name>/v<N>/.archive-meta.json
 *   skills-archive/<name>/.next-version          — monotonic counter
 *
 * The version counter is monotonic across the lifetime of a skill — restoring
 * an old version still increments the archive version number for the new live
 * snapshot, so the archive grows linearly and never loses history.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { CONFIG_DIR } from "../../utils.js";

const log = createSubsystemLogger("skills/storage");

export const LIVE_SUBDIR = "skills";
export const STAGING_SUBDIR = "skills-staging";
export const ARCHIVE_SUBDIR = "skills-archive";

/** Maximum SKILL.md size to refuse before write (1 MiB). */
export const MAX_SKILL_CONTENT_BYTES = 1_048_576;

/** Skill-name regex matching the existing skills.create sanitiser output. */
const VALID_NAME_RE = /^[a-z0-9][a-z0-9._-]*$/;
const MAX_NAME_LENGTH = 64;

export class SkillStorageError extends Error {
  readonly code: SkillStorageErrorCode;
  constructor(code: SkillStorageErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "SkillStorageError";
  }
}

export type SkillStorageErrorCode =
  | "invalid-name"
  | "name-too-long"
  | "content-too-large"
  | "missing-frontmatter"
  | "not-found"
  | "already-staged"
  | "io-error";

export interface SkillStorageRoots {
  /** Defaults to CONFIG_DIR. Tests override with a tmp dir. */
  configDir?: string;
}

export interface StorageRoots {
  readonly liveRoot: string;
  readonly stagingRoot: string;
  readonly archiveRoot: string;
}

export function resolveStorageRoots(opts: SkillStorageRoots = {}): StorageRoots {
  const root = opts.configDir ?? CONFIG_DIR;
  return {
    liveRoot: path.join(root, LIVE_SUBDIR),
    stagingRoot: path.join(root, STAGING_SUBDIR),
    archiveRoot: path.join(root, ARCHIVE_SUBDIR),
  };
}

/**
 * Reject anything that could escape the storage roots: empty, '..', '/',
 * pattern violations, length. The regex check alone is sufficient — paths
 * are constructed from this name and never user-supplied path segments —
 * but the explicit checks are defensive against future refactors.
 */
export function assertValidSkillName(name: string): void {
  const trimmed = name.trim();
  if (!trimmed) {
    throw new SkillStorageError("invalid-name", "skill name cannot be empty");
  }
  if (trimmed.length > MAX_NAME_LENGTH) {
    throw new SkillStorageError(
      "name-too-long",
      `skill name exceeds ${MAX_NAME_LENGTH} characters`,
    );
  }
  if (trimmed.includes("/") || trimmed.includes("\\") || trimmed.includes("..")) {
    throw new SkillStorageError(
      "invalid-name",
      `skill name "${trimmed}" contains path separators or traversal sequences`,
    );
  }
  if (!VALID_NAME_RE.test(trimmed)) {
    throw new SkillStorageError(
      "invalid-name",
      `skill name "${trimmed}" must match /^[a-z0-9][a-z0-9._-]*$/`,
    );
  }
}

function assertValidContent(content: string): void {
  if (!content.startsWith("---")) {
    throw new SkillStorageError(
      "missing-frontmatter",
      "SKILL.md must start with YAML frontmatter (---)",
    );
  }
  if (Buffer.byteLength(content, "utf-8") > MAX_SKILL_CONTENT_BYTES) {
    throw new SkillStorageError(
      "content-too-large",
      `SKILL.md exceeds ${MAX_SKILL_CONTENT_BYTES} bytes`,
    );
  }
}

async function atomicWrite(filePath: string, content: string): Promise<void> {
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    await fs.writeFile(tmp, content, "utf-8");
    await fs.rename(tmp, filePath);
  } catch (err) {
    try {
      await fs.unlink(tmp);
    } catch {
      // ignore
    }
    throw new SkillStorageError("io-error", `atomic write failed for ${filePath}: ${String(err)}`);
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJsonOr<T>(filePath: string, fallback: T): Promise<T> {
  try {
    const text = await fs.readFile(filePath, "utf-8");
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

// ── Live ────────────────────────────────────────────────────────────────────

export function liveSkillDir(roots: StorageRoots, name: string): string {
  return path.join(roots.liveRoot, name);
}

export function liveSkillPath(roots: StorageRoots, name: string): string {
  return path.join(liveSkillDir(roots, name), "SKILL.md");
}

export async function readLive(roots: StorageRoots, name: string): Promise<string | null> {
  assertValidSkillName(name);
  try {
    return await fs.readFile(liveSkillPath(roots, name), "utf-8");
  } catch {
    return null;
  }
}

// ── Staging ─────────────────────────────────────────────────────────────────

export interface StagingMeta {
  /** Whence the staged content originated. */
  reason: string;
  /** Author tag (e.g. "agent" / "user" / "curator"). */
  author: string;
  /** Wall-clock at stage time. */
  stagedAt: number;
  /** Gate state — set by Phase 2b's behavioural gate when it runs. */
  gateStatus?: "pending" | "passed" | "failed";
  /** Last gate failure reason, if any. */
  gateFailureReason?: string;
}

export function stagingSkillDir(roots: StorageRoots, name: string): string {
  return path.join(roots.stagingRoot, name);
}

export function stagingSkillPath(roots: StorageRoots, name: string): string {
  return path.join(stagingSkillDir(roots, name), "SKILL.md");
}

export function stagingMetaPath(roots: StorageRoots, name: string): string {
  return path.join(stagingSkillDir(roots, name), ".staging-meta.json");
}

export async function readStaged(
  roots: StorageRoots,
  name: string,
): Promise<{
  content: string;
  meta: StagingMeta;
} | null> {
  assertValidSkillName(name);
  try {
    const content = await fs.readFile(stagingSkillPath(roots, name), "utf-8");
    const meta = await readJsonOr<StagingMeta>(stagingMetaPath(roots, name), {
      reason: "(unknown)",
      author: "(unknown)",
      stagedAt: 0,
    });
    return { content, meta };
  } catch {
    return null;
  }
}

export async function hasStaged(roots: StorageRoots, name: string): Promise<boolean> {
  assertValidSkillName(name);
  return fileExists(stagingSkillPath(roots, name));
}

export interface StageSkillParams {
  name: string;
  content: string;
  reason: string;
  author: string;
  /** Allow overwriting an existing staged version. Defaults to false. */
  overwrite?: boolean;
  /** Override timestamp (test determinism). */
  timestamp?: number;
}

/** Write a SKILL.md into the staging directory. */
export async function stageSkill(
  roots: StorageRoots,
  params: StageSkillParams,
): Promise<{ filePath: string; meta: StagingMeta }> {
  assertValidSkillName(params.name);
  assertValidContent(params.content);
  const dir = stagingSkillDir(roots, params.name);
  const filePath = stagingSkillPath(roots, params.name);
  const metaPath = stagingMetaPath(roots, params.name);
  if (!params.overwrite && (await fileExists(filePath))) {
    throw new SkillStorageError(
      "already-staged",
      `skill "${params.name}" already has a staged edit; pass overwrite=true to replace`,
    );
  }
  await fs.mkdir(dir, { recursive: true });
  await atomicWrite(filePath, params.content);
  const meta: StagingMeta = {
    reason: params.reason,
    author: params.author,
    stagedAt: params.timestamp ?? Date.now(),
    gateStatus: "pending",
  };
  await atomicWrite(metaPath, JSON.stringify(meta, null, 2));
  log.debug(`staged ${params.name} by ${params.author}: ${params.reason}`);
  return { filePath, meta };
}

/** Update only the gate status fields on an existing staging meta. */
export async function updateStagingGateStatus(
  roots: StorageRoots,
  name: string,
  status: "passed" | "failed",
  failureReason?: string,
): Promise<void> {
  assertValidSkillName(name);
  const metaPath = stagingMetaPath(roots, name);
  const current = await readJsonOr<StagingMeta>(metaPath, {
    reason: "(unknown)",
    author: "(unknown)",
    stagedAt: Date.now(),
  });
  const next: StagingMeta = {
    ...current,
    gateStatus: status,
    ...(failureReason ? { gateFailureReason: failureReason } : {}),
  };
  await atomicWrite(metaPath, JSON.stringify(next, null, 2));
}

/** Delete the staged copy (e.g. on operator-requested discard). */
export async function discardStaged(roots: StorageRoots, name: string): Promise<boolean> {
  assertValidSkillName(name);
  const dir = stagingSkillDir(roots, name);
  try {
    await fs.rm(dir, { recursive: true, force: true });
    return true;
  } catch (err) {
    log.warn(`failed to discard staging for ${name}: ${String(err)}`);
    return false;
  }
}

// ── Archive ─────────────────────────────────────────────────────────────────

export interface ArchiveMeta {
  /** Why this version was created (publish / rollback / consolidate). */
  reason: string;
  /** Who triggered the archive (agent / curator / user). */
  author: string;
  /** When the snapshot was taken. */
  archivedAt: number;
}

export function archiveSkillDir(roots: StorageRoots, name: string): string {
  return path.join(roots.archiveRoot, name);
}

export function archiveVersionDir(roots: StorageRoots, name: string, version: number): string {
  return path.join(archiveSkillDir(roots, name), `v${version}`);
}

export function archiveCounterPath(roots: StorageRoots, name: string): string {
  return path.join(archiveSkillDir(roots, name), ".next-version");
}

async function readNextVersion(roots: StorageRoots, name: string): Promise<number> {
  try {
    const text = await fs.readFile(archiveCounterPath(roots, name), "utf-8");
    const n = parseInt(text.trim(), 10);
    return Number.isFinite(n) && n > 0 ? n : 1;
  } catch {
    return 1;
  }
}

async function writeNextVersion(roots: StorageRoots, name: string, value: number): Promise<void> {
  await fs.mkdir(archiveSkillDir(roots, name), { recursive: true });
  await atomicWrite(archiveCounterPath(roots, name), String(value));
}

export interface ArchivedVersion {
  version: number;
  meta: ArchiveMeta;
  contentPath: string;
}

/**
 * Snapshot the given content into the next available archive slot. Returns
 * the chosen version number. Idempotent only with respect to the counter —
 * each call increments.
 */
export async function archiveVersion(
  roots: StorageRoots,
  params: {
    name: string;
    content: string;
    reason: string;
    author: string;
    timestamp?: number;
  },
): Promise<ArchivedVersion> {
  assertValidSkillName(params.name);
  assertValidContent(params.content);
  const version = await readNextVersion(roots, params.name);
  const dir = archiveVersionDir(roots, params.name, version);
  await fs.mkdir(dir, { recursive: true });
  const contentPath = path.join(dir, "SKILL.md");
  const metaPath = path.join(dir, ".archive-meta.json");
  const meta: ArchiveMeta = {
    reason: params.reason,
    author: params.author,
    archivedAt: params.timestamp ?? Date.now(),
  };
  await atomicWrite(contentPath, params.content);
  await atomicWrite(metaPath, JSON.stringify(meta, null, 2));
  await writeNextVersion(roots, params.name, version + 1);
  return { version, meta, contentPath };
}

export async function listArchivedVersions(
  roots: StorageRoots,
  name: string,
): Promise<ArchivedVersion[]> {
  assertValidSkillName(name);
  const dir = archiveSkillDir(roots, name);
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }
  const versions: ArchivedVersion[] = [];
  for (const entry of entries) {
    const match = entry.match(/^v(\d+)$/);
    if (!match) {
      continue;
    }
    const version = parseInt(match[1] ?? "0", 10);
    if (!Number.isFinite(version) || version <= 0) {
      continue;
    }
    const versionDir = path.join(dir, entry);
    const contentPath = path.join(versionDir, "SKILL.md");
    if (!(await fileExists(contentPath))) {
      continue;
    }
    const meta = await readJsonOr<ArchiveMeta>(path.join(versionDir, ".archive-meta.json"), {
      reason: "(unknown)",
      author: "(unknown)",
      archivedAt: 0,
    });
    versions.push({ version, meta, contentPath });
  }
  versions.sort((a, b) => a.version - b.version);
  return versions;
}

export async function readArchivedVersion(
  roots: StorageRoots,
  name: string,
  version: number,
): Promise<{ content: string; meta: ArchiveMeta } | null> {
  assertValidSkillName(name);
  if (!Number.isInteger(version) || version <= 0) {
    return null;
  }
  const dir = archiveVersionDir(roots, name, version);
  const contentPath = path.join(dir, "SKILL.md");
  try {
    const content = await fs.readFile(contentPath, "utf-8");
    const meta = await readJsonOr<ArchiveMeta>(path.join(dir, ".archive-meta.json"), {
      reason: "(unknown)",
      author: "(unknown)",
      archivedAt: 0,
    });
    return { content, meta };
  } catch {
    return null;
  }
}

// ── Publish / rollback orchestration ───────────────────────────────────────

/**
 * Move staged content to live, snapshotting the previous live version into
 * the archive first. Returns the archived version of the previous live (or
 * null if no previous live existed) and the staged content now live.
 */
export async function publishStaged(
  roots: StorageRoots,
  params: { name: string; reason: string; author: string; timestamp?: number },
): Promise<{
  previousArchived: ArchivedVersion | null;
  publishedContent: string;
}> {
  assertValidSkillName(params.name);
  const staged = await readStaged(roots, params.name);
  if (!staged) {
    throw new SkillStorageError("not-found", `no staged content found for skill "${params.name}"`);
  }
  // Snapshot the previous live, if any.
  const prevLive = await readLive(roots, params.name);
  let previousArchived: ArchivedVersion | null = null;
  if (prevLive) {
    previousArchived = await archiveVersion(roots, {
      name: params.name,
      content: prevLive,
      reason: `pre-publish snapshot (${params.reason})`,
      author: params.author,
      timestamp: params.timestamp,
    });
  }
  // Write staged content to live.
  await fs.mkdir(liveSkillDir(roots, params.name), { recursive: true });
  await atomicWrite(liveSkillPath(roots, params.name), staged.content);
  await discardStaged(roots, params.name);
  log.debug(`published ${params.name} (previous version ${previousArchived?.version ?? "n/a"})`);
  return { previousArchived, publishedContent: staged.content };
}

/**
 * Restore an archived version to live. Snapshots the current live to a NEW
 * archive entry first so the rollback is itself rollback-able.
 */
export async function rollbackToVersion(
  roots: StorageRoots,
  params: {
    name: string;
    version: number;
    reason: string;
    author: string;
    timestamp?: number;
  },
): Promise<{
  previousArchived: ArchivedVersion | null;
  restoredContent: string;
}> {
  assertValidSkillName(params.name);
  const target = await readArchivedVersion(roots, params.name, params.version);
  if (!target) {
    throw new SkillStorageError(
      "not-found",
      `archived version v${params.version} not found for skill "${params.name}"`,
    );
  }
  const prevLive = await readLive(roots, params.name);
  let previousArchived: ArchivedVersion | null = null;
  if (prevLive) {
    previousArchived = await archiveVersion(roots, {
      name: params.name,
      content: prevLive,
      reason: `pre-rollback snapshot (target v${params.version}: ${params.reason})`,
      author: params.author,
      timestamp: params.timestamp,
    });
  }
  await fs.mkdir(liveSkillDir(roots, params.name), { recursive: true });
  await atomicWrite(liveSkillPath(roots, params.name), target.content);
  log.debug(`rolled back ${params.name} to v${params.version}`);
  return { previousArchived, restoredContent: target.content };
}
