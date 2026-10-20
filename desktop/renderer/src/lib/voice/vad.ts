/**
 * Energy-based voice activity detection (PLAN-53 F3). Fed one loudness
 * reading (RMS, 0..1) every few tens of milliseconds; it decides when someone
 * started and stopped talking. The noise floor adapts while nobody speaks, so
 * a fan or a café does not count as speech.
 */

export type VadOptions = {
  /** Speech must stay above the threshold this long to count. */
  startMs: number;
  /** Silence this long ends the utterance. */
  endMs: number;
  /** Speech is this many times louder than the noise floor. */
  ratio: number;
  /** Absolute floor below which nothing is speech. */
  minLevel: number;
};

export const DEFAULT_VAD: VadOptions = { startMs: 120, endMs: 900, ratio: 3, minLevel: 0.012 };

export type VadEvent = "speech-start" | "speech-end" | null;

export function createVad(opts: Partial<VadOptions> = {}) {
  const o = { ...DEFAULT_VAD, ...opts };
  let floor = o.minLevel / 2;
  let speaking = false;
  let aboveSince: number | null = null;
  let belowSince: number | null = null;
  /** Raised while the agent is talking, so its own voice is not taken as yours. */
  let gain = 1;

  return {
    setSensitivity(next: number) {
      gain = next;
    },
    get speaking() {
      return speaking;
    },
    process(level: number, now: number): VadEvent {
      const threshold = Math.max(o.minLevel, floor * o.ratio) * gain;
      const loud = level >= threshold;
      if (!speaking) {
        // Learn the room only while nobody is talking, and not from the
        // agent's own voice coming back through the speakers.
        if (gain === 1) {
          floor = floor * 0.95 + Math.min(level, threshold) * 0.05;
        }
        if (loud) {
          aboveSince ??= now;
          if (now - aboveSince >= o.startMs) {
            speaking = true;
            belowSince = null;
            return "speech-start";
          }
        } else {
          aboveSince = null;
        }
        return null;
      }
      if (loud) {
        belowSince = null;
        return null;
      }
      belowSince ??= now;
      if (now - belowSince >= o.endMs) {
        speaking = false;
        aboveSince = null;
        return "speech-end";
      }
      return null;
    },
  };
}

/** Root-mean-square loudness of a time-domain buffer from an AnalyserNode. */
export function rms(samples: Float32Array): number {
  let sum = 0;
  for (const s of samples) sum += s * s;
  return samples.length > 0 ? Math.sqrt(sum / samples.length) : 0;
}
