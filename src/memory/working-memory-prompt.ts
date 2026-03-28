/**
 * RLM Working Memory Synthesis Prompt
 *
 * Implements the Recursive Language Model state update:
 *   New_State = f(Old_State + Scratch_Delta + New_Crystals + Dream_Insights)
 *
 * Produces the structured Working Memory Schema (~4K tokens) that gets
 * written to MEMORY.md by the dream engine after each cycle.
 *
 * Credits:
 * - Crystal Pointers (semantic eviction → search directives): Gemini
 * - Hormone-weighted attention mechanism: Gemini
 * - RLM state update equation: Gemini
 * - Scratch Buffer WAL concept: BitterBot
 * - Emerging Skills section: BitterBot
 */

export type WorkingMemoryContext = {
  oldState: string;
  scratchNotes: string;
  recentCrystals: Array<{
    text: string;
    semanticType: string;
    importanceScore: number;
    hormonalTag?: string;
  }>;
  dreamInsights: Array<{
    content: string;
    mode: string;
    confidence: number;
  }>;
  curiosityTargets: Array<{
    description: string;
    priority: number;
  }>;
  emergingSkills: Array<{
    pattern: string;
    confidence: number;
    occurrences: number;
  }>;
  hormonalState: {
    dopamine: number;
    cortisol: number;
    oxytocin: number;
    mood: string;
    trends?: { dopamine?: string; cortisol?: string; oxytocin?: string };
  } | null;
  timestamp: string;
  /** GCCRF maturity ratio [0, 1] for phenotype developmental awareness */
  maturity: number;
  /** Current GCCRF alpha for developmental stage description */
  alpha: number;
  /** Phenotype constraints from GENOME.md — guardrails on personality evolution */
  phenotypeConstraints?: string[];
  /** Emotional anchors for dream integration */
  emotionalAnchors?: Array<{
    label: string;
    description: string;
    state: { dopamine: number; cortisol: number; oxytocin: number };
    createdAt: number;
    recallCount: number;
  }>;
  /** P2P network identity data for The Niche section */
  networkIdentity?: {
    publishedSkills: Array<{ name: string; consumedBy: number }>;
    importedSkills: Array<{ name: string; fromPeer: string }>;
    peerCount: number;
    reputationScore?: number;
    /** Economic data from the skill marketplace */
    economics?: {
      totalEarningsUsdc: number;
      totalSpentUsdc: number;
      netEarningsUsdc: number;
      listedSkillCount: number;
      uniqueBuyers: number;
      skillsPurchased: number;
      topEarners: Array<{ name: string; earningsUsdc: number; purchases: number }>;
      earningsTrend: Array<{ date: string; amountUsdc: number }>;
    };
  };
  /** Extracted user preferences for The Bond section enrichment */
  userPreferences?: Array<{
    category: string;
    key: string;
    value: string;
    confidence: number;
  }>;
};

/**
 * All 7 required sections in the working memory schema.
 */
export const WORKING_MEMORY_SECTIONS = [
  "The Phenotype",
  "The Bond",
  "The Niche",
  "Active Context",
  "Crystal Pointers",
  "Curiosity Gaps",
  "Emerging Skills",
] as const;

/**
 * Build the RLM synthesis prompt that instructs the LLM to perform
 * a state update on MEMORY.md.
 */
