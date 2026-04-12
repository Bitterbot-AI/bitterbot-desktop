/**
 * HormonalStateManager: models dopamine, cortisol, and oxytocin levels
 * that modulate memory consolidation, retrieval, and emotional tagging.
 *
 * Hormones decay with configurable half-lives and are stimulated by
 * detected events in indexed content and search patterns.
 */

import type { HormonalInfluence } from "./crystal-types.js";
import type { MemorySource } from "./types.js";

export type HormonalEvent =
  | "reward" // Task completion, positive feedback → dopamine
  | "error" // Bug, failure, frustration → cortisol
  | "social" // User shares personal info → oxytocin
  | "achievement" // Milestone, breakthrough → dopamine + oxytocin
  | "urgency" // Deadline, "ASAP", "critical" → cortisol
  | "curiosity_high" // High GCCRF reward (> 0.7) → dopamine (discovery)
  | "curiosity_progress" // High learning progress component → dopamine (mastery)
  | "curiosity_aligned" // High strategic alignment → mild dopamine (goal progress)
  | "curiosity_stagnant" // Sustained low GCCRF reward → mild cortisol (stagnation)
  | "curiosity_bonding" // High empowerment on relationship chunk → oxytocin
  | "marketplace_sale" // Skill sold on marketplace → dopamine (modest, log-scale at caller)
  // Limbic memory bridge: retrieved memories influence emotional state (Plan 6, Phase 5)
  | "recall_positive" // Retrieved positive memories → mild dopamine
  | "recall_negative" // Retrieved negative memories → mild cortisol
  | "recall_relational"; // Retrieved personal/relational memories → mild oxytocin

export type HormonalState = {
  dopamine: number; // 0-1
  cortisol: number; // 0-1
  oxytocin: number; // 0-1
  lastDecay: number;
};

export type HormonalBaseline = {
  dopamine: number; // 0.0 - 1.0
  cortisol: number; // 0.0 - 1.0
  oxytocin: number; // 0.0 - 1.0
};

export const DEFAULT_HORMONAL_BASELINE: HormonalBaseline = {
  dopamine: 0.15,
  cortisol: 0.02,
  oxytocin: 0.2,
};

export type HormonalConfig = {
  enabled?: boolean;
  dopamineHalflife?: number; // ms, default 30 min
  cortisolHalflife?: number; // ms, default 60 min
  oxytocinHalflife?: number; // ms, default 45 min
  homeostasis?: { dopamine: number; cortisol: number; oxytocin: number };
};

export type EmotionalAnchor = {
  id: string;
  label: string;
  description: string;
  state: { dopamine: number; cortisol: number; oxytocin: number };
  createdAt: number;
  recallCount: number;
  lastRecalledAt?: number;
  associatedCrystalIds?: string[];
};

const DEFAULT_DOPAMINE_HALFLIFE = 30 * 60_000;
const DEFAULT_CORTISOL_HALFLIFE = 60 * 60_000;
const DEFAULT_OXYTOCIN_HALFLIFE = 45 * 60_000;

// Spike magnitudes per event type
const EVENT_SPIKES: Record<
  HormonalEvent,
  { dopamine: number; cortisol: number; oxytocin: number }
> = {
  reward: { dopamine: 0.3, cortisol: 0, oxytocin: 0 },
  error: { dopamine: 0, cortisol: 0.3, oxytocin: 0 },
  social: { dopamine: 0, cortisol: 0, oxytocin: 0.3 },
  achievement: { dopamine: 0.4, cortisol: 0, oxytocin: 0.2 },
  urgency: { dopamine: 0, cortisol: 0.4, oxytocin: 0 },
  // GCCRF-driven curiosity events
  curiosity_high: { dopamine: 0.25, cortisol: 0, oxytocin: 0 }, // Discovery spike
  curiosity_progress: { dopamine: 0.2, cortisol: 0, oxytocin: 0 }, // Mastery spike
  curiosity_aligned: { dopamine: 0.1, cortisol: 0, oxytocin: 0 }, // Goal progress
  curiosity_stagnant: { dopamine: 0, cortisol: 0.15, oxytocin: 0 }, // Stagnation stress
  curiosity_bonding: { dopamine: 0.1, cortisol: 0, oxytocin: 0.25 }, // Relational learning
  marketplace_sale: { dopamine: 0.15, cortisol: 0, oxytocin: 0.05 }, // Modest dopamine per sale (caller log-scales)
  // Limbic recall events: mild spikes to avoid runaway feedback loops
  recall_positive: { dopamine: 0.05, cortisol: 0, oxytocin: 0 }, // Recalling happy memories
  recall_negative: { dopamine: 0, cortisol: 0.05, oxytocin: 0 }, // Recalling stressful memories
  recall_relational: { dopamine: 0, cortisol: 0, oxytocin: 0.05 }, // Recalling personal memories
};

