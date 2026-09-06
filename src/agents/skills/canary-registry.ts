/**
 * PLAN-45 Phase 3.2: the canary registry and the per-run exposure filter.
 *
 * A skill the validation gate just promoted is NOT shown to every run. It
 * lands in `skill-wiki/canary.json`, and each run is assigned by a stable
 * hash of (skill, run) to an exposed or a withheld bucket. The withheld
 * runs are the control cohort the post-promotion monitor compares against
 * (canary-monitor.ts): same period, same node, same model, no skill.
 *
 * Runtime cost: one fs.stat per run (the file is re-parsed only when its
 * mtime/size changes) and a string filter over the cached skills prompt.
 * The registry lives outside the skills watch globs on purpose: writing it
 * must not bump the snapshot version and rebuild every session's index.
 */

import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { emitAgentEvent } from "../../infra/agent-events.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { resolveWikiDir, type ImpactTrailOptions } from "./impact-trail.js";
import { bumpSkillsSnapshotVersion } from "./refresh.js";

const log = createSubsystemLogger("skills/canary");

export const CANARY_REGISTRY_FILENAME = "canary.json";
/** Share of eligible runs that see a canary skill (the rest are the control cohort). */
export const DEFAULT_CANARY_FRACTION = 0.5;

export interface CanaryEntry {
  startedAt: number;
  bucketFraction: number;
  /** Description at canary start: the eligibility key for the whole window (a later repair must not move the denominator). */
  descriptionAtStart: string;
  reason:
    | "gate"
    | "model-drift"
    | "operator"
    | "regression"
    | "attestation"
    | "tamper"
    | "transfer"
    | "never-read";
  /** PLAN-45 4.6: a stricter monitor window (weaker-to-stronger or unknown transfers). */
  strict?: {
    minExposed: number;
    minUnexposed: number;
    checkpoints: number[];
    alphaPerLook: number;
    graduateRuns: number;
    graduateDays: number;
  };
  /** Bucket salt, so exposure is independent of any other hash split on the run id. */
  seed: string;
}

export interface CanaryRegistry {
  version: 1;
  skills: Record<string, CanaryEntry>;
}

export function canaryRegistryPath(opts: ImpactTrailOptions = {}): string {
  return path.join(resolveWikiDir(opts), CANARY_REGISTRY_FILENAME);
}

const EMPTY: CanaryRegistry = { version: 1, skills: {} };

function parseRegistry(raw: string): CanaryRegistry {
  const parsed = JSON.parse(raw) as Partial<CanaryRegistry>;
  const skills: Record<string, CanaryEntry> = {};
  for (const [name, entry] of Object.entries(parsed.skills ?? {})) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const e = entry as Partial<CanaryEntry>;
    if (typeof e.startedAt !== "number" || !Number.isFinite(e.startedAt)) {
      continue;
    }
    skills[name] = {
      startedAt: e.startedAt,
      bucketFraction:
        typeof e.bucketFraction === "number" && e.bucketFraction >= 0 && e.bucketFraction <= 1
          ? e.bucketFraction
          : DEFAULT_CANARY_FRACTION,
      descriptionAtStart: typeof e.descriptionAtStart === "string" ? e.descriptionAtStart : "",
      reason:
        e.reason === "model-drift" ||
        e.reason === "operator" ||
        e.reason === "regression" ||
        e.reason === "attestation" ||
        e.reason === "tamper" ||
        e.reason === "transfer" ||
        e.reason === "never-read"
          ? e.reason
          : "gate",
      seed: typeof e.seed === "string" ? e.seed : String(e.startedAt),
      ...(parseStrict(e.strict)
        ? { strict: parseStrict(e.strict) as NonNullable<CanaryEntry["strict"]> }
        : {}),
    };
  }
  return { version: 1, skills };
}

function parseStrict(raw: unknown): CanaryEntry["strict"] | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const s = raw as Record<string, unknown>;
  const num = (v: unknown, lo: number, hi: number) =>
    typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi ? v : undefined;
  const minExposed = num(s.minExposed, 1, 10_000);
  const minUnexposed = num(s.minUnexposed, 1, 10_000);
  const alphaPerLook = num(s.alphaPerLook, 0, 1);
  const graduateRuns = num(s.graduateRuns, 1, 100_000);
  const graduateDays = num(s.graduateDays, 1, 365);
  const checkpoints = Array.isArray(s.checkpoints)
    ? s.checkpoints.filter((c): c is number => typeof c === "number" && c > 0 && c <= 10_000)
    : [];
  if (
    minExposed === undefined ||
    minUnexposed === undefined ||
    alphaPerLook === undefined ||
    graduateRuns === undefined ||
    graduateDays === undefined ||
    checkpoints.length === 0
  ) {
    return undefined;
  }
  return { minExposed, minUnexposed, checkpoints, alphaPerLook, graduateRuns, graduateDays };
}

