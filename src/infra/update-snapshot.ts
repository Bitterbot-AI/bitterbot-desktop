/**
 * Pre-update snapshots of user data (PLAN-56 Phase 3b).
 *
 * Before a release-tarball update activates a new version, the updater
 * copies what an update could damage into
 * `<stateDir>/snapshots/<timestamp>-<from>-to-<to>/` with a manifest:
 *
 *   - config: the config file and `<stateDir>/.env`
 *   - databases: every `<stateDir>/memory/*.sqlite`, copied with SQLite's
 *     `VACUUM INTO` (a consistent copy of a live WAL database; a raw file copy
 *     of a DB with an active -wal file can be torn), plus its schema_version
 *   - workspace: GENOME.md and MEMORY.md of the default agent
 *   - keys: the P2P identity (`node.key`, `node.pub` and the files that travel
 *     with them). COPIED, never moved: the originals are not touched.
 *
 * The app directory (`~/.bitterbot/app`) is never included. Only the newest
 * SNAPSHOT_KEEP (3) complete snapshots are kept; older ones are pruned after
 * a new one is written. A snapshot directory without manifest.json is an
 * interrupted one and is pruned too.
 *
 * Restoring is deliberately narrow (planSnapshotRestore): only what the
 * newer version changed and the older one may not be able to read. See the
 * rollback data policy in docs/cli/update.md.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

export const SNAPSHOTS_DIRNAME = "snapshots";
export const SNAPSHOT_KEEP = 3;
const MANIFEST = "manifest.json";
const SNAPSHOT_NAME_RE = /^\d{8}T\d{6}Z-[0-9.]+-to-[0-9.]+(-\d+)?$/;

export type SnapshotEntryKind = "config" | "database" | "workspace" | "key";

export type SnapshotEntry = {
  kind: SnapshotEntryKind;
  /** Absolute path of the original file. */
  source: string;
  /** Path of the copy, relative to the snapshot directory. */
  file: string;
  sha256: string;
  size: number;
  /** Databases: the memory schema_version at snapshot time (null when unreadable). */
  schemaVersion?: number | null;
};

export type SnapshotManifest = {
  schema: 1;
  createdAt: string;
  from: string;
  to: string;
  stateDir: string;
  /**
   * LATEST_SCHEMA_VERSION of the version that took the snapshot (`from`):
   * the newest memory schema the pre-update code knows.
   */
  fromMemorySchemaLatest: number;
  entries: SnapshotEntry[];
};

export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SnapshotError";
  }
}

export function snapshotsRoot(stateDir: string): string {
  return path.join(stateDir, SNAPSHOTS_DIRNAME);
}

function sha256File(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function compactTimestamp(date: Date): string {
  return date
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z")
    .replace(/[-:]/g, "");
}

function fileSize(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

/** `*.sqlite` files directly under `<stateDir>/memory`. */
export function listMemoryDatabases(stateDir: string): string[] {
  const dir = path.join(stateDir, "memory");
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith(".sqlite"))
      .map((e) => path.join(dir, e.name))
      .toSorted();
  } catch {
    return [];
  }
}

/**
 * Child-process script: open the DB read-only, read meta.schema_version,
 * VACUUM INTO the destination. Run out of process so a large memory DB never
 * blocks the gateway's event loop (the update can run inside the gateway).
 */
const SQLITE_SNAPSHOT_SCRIPT = `
const { DatabaseSync } = require("node:sqlite");
const [src, dest, mode] = process.argv.slice(1);
const db = new DatabaseSync(src, { readOnly: true });
try {
  db.exec("PRAGMA busy_timeout = 15000");
  let schemaVersion = null;
  try {
    const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
    const n = row ? parseInt(String(row.value), 10) : NaN;
    schemaVersion = Number.isFinite(n) ? n : null;
  } catch {}
  if (mode === "copy") db.prepare("VACUUM INTO ?").run(dest);
  process.stdout.write(JSON.stringify({ schemaVersion }));
} finally {
  db.close();
}
`;

async function runSqliteHelper(
  src: string,
  dest: string,
  mode: "copy" | "read",
): Promise<{ schemaVersion: number | null }> {
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ["--no-warnings", "-e", SQLITE_SNAPSHOT_SCRIPT, src, dest, mode],
    { timeout: 30 * 60_000, maxBuffer: 1024 * 1024 },
  );
  const parsed = JSON.parse(stdout) as { schemaVersion?: unknown };
  return {
    schemaVersion: typeof parsed.schemaVersion === "number" ? parsed.schemaVersion : null,
  };
}

