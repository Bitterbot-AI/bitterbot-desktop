/**
 * PLAN-45 4.6 (I8): cross-model transfer direction.
 *
 * A skill evolved on a weaker model and received by a stronger one is the
 * documented negative-transfer case (weak-model skills poison strong
 * models). The receiver compares the sender's evolver model with its own
 * primary on the featured-model tier table and applies a stricter canary
 * to weaker-to-stronger transfers. An unrecognized model on either side
 * is "unknown" and treated exactly like weaker-to-stronger: unproven until
 * measured, and not gameable by naming an unlisted model.
 */

import { classifyFeatured, TIER_ORDER } from "../../agents/model-featured.js";
import {
  CANARY_GRADUATE_DAYS,
  CANARY_GRADUATE_RUNS,
  MONITOR_ALPHA,
  MONITOR_CHECKPOINTS,
  MONITOR_MIN_EXPOSED,
  MONITOR_MIN_UNEXPOSED,
} from "./canary-stats.js";

export type TransferDirection =
  | "weaker-to-stronger"
  | "peer-to-peer"
  | "stronger-to-weaker"
  | "unknown";

/** 0 = frontier ... 2 = workhorse; null when the model is not in the featured table. */
export function modelRank(spec: string | null | undefined): number | null {
  if (!spec) {
    return null;
  }
  const i = spec.indexOf("/");
  if (i <= 0) {
    return null;
  }
  const info = classifyFeatured(spec.slice(0, i), spec.slice(i + 1));
  return info.tier ? TIER_ORDER.indexOf(info.tier) : null;
}

export function transferDirection(
  senderSpec: string | null | undefined,
  receiverSpec: string | null | undefined,
): TransferDirection {
  const s = modelRank(senderSpec);
  const r = modelRank(receiverSpec);
  if (s === null || r === null) {
    return "unknown";
  }
  if (s > r) {
    return "weaker-to-stronger";
  }
  if (s < r) {
    return "stronger-to-weaker";
  }
  return "peer-to-peer";
}

export interface StrictCanaryOptions {
  minExposed: number;
  minUnexposed: number;
  checkpoints: number[];
  alphaPerLook: number;
  graduateRuns: number;
  graduateDays: number;
}

/** The stricter window: a fifth of runs, twice the evidence, an earlier look, alpha split five ways. */
export const STRICT_CANARY: StrictCanaryOptions = {
  minExposed: MONITOR_MIN_EXPOSED * 2,
  minUnexposed: MONITOR_MIN_UNEXPOSED * 2,
  checkpoints: [4, ...MONITOR_CHECKPOINTS],
  alphaPerLook: MONITOR_ALPHA / (MONITOR_CHECKPOINTS.length + 1),
  graduateRuns: CANARY_GRADUATE_RUNS * 2,
  graduateDays: CANARY_GRADUATE_DAYS + 7,
};
export const STRICT_CANARY_FRACTION = 0.2;

/** Canary parameters for a transfer direction; null strict = the default window. */
export function strictCanaryFor(direction: TransferDirection): {
  bucketFraction: number;
  strict: StrictCanaryOptions | null;
} {
  if (direction === "weaker-to-stronger" || direction === "unknown") {
    return { bucketFraction: STRICT_CANARY_FRACTION, strict: { ...STRICT_CANARY } };
  }
  return { bucketFraction: 0.5, strict: null };
}