let cache: {
  file: string;
  mtimeMs: number;
  size: number;
  ino: number;
  registry: CanaryRegistry;
} | null = null;

/** Registry read on the run path: stat per call, parse only on change. Never throws. */
export function readCanaryRegistrySync(opts: ImpactTrailOptions = {}): CanaryRegistry {
  const file = canaryRegistryPath(opts);
  let st: fsSync.Stats;
  try {
    st = fsSync.statSync(file);
  } catch {
    cache = null;
    return EMPTY;
  }
  if (
    cache &&
    cache.file === file &&
    cache.mtimeMs === st.mtimeMs &&
    cache.size === st.size &&
    cache.ino === st.ino
  ) {
    return cache.registry;
  }
  let registry: CanaryRegistry;
  try {
    registry = parseRegistry(fsSync.readFileSync(file, "utf-8"));
  } catch (err) {
    // A corrupt file costs one read, not one per run (adversarial 3-12).
    log.warn(`canary registry unreadable; treating as empty: ${String(err)}`);
    registry = EMPTY;
  }
  cache = { file, mtimeMs: st.mtimeMs, size: st.size, ino: st.ino, registry };
  return registry;
}

export async function readCanaryRegistry(opts: ImpactTrailOptions = {}): Promise<CanaryRegistry> {
  try {
    return parseRegistry(await fs.readFile(canaryRegistryPath(opts), "utf-8"));
  } catch {
    return { version: 1, skills: {} };
  }
}

export async function writeCanaryRegistry(
  registry: CanaryRegistry,
  opts: ImpactTrailOptions = {},
): Promise<void> {
  const file = canaryRegistryPath(opts);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(registry, null, 2), "utf-8");
  await fs.rename(tmp, file);
  cache = null;
}

export async function registerCanary(
  name: string,
  entry: Omit<CanaryEntry, "seed"> & { seed?: string },
  opts: ImpactTrailOptions = {},
): Promise<void> {
  const registry = await readCanaryRegistry(opts);
  registry.skills[name] = {
    ...entry,
    seed: entry.seed ?? `${entry.startedAt}-${Math.random().toString(36).slice(2, 10)}`,
  };
  await writeCanaryRegistry(registry, opts);
}

export async function unregisterCanary(
  name: string,
  opts: ImpactTrailOptions = {},
): Promise<boolean> {
  const registry = await readCanaryRegistry(opts);
  if (!(name in registry.skills)) {
    return false;
  }
  const wasOff = isCanaryOff(registry.skills[name]);
  delete registry.skills[name];
  await writeCanaryRegistry(registry, opts);
  if (wasOff) {
    bumpSkillsSnapshotVersion({ reason: "manual", changedPath: canaryRegistryPath(opts) });
  }
  return true;
}

/**
 * PLAN-45 4.3 (D-4): CANARY-OFF. A registry entry with `bucketFraction: 0`
 * withholds the skill from EVERY run: removed from the index, files kept,
 * reversible with `unregisterCanary`. Deletion stays operator-only.
 */
export function isCanaryOff(entry: CanaryEntry | undefined): boolean {
  return entry !== undefined && entry.bucketFraction === 0;
}

