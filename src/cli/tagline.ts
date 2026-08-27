/**
 * PLAN-41 p0-28: one fixed tagline. The randomized joke set (~90 lines of
 * OpenClaw-era banter plus holiday rules) is gone — a V1 product presents
 * one identity on every invocation, and the banner already carries the
 * version + commit hash for the part that's actually useful.
 */
const DEFAULT_TAGLINE = "Dream. Remember. Evolve.";

export interface TaglineOptions {
  env?: NodeJS.ProcessEnv;
  random?: () => number;
  now?: () => Date;
}

export function pickTagline(_options: TaglineOptions = {}): string {
  return DEFAULT_TAGLINE;
}

export { DEFAULT_TAGLINE };