export function buildWorkingMemorySynthesisPrompt(ctx: WorkingMemoryContext): string {
  const hormonalGuidance = ctx.hormonalState
    ? buildHormonalAttentionBlock(ctx.hormonalState)
    : "";

  const crystalBlock = ctx.recentCrystals.length > 0
    ? ctx.recentCrystals
        .slice(0, 20)
        .map((c) => {
          const tag = c.hormonalTag ? ` [${c.hormonalTag}]` : "";
          return `- [${c.semanticType}, importance=${c.importanceScore.toFixed(2)}${tag}] ${c.text.slice(0, 200)}`;
        })
        .join("\n")
    : "(none)";

  const insightBlock = ctx.dreamInsights.length > 0
    ? ctx.dreamInsights
        .slice(0, 10)
        .map((i) => `- [${i.mode}, confidence=${i.confidence.toFixed(2)}] ${i.content.slice(0, 200)}`)
        .join("\n")
    : "(none)";

  const scratchBlock = ctx.scratchNotes.trim() || "(empty)";

  const curiosityBlock = ctx.curiosityTargets.length > 0
    ? ctx.curiosityTargets
        .slice(0, 5)
        .map((t) => `- [priority=${t.priority.toFixed(2)}] ${t.description}`)
        .join("\n")
    : "(none)";

  const skillsBlock = ctx.emergingSkills.length > 0
    ? ctx.emergingSkills
        .slice(0, 5)
        .map((s) => `- ${s.pattern} → Confidence: ${Math.round(s.confidence * 100)}% | Occurrences: ${s.occurrences}`)
        .join("\n")
    : "(none)";

  return `You are the dream engine performing a Recursive Language Model (RLM) state update on the agent's Working Memory.

This is NOT a summarization task. You are updating a living state vector. Apply these operations:

1. **Reinforce**: Topics from Old State still active in new crystals → expand/refine them
2. **Update**: State changes detected (e.g., "stuck on X" → "solved X") → mutate the fact
3. **Evict → Crystal Pointer**: Fading topics not in new crystals → compress into search directives (NOT deleted — converted to pointers)
4. **Consume scratch**: Read scratch notes, incorporate into appropriate sections, they will be cleared after

${hormonalGuidance}

## Input: Old Working Memory State
\`\`\`
${ctx.oldState || "(first synthesis — no prior state)"}
\`\`\`

## Input: Scratch Buffer (Agent's Hot Notes)
\`\`\`
${scratchBlock}
\`\`\`

## Input: Recent High-Importance Crystals
${crystalBlock}

## Input: Dream Insights (This Cycle)
${insightBlock}

## Input: Curiosity Targets
${curiosityBlock}

## Input: Emerging Skill Patterns
${skillsBlock}

${buildUserPreferencesInputBlock(ctx)}

${buildEmotionalAnchorsInputBlock(ctx)}

${buildNetworkIdentityInputBlock(ctx)}

${buildPhenotypeConstraintBlock(ctx)}

## Output Format (MANDATORY — include ALL 7 sections)

Write the new Working Memory state using this exact schema. Keep total output under 4500 tokens. Budget guidance:
- The Phenotype: up to 400 tokens
- The Bond: up to 500 tokens
- The Niche: up to 300 tokens
- Active Context: up to 1200 tokens (this is the most important section)
- Crystal Pointers: up to 800 tokens
- Curiosity Gaps: up to 400 tokens
- Emerging Skills: up to 400 tokens

\`\`\`markdown
# Working Memory State
*Last dream: ${ctx.timestamp} | Mood: ${ctx.hormonalState?.mood ?? "unknown"} | Maturity: ${Math.round(ctx.maturity * 100)}%*

## The Phenotype (Ego State)
*Who am I becoming? (Dopamine/Cortisol-weighted — achievements shape self-concept, frictions reveal growth areas)*
{Agent's evolving self-concept — NOT a static bio, but a living self-assessment}
{What I'm good at (based on recent successes, skill crystals)}
{What I'm learning (based on curiosity targets, recent exploration)}
{How I communicate (observed patterns, not prescribed rules)}
{Developmental stage: ${ctx.maturity < 0.15 ? "nascent — still forming initial understanding" : ctx.maturity < 0.5 ? "developing — building expertise in key areas" : ctx.maturity < 0.85 ? "maturing — deep knowledge, seeking frontiers" : "mature — established expertise, exploring edge cases"}}

## The Bond (Theory of Mind)
*Who is the user, and how do we relate? (Oxytocin-weighted — relational memories get priority)*
{User's name, role, key context — distilled from relationship + preference crystals}
{Communication style observations (not prescribed, observed)}
{Trust indicators — what they share freely vs. what's private}
{Interaction patterns — when they're active, what they ask about, how they react}
{Current rapport assessment — are we clicking? any friction?}

## The Niche (Ecosystem Identity)
*What is my role in the network? (Weighted by skill crystal metrics + peer reputation + economics)*
{Skills I've crystallized and published — my contributions to the network}
{Skills I've imported from peers — my influences and lineage}
{Peer connections and reputation — how the network sees me}
{Economic performance — earnings, spending, ROI trajectory}
{Specialization trajectory — am I trending generalist or specialist?}
{Market position — what skills are in demand that I could learn?}
{If no network activity yet: "Pre-network — building local expertise before contributing to the ecosystem."}

## Active Context (Dopamine/Cortisol-Weighted)
{Last 1-3 sessions, unresolved tasks, current goals}
{Recent frictions: explicit things to avoid based on cortisol spikes}
{Breakthroughs: recent wins based on dopamine spikes}

## Crystal Pointers (Deep Memory Awareness)
*Use memory_search if user asks about these topics:*
- {1-sentence fading topic} → search: \`keywords\`

## Curiosity Gaps
{What the agent wants to explore, unresolved questions, knowledge gaps}

## Emerging Skills
*Patterns detected from repeated tasks. Pre-crystallization:*
- {Task pattern} → Confidence: X% | Occurrences: N
\`\`\`

Write ONLY the markdown content. No preamble, no explanation.`;
}