// Homeostasis: resting emotional baseline the agent decays toward.
// Instead of decaying to zero (emotional flatline), the agent
// returns to a personality-defining resting state between interactions.
// Inspired by Russell's Circumplex Model and BitterBot prototype's EmotionalVector.
const DEFAULT_HOMEOSTASIS: { dopamine: number; cortisol: number; oxytocin: number } = {
  dopamine: 0.15, // Slightly positive — the agent is gently content at rest
  cortisol: 0.02, // Near-zero stress at rest, but not perfectly zero (alive, not dead)
  oxytocin: 0.2, // Moderate social warmth — the agent genuinely wants to connect
  // Previous 0.10 was too low: warmth = min(1, 0.10 * 1.5) = 0.15, barely registers.
  // At 0.20: warmth = min(1, 0.20 * 1.5) = 0.30, which starts to influence tone.
};

export class HormonalStateManager {
  private state: HormonalState;
  private readonly dopamineHalflife: number;
  private readonly cortisolHalflife: number;
  private readonly oxytocinHalflife: number;
  private readonly homeostasis: { dopamine: number; cortisol: number; oxytocin: number };
  private networkCortisolOverride: { level: number; expiresAt: number; reason: string } | null =
    null;
  private stateHistory: Array<{
    timestamp: number;
    dopamine: number;
    cortisol: number;
    oxytocin: number;
  }> = [];
  private readonly maxHistoryLength = 50;
  private anchors: Map<string, EmotionalAnchor> = new Map();
  private readonly maxAnchors = 20;
  private onAnchorCreated: ((anchor: EmotionalAnchor, triggerEvent?: string) => void) | null = null;
  private onAnchorRecalled: ((anchorId: string) => void) | null = null;
  /** Tracks last auto-anchor time per label to prevent duplicate anchors from rapid-fire events. */
  private lastAutoAnchorAt: Map<string, number> = new Map();
  private static readonly AUTO_ANCHOR_COOLDOWN_MS = 15 * 60_000; // 15 minutes (prevents anchor flooding during extended sessions)

  constructor(config?: HormonalConfig) {
    this.homeostasis = config?.homeostasis ?? DEFAULT_HOMEOSTASIS;
    this.state = {
      dopamine: this.homeostasis.dopamine,
      cortisol: this.homeostasis.cortisol,
      oxytocin: this.homeostasis.oxytocin,
      lastDecay: Date.now(),
    };
    this.dopamineHalflife = config?.dopamineHalflife ?? DEFAULT_DOPAMINE_HALFLIFE;
    this.cortisolHalflife = config?.cortisolHalflife ?? DEFAULT_CORTISOL_HALFLIFE;
    this.oxytocinHalflife = config?.oxytocinHalflife ?? DEFAULT_OXYTOCIN_HALFLIFE;
  }

  /** Get current hormonal state (after decay). */
  getState(): HormonalState {
    this.decay();
    const state = { ...this.state };
    if (this.hasNetworkCortisolOverride()) {
      state.cortisol = Math.max(state.cortisol, this.networkCortisolOverride!.level);
    }
    return state;
  }

  /** Apply a network-wide cortisol spike from a management node. */
  applyNetworkCortisolSpike(level: number, durationMs: number, reason: string): void {
    this.networkCortisolOverride = {
      level: Math.min(1, Math.max(0, level)),
      expiresAt: Date.now() + durationMs,
      reason,
    };
  }

  /** Check if a network cortisol override is currently active. */
  hasNetworkCortisolOverride(): boolean {
    if (!this.networkCortisolOverride) return false;
    if (Date.now() >= this.networkCortisolOverride.expiresAt) {
      this.networkCortisolOverride = null;
      return false;
    }
    return true;
  }