/** The memory schema_version a database reports now (null when unreadable or absent). */
export async function readDatabaseSchemaVersion(file: string): Promise<number | null> {
  if (!fs.existsSync(file)) {
    return null;
  }
  try {
    return (await runSqliteHelper(file, "", "read")).schemaVersion;
  } catch {
    return null;
  }
}

export type SnapshotSources = {
  stateDir: string;
  configPath: string;
  /** Default agent workspace (GENOME.md, MEMORY.md); null to skip. */
  workspaceDir: string | null;
  /** P2P key directory; null to skip. */
  keyDir: string | null;
};

const WORKSPACE_FILES = ["GENOME.md", "MEMORY.md"];
const KEY_FILES = ["node.key", "node.pub", "genesis_trust_list.txt", "bootnode-peers.json"];

/** Rough bytes a snapshot of `sources` needs (databases dominate). */
export function estimateSnapshotBytes(sources: SnapshotSources): number {
  let total = fileSize(sources.configPath) + fileSize(path.join(sources.stateDir, ".env"));
  for (const db of listMemoryDatabases(sources.stateDir)) {
    total += fileSize(db) + fileSize(`${db}-wal`);
  }
  return total;
}

function freeBytes(dir: string): number | null {
  try {
    const st = fs.statfsSync(dir);
    return Number(st.bavail) * Number(st.bsize);
  } catch {
    return null;
  }
}

function copyPreserving(src: string, dest: string, mode: number): void {
  fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
  // COPYFILE_EXCL: never overwrite; the source is only read.
  fs.copyFileSync(src, dest, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(dest, mode);
}

/**
 * Take a snapshot. Throws a SnapshotError (and removes the partial
 * directory) when anything that exists cannot be copied, or when the disk
 * does not have room: the update must not proceed without its safety net.
 */
export async function createUpdateSnapshot(params: {
  sources: SnapshotSources;
  from: string;
  to: string;
  fromMemorySchemaLatest: number;
  now?: Date;
  keep?: number;
}): Promise<{ dir: string; manifest: SnapshotManifest; pruned: string[] }> {
  const { sources } = params;
  const root = snapshotsRoot(sources.stateDir);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const need = estimateSnapshotBytes(sources);
  const free = freeBytes(root);
  const margin = 64 * 1024 * 1024;
  if (free !== null && free < need * 1.1 + margin) {
    throw new SnapshotError(
      `not enough free disk space for the pre-update snapshot in ${root}: ${Math.round(free / 1e6)} MB free, about ${Math.round((need * 1.1 + margin) / 1e6)} MB needed. Free some space (old snapshots live in ${root}) and retry.`,
    );
  }
  const now = params.now ?? new Date();
  const base = `${compactTimestamp(now)}-${params.from}-to-${params.to}`;
  let name = base;
  for (let i = 1; fs.existsSync(path.join(root, name)); i += 1) {
    name = `${base}-${i}`;
  }
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { mode: 0o700 });
  const entries: SnapshotEntry[] = [];
  try {
    const addFile = (kind: SnapshotEntryKind, source: string, rel: string, mode = 0o600) => {
      if (!fs.existsSync(source) || !fs.statSync(source).isFile()) {
        return;
      }
      const dest = path.join(dir, rel);
      copyPreserving(source, dest, mode);
      entries.push({ kind, source, file: rel, sha256: sha256File(dest), size: fileSize(dest) });
    };
    addFile("config", sources.configPath, path.join("config", path.basename(sources.configPath)));
    addFile("config", path.join(sources.stateDir, ".env"), path.join("config", ".env"));
    fs.mkdirSync(path.join(dir, "memory"), { mode: 0o700 });
    for (const db of listMemoryDatabases(sources.stateDir)) {
      const rel = path.join("memory", path.basename(db));
      const dest = path.join(dir, rel);
      let res: { schemaVersion: number | null };
      try {
        res = await runSqliteHelper(db, dest, "copy");
      } catch (err) {
        throw new SnapshotError(
          `could not snapshot ${db} with VACUUM INTO: ${String((err as { stderr?: string }).stderr || err).trim()}`,
        );
      }
      fs.chmodSync(dest, 0o600);
      entries.push({
        kind: "database",
        source: db,
        file: rel,
        sha256: sha256File(dest),
        size: fileSize(dest),
        schemaVersion: res.schemaVersion,
      });
    }
    if (sources.workspaceDir) {
      for (const f of WORKSPACE_FILES) {
        addFile("workspace", path.join(sources.workspaceDir, f), path.join("workspace", f));
      }
    }
    if (sources.keyDir) {
      for (const f of KEY_FILES) {
        addFile("key", path.join(sources.keyDir, f), path.join("keys", f));
      }
    }
    const manifest: SnapshotManifest = {
      schema: 1,
      createdAt: now.toISOString(),
      from: params.from,
      to: params.to,
      stateDir: sources.stateDir,
      fromMemorySchemaLatest: params.fromMemorySchemaLatest,
      entries,
    };
    // The manifest is written last: a directory without one is incomplete.
    const tmp = path.join(dir, `${MANIFEST}.tmp`);
    fs.writeFileSync(tmp, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, path.join(dir, MANIFEST));
    const pruned = pruneSnapshots(sources.stateDir, params.keep ?? SNAPSHOT_KEEP, name);
    return { dir, manifest, pruned };
  } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw err instanceof SnapshotError ? err : new SnapshotError(String(err));
  }
}