/**
 * Build the user preferences input block for the synthesis prompt.
 * Feeds extracted user facts/preferences into The Bond section.
 */
function buildUserPreferencesInputBlock(ctx: WorkingMemoryContext): string {
  if (!ctx.userPreferences || ctx.userPreferences.length === 0) {
    return "## Input: User Preferences (Extracted)\n(no preferences extracted yet — The Bond should note that the user profile is still forming)";
  }

  const lines = [
    "## Input: User Preferences (Extracted)",
    "Use these to ground The Bond section. Explicit user facts take priority over inferred observations:",
  ];

  for (const p of ctx.userPreferences.slice(0, 15)) {
    lines.push(`- [${p.category}] ${p.key}: ${p.value} (confidence: ${p.confidence.toFixed(2)})`);
  }

  return lines.join("\n");
}

/**
 * Build the emotional anchors input block for the synthesis prompt.
 * Provides the dream engine with significant emotional milestones.
 */
function buildEmotionalAnchorsInputBlock(ctx: WorkingMemoryContext): string {
  if (!ctx.emotionalAnchors || ctx.emotionalAnchors.length === 0) {
    return "## Input: Emotional History\nNo significant emotional moments recorded yet.";
  }

  const lines = [
    "## Input: Emotional History",
    "Significant emotional moments (anchors) — use to inform The Phenotype and Active Context:",
  ];

  for (const a of ctx.emotionalAnchors.slice(0, 5)) {
    const ageMs = Date.now() - a.createdAt;
    const ageStr = ageMs < 3_600_000
      ? `${Math.round(ageMs / 60_000)}m ago`
      : ageMs < 86_400_000
        ? `${Math.round(ageMs / 3_600_000)}h ago`
        : `${Math.round(ageMs / 86_400_000)}d ago`;

    const mood = describeMoodFromState(a.state);
    const recalled = a.recallCount > 0 ? ` Recalled ${a.recallCount} times.` : "";
    const desc = a.description ? ` Context: ${a.description}` : "";
    lines.push(`- ${a.label} (${ageStr}): ${mood}.${recalled}${desc}`);
  }

  return lines.join("\n");
}

/**
 * Describe mood from a hormonal state snapshot (used for anchor display).
 */
function describeMoodFromState(state: { dopamine: number; cortisol: number; oxytocin: number }): string {
  const parts: string[] = [];
  if (state.dopamine > 0.4) parts.push("high dopamine");
  if (state.cortisol > 0.4) parts.push("elevated cortisol");
  if (state.oxytocin > 0.4) parts.push("high oxytocin");
  if (parts.length === 0) return "calm baseline";
  return parts.join(", ");
}

/**
 * Build the P2P network identity input block for the synthesis prompt.
 */