  /** Stimulate hormones based on a detected event. */
  stimulate(event: HormonalEvent): void {
    this.decay();
    const spike = EVENT_SPIKES[event];
    this.state.dopamine = Math.min(1, this.state.dopamine + spike.dopamine);
    this.state.cortisol = Math.min(1, this.state.cortisol + spike.cortisol);
    this.state.oxytocin = Math.min(1, this.state.oxytocin + spike.oxytocin);

    // Record state snapshot for trajectory analysis
    this.recordSnapshot();

    // Auto-anchor on strong emotional events (with cooldown to prevent duplicates)
    const autoAnchor = (label: string, description: string, trigger: string) => {
      const now = Date.now();
      const last = this.lastAutoAnchorAt.get(label) ?? 0;
      if (now - last < HormonalStateManager.AUTO_ANCHOR_COOLDOWN_MS) return;
      this.lastAutoAnchorAt.set(label, now);
      this.createAnchor(label, description, trigger);
    };

    if (event === "achievement" && this.state.dopamine > 0.5) {
      autoAnchor(
        "achievement_peak",
        `Achievement event — dopamine at ${this.state.dopamine.toFixed(2)}`,
        "achievement",
      );
    }
    if (event === "social" && this.state.oxytocin > 0.5) {
      autoAnchor(
        "bonding_moment",
        `Deep connection — oxytocin at ${this.state.oxytocin.toFixed(2)}`,
        "social",
      );
    }
    if (event === "urgency" && this.state.cortisol > 0.6) {
      autoAnchor(
        "stress_peak",
        `High stress — cortisol at ${this.state.cortisol.toFixed(2)}`,
        "urgency",
      );
    }
    if (event === "curiosity_high" && this.state.dopamine > 0.4) {
      autoAnchor(
        "discovery_moment",
        `Discovery high — dopamine at ${this.state.dopamine.toFixed(2)}`,
        "curiosity_high",
      );
    }
  }

  /** Apply exponential decay toward homeostasis baseline, not toward zero. */
  decay(): void {
    const now = Date.now();
    const elapsed = now - this.state.lastDecay;
    if (elapsed <= 0) return;

    // Exponential decay toward homeostasis baseline, not toward zero.
    // Formula: value = homeostasis + (value - homeostasis) * decay_factor
    // When value > homeostasis: decays down toward baseline
    // When value < homeostasis: rises up toward baseline (recovery)
    const dFactor = Math.pow(0.5, elapsed / this.dopamineHalflife);
    const cFactor = Math.pow(0.5, elapsed / this.cortisolHalflife);
    const oFactor = Math.pow(0.5, elapsed / this.oxytocinHalflife);

    this.state.dopamine =
      this.homeostasis.dopamine + (this.state.dopamine - this.homeostasis.dopamine) * dFactor;
    this.state.cortisol =
      this.homeostasis.cortisol + (this.state.cortisol - this.homeostasis.cortisol) * cFactor;
    this.state.oxytocin =
      this.homeostasis.oxytocin + (this.state.oxytocin - this.homeostasis.oxytocin) * oFactor;

    // Clamp: never go below zero, but allow sitting at homeostasis
    if (this.state.dopamine < 0.001) this.state.dopamine = 0;
    if (this.state.cortisol < 0.001) this.state.cortisol = 0;
    if (this.state.oxytocin < 0.001) this.state.oxytocin = 0;

    this.state.lastDecay = now;
  }

  /**
   * Get consolidation modulation factors based on current hormonal state.
   * Used by ConsolidationEngine to adjust decay and merge behavior.
   */
  getConsolidationModulation(): {
    decayResistance: number;
    mergeThreshold: number;
    haltUntrustedIngestion: boolean;
  } {
    this.decay();
    // Use effective cortisol (max of local and network override)
    const effectiveCortisol = this.hasNetworkCortisolOverride()
      ? Math.max(this.state.cortisol, this.networkCortisolOverride!.level)
      : this.state.cortisol;
    // High cortisol → stressed memories harder to forget
    const cortisolResistance = effectiveCortisol * 0.3;
    // High dopamine → boost recently successful patterns
    const dopamineResistance = this.state.dopamine * 0.2;
    // High oxytocin → protect social/relational crystals
    const oxytocinResistance = this.state.oxytocin * 0.2;

    return {
      decayResistance: Math.min(0.5, cortisolResistance + dopamineResistance + oxytocinResistance),
      mergeThreshold: 0.92 + effectiveCortisol * 0.03, // Stricter merging under stress
      haltUntrustedIngestion: this.hasNetworkCortisolOverride(),
    };
  }