export function readSnapshotManifest(dir: string): SnapshotManifest | null {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(path.join(dir, MANIFEST), "utf8"),
    ) as SnapshotManifest;
    if (parsed?.schema === 1 && Array.isArray(parsed.entries) && typeof parsed.from === "string") {
      return parsed;
    }
  } catch {
    // incomplete or foreign
  }
  return null;
}

/** Complete snapshots, newest first. */
export function listSnapshots(
  stateDir: string,
): Array<{ dir: string; manifest: SnapshotManifest }> {
  const root = snapshotsRoot(stateDir);
  let names: string[] = [];
  try {
    names = fs.readdirSync(root).filter((n) => SNAPSHOT_NAME_RE.test(n));
  } catch {
    return [];
  }
  const out: Array<{ dir: string; manifest: SnapshotManifest }> = [];
  for (const name of names.toSorted().toReversed()) {
    const dir = path.join(root, name);
    const manifest = readSnapshotManifest(dir);
    if (manifest) {
      out.push({ dir, manifest });
    }
  }
  return out;
}

/**
 * Keep the newest `keep` complete snapshots; remove older ones and any
 * incomplete directory (no manifest) other than `active`. Only directories
 * named like snapshots are touched.
 */
export function pruneSnapshots(stateDir: string, keep = SNAPSHOT_KEEP, active?: string): string[] {
  const root = snapshotsRoot(stateDir);
  let names: string[] = [];
  try {
    names = fs.readdirSync(root).filter((n) => SNAPSHOT_NAME_RE.test(n));
  } catch {
    return [];
  }
  const removed: string[] = [];
  let kept = 0;
  for (const name of names.toSorted().toReversed()) {
    const dir = path.join(root, name);
    const complete = readSnapshotManifest(dir) !== null;
    if (complete && kept < keep) {
      kept += 1;
      continue;
    }
    if (!complete && name === active) {
      continue;
    }
    fs.rmSync(dir, { recursive: true, force: true });
    removed.push(name);
  }
  return removed;
}

/** The newest snapshot taken for the update `from` -> `to`. */
export function findSnapshotFor(
  stateDir: string,
  from: string,
  to: string,
): { dir: string; manifest: SnapshotManifest } | null {
  return (
    listSnapshots(stateDir).find((s) => s.manifest.from === from && s.manifest.to === to) ?? null
  );
}

export type RestoreAction = {
  entry: SnapshotEntry;
  reason: string;
};

export type RestorePlan = {
  restore: RestoreAction[];
  /** Data the plan leaves alone on purpose, with the reason (for the report). */
  kept: Array<{ source: string; reason: string }>;
};

/**
 * Decide what a rollback restores from `manifest` (the snapshot taken for
 * the update being undone). The policy, and why:
 *
 *   - Config files: restored when they changed since the snapshot. The older
 *     version validates config strictly, so a key the newer version wrote can
 *     stop it from booting. The newer file is kept beside the snapshot.
 *   - Memory databases: KEPT by default. Restoring one throws away every
 *     memory written since the update, and migrations are forward-only with
 *     an N-1 compatibility contract (src/memory/migrations.ts), so the older
 *     version reads the migrated schema. A database is restored only when an
 *     automatic rollback finds that the newer version migrated it past the
 *     newest schema the older version knows (schema_version >
 *     `targetMemorySchemaLatest`): that version never booted healthy, so it
 *     wrote almost nothing worth keeping, and an unknown schema is the likely
 *     reason it failed. A manual rollback (`bitterbot update --rollback`)
 *     restores databases only with `includeData` (`--restore-data`).
 *   - GENOME.md, MEMORY.md and keys: never restored automatically (they are
 *     not changed by an update; the copies are there for a manual restore).
 */