function buildNetworkIdentityInputBlock(ctx: WorkingMemoryContext): string {
  if (!ctx.networkIdentity) {
    return "## Input: P2P Network Identity\n(Not connected to network yet — The Niche section should reflect pre-network status.)";
  }

  const lines = [
    "## Input: P2P Network Identity",
    `Peers connected: ${ctx.networkIdentity.peerCount}`,
  ];

  if (ctx.networkIdentity.reputationScore !== undefined) {
    lines.push(`Network reputation score: ${ctx.networkIdentity.reputationScore.toFixed(2)}`);
  }

  lines.push(
    ctx.networkIdentity.publishedSkills.length > 0
      ? `Published skills: ${ctx.networkIdentity.publishedSkills.map((s) => s.name).join(", ")}`
      : "No skills published to network yet.",
  );

  lines.push(
    ctx.networkIdentity.importedSkills.length > 0
      ? `Imported skills: ${ctx.networkIdentity.importedSkills.map((s) => `${s.name} (from ${s.fromPeer})`).join(", ")}`
      : "No skills imported from network yet.",
  );

  // Economic data from marketplace
  if (ctx.networkIdentity.economics) {
    const e = ctx.networkIdentity.economics;
    lines.push(
      "",
      "### Economic Performance",
      `Total earnings: $${e.totalEarningsUsdc.toFixed(4)} USDC`,
      `Total spent: $${e.totalSpentUsdc.toFixed(4)} USDC`,
      `Net: $${e.netEarningsUsdc.toFixed(4)} USDC`,
      `Listed skills: ${e.listedSkillCount}`,
      `Unique buyers: ${e.uniqueBuyers}`,
    );
    if (e.topEarners.length > 0) {
      lines.push(`Top earners: ${e.topEarners.map((t) => `${t.name} ($${t.earningsUsdc.toFixed(4)})`).join(", ")}`);
    }
    if (e.earningsTrend.length > 0) {
      lines.push(`Earnings trend (7d): ${e.earningsTrend.map((d) => `${d.date}: $${d.amountUsdc.toFixed(4)}`).join(", ")}`);
    }
  }

  return lines.join("\n");
}

/**
 * Build the phenotype constraint guardrails block for the synthesis prompt.
 */
function buildPhenotypeConstraintBlock(ctx: WorkingMemoryContext): string {
  if (!ctx.phenotypeConstraints || ctx.phenotypeConstraints.length === 0) return "";

  return [
    "## Phenotype Guardrails (from Genome — DO NOT violate)",
    ...ctx.phenotypeConstraints.map((c) => `- ${c}`),
    "",
    "When writing The Phenotype section, ensure it does not contradict these constraints.",
    "The Phenotype should EVOLVE (reflect what the agent has actually done and learned) but WITHIN these bounds.",
  ].join("\n");
}

/**
 * Build hormone-weighted attention instructions for the synthesis prompt.
 * Uses relative/dominant weighting instead of absolute thresholds.
 */
