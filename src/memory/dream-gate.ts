/**
 * Dream gate (token-efficiency pass, 2026-09-19).
 *
 * The dream timer used to run a full cycle every interval regardless of new
 * input: an idle day produced 6 full cycles (exploration + discovery +
 * extraction + synthesis + embeddings) and 48 mini-dreams, all metabolizing
 * artifacts the previous cycle wrote. Every function here is pure or backed
 * by the `memory_meta` key-value table so it can be unit-tested without the
 * manager.
 *
 * - `evaluateDreamGate`: a SCHEDULED full cycle runs only when new user turns
 *   arrived AND the user has been idle AND enough hours passed since the last
 *   full cycle. Explicit triggers bypass the gate at the call site.
 * - `DreamGateState`: the persisted counters (survive restarts).
 * - `HormonalDeltaTrigger`: fires on a RISE since the previous check, never
 *   on an absolute level, so a hormone pinned above 0.7 fires once.
 * - `shouldRunDiscovery`: the discovery agent's pair selection is
 *   deterministic, so a re-run without new skill chunks is pure waste.
 * - `lastAutoScratchEvent`: dedupe key for the hormonal auto-scratch note.
 */

import type { DatabaseSync } from "node:sqlite";

export type DreamGateConfig = {
  minNewSessions: number;
  minIdleMinutes: number;
  minHoursBetween: number;
};

export type DreamGateInput = {
  now: number;
  /** New user turns (non-heartbeat) since the last full cycle. */
  newSessions: number;
  /** Unix ms of the last live user turn; 0 when unknown. */
  lastUserTurnAt: number;
  /** Unix ms of the last completed full cycle; 0 when none. */
  lastFullCycleAt: number;
};

export type DreamGateDecision = { pass: boolean; reason: string };

export function evaluateDreamGate(cfg: DreamGateConfig, input: DreamGateInput): DreamGateDecision {
  const minNew = Math.max(0, cfg.minNewSessions);
  if (input.newSessions < minNew) {
    return {
      pass: false,
      reason: `no new input: ${input.newSessions} new turn(s) since last full cycle (need ${minNew})`,
    };
  }
  const idleMs = input.now - input.lastUserTurnAt;
  const minIdleMs = Math.max(0, cfg.minIdleMinutes) * 60_000;
  if (input.lastUserTurnAt > 0 && idleMs < minIdleMs) {
    return {
      pass: false,
      reason: `user active ${Math.round(idleMs / 60_000)}m ago (need ${cfg.minIdleMinutes}m idle)`,
    };
  }
  const sinceCycleMs = input.now - input.lastFullCycleAt;
  const minBetweenMs = Math.max(0, cfg.minHoursBetween) * 3_600_000;
  if (input.lastFullCycleAt > 0 && sinceCycleMs < minBetweenMs) {
    return {
      pass: false,
      reason: `last full cycle ${(sinceCycleMs / 3_600_000).toFixed(1)}h ago (need ${cfg.minHoursBetween}h)`,
    };
  }
  return { pass: true, reason: `${input.newSessions} new turn(s), idle, cadence satisfied` };
}

const META_KEYS = {
  newTurns: "dream_gate.new_turns_since_full_cycle",
  lastUserTurnAt: "dream_gate.last_user_turn_at",
  lastFullCycleAt: "dream_gate.last_full_cycle_at",
  discoveryLastRunAt: "discovery.last_run_at",
} as const;

/** Persisted gate counters in `memory_meta` (created on first use). */
export class DreamGateState {
  constructor(private readonly db: DatabaseSync) {}

