// PLAN-25: versioned on-disk store for the evolved HarnessPolicy, mirroring the
// skill-storage idioms (live / staging / archive vN, monotonic .next-version,
// atomic rename). The harness-evolve dream mode stages + promotes candidates
// here; the runner reads the live policy at session start.
//
// Layout under CONFIG_DIR:
//   harness-policy/policy.json              live, active evolved policy
//   harness-policy-staging/policy.json      staged candidate awaiting the gate
//   harness-policy-archive/v<N>/policy.json historical snapshots (rollback)
//   harness-policy-archive/v<N>/.meta.json
//   harness-policy-archive/.next-version    monotonic counter

import { readFileSync, statSync } from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { BitterbotConfig } from "../../config/config.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { CONFIG_DIR } from "../../utils.js";
import {
  type HarnessPolicy,
  mergeActivePolicy,
  parseHarnessPolicy,
  resolveHarnessPolicy,
} from "./harness-policy.js";

const log = createSubsystemLogger("agents/harness-policy-store");

export const LIVE_SUBDIR = "harness-policy";
export const STAGING_SUBDIR = "harness-policy-staging";
export const ARCHIVE_SUBDIR = "harness-policy-archive";
const POLICY_FILE = "policy.json";

export interface HarnessPolicyRoots {
  liveDir: string;
  stagingDir: string;
  archiveDir: string;
}

export interface ArchiveMeta {
  version: number;
  reason: string;
  promotedAt: number;
  /** Held-out paired-bootstrap delta that justified the promotion, if any. */
  delta?: number;
  surfacesTouched?: string[];
}

export function resolveHarnessPolicyRoots(opts: { configDir?: string } = {}): HarnessPolicyRoots {
  const root = opts.configDir ?? CONFIG_DIR;
  return {
    liveDir: path.join(root, LIVE_SUBDIR),
    stagingDir: path.join(root, STAGING_SUBDIR),
    archiveDir: path.join(root, ARCHIVE_SUBDIR),
  };
}

async function atomicWrite(filePath: string, content: string): Promise<void> {
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  try {
    await fsp.writeFile(tmp, content, "utf-8");
    await fsp.rename(tmp, filePath);
  } catch (err) {
    await fsp.unlink(tmp).catch(() => {});
    throw err;
  }
}

// ── Sync read path (runner hot path, mtime-cached) ──

const liveCache = new Map<string, { mtimeMs: number; policy: HarnessPolicy }>();

/** Read the live evolved policy synchronously, or null if none/invalid. */
export function readLivePolicy(opts: { configDir?: string } = {}): HarnessPolicy | null {
  const { liveDir } = resolveHarnessPolicyRoots(opts);
  const file = path.join(liveDir, POLICY_FILE);
  let mtimeMs: number;
  try {
    mtimeMs = statSync(file).mtimeMs;
  } catch {
    return null; // no live policy yet — the normal pre-evolution state
  }
  const cached = liveCache.get(file);
  if (cached && cached.mtimeMs === mtimeMs) return cached.policy;
  try {
    const parsed = parseHarnessPolicy(JSON.parse(readFileSync(file, "utf-8")));
    if (!parsed) return null;
    liveCache.set(file, { mtimeMs, policy: parsed });
    return parsed;
  } catch (err) {
    log.warn(`failed to read live harness policy: ${String(err)}`);
    return null;
  }
}

/**
 * The policy the runner actually uses: config baseline overlaid with the latest
 * promoted evolution. With no evolved policy on disk this returns the baseline
 * unchanged (behavior-neutral).
 */
export function loadActiveHarnessPolicy(
  cfg: BitterbotConfig | undefined,
  opts: { configDir?: string } = {},
): HarnessPolicy {
  const baseline = resolveHarnessPolicy(cfg);
  const evolved = readLivePolicy(opts);
  if (!evolved) return baseline;
  return mergeActivePolicy(baseline, evolved);
}

// ── Async write path (dream mode: stage / promote / rollback) ──

async function readNextVersion(roots: HarnessPolicyRoots): Promise<number> {
  try {
    const n = parseInt(
      await fsp.readFile(path.join(roots.archiveDir, ".next-version"), "utf-8"),
      10,
    );
    return Number.isFinite(n) && n > 0 ? n : 1;
  } catch {
    return 1;
  }
}

async function writeNextVersion(roots: HarnessPolicyRoots, value: number): Promise<void> {
  await atomicWrite(path.join(roots.archiveDir, ".next-version"), String(value));
}

async function readPolicyFile(file: string): Promise<HarnessPolicy | null> {
  try {
    return parseHarnessPolicy(JSON.parse(await fsp.readFile(file, "utf-8")));
  } catch {
    return null;
  }
}

