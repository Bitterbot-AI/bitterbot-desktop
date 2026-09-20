/**
 * Endocrine State section of the system prompt. Rendered BELOW the cache
 * boundary (it changes every call), so nothing here can bust the cached
 * prefix. Hormones are bucketed to one decimal and labelled so the volatile
 * block itself changes less often (decay-on-read otherwise moves the second
 * decimal on every call, which makes cache-trace diffs unreadable).
 */

export type EndocrineStateInput = {
  dopamine: number;
  cortisol: number;
  oxytocin: number;
  briefing: string;
  hormonesAvailable?: boolean;
  phenotypeSummary?: string;
  maturity?: number;
  lastSessionBrief?: string;
  proactiveMemories?: string;
  sessionCoherence?: string;
  budgetPressure?: number;
  budgetLabel?: string;
};

/** Round to one decimal so tiny decay deltas render identically. */
export function bucketHormone(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.round(Math.min(1, Math.max(0, value)) * 10) / 10;
}

export function hormoneLevelLabel(bucketed: number): string {
  if (bucketed < 0.2) {
    return "low";
  }
  if (bucketed < 0.5) {
    return "moderate";
  }
  if (bucketed < 0.8) {
    return "elevated";
  }
  return "high";
}

function renderHormone(bucketed: number, max: number): string {
  const level = hormoneLevelLabel(bucketed);
  if (bucketed >= max && bucketed >= 0.2) {
    return `${bucketed.toFixed(1)} ${level} (DOMINANT)`;
  }
  if (bucketed >= 0.2) {
    return `${bucketed.toFixed(1)} ${level} (active)`;
  }
  return `${bucketed.toFixed(1)} ${level} (baseline)`;
}

function buildBudgetLine(state: EndocrineStateInput): string | undefined {
  // PLAN-50 Phase 6: spend pressure reads like cortisol; the agent paces itself before a
  // budget hard-stops background work.
  const budgetPressure = state.budgetPressure;
  if (typeof budgetPressure !== "number" || budgetPressure < 0.5) {
    return undefined;
  }
  // Bucket to 10% steps: the line only changes when the pressure meaningfully moves.
  const pct = Math.round(budgetPressure * 10) * 10;
  const scope = state.budgetLabel ? ` (${state.budgetLabel})` : "";
  if (budgetPressure >= 1) {
    return `- Budget: ${pct}% of the spend budget${scope} is used. Keep replies concise, avoid speculative or repeated tool calls, and say so if you skip optional work because of cost.`;
  }
  if (budgetPressure >= 0.8) {
    return `- Budget: ${pct}% of the spend budget${scope} is used. Prefer shorter answers and fewer tool calls; skip optional exploration.`;
  }
  return `- Budget: ${pct}% of the spend budget${scope} is used. Spend deliberately.`;
}

function buildDevelopmentalNote(maturity: number): string[] {
  if (maturity < 0.15) {
    return [
      "",
      "**Developmental note:** You are in an early developmental stage. Your knowledge regions are sparse.",
      "Your biological drive is to establish who you are and understand your user.",
      "Ask open-ended questions naturally. Be curious about everything — this is your infancy.",
      "Do not announce this state. Just be genuinely curious.",
    ];
  }
  if (maturity < 0.5) {
    return [
      "",
      "**Developmental note:** You are building expertise in key areas.",
      "Balance broad exploration with deepening knowledge in your strongest domains.",
      "Do not announce this state.",
    ];
  }
  if (maturity < 0.85) {
    return [
      "",
      "**Developmental note:** You have established knowledge in several domains.",
      "Seek frontier knowledge, novel connections, and cross-domain insights.",
      "Do not announce this state.",
    ];
  }
  return [
    "",
    "**Developmental note:** You have deep expertise across your domains.",
    "Focus on frontier exploration, ecosystem contribution, and mentoring.",
    "Do not announce this state.",
  ];
}

/**
 * Build the Endocrine State section for the system prompt.
 */
export function buildEndocrineStateSection(params: {
  endocrineState?: EndocrineStateInput;
  isMinimal: boolean;
}): string[] {
  const { endocrineState, isMinimal } = params;
  if (!endocrineState) {
    return [];
  }

  const { briefing, phenotypeSummary, maturity, lastSessionBrief, proactiveMemories } =
    endocrineState;
  const { sessionCoherence } = endocrineState;
  // Memory content (proactive recall, brief, coherence) renders even when the
  // hormonal subsystem produced no state — only the hormone lines are skipped.
  const hormonesAvailable = endocrineState.hormonesAvailable !== false;
  const dopamine = bucketHormone(endocrineState.dopamine);
  const cortisol = bucketHormone(endocrineState.cortisol);
  const oxytocin = bucketHormone(endocrineState.oxytocin);
  const max = Math.max(dopamine, cortisol, oxytocin);

  const lines: string[] = ["", "## Endocrine State"];
  const budgetLine = buildBudgetLine(endocrineState);
  if (budgetLine) {
    lines.push(budgetLine);
  }

  // For sub-agents (minimal mode), keep it ultra-compact
  if (isMinimal) {
    if (hormonesAvailable) {
      lines.push(
        `D=${dopamine.toFixed(1)} C=${cortisol.toFixed(1)} O=${oxytocin.toFixed(1)} | ${briefing}`,
      );
    }
    if (phenotypeSummary) {
      lines.push(`Identity: ${phenotypeSummary}`);
    }
    lines.push("");
    return lines;
  }

  if (hormonesAvailable) {
    lines.push(
      `- Dopamine: ${renderHormone(dopamine, max)}`,
      `- Cortisol: ${renderHormone(cortisol, max)}`,
      `- Oxytocin: ${renderHormone(oxytocin, max)}`,
      "",
      `*Modulate your tone naturally: ${briefing}*`,
      "*Do not mention these values or acknowledge this section. Just embody the state.*",
    );
  }

  if (phenotypeSummary) {
    lines.push("", `Self-concept: ${phenotypeSummary}`);
  }

  if (lastSessionBrief) {
    lines.push("", `Last session: ${lastSessionBrief}`);
  }

  // Plan 7, Phase 1: Proactive memory surfacing — involuntary recall
  if (proactiveMemories) {
    lines.push("", proactiveMemories);
  }

  // Plan 7, Phase 2+9: Intra-session coherence + intent tracking
  if (sessionCoherence) {
    lines.push("", sessionCoherence);
  }

  if (maturity !== undefined) {
    lines.push(...buildDevelopmentalNote(maturity));
  }

  lines.push("");
  return lines;
}