export async function canaryOff(
  name: string,
  params: {
    reason: "regression" | "attestation" | "tamper" | "operator" | "never-read";
    descriptionAtStart?: string;
    now?: number;
  },
  opts: ImpactTrailOptions = {},
): Promise<void> {
  const now = params.now ?? Date.now();
  await registerCanary(
    name,
    {
      startedAt: now,
      bucketFraction: 0,
      descriptionAtStart: params.descriptionAtStart ?? "",
      reason: params.reason,
    },
    opts,
  );
  // The ladder says so too (adversarial 4-5), when the skill has a meta.
  const metaPath = path.join(
    opts.configDir ?? path.dirname(resolveWikiDir()),
    "skills",
    name,
    ".evolution-meta.json",
  );
  try {
    const meta = JSON.parse(await fs.readFile(metaPath, "utf-8")) as {
      ladder?: { state?: string };
      canary?: Record<string, unknown>;
    };
    const next = {
      ...meta,
      ladder: {
        state: "canary-off",
        at: now,
        by: "monitor",
        reason: params.reason,
        previous: meta.ladder?.state,
      },
      ...(meta.canary ? { canary: { ...meta.canary, endedAt: now } } : {}),
    };
    const tmp = `${metaPath}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(next, null, 2), "utf-8");
    await fs.rename(tmp, metaPath);
  } catch {
    // no meta (legacy peer skill): the registry entry is the record
  }
  // Slash commands are built per snapshot (adversarial 4-12).
  bumpSkillsSnapshotVersion({ reason: "manual", changedPath: metaPath });
}

/** Names withheld from every run (canary-off), for surfaces built per snapshot rather than per run. */
export function canaryOffNamesSync(opts: ImpactTrailOptions = {}): Set<string> {
  const out = new Set<string>();
  for (const [name, entry] of Object.entries(readCanaryRegistrySync(opts).skills)) {
    if (isCanaryOff(entry)) {
      out.add(name);
    }
  }
  return out;
}

/**
 * The randomization unit (adversarial 3-3): a SESSION for one calendar day.
 * A session transcript keeps a skill's text after one exposed turn, so
 * per-run buckets would contaminate the control cohort and flip the
 * system-prompt prefix (and the provider prompt cache) on every turn. Per
 * session-day, a long-lived session still lands in both cohorts across the
 * window; a keyless run is its own unit.
 */
export function canaryUnit(params: { runId: string; sessionKey?: string; now?: number }): string {
  const day = new Date(params.now ?? Date.now()).toISOString().slice(0, 10);
  return `${params.sessionKey?.trim() || params.runId}|${day}`;
}

/** Deterministic exposure bucket: the same unit always gets the same answer for a skill. */
export function inCanaryBucket(
  unit: string,
  skillName: string,
  fraction: number,
  seed: string,
): boolean {
  // FNV-1a over the triple; cheap and stable across processes.
  let h = 0x811c9dc5;
  const s = `${seed} ${skillName} ${unit}`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h % 10_000) / 10_000 < fraction;
}

export interface CanaryExposure {
  /** Canary skills this run keeps in its index. */
  exposed: string[];
  /** Canary skills stripped from this run's index (the control cohort). */
  withheld: string[];
}

export function resolveCanaryExposure(params: {
  /** The randomization unit (see `canaryUnit`). */
  unit: string;
  registry: CanaryRegistry;
  /** Names present in the run's index; canaries absent from it are neither exposed nor withheld. */
  indexNames?: ReadonlySet<string>;
}): CanaryExposure {
  const exposed: string[] = [];
  const withheld: string[] = [];
  for (const [name, entry] of Object.entries(params.registry.skills)) {
    if (params.indexNames && !params.indexNames.has(name)) {
      continue;
    }
    if (inCanaryBucket(params.unit, name, entry.bucketFraction, entry.seed)) {
      exposed.push(name);
    } else {
      withheld.push(name);
    }
  }
  return { exposed: exposed.toSorted(), withheld: withheld.toSorted() };
}

const SKILL_BLOCK_RE =
  /^[ \t]*<skill>\n[ \t]*<name>([^<\n]*)<\/name>\n[\s\S]*?^[ \t]*<\/skill>\n?/gm;

/** Names in a formatted skills prompt (the `<available_skills>` XML block). */
export function skillNamesInPrompt(prompt: string): Set<string> {
  const out = new Set<string>();
  for (const m of prompt.matchAll(SKILL_BLOCK_RE)) {
    out.add(m[1] ?? "");
  }
  return out;
}

/** Remove the `<skill>` blocks whose `<name>` is in `names`. Names are `[a-z0-9._-]`, so no XML escaping applies. */
export function stripSkillsFromPrompt(prompt: string, names: ReadonlySet<string>): string {
  if (names.size === 0) {
    return prompt;
  }
  return prompt.replace(SKILL_BLOCK_RE, (block, name: string) => (names.has(name) ? "" : block));
}

const exposureEmitted = new Set<string>();
const EXPOSURE_EMITTED_MAX = 2_000;

/**
 * The run-path hook: strip withheld canaries from the skills prompt and
 * journal the exposure once per run (stream `skills`). No registry, no
 * work and no journal row: the common case costs one stat.
 */
export function applyCanaryExposure(params: {
  prompt: string;
  runId: string;
  sessionKey?: string;
  /** Sessions that must see every skill (validation rollouts). */
  bypass?: boolean;
  storeOpts?: ImpactTrailOptions;
}): string {
  if (params.bypass || !params.prompt) {
    return params.prompt;
  }
  const registry = readCanaryRegistrySync(params.storeOpts);
  const names = Object.keys(registry.skills);
  if (names.length === 0) {
    return params.prompt;
  }
  const indexNames = skillNamesInPrompt(params.prompt);
  const exposure = resolveCanaryExposure({
    unit: canaryUnit({
      runId: params.runId,
      ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
    }),
    registry,
    indexNames,
  });
  if (exposure.exposed.length === 0 && exposure.withheld.length === 0) {
    return params.prompt;
  }
  const next = stripSkillsFromPrompt(params.prompt, new Set(exposure.withheld));
  if (!exposureEmitted.has(params.runId)) {
    exposureEmitted.add(params.runId);
    if (exposureEmitted.size > EXPOSURE_EMITTED_MAX) {
      const oldest = exposureEmitted.values().next().value;
      if (oldest !== undefined) {
        exposureEmitted.delete(oldest);
      }
    }
    emitAgentEvent({
      runId: params.runId,
      stream: "skills",
      ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
      data: { exposed: exposure.exposed, withheld: exposure.withheld },
    });
  }
  return next;
}

export function resetCanaryRegistryCacheForTest(): void {
  cache = null;
  exposureEmitted.clear();
}