export async function readStagedPolicy(
  opts: { configDir?: string } = {},
): Promise<HarnessPolicy | null> {
  const { stagingDir } = resolveHarnessPolicyRoots(opts);
  return readPolicyFile(path.join(stagingDir, POLICY_FILE));
}

/** Stage a candidate policy (does not affect the live runner). */
export async function stagePolicy(
  policy: HarnessPolicy,
  opts: { configDir?: string } = {},
): Promise<void> {
  const { stagingDir } = resolveHarnessPolicyRoots(opts);
  await atomicWrite(path.join(stagingDir, POLICY_FILE), JSON.stringify(policy, null, 2));
}

/** Archive the current live policy (if any) under the next version number. */
async function archiveLive(roots: HarnessPolicyRoots, reason: string, meta: Partial<ArchiveMeta>) {
  const live = await readPolicyFile(path.join(roots.liveDir, POLICY_FILE));
  if (!live) return null;
  const version = await readNextVersion(roots);
  const dir = path.join(roots.archiveDir, `v${version}`);
  await atomicWrite(path.join(dir, POLICY_FILE), JSON.stringify(live, null, 2));
  const archiveMeta: ArchiveMeta = {
    version,
    reason,
    promotedAt: meta.promotedAt ?? Date.now(),
    delta: meta.delta,
    surfacesTouched: meta.surfacesTouched,
  };
  await atomicWrite(path.join(dir, ".meta.json"), JSON.stringify(archiveMeta, null, 2));
  await writeNextVersion(roots, version + 1);
  return version;
}

/**
 * Promote a validated candidate to live: snapshot the previous live to the
 * archive, then atomically write the candidate as the new live policy. The
 * candidate's version is set to one past the highest archived version.
 */
export async function promotePolicy(
  candidate: HarnessPolicy,
  meta: { reason: string; delta?: number; surfacesTouched?: string[] },
  opts: { configDir?: string } = {},
): Promise<{ previousVersion: number | null; version: number }> {
  const roots = resolveHarnessPolicyRoots(opts);
  const previousVersion = await archiveLive(roots, `pre-promote snapshot (${meta.reason})`, meta);
  const version = await readNextVersion(roots); // next free slot becomes this policy's id
  const live: HarnessPolicy = { ...candidate, version, provenance: "evolved" };
  await atomicWrite(path.join(roots.liveDir, POLICY_FILE), JSON.stringify(live, null, 2));
  await fsp.rm(path.join(roots.stagingDir, POLICY_FILE), { force: true }).catch(() => {});
  log.info(`promoted harness policy v${version} (${meta.surfacesTouched?.join(",") ?? "?"})`);
  return { previousVersion, version };
}

/** Restore an archived version to live, snapshotting current live first. */
export async function rollbackPolicy(
  version: number,
  reason: string,
  opts: { configDir?: string } = {},
): Promise<HarnessPolicy | null> {
  const roots = resolveHarnessPolicyRoots(opts);
  const target = await readPolicyFile(path.join(roots.archiveDir, `v${version}`, POLICY_FILE));
  if (!target) {
    log.warn(`rollback: archived harness policy v${version} not found`);
    return null;
  }
  await archiveLive(roots, `pre-rollback snapshot (target v${version}: ${reason})`, {});
  const restored: HarnessPolicy = { ...target, provenance: "evolved" };
  await atomicWrite(path.join(roots.liveDir, POLICY_FILE), JSON.stringify(restored, null, 2));
  log.info(`rolled back harness policy to v${version} (${reason})`);
  return restored;
}

export interface PolicyVersionRef {
  version: number;
  policy: HarnessPolicy;
}

/** Read the archived policy history, newest first, up to `depth`. */
export async function readPolicyHistory(
  depth: number,
  opts: { configDir?: string } = {},
): Promise<PolicyVersionRef[]> {
  const roots = resolveHarnessPolicyRoots(opts);
  let entries: string[];
  try {
    entries = await fsp.readdir(roots.archiveDir);
  } catch {
    return [];
  }
  const versions = entries
    .map((e) => (e.startsWith("v") ? parseInt(e.slice(1), 10) : NaN))
    .filter((n) => Number.isFinite(n))
    .toSorted((a, b) => b - a)
    .slice(0, depth);
  const refs: PolicyVersionRef[] = [];
  for (const version of versions) {
    const policy = await readPolicyFile(path.join(roots.archiveDir, `v${version}`, POLICY_FILE));
    if (policy) refs.push({ version, policy });
  }
  return refs;
}