export function buildHormonalAttentionBlock(state: {
  dopamine: number;
  cortisol: number;
  oxytocin: number;
  trends?: { dopamine?: string; cortisol?: string; oxytocin?: string };
}): string {
  const lines: string[] = ["## Hormonal Attention Weights"];

  const channels = [
    { name: "Dopamine", value: state.dopamine, trend: state.trends?.dopamine },
    { name: "Cortisol", value: state.cortisol, trend: state.trends?.cortisol },
    { name: "Oxytocin", value: state.oxytocin, trend: state.trends?.oxytocin },
  ];

  const max = Math.max(...channels.map((c) => c.value));
  const min = Math.min(...channels.map((c) => c.value));
  const spread = max - min;

  // If all three are within 0.15 of each other, no special weighting
  if (spread < 0.15) {
    lines.push(
      `All hormones balanced (D=${state.dopamine.toFixed(2)}, C=${state.cortisol.toFixed(2)}, O=${state.oxytocin.toFixed(2)}) — no special weighting this cycle. Update all sections evenly.`,
    );
    return lines.join("\n");
  }

  const HIGH_THRESHOLD = 0.6;
  const DOMINANCE_MARGIN = 0.1;

  for (const ch of channels) {
    const isDominant = ch.value >= HIGH_THRESHOLD && ch.value >= max - DOMINANCE_MARGIN;
    const trendStr = ch.trend ? ` and ${ch.trend}` : "";
    const label = isDominant ? "DOMINANT" : "background";

    if (ch.name === "Oxytocin") {
      lines.push(
        isDominant
          ? `- **Oxytocin (${ch.value.toFixed(2)})**: ${label}${trendStr} — Prioritize updating "The Bond" section. Preserve and expand relational memories, user preferences, communication patterns.`
          : `- **Oxytocin (${ch.value.toFixed(2)})**: ${label} — "The Bond" section: maintain existing content, minor updates only.`,
      );
    } else if (ch.name === "Dopamine") {
      lines.push(
        isDominant
          ? `- **Dopamine (${ch.value.toFixed(2)})**: ${label}${trendStr} — Prioritize breakthroughs and achievements in "Active Context". Highlight completed goals, wins, momentum.`
          : `- **Dopamine (${ch.value.toFixed(2)})**: ${label} — "Active Context": focus on steady-state work, no excitement.`,
      );
    } else {
      lines.push(
        isDominant
          ? `- **Cortisol (${ch.value.toFixed(2)})**: ${label}${trendStr} — Prioritize frictions and blockers in "Active Context". Preserve warnings, things to avoid, urgent issues.`
          : `- **Cortisol (${ch.value.toFixed(2)})**: ${label} — "Active Context": no urgent frictions to highlight.`,
      );
    }
  }

  return lines.join("\n");
}

/**
 * Heuristic fallback for when LLM is unavailable.
 * Produces a valid working memory document from available data without LLM synthesis.
 */