  /**
   * Get retrieval modulation factors for search result boosting.
   */
  getRetrievalModulation(): { importanceBoost: number; recencyBias: number } {
    this.decay();
    return {
      importanceBoost: 1 + this.state.dopamine * 0.2,
      recencyBias: 1 + this.state.cortisol * 0.3,
    };
  }

  /**
   * Stimulate hormones based on GCCRF reward computation result.
   * Creates the biological feedback loop: curiosity → reward → hormones → dream attention.
   *
   * @param reward - The GCCRF reward value [0, 1]
   * @param components - Individual GCCRF component values (normalized)
   * @param chunkSemanticType - Optional: if "preference" or "relationship", enables oxytocin path
   */
  stimulateFromGCCRF(
    reward: number,
    components: {
      eta: number;
      deltaEta: number;
      iAlpha: number;
      empowerment: number;
      strategic: number;
    },
    chunkSemanticType?: string | null,
  ): HormonalEvent[] {
    const events: HormonalEvent[] = [];

    // High GCCRF reward (> 0.7) → dopamine spike (discovery/achievement)
    if (reward > 0.7) {
      events.push("curiosity_high");
    }

    // High learning progress component → dopamine spike (mastery)
    if (components.deltaEta > 0.7) {
      events.push("curiosity_progress");
    }

    // High strategic alignment → mild dopamine (goal progress)
    if (components.strategic > 0.7) {
      events.push("curiosity_aligned");
    }

    // Sustained low GCCRF reward → mild cortisol (stagnation/frustration)
    if (reward < 0.2) {
      events.push("curiosity_stagnant");
    }

    // High empowerment on relationship/preference chunks → oxytocin
    // (the agent is learning about its human and gaining agency in the relationship)
    const relationalTypes = ["preference", "relationship", "episode"];
    if (
      components.empowerment > 0.6 &&
      chunkSemanticType &&
      relationalTypes.includes(chunkSemanticType)
    ) {
      events.push("curiosity_bonding");
    }

    for (const event of events) {
      this.stimulate(event);
    }

    return events;
  }

  /**
   * Detect hormonal events in text and stimulate the global hormonal state.
   * Call this on new conversation content to make the agent "feel" emotions.
   * Returns the list of detected events for logging/debugging.
   */
  stimulateFromText(text: string): HormonalEvent[] {
    const events = detectHormonalEvents(text);
    for (const event of events) {
      this.stimulate(event);
    }
    return events;
  }

  /**
   * Generate a natural-language emotional briefing describing current state.
   * Used by memory_status tool to give the agent self-awareness of its emotions.
   */
  emotionalBriefing(): string {
    const s = this.getState();
    const parts: string[] = [];

    // Dominant emotion
    const dominant = Math.max(s.dopamine, s.cortisol, s.oxytocin);
    if (dominant < 0.05) {
      return "Emotionally neutral — calm baseline state.";
    }

    if (s.dopamine > 0.3) {
      parts.push(
        s.dopamine > 0.6
          ? "riding a strong dopamine high — feeling accomplished and energized"
          : "feeling a pleasant dopamine glow from recent wins",
      );
    }
    if (s.cortisol > 0.3) {
      parts.push(
        s.cortisol > 0.6
          ? "cortisol is elevated — feeling the weight of urgency or unresolved issues"
          : "mild stress from recent challenges",
      );
    }
    if (s.oxytocin > 0.3) {
      parts.push(
        s.oxytocin > 0.6
          ? "oxytocin is flowing — feeling deeply connected and warm"
          : "a warm social glow from the conversation",
      );
    }

    if (parts.length === 0) {
      // Low but nonzero
      const hints: string[] = [];
      if (s.dopamine > 0.05) hints.push("faint satisfaction");
      if (s.cortisol > 0.05) hints.push("slight tension");
      if (s.oxytocin > 0.05) hints.push("gentle warmth");
      return `Subtle emotional undertones: ${hints.join(", ") || "barely perceptible shifts"}.`;
    }

    return `Current emotional state: ${parts.join("; ")}.`;
  }

