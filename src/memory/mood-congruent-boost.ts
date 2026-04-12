/**
 * Mood-Congruent Retrieval: current hormonal state biases which memories surface.
 *
 * Completes the bidirectional emotion-memory loop:
 * - Forward: emotional state → retrieval bias (this module)
 * - Reverse: recalled content → hormonal stimulation (limbic bridge, hormonal.ts)
 *
 * FIRST IMPLEMENTATION of mood-congruent retrieval in any agent memory system.
 *
 * Scientific basis:
 * - Bower, G.H. (1981). Mood and memory. American Psychologist, 36(2).
 * - Eich, E. (1995). Searching for mood dependent memory. Psychological Science.
 *
 * PLAN-9: GAP-6 (Mood-Congruent Retrieval)
 */

export interface HormonalState {
  dopamine: number; // 0-1
  cortisol: number; // 0-1
  oxytocin: number; // 0-1
}

export interface MoodCongruentConfig {
  enabled: boolean;
  /** Maximum bonus per result (prevents emotional spiraling) */
  maxBonus: number;
  /** Hormone level threshold to activate mood influence */
  activationThreshold: number;
  /** Weight of dopamine on positive-valence memories */
  dopamineWeight: number;
  /** Weight of cortisol on task/goal memories */
  cortisolWeight: number;
  /** Weight of oxytocin on relationship memories */
  oxytocinWeight: number;
}

export const DEFAULT_MOOD_CONGRUENT_CONFIG: MoodCongruentConfig = {
  enabled: true,
  maxBonus: 0.15,
  activationThreshold: 0.4,
  dopamineWeight: 0.1,
  cortisolWeight: 0.1,
  oxytocinWeight: 0.1,
};

/**
 * Compute mood-congruent retrieval bonus for a search result.
 *
 * In the search pipeline, apply after RRF fusion and before final ranking:
 *   result.score *= (1 + moodCongruentBonus(...))
 *
 * @returns Additive bonus in [0, maxBonus]. Apply as: score *= (1 + bonus)
 */
export function moodCongruentBonus(params: {
  hormonalState: HormonalState;
  emotionalValence: number | null;
  semanticType: string | null;
  config?: Partial<MoodCongruentConfig>;
}): number {
  const cfg = { ...DEFAULT_MOOD_CONGRUENT_CONFIG, ...params.config };
  if (!cfg.enabled) return 0;

  const { hormonalState, emotionalValence, semanticType } = params;
  let bonus = 0;

  // Dopamine → positive-valence memories
  // High dopamine (reward, discovery) biases recall toward positive memories
  if (
    hormonalState.dopamine >= cfg.activationThreshold &&
    emotionalValence != null &&
    emotionalValence > 0
  ) {
    bonus += cfg.dopamineWeight * emotionalValence * hormonalState.dopamine;
  }

  // Cortisol → task-oriented memories (task_pattern, goal)
  // High cortisol (stress, urgency) biases recall toward actionable information
  if (hormonalState.cortisol >= cfg.activationThreshold) {
    const taskTypes = new Set(["task_pattern", "goal", "directive", "skill"]);
    if (semanticType && taskTypes.has(semanticType)) {
      bonus += cfg.cortisolWeight * hormonalState.cortisol;
    }
  }

  // Oxytocin → relational/social memories (relationship, preference)
  // High oxytocin (social bonding) biases recall toward personal/social info
  if (hormonalState.oxytocin >= cfg.activationThreshold) {
    const relationalTypes = new Set(["relationship", "preference", "episode"]);
    if (semanticType && relationalTypes.has(semanticType)) {
      bonus += cfg.oxytocinWeight * hormonalState.oxytocin;
    }
  }

  // Clamp to prevent emotional spiraling
  return Math.min(cfg.maxBonus, Math.max(0, bonus));
}