export async function planSnapshotRestore(params: {
  manifest: SnapshotManifest;
  snapshotDir: string;
  mode: "auto" | "manual";
  targetMemorySchemaLatest: number;
  includeData?: boolean;
  readSchemaVersion?: (file: string) => Promise<number | null>;
}): Promise<RestorePlan> {
  const readSchema = params.readSchemaVersion ?? readDatabaseSchemaVersion;
  const plan: RestorePlan = { restore: [], kept: [] };
  for (const entry of params.manifest.entries) {
    if (!fs.existsSync(path.join(params.snapshotDir, entry.file))) {
      plan.kept.push({ source: entry.source, reason: "snapshot copy missing" });
      continue;
    }
    if (entry.kind === "config") {
      let current: string | null = null;
      try {
        current = sha256File(entry.source);
      } catch {
        current = null;
      }
      if (current === entry.sha256) {
        plan.kept.push({ source: entry.source, reason: "unchanged since the update" });
      } else {
        plan.restore.push({
          entry,
          reason:
            current === null
              ? "missing after the update"
              : "changed by or after the update; the older version validates config strictly",
        });
      }
      continue;
    }
    if (entry.kind === "database") {
      if (params.includeData) {
        plan.restore.push({ entry, reason: "--restore-data" });
        continue;
      }
      const now = await readSchema(entry.source);
      if (now !== null && now > params.targetMemorySchemaLatest) {
        if (params.mode === "auto") {
          plan.restore.push({
            entry,
            reason: `schema ${now} is newer than the ${params.targetMemorySchemaLatest} the restored version knows`,
          });
        } else {
          plan.kept.push({
            source: entry.source,
            reason: `kept (schema ${now} is newer than ${params.targetMemorySchemaLatest}; the N-1 migration contract keeps it readable). Pass --restore-data to restore the pre-update copy and lose writes since the update`,
          });
        }
      } else {
        plan.kept.push({
          source: entry.source,
          reason: "kept: the restored version reads this schema, and restoring would lose writes",
        });
      }
      continue;
    }
    plan.kept.push({
      source: entry.source,
      reason: "never restored automatically; a copy is in the snapshot",
    });
  }
  return plan;
}

export type RestoreResult = {
  restored: string[];
  /** Where the replaced (post-update) files were moved. */
  displacedDir: string | null;
};

/**
 * Apply a plan. Every file that gets replaced is MOVED into
 * `<snapshotDir>/displaced-<timestamp>/` first (with its -wal/-shm for a
 * database), never deleted. The gateway must be stopped for databases.
 */
export function applySnapshotRestore(params: {
  plan: RestorePlan;
  snapshotDir: string;
  now?: Date;
}): RestoreResult {
  if (params.plan.restore.length === 0) {
    return { restored: [], displacedDir: null };
  }
  const displacedDir = path.join(
    params.snapshotDir,
    `displaced-${compactTimestamp(params.now ?? new Date())}`,
  );
  fs.mkdirSync(displacedDir, { recursive: true, mode: 0o700 });
  const restored: string[] = [];
  for (const { entry } of params.plan.restore) {
    const target = entry.source;
    const companions = entry.kind === "database" ? ["", "-wal", "-shm", "-journal"] : [""];
    for (const suffix of companions) {
      const file = `${target}${suffix}`;
      if (fs.existsSync(file)) {
        const dest = path.join(displacedDir, `${entry.kind}-${path.basename(file)}`);
        try {
          fs.renameSync(file, dest);
        } catch {
          // Another filesystem: copy, then remove the original.
          fs.copyFileSync(file, dest);
          fs.rmSync(file, { force: true });
        }
      }
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = `${target}.restore-${process.pid}`;
    fs.copyFileSync(path.join(params.snapshotDir, entry.file), tmp);
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, target);
    restored.push(target);
  }
  return { restored, displacedDir };
}