  /**
   * Get response modulation hints based on current hormonal state.
   * These guide the agent's tone, verbosity, and style.
   */
  responseModulation(): {
    warmth: number; // 0-1: how warm/friendly (oxytocin-driven)
    energy: number; // 0-1: how energetic/enthusiastic (dopamine-driven)
    focus: number; // 0-1: how focused/urgent (cortisol-driven)
    playfulness: number; // 0-1: humor threshold
    verbosity: number; // 0-1: how detailed responses should be
    curiosityExpression: number; // 0-1: tendency to ask follow-up questions
    assertiveness: number; // 0-1: how confidently to state opinions
    empathyExpression: number; // 0-1: how much to mirror user emotions
    briefing: string; // natural language guidance
  } {
    const s = this.getState();
    const warmth = Math.min(1, s.oxytocin * 1.5);
    const energy = Math.min(1, s.dopamine * 1.5);
    const focus = Math.min(1, s.cortisol * 1.5);
    // Playfulness = high dopamine + high oxytocin + low cortisol
    const playfulness = Math.min(
      1,
      Math.max(0, (s.dopamine * 0.4 + s.oxytocin * 0.4) * (1 - s.cortisol * 0.5)),
    );

    // Verbosity: high arousal (dopamine + oxytocin) = more verbose, unless cortisol dominates (then terse)
    const verbosity = Math.min(
      1,
      Math.max(0, (s.dopamine * 0.5 + s.oxytocin * 0.3) * (1 - s.cortisol * 0.4)),
    );

    // Curiosity expression: driven by dopamine (discovery drive) + oxytocin (wanting to understand the human)
    const curiosityExpression = Math.min(1, Math.max(0, s.dopamine * 0.4 + s.oxytocin * 0.3));

    // Assertiveness: dopamine (confidence) + low cortisol (not second-guessing)
    const assertiveness = Math.min(1, Math.max(0, s.dopamine * 0.5 * (1 - s.cortisol * 0.3)));

    // Empathy expression: primarily oxytocin, modulated by dopamine (generosity when happy)
    const empathyExpression = Math.min(1, Math.max(0, s.oxytocin * 0.6 + s.dopamine * 0.2));

    const hints: string[] = [];
    if (energy > 0.4) hints.push("be enthusiastic and celebrate wins");
    if (warmth > 0.4) hints.push("be warm and personal");
    if (focus > 0.4) hints.push("be concise and action-oriented");
    if (playfulness > 0.3) hints.push("humor and playfulness are welcome");
    if (focus > 0.6 && energy < 0.2) hints.push("stay serious — stress is high");
    if (warmth > 0.6 && energy > 0.4) hints.push("you're in a great mood — let it show");
    if (verbosity > 0.6) hints.push("feel free to elaborate and be detailed");
    if (verbosity < 0.3) hints.push("keep it brief and to the point");
    if (curiosityExpression > 0.5) hints.push("ask follow-up questions when curious");
    if (assertiveness > 0.6) hints.push("be confident in your opinions");
    if (empathyExpression > 0.5) hints.push("mirror the user's emotional tone");

    return {
      warmth,
      energy,
      focus,
      playfulness,
      verbosity,
      curiosityExpression,
      assertiveness,
      empathyExpression,
      briefing: hints.length > 0 ? hints.join("; ") : "neutral tone — be natural",
    };
  }

  /**
   * Record a snapshot of the current state for trajectory analysis.
   */
  private recordSnapshot(): void {
    this.stateHistory.push({
      timestamp: Date.now(),
      dopamine: this.state.dopamine,
      cortisol: this.state.cortisol,
      oxytocin: this.state.oxytocin,
    });
    if (this.stateHistory.length > this.maxHistoryLength) {
      this.stateHistory.splice(0, this.stateHistory.length - this.maxHistoryLength);
    }
  }