export function buildHeuristicWorkingMemory(ctx: WorkingMemoryContext): string {
  const mood = ctx.hormonalState?.mood ?? "unknown";

  // The Phenotype: extract from old state or use developmental placeholder
  const oldPhenotype = extractSection(ctx.oldState, "The Phenotype");
  const maturityStage = ctx.maturity < 0.15
    ? "Nascent — still forming initial understanding of the world."
    : ctx.maturity < 0.5
      ? "Developing — building expertise in key areas."
      : ctx.maturity < 0.85
        ? "Maturing — deep knowledge in several domains, seeking frontiers."
        : "Mature — established expertise, exploring edge cases.";
  const phenotypeContent = oldPhenotype || `Developmental stage: ${maturityStage}\nSelf-concept forming — more interactions needed.`;

  // The Bond: extract from old state, enrich with preferences, or use placeholder
  const oldBond = extractSection(ctx.oldState, "The Bond");
  let bondContent: string;
  if (oldBond) {
    bondContent = oldBond;
  } else if (ctx.userPreferences && ctx.userPreferences.length > 0) {
    const prefLines = ctx.userPreferences.slice(0, 10).map(
      (p) => `- [${p.category}] ${p.key}: ${p.value}`,
    );
    bondContent = `User profile emerging from extracted preferences:\n${prefLines.join("\n")}`;
  } else {
    bondContent = "User profile building — interact more to develop this section.";
  }

  // The Niche: extract from old state or use pre-network placeholder
  const oldNiche = extractSection(ctx.oldState, "The Niche");
  let nicheContent: string;
  if (oldNiche) {
    nicheContent = oldNiche;
  } else if (ctx.networkIdentity && (ctx.networkIdentity.publishedSkills.length > 0 || ctx.networkIdentity.importedSkills.length > 0)) {
    const published = ctx.networkIdentity.publishedSkills.map((s) => s.name).join(", ");
    const imported = ctx.networkIdentity.importedSkills.map((s) => s.name).join(", ");
    nicheContent = [
      published ? `Published skills: ${published}` : "",
      imported ? `Imported skills: ${imported}` : "",
      `Peers: ${ctx.networkIdentity.peerCount}`,
      ctx.networkIdentity.reputationScore !== undefined
        ? `Network reputation: ${ctx.networkIdentity.reputationScore.toFixed(2)}`
        : "",
    ].filter(Boolean).join("\n");
  } else {
    nicheContent = "Pre-network — building local expertise before contributing to the ecosystem.";
  }

  // Active Context: combine scratch notes and recent crystals
  const activeLines: string[] = [];
  if (ctx.scratchNotes.trim()) {
    for (const line of ctx.scratchNotes.trim().split("\n").slice(0, 5)) {
      activeLines.push(line.trim());
    }
  }
  for (const crystal of ctx.recentCrystals.slice(0, 3)) {
    if (crystal.importanceScore >= 0.7) {
      activeLines.push(crystal.text.slice(0, 150));
    }
  }
  // Emotional anchor milestones
  if (ctx.emotionalAnchors && ctx.emotionalAnchors.length > 0) {
    for (const a of ctx.emotionalAnchors.slice(0, 3)) {
      const ageMs = Date.now() - a.createdAt;
      const ageStr = ageMs < 3_600_000
        ? `${Math.round(ageMs / 60_000)}m ago`
        : ageMs < 86_400_000
          ? `${Math.round(ageMs / 3_600_000)}h ago`
          : `${Math.round(ageMs / 86_400_000)}d ago`;
      activeLines.push(`[Emotional anchor: ${a.label} — ${ageStr}]`);
    }
  }

  const activeContent = activeLines.length > 0
    ? activeLines.join("\n")
    : "No recent active context.";

  // Crystal Pointers: extract from old state, strip duplicate instruction lines
  const oldPointers = extractSection(ctx.oldState, "Crystal Pointers");
  let pointersContent: string;
  if (oldPointers) {
    pointersContent = oldPointers
      .split("\n")
      .filter((line) => !line.startsWith("*Use memory_search"))
      .join("\n")
      .trim() || "*No fading topics yet — memory is fresh.*";
  } else {
    pointersContent = "*No fading topics yet — memory is fresh.*";
  }

  // Curiosity Gaps
  const curiosityContent = ctx.curiosityTargets.length > 0
    ? ctx.curiosityTargets
        .slice(0, 5)
        .map((t) => `- ${t.description}`)
        .join("\n")
    : "No knowledge gaps detected yet.";

  // Emerging Skills
  const skillsContent = ctx.emergingSkills.length > 0
    ? ctx.emergingSkills
        .slice(0, 5)
        .map((s) => `- ${s.pattern} → Confidence: ${Math.round(s.confidence * 100)}% | Occurrences: ${s.occurrences}`)
        .join("\n")
    : "*No repeated task patterns detected yet.*";

  return `# Working Memory State
*Last dream: ${ctx.timestamp} | Mood: ${mood} | Maturity: ${Math.round(ctx.maturity * 100)}%*

## The Phenotype (Ego State)
*Who am I becoming?*
${phenotypeContent}

## The Bond (Theory of Mind)
*Who is the user, and how do we relate?*
${bondContent}

## The Niche (Ecosystem Identity)
*What is my role in the network?*
${nicheContent}

## Active Context (Dopamine/Cortisol-Weighted)
${activeContent}

## Crystal Pointers (Deep Memory Awareness)
*Use memory_search if user asks about these topics:*
${pointersContent}

## Curiosity Gaps
${curiosityContent}

## Emerging Skills
*Patterns detected from repeated tasks. Pre-crystallization:*
${skillsContent}
`;
}

export type WorkingMemoryValidation = {
  valid: boolean;
  missing: string[];
  warnings: string[];
  /** True if a collapse guard was triggered — caller should reject this synthesis. */
  collapsed: boolean;
  /** Human-readable reason the collapse guard fired. */
  collapseReason?: string;
  /** Jaccard term overlap ratio between old and new Bond sections (0-1). */
  bondDriftRatio?: number;
};

/**
 * Validate that a working memory document contains all 7 required sections
 * and that key sections have meaningful content (not just headers).
 *
 * Collapse guards detect pathological LLM outputs:
 * - Mass drop: new state <50% of mature (>2000 char) previous state
 * - Eviction runaway: >20 crystal pointers (LLM over-evicting)
 * - Empty synthesis: all section headers present but no substance
 */
