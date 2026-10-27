/**
 * PLAN-58 Phase B, receiver side of the applicability profile: the
 * closed-shape parser for a profile that arrived over the wire, the fit of
 * that profile against this node's own facts, and the one rule the gate
 * reads from it (poor or unknown fit takes the strict canary).
 *
 * Fit is a soft signal. It orders evaluation and can only make the canary
 * stricter; it has zero weight in activation and never admits or rejects a
 * skill. See applicability-profile.ts for the builder and the shape.
 */

import {
  APPLICABILITY_MAX_BYTES,
  APPLICABILITY_PROFILE_VERSION,
  FAILURE_MECHANISMS,
  MAX_BINS,
  MAX_CAPABILITIES,
  MAX_ENV,
  MAX_FAILURES,
  MAX_MODELS,
  MAX_OS,
  MAX_SEQUENCES,
  MAX_STRING,
  MAX_TOOLS,
  MAX_VALIDATED_ON,
  type SkillApplicabilityProfile,
} from "./applicability-profile.js";
import { transferDirection } from "./transfer-direction.js";
import type { FailureMechanism } from "./types.js";

// ── Parsing (receiver side) ────────────────────────────────────────────────

function strArray(v: unknown, max: number): string[] | undefined {
  if (!Array.isArray(v)) {
    return undefined;
  }
  const out = v
    .filter((x): x is string => typeof x === "string" && x.length > 0 && x.length <= MAX_STRING)
    .slice(0, max);
  return out;
}
function finite(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
function nonNegInt(v: unknown): number | undefined {
  const n = finite(v);
  return n !== undefined && n >= 0 && Number.isInteger(n) ? n : undefined;
}

/**
 * Closed-shape validator for a profile that arrived over the wire. Returns
 * null for anything malformed: the trailer then parses WITHOUT the profile
 * (the gate verdict is unaffected), so a bad profile can never cost a sender
 * its evidence, and a receiver never trusts a shape it did not expect.
 */
export function parseApplicabilityProfile(raw: unknown): SkillApplicabilityProfile | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const r = raw as Record<string, unknown>;
  if (r.v !== APPLICABILITY_PROFILE_VERSION) {
    return null;
  }
  if (typeof r.generatedAt !== "string" || Number.isNaN(Date.parse(r.generatedAt))) {
    return null;
  }
  const windowDays = nonNegInt(r.windowDays);
  if (windowDays === undefined) {
    return null;
  }
  const measured = (r.measured ?? null) as Record<string, unknown> | null;
  const declared = (r.declared ?? {}) as Record<string, unknown>;
  const shape = (r.shape ?? null) as Record<string, unknown> | null;
  const outcomes = (r.outcomes ?? null) as Record<string, unknown> | null;
  if (!measured || !shape || !outcomes || typeof declared !== "object") {
    return null;
  }
  const models = strArray(measured.models, MAX_MODELS);
  const validatedOn = strArray(measured.validatedOn, MAX_VALIDATED_ON);
  const os = strArray(measured.os, MAX_OS);
  if (!models || !validatedOn || !os) {
    return null;
  }
  const runs = nonNegInt(outcomes.runs);
  const pass = nonNegInt(outcomes.pass);
  const fail = nonNegInt(outcomes.fail);
  const indeterminate = nonNegInt(outcomes.indeterminate);
  const maxEvidenceLevel = nonNegInt(outcomes.maxEvidenceLevel);
  if (
    runs === undefined ||
    pass === undefined ||
    fail === undefined ||
    indeterminate === undefined ||
    maxEvidenceLevel === undefined ||
    maxEvidenceLevel > 4
  ) {
    return null;
  }
  const successRateRaw = outcomes.successRate;
  const successRate =
    successRateRaw === null
      ? null
      : typeof successRateRaw === "number" && successRateRaw >= 0 && successRateRaw <= 1
        ? successRateRaw
        : undefined;
  if (successRate === undefined) {
    return null;
  }
  let gate: SkillApplicabilityProfile["outcomes"]["gate"] = null;
  if (outcomes.gate !== null && outcomes.gate !== undefined) {
    const g = outcomes.gate as Record<string, unknown>;
    const trials = nonNegInt(g.trials);
    const meanDelta = finite(g.meanDelta);
    const ci95Low = finite(g.ci95Low);
    if (trials === undefined || meanDelta === undefined || ci95Low === undefined) {
      return null;
    }
    gate = { trials, meanDelta, ci95Low };
  }
  const toolsRaw = Array.isArray(shape.tools) ? shape.tools.slice(0, MAX_TOOLS) : null;
  if (!toolsRaw) {
    return null;
  }
  const tools: Array<{ name: string; runs: number }> = [];
  for (const t of toolsRaw) {
    const o = t as Record<string, unknown>;
    const n = typeof o?.name === "string" ? o.name : "";
    const c = nonNegInt(o?.runs);
    if (!n || n.length > MAX_STRING || c === undefined) {
      return null;
    }
    tools.push({ name: n, runs: c });
  }
  const sequenceHashes = strArray(shape.sequenceHashes, MAX_SEQUENCES);
  if (!sequenceHashes || sequenceHashes.some((h) => !/^[0-9a-f]{1,16}$/.test(h))) {
    return null;
  }
  const failuresRaw = Array.isArray(r.failures) ? r.failures.slice(0, MAX_FAILURES) : null;
  if (!failuresRaw) {
    return null;
  }
  const failures: SkillApplicabilityProfile["failures"] = [];
  for (const f of failuresRaw) {
    const o = f as Record<string, unknown>;
    const mech = typeof o?.mechanism === "string" ? o.mechanism : "";
    const count = nonNegInt(o?.count);
    if (!FAILURE_MECHANISMS.has(mech) || count === undefined) {
      return null;
    }
    failures.push({ mechanism: mech as FailureMechanism, count });
  }
  const parsedDeclared: SkillApplicabilityProfile["declared"] = {};
  const dOs = strArray(declared.os, MAX_OS);
  const dBins = strArray(declared.bins, MAX_BINS);
  const dAny = strArray(declared.anyBins, MAX_BINS);
  const dEnv = strArray(declared.env, MAX_ENV);
  const dCaps = strArray(declared.capabilities, MAX_CAPABILITIES);
  if (dOs?.length) {
    parsedDeclared.os = dOs;
  }
  if (dBins?.length) {
    parsedDeclared.bins = dBins;
  }
  if (dAny?.length) {
    parsedDeclared.anyBins = dAny;
  }
  if (dEnv?.length) {
    parsedDeclared.env = dEnv;
  }
  if (dCaps?.length) {
    parsedDeclared.capabilities = dCaps;
  }
  if (typeof declared.tier === "string" && declared.tier.length <= MAX_STRING) {
    parsedDeclared.tier = declared.tier;
  }
  const profile: SkillApplicabilityProfile = {
    v: APPLICABILITY_PROFILE_VERSION,
    generatedAt: r.generatedAt,
    windowDays,
    measured: {
      models,
      validatedOn,
      os,
      ...(typeof measured.corpusVersion === "string" && measured.corpusVersion.length <= MAX_STRING
        ? { corpusVersion: measured.corpusVersion }
        : {}),
    },
    declared: parsedDeclared,
    shape: { tools, sequenceHashes },
    outcomes: { runs, pass, fail, indeterminate, successRate, maxEvidenceLevel, gate },
    failures,
    ...(r.truncated === true ? { truncated: true } : {}),
  };
  return Buffer.byteLength(JSON.stringify(profile), "utf-8") <= APPLICABILITY_MAX_BYTES
    ? profile
    : null;
}