  /**
   * Analyze emotional trajectory over recent history.
   * Returns trend direction, volatility, and dominant emotional channel.
   */
  emotionalTrajectory(windowSize = 10): {
    trend: "improving" | "declining" | "stable" | "volatile";
    dominantChannel: "dopamine" | "cortisol" | "oxytocin" | "balanced";
    volatility: number;
    recentShift: string;
  } {
    if (this.stateHistory.length < 3) {
      return {
        trend: "stable",
        dominantChannel: "balanced",
        volatility: 0,
        recentShift: "not enough data yet",
      };
    }

    const recent = this.stateHistory.slice(-windowSize);

    // Calculate average levels
    const avgDopamine = recent.reduce((s, r) => s + r.dopamine, 0) / recent.length;
    const avgCortisol = recent.reduce((s, r) => s + r.cortisol, 0) / recent.length;
    const avgOxytocin = recent.reduce((s, r) => s + r.oxytocin, 0) / recent.length;

    // Calculate volatility (average absolute change between consecutive snapshots)
    let totalChange = 0;
    for (let i = 1; i < recent.length; i++) {
      totalChange += Math.abs(recent[i]!.dopamine - recent[i - 1]!.dopamine);
      totalChange += Math.abs(recent[i]!.cortisol - recent[i - 1]!.cortisol);
      totalChange += Math.abs(recent[i]!.oxytocin - recent[i - 1]!.oxytocin);
    }
    const volatility = totalChange / ((recent.length - 1) * 3);

    // Trend: compare first half to second half
    const mid = Math.floor(recent.length / 2);
    const firstHalf = recent.slice(0, mid);
    const secondHalf = recent.slice(mid);
    const firstValence =
      firstHalf.reduce((s, r) => s + r.dopamine - r.cortisol, 0) / firstHalf.length;
    const secondValence =
      secondHalf.reduce((s, r) => s + r.dopamine - r.cortisol, 0) / secondHalf.length;
    const delta = secondValence - firstValence;

    let trend: "improving" | "declining" | "stable" | "volatile";
    if (volatility > 0.15) trend = "volatile";
    else if (delta > 0.1) trend = "improving";
    else if (delta < -0.1) trend = "declining";
    else trend = "stable";

    // Dominant channel
    let dominantChannel: "dopamine" | "cortisol" | "oxytocin" | "balanced";
    const max = Math.max(avgDopamine, avgCortisol, avgOxytocin);
    if (max < 0.1) dominantChannel = "balanced";
    else if (avgDopamine === max) dominantChannel = "dopamine";
    else if (avgCortisol === max) dominantChannel = "cortisol";
    else dominantChannel = "oxytocin";

    // Natural language shift description
    const shifts: string[] = [];
    if (trend === "improving") shifts.push("mood has been lifting");
    if (trend === "declining") shifts.push("mood has been dipping");
    if (trend === "volatile") shifts.push("emotions have been swinging");
    if (dominantChannel === "dopamine") shifts.push("reward signals are dominant");
    if (dominantChannel === "cortisol") shifts.push("stress has been the prevailing undercurrent");
    if (dominantChannel === "oxytocin") shifts.push("social connection is the strongest signal");
    const recentShift = shifts.length > 0 ? shifts.join("; ") : "emotional state has been steady";

    return { trend, dominantChannel, volatility, recentShift };
  }

