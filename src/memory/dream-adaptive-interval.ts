/**
 * Adaptive dream-cycle interval (PLAN-11 Gap 5).
 *
 * When marketplace activity is high, shorten the interval so skill generation
 * keeps up with demand. When quiet, lengthen it to conserve compute. But a
 * naive "last hour" check would cause the interval to flap — one burst of 5
 * purchases could yank it from 240 min to 60 min and back.
 *
 * Anti-flap discipline:
 *   - Smoothed activity signal from MarketplaceIntelligence (rolling window).
 *   - Hysteresis bands: require two consecutive evaluations on the same side
 *     of a threshold before changing the interval.
 *   - Cooldown: after any change, refuse to change again for cooldownMinutes.
 *   - Floor / ceiling clamp: 30 min / 240 min.
 */

import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("dream-adaptive-interval");

// ── Types ──

export type AdaptiveIntervalConfig = {
  /** Default interval when no signal / disabled. */
  baseMinutes: number;
  /** Minimum interval (floor). Default 30. */
  minMinutes?: number;
  /** Maximum interval (ceiling). Default 240. */
  maxMinutes?: number;
  /** Rolling-window hours for activity smoothing. Default 8. */
  windowHours?: number;
  /** Minimum time between interval changes. Default 60 (prevents rapid flapping). */
  cooldownMinutes?: number;
  /** Activity threshold above which interval halves. Default 0.7. */
  highThreshold?: number;
  /** Activity threshold below which interval doubles. Default 0.3. */
  lowThreshold?: number;
  /**
   * Consecutive evaluations required on the same side of a threshold before
   * committing a change. Default 2 (hysteresis).
   */
  consecutiveRequired?: number;
};

export type ActivityScorer = {
  getSmoothedActivityScore(windowHours: number, now?: number): number;
};

export type AdaptiveIntervalState = {
  currentMinutes: number;
  lastChangedAt: number;
  consecutiveAbove: number;
  consecutiveBelow: number;
  lastScore: number;
};

// ── Public API ──

export class AdaptiveIntervalController {
  private readonly config: Required<AdaptiveIntervalConfig>;
  private state: AdaptiveIntervalState;

  constructor(config: AdaptiveIntervalConfig) {
    this.config = {
      baseMinutes: config.baseMinutes,
      minMinutes: config.minMinutes ?? 30,
      maxMinutes: config.maxMinutes ?? 240,
      windowHours: config.windowHours ?? 8,
      cooldownMinutes: config.cooldownMinutes ?? 60,
      highThreshold: config.highThreshold ?? 0.7,
      lowThreshold: config.lowThreshold ?? 0.3,
      consecutiveRequired: config.consecutiveRequired ?? 2,
    };
    // Clamp the starting interval into the valid range.
    const clamped = Math.min(
      this.config.maxMinutes,
      Math.max(this.config.minMinutes, this.config.baseMinutes),
    );
    this.state = {
      currentMinutes: clamped,
      lastChangedAt: 0,
      consecutiveAbove: 0,
      consecutiveBelow: 0,
      lastScore: 0,
    };
  }

  getCurrentMinutes(): number {
    return this.state.currentMinutes;
  }

  getState(): Readonly<AdaptiveIntervalState> {
    return this.state;
  }

  /**
   * Re-evaluate the interval using the current marketplace activity score.
   * Applies hysteresis + cooldown + clamping. Returns the interval to use
   * for the NEXT scheduled cycle (may or may not differ from current).
   */
  evaluate(scorer: ActivityScorer, now: number = Date.now()): number {
    const score = scorer.getSmoothedActivityScore(this.config.windowHours, now);
    this.state.lastScore = score;

    const inCooldown =
      this.state.lastChangedAt > 0 &&
      now - this.state.lastChangedAt < this.config.cooldownMinutes * 60_000;

    // Update consecutive counters regardless of cooldown so hysteresis
    // progresses; we just refuse to commit a change while cooling down.
    if (score >= this.config.highThreshold) {
      this.state.consecutiveAbove += 1;
      this.state.consecutiveBelow = 0;
    } else if (score <= this.config.lowThreshold) {
      this.state.consecutiveBelow += 1;
      this.state.consecutiveAbove = 0;
    } else {
      // Middle band — reset both so neither side builds up on noise.
      this.state.consecutiveAbove = 0;
      this.state.consecutiveBelow = 0;
    }

    if (inCooldown) {
      return this.state.currentMinutes;
    }

    let nextMinutes = this.state.currentMinutes;
    let reason = "";

    if (this.state.consecutiveAbove >= this.config.consecutiveRequired) {
      nextMinutes = Math.max(this.config.minMinutes, Math.floor(this.state.currentMinutes / 2));
      reason = `activity high (score=${score.toFixed(2)}, ${this.state.consecutiveAbove} consec)`;
      this.state.consecutiveAbove = 0;
    } else if (this.state.consecutiveBelow >= this.config.consecutiveRequired) {
      nextMinutes = Math.min(this.config.maxMinutes, Math.ceil(this.state.currentMinutes * 2));
      reason = `activity low (score=${score.toFixed(2)}, ${this.state.consecutiveBelow} consec)`;
      this.state.consecutiveBelow = 0;
    }

    if (nextMinutes !== this.state.currentMinutes) {
      log.info(
        `adaptive interval: ${this.state.currentMinutes}min → ${nextMinutes}min (${reason})`,
      );
      this.state.currentMinutes = nextMinutes;
      this.state.lastChangedAt = now;
    }

    return this.state.currentMinutes;
  }
}
