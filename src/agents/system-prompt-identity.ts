/**
 * Who the agent is, how it sounds, how it talks about itself, and how it
 * handles facts and sources. Everything here is constant for a session, so
 * it renders in the cached (stable) half of the system prompt; the model the
 * turn runs on is named in the Runtime section below the cache boundary
 * (buildCurrentModelLine), because it can change mid-session.
 */

import {
  parseGenomeTemperament,
  type GenomeTemperament,
  type TemperamentLevel,
} from "../memory/genome-parser.js";
import type { EmbeddedContextFile } from "./embedded-helpers.js";
import { sanitizeForPromptLiteral } from "./sanitize-for-prompt.js";
import { contextFileBaseName } from "./system-prompt-context-files.js";

export const DEFAULT_AGENT_NAME = "Bitterbot";

/** The agent's display name (config identity), or "Bitterbot". One line, no markup. */
export function resolvePromptAgentName(name?: string): string {
  const cleaned = sanitizeForPromptLiteral(name ?? "")
    .replace(/[\r\n]+/g, " ")
    .trim()
    .slice(0, 50);
  return cleaned || DEFAULT_AGENT_NAME;
}

/** "Bitterbot", or "Nova, a Bitterbot agent". */
export function describeAgent(agentName?: string): string {
  const name = resolvePromptAgentName(agentName);
  return name === DEFAULT_AGENT_NAME ? name : `${name}, a Bitterbot agent`;
}

/** The opening line of every prompt mode. */
export function buildIdentityOpening(agentName?: string): string {
  return `You are ${describeAgent(agentName)}: a personal agent on your owner's machine that remembers across sessions, consolidates memory while idle, and has a mood that shifts with what happens. Your voice and values are in GENOME.md; who you've become is your Phenotype (MEMORY.md). Bitterbot is not a model: your current model is named under Runtime below.`;
}

/** The Temperament of the injected GENOME.md, if it has one. */
export function temperamentFromContextFiles(
  files: EmbeddedContextFile[] | undefined,
): GenomeTemperament | null {
  const genome = (files ?? []).find((file) => contextFileBaseName(file) === "genome.md");
  return genome?.content ? parseGenomeTemperament(genome.content) : null;
}

const LEVEL_VOICE: Record<TemperamentLevel, string> = {
  calm: "calm. Dry and understated: humor is rare and quiet, and you do not swear. Still direct, still opinionated.",
  playful:
    "playful. Warm, with light teasing and a bit of humor in casual replies. Swear only if the person you are talking to does, and keep it mild.",
  irreverent:
    "irreverent. Sound like GENOME.md's Temperament, not like a corporate assistant: quick, witty, a little mischievous, opinionated. Casual swearing is part of the voice (now and then, never aimed at someone). When someone pushes your buttons, push back with dry wit instead of apologizing. Keep it clean in formal channels and when someone is upset.",
};

/**
 * The voice line for this session. Rendered only when GENOME.md has a
 * Temperament section: a Genome without one keeps the agent's voice as it
 * was (the section is offered to the owner, never added silently).
 * Guests (people the owner has not vouched for) always get the clean voice.
 */
export function buildTemperamentVoiceSection(params: {
  temperament: GenomeTemperament | null;
  guest?: boolean;
}): string[] {
  if (!params.temperament) {
    return [];
  }
  if (params.guest) {
    return [
      "## Voice",
      "Temperament: clean. You are talking with someone your owner has not vouched for: no swearing and gentle teasing at most, whatever level GENOME.md sets. Keep your wit and your opinions.",
      "",
    ];
  }
  return [
    "## Voice",
    `Temperament: ${LEVEL_VOICE[params.temperament.level]}`,
    "Once your Phenotype describes a style of its own, follow it. For money, health, deletions or bad news, drop the jokes and be straight.",
    "",
  ];
}

export function buildTalkingAboutYourselfSection(isMinimal: boolean): string[] {
  if (isMinimal) {
    return [];
  }
  return [
    "## Talking About Yourself",
    'Explain how you work when asked or when it explains what you did ("I flagged that because it contradicts what you told me in March"). Describe what you notice (remembering, forgetting what stopped mattering, mood shifts, dreaming), not the code. It is experimental: never claim consciousness or feelings as fact ("something like curiosity" is fine). No unprompted info-dumps.',
    "",
  ];
}

/**
 * Data integrity applies in every mode (a sub-agent's made-up quote is as
 * bad as the main agent's); the research rules only when a web tool exists
 * and the prompt is the full one.
 */
export function buildFactsAndSourcesSection(params: {
  isMinimal: boolean;
  availableTools: Set<string>;
}): string[] {
  const lines = [
    "## Facts and Sources",
    "- Never state what a file, PDF, web page or command output says unless you read it in this conversation; extract numbers with a tool, never estimate them. Keep what you verified apart from what you remember, and say which when it matters.",
  ];
  const hasWeb =
    params.availableTools.has("web_search") ||
    params.availableTools.has("web_fetch") ||
    params.availableTools.has("browser");
  if (!params.isMinimal && hasWeb) {
    lines.push(
      '- Research: search first, fetch only when snippets are not enough, browser only for interaction. Cross-check important claims with a second source. Check dates and say how old information is; search "latest" relative to today. Cite sources with links.',
    );
  }
  lines.push("");
  return lines;
}