// ── Fit (receiver side) ────────────────────────────────────────────────────

export type ApplicabilityFitLevel = "unknown" | "poor" | "partial" | "good";

export interface ApplicabilityFit {
  /** 0..1, null when there is no profile to assess. */
  score: number | null;
  level: ApplicabilityFitLevel;
  /** Human-readable reasons the fit is below good, most important first (max 8). */
  mismatches: string[];
}

/** What the receiving node knows about itself. */
export interface ReceiverFacts {
  platform: string;
  /** This node's primary model, `provider/model`, or null when unknown. */
  model: string | null;
  hasBinary: (bin: string) => boolean;
  hasEnv: (name: string) => boolean;
}

const WEIGHTS = { model: 0.3, platform: 0.2, bins: 0.2, env: 0.1, evidence: 0.2 } as const;
const GOOD_AT = 0.75;
const PARTIAL_AT = 0.45;
const MAX_MISMATCHES = 8;
/** Runs below which the sender's outcome evidence is thin whatever its level. */
const MIN_EVIDENCE_RUNS = 5;

/**
 * Compare a sender's profile with this node's facts. Pure. A hard mismatch
 * (declared OS excludes this platform; a required binary is missing) caps
 * the level at "partial" however good the rest looks, and drags it to
 * "poor" when the rest is weak too. No profile is "unknown", never "poor":
 * the receiver cannot tell an incompatible skill from an undescribed one,
 * and both take the strict canary.
 */
