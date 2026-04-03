/**
 * Session Fact Extraction Pipeline
 *
 * Processes raw session transcripts through an LLM to extract structured,
 * atomic facts classified into four epistemic layers (inspired by Hindsight):
 *
 * - world_fact:   Objective knowledge (versions, configs, endpoints, names)
 * - experience:   Episodic events (what happened, causal sequences, outcomes)
 * - mental_model: Beliefs, reasoning frameworks, patterns the user expressed
 * - directive:    Standing instructions, preferences, hard rules from the user
 *
 * Also generates a session handover brief for seamless cross-session continuity.
 *
 * The extraction prompt is modulated by the current hormonal state:
 * - High cortisol → prioritize error/friction facts
 * - High oxytocin → prioritize relational facts
 * - High dopamine → prioritize achievement facts
 */

import type { SessionHandoverBrief } from "./session-handover.js";

export type EpistemicLayer = "world_fact" | "experience" | "mental_model" | "directive";

export type ExtractedFact = {
  text: string;
  epistemicLayer: EpistemicLayer;
  confidence: number;
  semanticType: string;
  sessionId: string;
};

export type ExtractionResult = {
  facts: ExtractedFact[];
  handoverBrief: SessionHandoverBrief;
  processingTimeMs: number;
};

export type HormonalBias = {
  dopamine: number;
  cortisol: number;
  oxytocin: number;
};

const EPISTEMIC_TO_SEMANTIC: Record<EpistemicLayer, string> = {
  world_fact: "fact",
  experience: "episode",
  mental_model: "insight",
  directive: "preference",
};

function buildHormonalGuidance(hormones?: HormonalBias): string {
  if (!hormones) return "";
  const lines: string[] = [];
  if (hormones.cortisol > 0.3) {
    lines.push("- PRIORITY: Extract errors, frictions, and blockers encountered during this session.");
  }
  if (hormones.dopamine > 0.3) {
    lines.push("- PRIORITY: Extract achievements, breakthroughs, and successful outcomes.");
  }
  if (hormones.oxytocin > 0.3) {
    lines.push("- PRIORITY: Extract relational information, user preferences, and personal details shared.");
  }
  return lines.length > 0
    ? `\n## Extraction Priority (hormonal modulation)\n${lines.join("\n")}\n`
    : "";
}

function buildExtractionPrompt(
  sessionContent: string,
  maxFacts: number,
  hormones?: HormonalBias,
): string {
  return `You are a memory extraction system. Analyze the following conversation transcript and extract structured facts.

## Task
1. Extract up to ${maxFacts} atomic facts from the conversation, classified into epistemic layers.
2. Generate a session handover brief summarizing the session state.

## Epistemic Layers
- **world_fact**: Objective knowledge — software versions, configuration values, API endpoints, hardware specs, names, dates, established technical facts.
- **experience**: Episodic events — what was attempted, what succeeded/failed, debugging steps taken, causal sequences.
- **mental_model**: Synthesized beliefs — user's reasoning patterns, architectural preferences, design principles expressed.
- **directive**: Hard rules — explicit instructions like "always do X", "never do Y", formatting requirements, workflow preferences.
${buildHormonalGuidance(hormones)}
## Output Format
Respond with ONLY a JSON object (no markdown fences):
{
  "facts": [
    { "text": "atomic fact statement", "layer": "world_fact|experience|mental_model|directive", "confidence": 0.0-1.0 }
  ],
  "handover": {
    "purpose": "one-line session purpose",
    "milestones": ["completed milestone 1", "..."],
    "decisions": ["decision made and rationale", "..."],
    "blockers": ["current blocker or open question", "..."],
    "nextSteps": ["immediate next action", "..."],
    "entities": [
      { "name": "filename.ts or functionName() or CONFIG_KEY", "type": "file|function|variable|config|service|tool", "lastAction": "edited|debugged|created|discussed|configured" }
    ]
  }
}

## Rules
- Each fact must be a single, self-contained assertion. No compound statements.
- Facts must be extractable truths, not conversational filler.
- Confidence reflects how certain the fact is: 1.0 = explicitly stated, 0.5 = inferred.
- Prefer fewer high-quality facts over many low-quality ones.
- The handover brief should let a new session pick up exactly where this one left off.
- The entities list should capture specific files, functions, variables, config keys, and services the user was working with — concrete referents that allow resolving references like "that file" or "the second parameter" in the next session. Focus on the 5-10 most recently touched entities.

## Conversation Transcript
${sessionContent}`;
}