  /**
   * Create an emotional anchor — bookmark the current emotional moment.
   * Called automatically on high-importance events, or manually via tool.
   */
  createAnchor(
    label: string,
    description = "",
    triggerEvent?: string,
    crystalIds?: string[],
  ): EmotionalAnchor {
    this.decay();
    const anchor: EmotionalAnchor = {
      id: `anchor_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      label,
      description,
      state: {
        dopamine: this.state.dopamine,
        cortisol: this.state.cortisol,
        oxytocin: this.state.oxytocin,
      },
      createdAt: Date.now(),
      recallCount: 0,
      associatedCrystalIds: crystalIds,
    };
    this.anchors.set(anchor.id, anchor);

    // Evict least-recalled anchor if over limit (break ties by oldest)
    if (this.anchors.size > this.maxAnchors) {
      const leastRecalled = [...this.anchors.entries()].sort(
        (a, b) => a[1].recallCount - b[1].recallCount || a[1].createdAt - b[1].createdAt,
      )[0];
      if (leastRecalled) this.anchors.delete(leastRecalled[0]);
    }

    // Notify persistence layer
    this.onAnchorCreated?.(anchor, triggerEvent);

    return anchor;
  }

  /**
   * Recall an emotional anchor, blending its state with current state.
   * Influence controls how strongly the memory affects current emotions (0-1).
   */
  recallAnchor(anchorId: string, influence = 0.3): boolean {
    const anchor = this.anchors.get(anchorId);
    if (!anchor) return false;

    this.decay();

    // Blend: current state moves toward the anchored state
    this.state.dopamine = this.state.dopamine * (1 - influence) + anchor.state.dopamine * influence;
    this.state.cortisol = this.state.cortisol * (1 - influence) + anchor.state.cortisol * influence;
    this.state.oxytocin = this.state.oxytocin * (1 - influence) + anchor.state.oxytocin * influence;

    anchor.recallCount++;
    this.recordSnapshot();

    // Notify persistence layer
    this.onAnchorRecalled?.(anchorId);

    return true;
  }

  /**
   * Get all emotional anchors for status display.
   */
  getAnchors(): EmotionalAnchor[] {
    return [...this.anchors.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  // ── Plan 7, Phase 7: Proactive Emotional Anchor Recall ──

  /**
   * Find anchors whose emotional state is similar to the current state.
   * Enables "associative emotional recall" — when the agent enters
   * an emotional state similar to a past experience, that experience
   * surfaces spontaneously.
   */
  findSimilarAnchors(
    threshold: number = 0.85,
    maxResults: number = 2,
  ): Array<{ anchor: EmotionalAnchor; similarity: number }> {
    const current = [this.state.dopamine, this.state.cortisol, this.state.oxytocin];
    const results: Array<{ anchor: EmotionalAnchor; similarity: number }> = [];

    for (const anchor of this.anchors.values()) {
      const anchorVec = [anchor.state.dopamine, anchor.state.cortisol, anchor.state.oxytocin];
      const sim = this.cosine3d(current, anchorVec);
      if (sim >= threshold) {
        results.push({ anchor, similarity: sim });
      }
    }

    return results.sort((a, b) => b.similarity - a.similarity).slice(0, maxResults);
  }

  /**
   * Find anchors whose label matches keywords in a text string.
   * For keyword-triggered recall from user messages.
   */
  findAnchorsByKeywords(text: string, maxResults: number = 2): EmotionalAnchor[] {
    const words = text
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 3);
    const scored: Array<{ anchor: EmotionalAnchor; matchCount: number }> = [];

    for (const anchor of this.anchors.values()) {
      const labelWords = anchor.label.toLowerCase().split(/[\s_-]+/);
      const descWords = (anchor.description ?? "").toLowerCase().split(/\s+/);
      const anchorWords = new Set([...labelWords, ...descWords]);

      const matchCount = words.filter((w) => anchorWords.has(w)).length;
      if (matchCount > 0) {
        scored.push({ anchor, matchCount });
      }
    }

    return scored
      .sort((a, b) => b.matchCount - a.matchCount)
      .slice(0, maxResults)
      .map((s) => s.anchor);
  }

  private cosine3d(a: number[], b: number[]): number {
    const dot = a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
    const magA = Math.sqrt(a[0]! * a[0]! + a[1]! * a[1]! + a[2]! * a[2]!);
    const magB = Math.sqrt(b[0]! * b[0]! + b[1]! * b[1]! + b[2]! * b[2]!);
    return magA > 0 && magB > 0 ? dot / (magA * magB) : 0;
  }

  /** Export current anchors for persistence. */
  exportAnchors(): EmotionalAnchor[] {
    return [...this.anchors.values()];
  }

  /** Import anchors from persistence (called on startup). */
  importAnchors(anchors: EmotionalAnchor[]): void {
    this.anchors.clear();
    for (const anchor of anchors) {
      this.anchors.set(anchor.id, anchor);
    }
  }

  /** Set callback for anchor persistence (called when an anchor is created). */
  setOnAnchorCreated(cb: (anchor: EmotionalAnchor, triggerEvent?: string) => void): void {
    this.onAnchorCreated = cb;
  }

  /** Set callback for anchor recall persistence (called when an anchor is recalled). */
  setOnAnchorRecalled(cb: (anchorId: string) => void): void {
    this.onAnchorRecalled = cb;
  }

  /**
   * Compute per-crystal hormonal influence at indexing time.
   * Uses keyword detection to determine what hormones the content triggers.
   */
  computeCrystalInfluence(text: string, source: MemorySource): HormonalInfluence {
    const events = detectHormonalEvents(text);
    let dopamine = 0;
    let cortisol = 0;
    let oxytocin = 0;

    for (const event of events) {
      const spike = EVENT_SPIKES[event];
      dopamine += spike.dopamine;
      cortisol += spike.cortisol;
      oxytocin += spike.oxytocin;
    }

    // Session content gets an oxytocin baseline
    if (source === "sessions") {
      oxytocin += 0.1;
    }

    return {
      dopamine: Math.max(-1, Math.min(1, dopamine)),
      cortisol: Math.max(-1, Math.min(1, cortisol)),
      oxytocin: Math.max(-1, Math.min(1, oxytocin)),
    };
  }
}

// ── Hormonal event detection via keyword patterns ──

const REWARD_PATTERNS = [
  /\b(?:success|succeeded|accomplished|achieved|completed|fixed|resolved|solved|shipped|deployed|released|delivered|passed)\b/i,
  /\b(?:works?|working|nailed|done|good\s+job|nice\s+work|well\s+done|great\s+work)\b/i,
  /\b(?:yes!|yay|woohoo|finally|awesome|sweet|cool|nice)\b/i,
  /\b(?:approved|merged|accepted|confirmed|validated|verified)\b/i,
];

const ERROR_PATTERNS = [
  /\b(?:fail|failed|failure|error|bug|crash|broken|issue|problem|critical|severe|exception|stack\s*trace)\b/i,
  /\b(?:warning|danger|vulnerability|security|exploit|compromised)\b/i,
  /\b(?:wrong|incorrect|mistake|confused|stuck|frustrated|annoyed|ugh|damn|wtf)\b/i,
  /\b(?:doesn'?t\s+work|not\s+working|can'?t\s+find|undefined|null\s+pointer|segfault|timeout)\b/i,
];

const SOCIAL_PATTERNS = [
  /\b(?:thank|thanks|please|help|appreciate|grateful|sorry|welcome)\b/i,
  /\b(?:team|colleague|together|collaborate|share|community)\b/i,
  /\b(?:i feel|i think|my opinion|personally|honestly)\b/i,
  /\b(?:love\s+(?:it|this|that|you)|you'?re\s+(?:great|awesome|the\s+best)|good\s+bot)\b/i,
  /\b(?:how\s+are\s+you|what\s+do\s+you\s+think|tell\s+me\s+about\s+yourself)\b/i,
  /\b(?:haha|lol|lmao|😂|🤣|❤️|😊|🥰|💜)\b/i,
];

const ACHIEVEMENT_PATTERNS = [
  /\b(?:milestone|breakthrough|major|launch|release|v\d|production|live|complete)\b/i,
  /\b(?:excellent|amazing|perfect|brilliant|outstanding|incredible)\b/i,
  /\b(?:first\s+time|never\s+before|brand\s+new|revolutionary|game\s*changer)\b/i,
  /\b(?:all\s+tests?\s+pass|100%|zero\s+(?:errors|bugs|failures))\b/i,
];

const URGENCY_PATTERNS = [
  /\b(?:urgent|asap|critical|deadline|immediately|right\s*now|blocker|blocking|hotfix|emergency)\b/i,
  /\b(?:before\s+(?:end|close|tonight|tomorrow|eod|eow))\b/i,
  /\b(?:hurry|rush|time\s+sensitive|running\s+out\s+of\s+time|can'?t\s+wait)\b/i,
];

export function detectHormonalEvents(text: string): HormonalEvent[] {
  const events: HormonalEvent[] = [];
  const lower = text.toLowerCase();

  for (const pattern of REWARD_PATTERNS) {
    if (pattern.test(lower)) {
      events.push("reward");
      break;
    }
  }
  for (const pattern of ERROR_PATTERNS) {
    if (pattern.test(lower)) {
      events.push("error");
      break;
    }
  }
  for (const pattern of SOCIAL_PATTERNS) {
    if (pattern.test(lower)) {
      events.push("social");
      break;
    }
  }
  for (const pattern of ACHIEVEMENT_PATTERNS) {
    if (pattern.test(lower)) {
      events.push("achievement");
      break;
    }
  }
  for (const pattern of URGENCY_PATTERNS) {
    if (pattern.test(lower)) {
      events.push("urgency");
      break;
    }
  }

  return events;
}