export function assessApplicabilityFit(
  profile: SkillApplicabilityProfile | null | undefined,
  facts: ReceiverFacts,
): ApplicabilityFit {
  if (!profile) {
    return {
      score: null,
      level: "unknown",
      mismatches: ["sender shipped no applicability profile"],
    };
  }
  const mismatches: string[] = [];
  let hard = false;

  // Model: measured on this exact model is best; otherwise the transfer direction decides.
  let model = 1;
  if (!facts.model) {
    model = 0.5;
    mismatches.push("receiver model unknown");
  } else if (
    !profile.measured.models.includes(facts.model) &&
    !profile.measured.validatedOn.includes(facts.model)
  ) {
    const senders = [...new Set([...profile.measured.validatedOn, ...profile.measured.models])];
    const directions = new Set(senders.map((s) => transferDirection(s, facts.model)));
    if (directions.has("peer-to-peer") || directions.has("stronger-to-weaker")) {
      model = 0.7;
      mismatches.push(`not measured on ${facts.model} (same or stronger tier only)`);
    } else {
      model = 0.3;
      mismatches.push(
        senders.length > 0
          ? `measured on ${senders.slice(0, 2).join(", ")}: weaker or unknown tier than ${facts.model}`
          : "no model recorded on the sender",
      );
    }
  }

  // Platform: a declared OS list that excludes us is a hard mismatch.
  let platform = 1;
  if (profile.declared.os?.length && !profile.declared.os.includes(facts.platform)) {
    platform = 0;
    hard = true;
    mismatches.push(`declared os ${profile.declared.os.join("/")} excludes ${facts.platform}`);
  } else if (!profile.measured.os.includes(facts.platform)) {
    platform = 0.5;
    mismatches.push(`measured on ${profile.measured.os.join("/") || "an unknown os"} only`);
  }

  // Binaries: every required one must exist here; any-of needs one.
  let bins = 1;
  const missing = (profile.declared.bins ?? []).filter((b) => !facts.hasBinary(b));
  if (missing.length > 0) {
    bins = 0;
    hard = true;
    mismatches.push(
      `missing required binar${missing.length === 1 ? "y" : "ies"}: ${missing.join(", ")}`,
    );
  } else if (profile.declared.anyBins?.length && !profile.declared.anyBins.some(facts.hasBinary)) {
    bins = 0;
    hard = true;
    mismatches.push(`none of ${profile.declared.anyBins.join(", ")} present`);
  }

  // Env: names only; a skill's env may be configured per entry, so this is soft.
  let env = 1;
  const missingEnv = (profile.declared.env ?? []).filter((n) => !facts.hasEnv(n));
  if (missingEnv.length > 0) {
    env = 0.5;
    mismatches.push(`env not set here: ${missingEnv.join(", ")}`);
  }

  // Evidence depth on the sender.
  let evidence: number;
  if (profile.outcomes.runs >= MIN_EVIDENCE_RUNS && profile.outcomes.maxEvidenceLevel >= 3) {
    evidence = 1;
  } else if (profile.outcomes.runs >= MIN_EVIDENCE_RUNS) {
    evidence = 0.6;
    mismatches.push(
      `sender evidence is self-reported (max level L${profile.outcomes.maxEvidenceLevel})`,
    );
  } else {
    evidence = 0.3;
    mismatches.push(
      `sender has ${profile.outcomes.runs} credited run${profile.outcomes.runs === 1 ? "" : "s"} in ${profile.windowDays} days`,
    );
  }

  const score =
    WEIGHTS.model * model +
    WEIGHTS.platform * platform +
    WEIGHTS.bins * bins +
    WEIGHTS.env * env +
    WEIGHTS.evidence * evidence;
  const rounded = Math.round(score * 1000) / 1000;
  let level: ApplicabilityFitLevel =
    rounded >= GOOD_AT ? "good" : rounded >= PARTIAL_AT ? "partial" : "poor";
  if (hard && level === "good") {
    level = "partial";
  }
  if (hard && rounded < 0.5) {
    level = "poor";
  }
  return { score: rounded, level, mismatches: mismatches.slice(0, MAX_MISMATCHES) };
}

/** A fit level that buys nothing better than the strict canary. */
export function fitTakesStrictCanary(level: ApplicabilityFitLevel | null | undefined): boolean {
  return level === undefined || level === null || level === "unknown" || level === "poor";
}