function parseExtractionResponse(
  raw: string,
  sessionId: string,
): { facts: ExtractedFact[]; handover: SessionHandoverBrief } | null {
  try {
    // Strip markdown code fences if present
    const cleaned = raw.replace(/^```(?:json)?\s*\n?/m, "").replace(/\n?```\s*$/m, "").trim();
    const parsed = JSON.parse(cleaned) as {
      facts?: Array<{ text?: string; layer?: string; confidence?: number }>;
      handover?: {
        purpose?: string;
        milestones?: string[];
        decisions?: string[];
        blockers?: string[];
        nextSteps?: string[];
      };
    };

    if (!parsed.facts || !Array.isArray(parsed.facts)) return null;

    const validLayers = new Set<string>(["world_fact", "experience", "mental_model", "directive"]);

    const facts: ExtractedFact[] = parsed.facts
      .filter(
        (f) =>
          typeof f.text === "string" &&
          f.text.length > 0 &&
          typeof f.layer === "string" &&
          validLayers.has(f.layer),
      )
      .map((f) => ({
        text: f.text!,
        epistemicLayer: f.layer as EpistemicLayer,
        confidence: typeof f.confidence === "number" ? Math.min(1, Math.max(0, f.confidence)) : 0.7,
        semanticType: EPISTEMIC_TO_SEMANTIC[f.layer as EpistemicLayer] ?? "general",
        sessionId,
      }));

    const h = parsed.handover;

    // Parse entity registry from LLM output
    const rawEntities = Array.isArray((h as Record<string, unknown>)?.entities)
      ? ((h as Record<string, unknown>).entities as Array<{ name?: string; type?: string; lastAction?: string }>)
      : [];
    const entities = rawEntities
      .filter((e) => typeof e?.name === "string" && e.name.length > 0)
      .map((e) => ({
        name: e.name!,
        type: typeof e.type === "string" ? e.type : "unknown",
        lastAction: typeof e.lastAction === "string" ? e.lastAction : "discussed",
      }))
      .slice(0, 10);

    const handover: SessionHandoverBrief = {
      sessionId,
      purpose: typeof h?.purpose === "string" ? h.purpose : "Session purpose not determined",
      milestones: Array.isArray(h?.milestones) ? h.milestones.filter((s) => typeof s === "string") : [],
      decisions: Array.isArray(h?.decisions) ? h.decisions.filter((s) => typeof s === "string") : [],
      blockers: Array.isArray(h?.blockers) ? h.blockers.filter((s) => typeof s === "string") : [],
      nextSteps: Array.isArray(h?.nextSteps) ? h.nextSteps.filter((s) => typeof s === "string") : [],
      entities,
      timestamp: Date.now(),
    };

    return { facts, handover };
  } catch {
    return null;
  }
}

/**
 * Extract structured facts and a handover brief from a session transcript.
 *
 * @param sessionContent  The raw session text (concatenated user/assistant messages)
 * @param sessionId       Unique identifier for the session (typically the file path)
 * @param llmCall         Function to call the LLM: (prompt) => response
 * @param maxFacts        Maximum facts to extract (default 20)
 * @param hormones        Current hormonal state for extraction bias (optional)
 * @returns Extraction result with facts and handover, or null on LLM failure
 */
export async function extractSessionFacts(
  sessionContent: string,
  sessionId: string,
  llmCall: (prompt: string) => Promise<string>,
  maxFacts = 20,
  hormones?: HormonalBias,
): Promise<ExtractionResult | null> {
  const start = Date.now();

  const prompt = buildExtractionPrompt(sessionContent, maxFacts, hormones);

  let response: string;
  try {
    response = await llmCall(prompt);
  } catch {
    return null;
  }

  const parsed = parseExtractionResponse(response, sessionId);
  if (!parsed) return null;

  return {
    facts: parsed.facts.slice(0, maxFacts),
    handoverBrief: parsed.handover,
    processingTimeMs: Date.now() - start,
  };
}

export { EPISTEMIC_TO_SEMANTIC };