  private ensure(): void {
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS memory_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
    );
  }

  private getNumber(key: string): number {
    try {
      this.ensure();
      const row = this.db.prepare(`SELECT value FROM memory_meta WHERE key = ?`).get(key) as
        | { value: string }
        | undefined;
      const n = row ? Number(row.value) : 0;
      return Number.isFinite(n) ? n : 0;
    } catch {
      return 0;
    }
  }

  private setNumber(key: string, value: number): void {
    try {
      this.ensure();
      this.db
        .prepare(
          `INSERT INTO memory_meta (key, value) VALUES (?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        )
        .run(key, String(value));
    } catch {
      // Non-critical: a failed write only makes the gate more conservative.
    }
  }

  /** Record a live (non-heartbeat) user turn. */
  recordUserTurn(now = Date.now()): void {
    this.setNumber(META_KEYS.newTurns, this.getNumber(META_KEYS.newTurns) + 1);
    this.setNumber(META_KEYS.lastUserTurnAt, now);
  }

  /** Record that a full cycle ran; resets the new-turn counter. */
  recordFullCycle(now = Date.now()): void {
    this.setNumber(META_KEYS.newTurns, 0);
    this.setNumber(META_KEYS.lastFullCycleAt, now);
  }

  snapshot(now = Date.now()): DreamGateInput {
    return {
      now,
      newSessions: this.getNumber(META_KEYS.newTurns),
      lastUserTurnAt: this.getNumber(META_KEYS.lastUserTurnAt),
      lastFullCycleAt: this.getNumber(META_KEYS.lastFullCycleAt),
    };
  }

  /**
   * Discovery runs only when skill chunks were created since its last run.
   * Returns the count of new skill chunks (0 = skip). Marks the run when
   * `mark` is true.
   */
  newSkillChunksSinceDiscovery(): number {
    const since = this.getNumber(META_KEYS.discoveryLastRunAt);
    try {
      const row = this.db
        .prepare(
          `SELECT COUNT(*) as c FROM chunks
           WHERE (COALESCE(memory_type, 'plaintext') = 'skill'
                  OR COALESCE(semantic_type, 'general') = 'skill')
             AND created_at > ?`,
        )
        .get(since) as { c: number } | undefined;
      return row?.c ?? 0;
    } catch {
      return 0;
    }
  }

  recordDiscoveryRun(now = Date.now()): void {
    this.setNumber(META_KEYS.discoveryLastRunAt, now);
  }
}

export type HormonalLevels = { dopamine: number; cortisol: number; oxytocin: number };
export type HormonalSpike = "dopamine_spike" | "cortisol_spike" | "oxytocin_spike";

/**
 * Delta trigger: a spike is a RISE of >= `delta` since the previous check of
 * that hormone. The baseline moves to the current level on every check, so a
 * level that stays high never re-fires; it must fall and rise again.
 */
export class HormonalDeltaTrigger {
  private last: HormonalLevels | null = null;

  constructor(private readonly delta: number) {}

  /** Returns every hormone that rose by >= delta since the previous check. */
  check(state: HormonalLevels): HormonalSpike[] {
    const spikes: HormonalSpike[] = [];
    if (this.last) {
      if (state.dopamine - this.last.dopamine >= this.delta) {
        spikes.push("dopamine_spike");
      }
      if (state.cortisol - this.last.cortisol >= this.delta) {
        spikes.push("cortisol_spike");
      }
      if (state.oxytocin - this.last.oxytocin >= this.delta) {
        spikes.push("oxytocin_spike");
      }
    }
    this.last = { dopamine: state.dopamine, cortisol: state.cortisol, oxytocin: state.oxytocin };
    return spikes;
  }
}

const AUTO_SCRATCH_PREFIX = "[AUTO] Hormonal event: ";

/**
 * The event text (between the prefix and the first period) of the most
 * recent auto-generated hormonal scratch note, or null when none exists.
 * Used so the consolidation tick never appends the same event twice in a row.
 */
export function lastAutoScratchEvent(scratchContent: string): string | null {
  const lines = scratchContent.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const idx = lines[i]!.indexOf(AUTO_SCRATCH_PREFIX);
    if (idx >= 0) {
      const rest = lines[i]!.slice(idx + AUTO_SCRATCH_PREFIX.length);
      const end = rest.indexOf(". ");
      return (end >= 0 ? rest.slice(0, end) : rest.replace(/\.\s*$/, "")).trim();
    }
  }
  return null;
}

export function autoScratchEventText(parts: string[]): string {
  return parts.join(", ");
}

export { AUTO_SCRATCH_PREFIX };
