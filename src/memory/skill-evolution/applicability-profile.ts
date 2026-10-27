/**
 * PLAN-58 Phase B: the skill applicability profile.
 *
 * A skill published to the mesh has, until now, carried one kind of
 * evidence: the gate verdict in its provenance trailer. That says the skill
 * helped on the SENDER's capability suite under the sender's model. It says
 * nothing about the conditions the skill was measured under, so a receiver
 * could tell "this skill sounds relevant" from nothing more.
 *
 * The profile is a compact, machine-readable account of those conditions,
 * rebuilt every housekeeping pass from ledgers that already exist (the read
 * ledger, the evolution meta, the SKILL.md frontmatter, the journal traces
 * that credited a read), written to `<skill>/.applicability.json` and shipped
 * INSIDE the signed provenance trailer, so the device-key binding covers it
 * with no change to the signing code.
 *
 * On the receiver it becomes a FIT against this node's own facts (model
 * tier, platform, binaries, env, evidence depth). Fit is a soft signal:
 * it orders evaluation and can only make the canary stricter. It has zero
 * weight in any activation decision and never admits or rejects a skill;
 * every exact gate keeps the last word (PLAN-45 "trust is not evidence").
 *
 * What never enters a profile: task text, session keys, run ids, user
 * feedback, tool arguments or results, paths, env VALUES. The builder is
 * pure; the publisher re-runs the leak check over the serialized profile.
 */

import { parseFrontmatter, resolveBitterbotMetadata } from "../../agents/skills/frontmatter.js";
import type { RunOutcome } from "./outcome.js";
import { extractTraceSignals } from "./signals.js";
import { deriveFailureSignature } from "./signatures.js";
import type { SkillReadEvent } from "./skill-reads.js";
import type { FailureMechanism, ReconstructedTrace, TraceLabel, TraceToolStep } from "./types.js";
import type { EvolutionMeta } from "./validation-gate.js";

export const APPLICABILITY_PROFILE_FILENAME = ".applicability.json";
export const APPLICABILITY_PROFILE_VERSION = 1 as const;
/** Serialized profile ceiling; the builder truncates arrays from the tail to stay under it. */
export const APPLICABILITY_MAX_BYTES = 4_096;
export const APPLICABILITY_DEFAULT_WINDOW_DAYS = 14;

export const MAX_STRING = 96;
export const MAX_MODELS = 6;
export const MAX_VALIDATED_ON = 4;
export const MAX_OS = 3;
export const MAX_BINS = 12;
export const MAX_ENV = 8;
export const MAX_CAPABILITIES = 12;
export const MAX_TOOLS = 8;
export const MAX_SEQUENCES = 4;
export const MAX_FAILURES = 12;
/** Journal runs the housekeeping builder reconstructs per skill (newest first). */
export const APPLICABILITY_MAX_TRACE_RUNS = 40;

export const FAILURE_MECHANISMS: ReadonlySet<string> = new Set<FailureMechanism>([
  "environment-outage",
  "repeated-unsuccessful-retry",
  "missing-prerequisite",
  "invalid-parameter",
  "policy-blocked",
  "unknown-tool",
  "context-overflow",
  "premature-completion",
  "human-rejected",
  "verification-failed",
  "approval-never-granted",
  "unresolved-tool-error",
]);

export interface SkillApplicabilityProfile {
  v: typeof APPLICABILITY_PROFILE_VERSION;
  generatedAt: string;
  windowDays: number;
  /** What the sender actually ran the skill under. */
  measured: {
    /** `provider/model` specs the skill was READ under in the window. */
    models: string[];
    /** Models the gate measured the skill on. */
    validatedOn: string[];
    /** Sender platform(s) the reads came from. */
    os: string[];
    corpusVersion?: string;
  };
  /** What the SKILL.md frontmatter declares, copied so a receiver can diff declared vs measured. */
  declared: {
    os?: string[];
    bins?: string[];
    anyBins?: string[];
    /** Environment variable NAMES only. */
    env?: string[];
    /** Capability declaration keys only (network, fs, wallet, shell, process). */
    capabilities?: string[];
    tier?: string;
  };
  /** The shape of the runs that read the skill. */
  shape: {
    /** Tool names by distinct runs that called them, most common first. */
    tools: Array<{ name: string; runs: number }>;
    /** Most common tool-sequence hashes (12 hex chars, no content). */
    sequenceHashes: string[];
  };
  outcomes: {
    runs: number;
    pass: number;
    fail: number;
    indeterminate: number;
    successRate: number | null;
    /** Highest L0-L4 evidence level behind any read's label. */
    maxEvidenceLevel: number;
    gate: { trials: number; meanDelta: number; ci95Low: number } | null;
  };
  /** Non-zero failure mechanisms among fail-labeled runs that read the skill. */
  failures: Array<{ mechanism: FailureMechanism; count: number }>;
  /** Set when the size ceiling forced arrays to be cut. */
  truncated?: boolean;
}