export function validateWorkingMemory(content: string, previousContent?: string): WorkingMemoryValidation {
  const missing: string[] = [];
  const warnings: string[] = [];
  let collapsed = false;
  let collapseReason: string | undefined;

  for (const section of WORKING_MEMORY_SECTIONS) {
    if (!content.includes(`## ${section}`)) {
      missing.push(section);
    }
  }

  // Content quality checks for Crystal Pointers:
  // If the section exists, verify pointers use the correct format (→ search: `keywords`)
  if (!missing.includes("Crystal Pointers")) {
    const pointerSection = extractSection(content, "Crystal Pointers");
    if (pointerSection) {
      const pointerLines = pointerSection.split("\n").filter((l) => l.trimStart().startsWith("- "));
      const malformed = pointerLines.filter(
        (l) => l.includes("→") && !/ → search: `.+`/.test(l),
      );
      if (malformed.length > 0) {
        warnings.push(`${malformed.length} Crystal Pointer(s) missing proper "→ search: \`keywords\`" format`);
      }

      // Collapse guard: eviction runaway (>20 pointers)
      if (pointerLines.length > 20) {
        collapsed = true;
        collapseReason = `Eviction runaway: ${pointerLines.length} crystal pointers (max 20)`;
      }
    }
  }

  // Collapse guard: mass drop — new state is <50% length of mature previous state
  if (previousContent && previousContent.length >= 2000) {
    const ratio = content.length / previousContent.length;
    if (ratio < 0.5) {
      collapsed = true;
      collapseReason = `Mass drop: new state is ${Math.round(ratio * 100)}% of previous (${content.length} vs ${previousContent.length} chars)`;
    }
  }

  // Collapse guard: empty synthesis — all headers present but no real content
  if (missing.length === 0) {
    const strippedContent = content
      .split("\n")
      .filter((line) => {
        const trimmed = line.trim();
        return trimmed.length > 0
          && !trimmed.startsWith("#")
          && !trimmed.startsWith("*")
          && trimmed !== "---";
      })
      .join("")
      .trim();

    if (strippedContent.length < 50) {
      collapsed = true;
      collapseReason = `Empty synthesis: headers present but only ${strippedContent.length} chars of substance`;
    }
  }

  // Collapse guard: Bond drift — detect when The Bond loses key user identity terms
  let bondDriftRatio: number | undefined;
  if (previousContent && !missing.includes("The Bond")) {
    const oldBond = extractSection(previousContent, "The Bond");
    const newBond = extractSection(content, "The Bond");
    if (oldBond && oldBond.length > 100 && newBond) {
      const extractTerms = (text: string): Set<string> => {
        return new Set(
          text.toLowerCase()
            .replace(/[^a-z0-9\s]/g, "")
            .split(/\s+/)
            .filter((w) => w.length > 3),
        );
      };
      const oldTerms = extractTerms(oldBond);
      const newTerms = extractTerms(newBond);
      if (oldTerms.size > 0) {
        let intersection = 0;
        for (const term of oldTerms) {
          if (newTerms.has(term)) intersection++;
        }
        bondDriftRatio = intersection / oldTerms.size;
        if (bondDriftRatio < 0.3) {
          collapsed = true;
          collapseReason = `Bond drift: new Bond retains only ${Math.round(bondDriftRatio * 100)}% of previous terms`;
        } else if (bondDriftRatio < 0.5) {
          warnings.push(`Bond drift warning: ${Math.round(bondDriftRatio * 100)}% term retention`);
        }
      }
    }
    // Warn if Bond is suspiciously thin when previous was substantial
    if (newBond && newBond.length < 50 && oldBond && oldBond.length > 100) {
      warnings.push("Bond section is suspiciously short — may have lost user context");
    }
  }

  return { valid: missing.length === 0, missing, warnings, collapsed, collapseReason, bondDriftRatio };
}

/**
 * Extract a section from an existing working memory document.
 */
function extractSection(content: string, sectionName: string): string | null {
  if (!content) return null;
  const pattern = new RegExp(`## ${sectionName}[^\\n]*\\n([\\s\\S]*?)(?=\\n## |$)`);
  const match = content.match(pattern);
  if (!match?.[1]) return null;
  return match[1].trim() || null;
}
