/**
 * ExperienceSignalCollector: packages node experience data into scored
 * training signals for network propagation and future model improvement.
 *
 * Taps into:
 * - DreamEngine: post-synthesis insights with confidence/mode
 * - HormonalStateManager: current emotional state
 * - SkillExecutionTracker: execution outcomes
 * - CuriosityEngine: surprise assessments
 *
 * Signals are batched per dream cycle (not real-time) and published on
 * the telemetry/v1 Gossipsub topic.
 */

import type { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
import type { CuriosityEngine } from "./curiosity-engine.js";
import type { DreamInsight, DreamStats, DreamMode } from "./dream-types.js";
import type { HormonalStateManager } from "./hormonal.js";
import type { SkillExecutionTracker } from "./skill-execution-tracker.js";
import type { OrchestratorBridgeLike } from "./skill-network-bridge.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("memory/experience-signals");

/** A scored experience signal ready for network propagation. */
export type ExperienceSignal = {
  signalId: string;
  cycleId: string;
  signalType: "dream_insight" | "execution_outcome" | "curiosity_spike" | "emotional_shift";
  content: string;
  scores: {
    trainingRelevance: number;
    novelty: number;
    emotionalWeight: number;
    dreamConsolidation: number;
  };
  metadata: Record<string, unknown>;
  timestamp: number;
};

/** Batch of signals from a single collection event. */
export type SignalBatch = {
  batchId: string;
  cycleId: string | null;
  signals: ExperienceSignal[];
  aggregateScores: {
    meanRelevance: number;
    meanNovelty: number;
    emotionalIntensity: number;
  };
  collectedAt: number;
};

/** Training relevance weights by signal source. */
const SOURCE_WEIGHTS: Record<ExperienceSignal["signalType"], number> = {
  dream_insight: 0.9,
  execution_outcome: 0.8,
  curiosity_spike: 0.6,
  emotional_shift: 0.4,
};

/** Emotional channel weights for blended emotional_weight. */
const EMOTION_BLEND = {
  valence: 0.4, // dopamine → positivity
  arousal: 0.3, // cortisol → stress/arousal
  warmth: 0.3, // oxytocin → social connection
};

const MAX_RECENT_SIGNALS = 50;

export class ExperienceSignalCollector {
  private readonly db: DatabaseSync;
  private recentSignalHashes: string[] = [];
  private orchestratorBridge: OrchestratorBridgeLike | null = null;
  private hormonalManager: HormonalStateManager | null = null;
  private curiosityEngine: CuriosityEngine | null = null;
  private executionTracker: SkillExecutionTracker | null = null;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  setOrchestratorBridge(bridge: OrchestratorBridgeLike | null): void {
    this.orchestratorBridge = bridge;
  }

  setHormonalManager(manager: HormonalStateManager | null): void {
    this.hormonalManager = manager;
  }

  setCuriosityEngine(engine: CuriosityEngine | null): void {
    this.curiosityEngine = engine;
  }

  setExecutionTracker(tracker: SkillExecutionTracker | null): void {
    this.executionTracker = tracker;
  }

  /**
   * Collect and score signals from a completed dream cycle.
   * This is the primary collection trigger — called after DreamEngine.run() completes.
   */
  collectFromDreamCycle(dreamStats: DreamStats): SignalBatch | null {
    if (!dreamStats.cycle.completedAt || dreamStats.cycle.error) {
      return null;
    }

    const signals: ExperienceSignal[] = [];
    const cycleId = dreamStats.cycle.cycleId;
    const now = Date.now();

    // 1. Dream insights → signals
    for (const insight of dreamStats.newInsights) {
      const signal = this.scoreDreamInsight(insight, cycleId, now);
      if (signal) {
        signals.push(signal);
      }
    }

    // 2. Recent curiosity spikes → signals
    if (this.curiosityEngine) {
      const state = this.curiosityEngine.getState();
      for (const surprise of state.recentSurprises.slice(0, 5)) {
        if (surprise.compositeReward > 0.5) {
          const signal = this.scoreCuriositySpike(surprise, cycleId, now);
          if (signal) {
            signals.push(signal);
          }
        }
      }
    }

    // 3. Recent execution outcomes → signals
    const recentExecs = this.getRecentExecutions(5);
    for (const exec of recentExecs) {
      const signal = this.scoreExecutionOutcome(exec, cycleId, now);
      if (signal) {
        signals.push(signal);
      }
    }

    // 4. Emotional state shift → signal (if significant)
    const emotionalSignal = this.scoreEmotionalState(cycleId, now);
    if (emotionalSignal) {
      signals.push(emotionalSignal);
    }

    if (signals.length === 0) {
      return null;
    }

    // Build batch
    const batch = this.buildBatch(signals, cycleId, now);

    // Publish to network
    this.publishBatch(batch).catch((err) => {
      log.debug(`failed to publish signal batch: ${String(err)}`);
    });

    log.debug("experience signals collected", {
      cycleId,
      signalCount: signals.length,
      meanRelevance: batch.aggregateScores.meanRelevance.toFixed(3),
    });

    return batch;
  }

  private scoreDreamInsight(
    insight: DreamInsight,
    cycleId: string,
    now: number,
  ): ExperienceSignal | null {
    const contentHash = this.hashContent(insight.content);
    const novelty = this.computeNoveltyVsRecent(contentHash);

    // Dream consolidation: confidence * mode weight
    const modeWeights: Record<string, number> = {
      replay: 0.3,
      compression: 0.4,
      exploration: 0.7,
      mutation: 0.9,
      extrapolation: 0.8,
      simulation: 0.85,
    };
    const modeWeight = modeWeights[insight.mode] ?? 0.5;
    const dreamConsolidation = insight.confidence * modeWeight;

    const emotionalWeight = this.computeEmotionalWeight();

    const trainingRelevance =
      SOURCE_WEIGHTS.dream_insight * 0.4 +
      novelty * 0.3 +
      dreamConsolidation * 0.2 +
      emotionalWeight * 0.1;

    return {
      signalId: crypto.randomUUID(),
      cycleId,
      signalType: "dream_insight",
      content: insight.content.slice(0, 500),
      scores: {
        trainingRelevance: Math.min(1, trainingRelevance),
        novelty,
        emotionalWeight,
        dreamConsolidation,
      },
      metadata: {
        mode: insight.mode,
        confidence: insight.confidence,
        sourceChunkCount: insight.sourceChunkIds.length,
        importanceScore: insight.importanceScore,
      },
      timestamp: now,
    };
  }

  private scoreCuriositySpike(
    surprise: {
      chunkId: string;
      compositeReward: number;
      noveltyScore: number;
      surpriseFactor: number;
      informationGain: number;
      regionId: string | null;
    },
    cycleId: string,
    now: number,
  ): ExperienceSignal | null {
    const novelty = surprise.noveltyScore;
    const emotionalWeight = this.computeEmotionalWeight();

    const trainingRelevance =
      SOURCE_WEIGHTS.curiosity_spike * 0.3 +
      novelty * 0.3 +
      surprise.compositeReward * 0.3 +
      emotionalWeight * 0.1;

    return {
      signalId: crypto.randomUUID(),
      cycleId,
      signalType: "curiosity_spike",
      content: `High-surprise chunk: reward=${surprise.compositeReward.toFixed(3)}`,
      scores: {
        trainingRelevance: Math.min(1, trainingRelevance),
        novelty,
        emotionalWeight,
        dreamConsolidation: 0,
      },
      metadata: {
        chunkId: surprise.chunkId,
        compositeReward: surprise.compositeReward,
        surpriseFactor: surprise.surpriseFactor,
        informationGain: surprise.informationGain,
        regionId: surprise.regionId,
      },
      timestamp: now,
    };
  }

  private scoreExecutionOutcome(
    exec: {
      skillId: string;
      success: boolean;
      rewardScore: number | null;
      executionTimeMs: number | null;
    },
    cycleId: string,
    now: number,
  ): ExperienceSignal | null {
    const emotionalWeight = this.computeEmotionalWeight();
    // Failures are more training-relevant than successes (learn from mistakes)
    const outcomeFactor = exec.success ? 0.5 : 0.8;
    const rewardFactor = exec.rewardScore != null ? Math.abs(exec.rewardScore) : 0.3;
    const novelty = this.computeNoveltyVsRecent(this.hashContent(exec.skillId + exec.success));

    const trainingRelevance =
      SOURCE_WEIGHTS.execution_outcome * 0.3 +
      outcomeFactor * 0.3 +
      rewardFactor * 0.2 +
      novelty * 0.1 +
      emotionalWeight * 0.1;

    return {
      signalId: crypto.randomUUID(),
      cycleId,
      signalType: "execution_outcome",
      content: `Skill ${exec.skillId.slice(0, 8)}: ${exec.success ? "success" : "failure"}`,
      scores: {
        trainingRelevance: Math.min(1, trainingRelevance),
        novelty,
        emotionalWeight,
        dreamConsolidation: 0,
      },
      metadata: {
        skillId: exec.skillId,
        success: exec.success,
        rewardScore: exec.rewardScore,
        executionTimeMs: exec.executionTimeMs,
      },
      timestamp: now,
    };
  }

  private scoreEmotionalState(cycleId: string, now: number): ExperienceSignal | null {
    if (!this.hormonalManager) {
      return null;
    }

    const state = this.hormonalManager.getState();
    const trajectory = this.hormonalManager.emotionalTrajectory();

    // Only emit if there's significant emotional activity
    if (!trajectory || trajectory.trend === "stable") {
      return null;
    }

    const emotionalWeight = this.computeEmotionalWeight();
    if (emotionalWeight < 0.3) {
      return null;
    }

    const novelty = trajectory.trend === "volatile" ? 0.7 : 0.4;
    const trainingRelevance =
      SOURCE_WEIGHTS.emotional_shift * 0.4 + emotionalWeight * 0.4 + novelty * 0.2;

    return {
      signalId: crypto.randomUUID(),
      cycleId,
      signalType: "emotional_shift",
      content: `Emotional trend: ${trajectory.trend}, dominant: ${trajectory.dominantChannel}`,
      scores: {
        trainingRelevance: Math.min(1, trainingRelevance),
        novelty,
        emotionalWeight,
        dreamConsolidation: 0,
      },
      metadata: {
        trend: trajectory.trend,
        dominantChannel: trajectory.dominantChannel,
        volatility: trajectory.volatility,
        dopamine: state.dopamine,
        cortisol: state.cortisol,
        oxytocin: state.oxytocin,
      },
      timestamp: now,
    };
  }

  private computeEmotionalWeight(): number {
    if (!this.hormonalManager) {
      return 0.3;
    }
    const state = this.hormonalManager.getState();
    return (
      Math.abs(state.dopamine) * EMOTION_BLEND.valence +
      Math.abs(state.cortisol) * EMOTION_BLEND.arousal +
      Math.abs(state.oxytocin) * EMOTION_BLEND.warmth
    );
  }

  private computeNoveltyVsRecent(contentHash: string): number {
    if (this.recentSignalHashes.includes(contentHash)) {
      return 0.1;
    }

    this.recentSignalHashes.push(contentHash);
    if (this.recentSignalHashes.length > MAX_RECENT_SIGNALS) {
      this.recentSignalHashes.shift();
    }

    return 0.8; // Novel relative to recent history
  }

  private hashContent(content: string): string {
    return crypto.createHash("sha256").update(content).digest("hex").slice(0, 16);
  }

  private getRecentExecutions(limit: number): Array<{
    skillId: string;
    success: boolean;
    rewardScore: number | null;
    executionTimeMs: number | null;
  }> {
    try {
      const rows = this.db
        .prepare(
          `SELECT skill_crystal_id, success, reward_score,
                  execution_time_ms
           FROM skill_executions
           WHERE completed_at IS NOT NULL
           ORDER BY completed_at DESC LIMIT ?`,
        )
        .all(limit) as Array<{
        skill_crystal_id: string;
        success: number | null;
        reward_score: number | null;
        execution_time_ms: number | null;
      }>;
      return rows.map((r) => ({
        skillId: r.skill_crystal_id,
        success: r.success === 1,
        rewardScore: r.reward_score,
        executionTimeMs: r.execution_time_ms,
      }));
    } catch {
      return [];
    }
  }

  private buildBatch(
    signals: ExperienceSignal[],
    cycleId: string | null,
    now: number,
  ): SignalBatch {
    const meanRelevance =
      signals.reduce((s, sig) => s + sig.scores.trainingRelevance, 0) / signals.length;
    const meanNovelty = signals.reduce((s, sig) => s + sig.scores.novelty, 0) / signals.length;
    const emotionalIntensity =
      signals.reduce((s, sig) => s + sig.scores.emotionalWeight, 0) / signals.length;

    return {
      batchId: crypto.randomUUID(),
      cycleId,
      signals,
      aggregateScores: {
        meanRelevance,
        meanNovelty,
        emotionalIntensity,
      },
      collectedAt: now,
    };
  }

  private async publishBatch(batch: SignalBatch): Promise<void> {
    if (!this.orchestratorBridge?.publishTelemetry) {
      return;
    }

    try {
      await this.orchestratorBridge.publishTelemetry("experience", {
        batchId: batch.batchId,
        cycleId: batch.cycleId,
        signalCount: batch.signals.length,
        aggregateScores: batch.aggregateScores,
        // Send compact summaries, not full signal content
        signalSummaries: batch.signals.map((s) => ({
          type: s.signalType,
          relevance: s.scores.trainingRelevance,
          novelty: s.scores.novelty,
          emotional: s.scores.emotionalWeight,
          dream: s.scores.dreamConsolidation,
        })),
        collectedAt: batch.collectedAt,
      });
      log.debug(`experience batch published: ${batch.signals.length} signals`);
    } catch (err) {
      log.debug(`failed to publish experience batch: ${String(err)}`);
    }
  }
}