/** One journal run that credited a read of the skill, already reconstructed. */
export interface ApplicabilityTraceInput {
  trace: ReconstructedTrace;
  label: TraceLabel;
  outcome?: RunOutcome;
}

function clip(s: string): string {
  return s.length > MAX_STRING ? s.slice(0, MAX_STRING) : s;
}

function uniqSorted(values: Iterable<string>, max: number): string[] {
  return [...new Set([...values].filter((v) => v.length > 0).map(clip))].toSorted().slice(0, max);
}

/** Sequence hash of a trace: the same shape key the evolution sampler uses, recomputed here to stay import-light. */
export function traceSequenceHash(trace: ReconstructedTrace): string {
  const seq = trace.steps
    .filter((s): s is TraceToolStep => s.kind === "tool")
    .map((s) => (s.isError ? `${s.name}!` : s.name))
    .join(">");
  // FNV-1a 32-bit, hex, then widened with a second pass over the same
  // string under a second seed so collisions on short sequences are unlikely.
  // 12 hex chars.
  const fnv = (input: string, seed: number): number => {
    let h = seed;
    for (let i = 0; i < input.length; i++) {
      h ^= input.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h >>> 0;
  };
  const a = fnv(seq, 0x811c9dc5).toString(16).padStart(8, "0");
  const b = fnv(seq, 0x5bd1e995).toString(16).padStart(8, "0");
  return `${a}${b}`.slice(0, 12);
}

export function buildApplicabilityProfile(params: {
  name: string;
  events: SkillReadEvent[];
  meta: EvolutionMeta | null;
  /** The live SKILL.md body, for the declared block; null skips it. */
  skillMd: string | null;
  traces: ApplicabilityTraceInput[];
  /** This node's platform (resolveRuntimePlatform()). */
  platform: string;
  now?: number;
  windowDays?: number;
}): SkillApplicabilityProfile {
  const now = params.now ?? Date.now();
  const windowDays = params.windowDays ?? APPLICABILITY_DEFAULT_WINDOW_DAYS;
  const since = now - windowDays * 24 * 60 * 60 * 1000;

  const outcomes = {
    runs: 0,
    pass: 0,
    fail: 0,
    indeterminate: 0,
    successRate: null as number | null,
    maxEvidenceLevel: 0,
    gate: null as { trials: number; meanDelta: number; ci95Low: number } | null,
  };
  const runIds = new Set<string>();
  const models = new Set<string>();
  for (const e of params.events) {
    if (e.skill !== params.name || !e.credited || e.ts < since) {
      continue;
    }
    runIds.add(e.runId);
    if (e.label === "pass") {
      outcomes.pass += 1;
    } else if (e.label === "fail") {
      outcomes.fail += 1;
    } else {
      outcomes.indeterminate += 1;
    }
    outcomes.maxEvidenceLevel = Math.max(outcomes.maxEvidenceLevel, e.outcomeLevel ?? 0);
    if (e.model) {
      models.add(e.model);
    }
  }
  outcomes.runs = runIds.size;
  outcomes.successRate =
    outcomes.pass + outcomes.fail > 0 ? outcomes.pass / (outcomes.pass + outcomes.fail) : null;

  const v = params.meta?.validation;
  if (
    v &&
    typeof v.trials === "number" &&
    typeof v.meanDelta === "number" &&
    typeof v.ci95Low === "number"
  ) {
    outcomes.gate = { trials: v.trials, meanDelta: v.meanDelta, ci95Low: v.ci95Low };
  }
  const validatedOn = v?.validatedOn?.length ? v.validatedOn : v?.model ? [v.model] : [];

  // Declared block from the frontmatter: names only, never values.
  const declared: SkillApplicabilityProfile["declared"] = {};
  if (params.skillMd) {
    try {
      const md = resolveBitterbotMetadata(parseFrontmatter(params.skillMd));
      if (md?.os?.length) {
        declared.os = uniqSorted(md.os, MAX_OS);
      }
      if (md?.requires?.bins?.length) {
        declared.bins = uniqSorted(md.requires.bins, MAX_BINS);
      }
      if (md?.requires?.anyBins?.length) {
        declared.anyBins = uniqSorted(md.requires.anyBins, MAX_BINS);
      }
      if (md?.requires?.env?.length) {
        declared.env = uniqSorted(md.requires.env, MAX_ENV);
      }
      if (md?.capabilities && typeof md.capabilities === "object") {
        const keys = Object.keys(md.capabilities);
        if (keys.length > 0) {
          declared.capabilities = uniqSorted(keys, MAX_CAPABILITIES);
        }
      }
      if (md?.tier) {
        declared.tier = clip(String(md.tier));
      }
    } catch {
      // A malformed frontmatter yields an empty declared block, never a throw.
    }
  }

  // Shape and failures from the reconstructed traces.
  const toolRuns = new Map<string, number>();
  const sequenceCounts = new Map<string, number>();
  const failureCounts = new Map<FailureMechanism, number>();
  for (const t of params.traces) {
    const names = new Set<string>();
    for (const s of t.trace.steps) {
      if (s.kind === "tool") {
        names.add(clip(s.name));
      }
    }
    for (const n of names) {
      toolRuns.set(n, (toolRuns.get(n) ?? 0) + 1);
    }
    if (t.trace.steps.some((s) => s.kind === "tool")) {
      const h = traceSequenceHash(t.trace);
      sequenceCounts.set(h, (sequenceCounts.get(h) ?? 0) + 1);
    }
    if (t.label === "fail") {
      try {
        const sig = deriveFailureSignature(
          t.trace,
          extractTraceSignals(t.trace),
          { label: "fail", confidence: 1, reason: "skill-reads", judged: false },
          t.outcome,
        );
        failureCounts.set(sig.mechanism, (failureCounts.get(sig.mechanism) ?? 0) + 1);
      } catch {
        // A trace the signature code cannot classify is simply not counted.
      }
    }
  }
  const byCountThenName = <K extends string>(a: [K, number], b: [K, number]) =>
    b[1] - a[1] || a[0].localeCompare(b[0]);

  const profile: SkillApplicabilityProfile = {
    v: APPLICABILITY_PROFILE_VERSION,
    generatedAt: new Date(now).toISOString(),
    windowDays,
    measured: {
      models: uniqSorted(models, MAX_MODELS),
      validatedOn: uniqSorted(validatedOn, MAX_VALIDATED_ON),
      os: uniqSorted([params.platform], MAX_OS),
      ...(v?.corpusVersion ? { corpusVersion: clip(v.corpusVersion) } : {}),
    },
    declared,
    shape: {
      tools: [...toolRuns.entries()]
        .toSorted(byCountThenName)
        .slice(0, MAX_TOOLS)
        .map(([name, runs]) => ({ name, runs })),
      sequenceHashes: [...sequenceCounts.entries()]
        .toSorted(byCountThenName)
        .slice(0, MAX_SEQUENCES)
        .map(([h]) => h),
    },
    outcomes,
    failures: [...failureCounts.entries()]
      .toSorted(byCountThenName)
      .slice(0, MAX_FAILURES)
      .map(([mechanism, count]) => ({ mechanism, count })),
  };
  return enforceSize(profile);
}

/** Cut arrays from the tail until the serialized profile fits the ceiling. */
function enforceSize(profile: SkillApplicabilityProfile): SkillApplicabilityProfile {
  const size = (p: SkillApplicabilityProfile) => Buffer.byteLength(JSON.stringify(p), "utf-8");
  if (size(profile) <= APPLICABILITY_MAX_BYTES) {
    return profile;
  }
  const out: SkillApplicabilityProfile = { ...profile, truncated: true };
  const cuts: Array<() => boolean> = [
    () =>
      out.shape.tools.length > 0 ? ((out.shape.tools = out.shape.tools.slice(0, -1)), true) : false,
    () =>
      out.shape.sequenceHashes.length > 0
        ? ((out.shape.sequenceHashes = out.shape.sequenceHashes.slice(0, -1)), true)
        : false,
    () => (out.failures.length > 0 ? ((out.failures = out.failures.slice(0, -1)), true) : false),
    () =>
      out.measured.models.length > 1
        ? ((out.measured.models = out.measured.models.slice(0, -1)), true)
        : false,
    () =>
      (out.declared.bins?.length ?? 0) > 0
        ? ((out.declared.bins = out.declared.bins!.slice(0, -1)), true)
        : false,
  ];
  let guard = 0;
  while (size(out) > APPLICABILITY_MAX_BYTES && guard < 200) {
    guard += 1;
    if (!cuts.some((cut) => cut())) {
      break;
    }
  }
  return out;
}

// The receiver side (closed-shape parser, fit, strictness) lives in
// applicability-fit.ts and is re-exported here so callers import one module.
export {
  type ApplicabilityFit,
  type ApplicabilityFitLevel,
  assessApplicabilityFit,
  fitTakesStrictCanary,
  parseApplicabilityProfile,
  type ReceiverFacts,
} from "./applicability-fit.js";
