import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  isSessionSkillSnapshotRef,
  type SessionEntry,
  type SessionSkillSnapshot,
  type SessionSkillSnapshotRef,
} from "./types.js";

/**
 * Per-session skills snapshots, stored once per distinct content.
 *
 * Every session entry used to carry its own copy of the skills prompt and the
 * resolved skill records (about 22 KB). The copies were identical across the
 * sessions of an agent, so a store with 300 sessions was a 9.7 MB file that
 * the gateway parsed, deep-copied and rewrote on every turn (2026-10-03
 * profile). The body now lives in `<store dir>/skills-snapshots/<ref>.json`,
 * keyed by a content hash, and the entry keeps a `SessionSkillSnapshotRef`.
 *
 * Reading an index written before this change still works: inline snapshots
 * stay inline until the next save externalizes them.
 */

const log = createSubsystemLogger("sessions/skills-snapshots");

export const SKILLS_SNAPSHOT_DIR = "skills-snapshots";

/** Body kept in the side file: everything but the small fields the ref repeats. */
type SnapshotBody = Pick<SessionSkillSnapshot, "prompt" | "resolvedSkills">;

const bodyCache = new Map<string, SnapshotBody>();
const BODY_CACHE_MAX = 32;

function snapshotDir(storePath: string): string {
  return path.join(path.dirname(storePath), SKILLS_SNAPSHOT_DIR);
}

function snapshotFile(storePath: string, ref: string): string {
  return path.join(snapshotDir(storePath), `${ref}.json`);
}

export function snapshotRefFor(body: SnapshotBody): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify({ prompt: body.prompt, resolvedSkills: body.resolvedSkills ?? null }))
    .digest("hex")
    .slice(0, 16);
}

function isSafeRef(ref: string): boolean {
  return /^[0-9a-f]{16}$/.test(ref);
}

/**
 * Replace inline snapshots with refs, writing each distinct body once.
 * Returns a new store object; the input is not mutated. Bodies that cannot be
 * written stay inline so nothing is lost.
 */
export function externalizeSkillsSnapshots(
  storePath: string,
  store: Record<string, SessionEntry>,
): Record<string, SessionEntry> {
  let out: Record<string, SessionEntry> | null = null;
  const written = new Set<string>();
  for (const [key, entry] of Object.entries(store)) {
    const snapshot = entry?.skillsSnapshot;
    if (!snapshot || isSessionSkillSnapshotRef(snapshot)) {
      continue;
    }
    const body: SnapshotBody = { prompt: snapshot.prompt, resolvedSkills: snapshot.resolvedSkills };
    const ref = snapshotRefFor(body);
    if (!written.has(ref)) {
      try {
        const file = snapshotFile(storePath, ref);
        if (!fs.existsSync(file)) {
          fs.mkdirSync(snapshotDir(storePath), { recursive: true });
          const tmp = `${file}.${process.pid}.tmp`;
          fs.writeFileSync(tmp, JSON.stringify(body), { mode: 0o600, encoding: "utf-8" });
          fs.renameSync(tmp, file);
        }
        bodyCache.set(`${storePath}\u0000${ref}`, body);
        written.add(ref);
      } catch (err) {
        log.warn(`could not externalize skills snapshot ${ref}: ${String(err)}`);
        continue;
      }
    }
    const asRef: SessionSkillSnapshotRef = {
      ref,
      skills: snapshot.skills,
      ...(snapshot.skillFilter ? { skillFilter: snapshot.skillFilter } : {}),
      ...(snapshot.version !== undefined ? { version: snapshot.version } : {}),
    };
    out ??= { ...store };
    out[key] = { ...entry, skillsSnapshot: asRef };
  }
  return out ?? store;
}

/** Delete side files no entry references any more. Best effort. */
export function pruneSkillsSnapshotFiles(
  storePath: string,
  store: Record<string, SessionEntry>,
): number {
  const dir = snapshotDir(storePath);
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return 0;
  }
  const live = new Set<string>();
  for (const entry of Object.values(store)) {
    const snapshot = entry?.skillsSnapshot;
    if (isSessionSkillSnapshotRef(snapshot)) {
      live.add(snapshot.ref);
    }
  }
  let removed = 0;
  for (const name of names) {
    const ref = name.endsWith(".json") ? name.slice(0, -".json".length) : null;
    if (!ref || !isSafeRef(ref) || live.has(ref)) {
      continue;
    }
    try {
      fs.unlinkSync(path.join(dir, name));
      bodyCache.delete(`${storePath}\u0000${ref}`);
      removed += 1;
    } catch {
      // another writer may have removed it
    }
  }
  return removed;
}

function readBody(storePath: string, ref: string): SnapshotBody | undefined {
  if (!isSafeRef(ref)) {
    return undefined;
  }
  const cacheKey = `${storePath}\u0000${ref}`;
  const cached = bodyCache.get(cacheKey);
  if (cached) {
    return cached;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(snapshotFile(storePath, ref), "utf-8")) as unknown;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      typeof (parsed as SnapshotBody).prompt !== "string"
    ) {
      return undefined;
    }
    const body = parsed as SnapshotBody;
    if (bodyCache.size >= BODY_CACHE_MAX) {
      bodyCache.delete(bodyCache.keys().next().value!);
    }
    bodyCache.set(cacheKey, body);
    return body;
  } catch {
    return undefined;
  }
}

/**
 * The full snapshot for a run. Inline snapshots come back as they are; a ref
 * is joined with its body. Returns undefined when the body is gone, so the
 * caller rebuilds the snapshot from the workspace as it would for a session
 * that never had one.
 */
export function materializeSessionSkillsSnapshot(
  storePath: string | undefined,
  snapshot: SessionSkillSnapshot | SessionSkillSnapshotRef | undefined,
): SessionSkillSnapshot | undefined {
  if (!snapshot) {
    return undefined;
  }
  if (!isSessionSkillSnapshotRef(snapshot)) {
    return snapshot;
  }
  if (!storePath) {
    return undefined;
  }
  const body = readBody(storePath, snapshot.ref);
  if (!body) {
    log.warn(`skills snapshot body ${snapshot.ref} missing; the session will rebuild it`);
    return undefined;
  }
  return {
    prompt: body.prompt,
    skills: snapshot.skills,
    ...(snapshot.skillFilter ? { skillFilter: snapshot.skillFilter } : {}),
    ...(body.resolvedSkills ? { resolvedSkills: body.resolvedSkills } : {}),
    ...(snapshot.version !== undefined ? { version: snapshot.version } : {}),
  };
}

export function clearSkillsSnapshotBodyCacheForTest(): void {
  bodyCache.clear();
}
