/**
 * Skills index in the system prompt: name + one short line per skill, with
 * the whole index capped at ~1k tokens. Bodies (SKILL.md) stay on demand via
 * the read tool. The `<available_skills>` XML shape is preserved because the
 * canary registry, the system-prompt report and the skill-evolution
 * validators all parse `<skill><name>...</name>...</skill>` blocks.
 */

/** ~1k tokens at ~4 chars/token. */
export const SKILLS_PROMPT_BUDGET_CHARS = 4_000;
const DESCRIPTION_STEPS = [160, 80, 40];

const SKILL_BLOCK_RE =
  /^([ \t]*)<skill>\n[ \t]*<name>([^<\n]*)<\/name>\n(?:[ \t]*<description>([\s\S]*?)<\/description>\n)?(?:[ \t]*<location>([^<\n]*)<\/location>\n)?[ \t]*<\/skill>/gm;

function unescapeXml(text: string): string {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** First sentence, whitespace-collapsed, cut at a word boundary under `maxChars`. */
export function summarizeSkillLine(description: string, maxChars: number): string {
  const collapsed = description.replace(/\s+/g, " ").trim();
  if (!collapsed) {
    return "";
  }
  const sentenceEnd = collapsed.search(/[.!?](\s|$)/);
  const sentence = sentenceEnd === -1 ? collapsed : collapsed.slice(0, sentenceEnd + 1);
  if (sentence.length <= maxChars) {
    return sentence;
  }
  const cut = sentence.slice(0, maxChars);
  const lastSpace = cut.lastIndexOf(" ");
  const head = lastSpace > maxChars * 0.5 ? cut.slice(0, lastSpace) : cut;
  return `${head.replace(/[\s,;:]+$/g, "")}…`;
}

function renderCompact(prompt: string, maxDescriptionChars: number | null): string {
  return prompt.replace(
    SKILL_BLOCK_RE,
    (_block, indent: string, name: string, description: string | undefined, location) => {
      const inner = `${indent}  `;
      const lines = [`${indent}<skill>`, `${inner}<name>${name}</name>`];
      if (maxDescriptionChars !== null && description) {
        const line = summarizeSkillLine(unescapeXml(description), maxDescriptionChars);
        if (line) {
          lines.push(`${inner}<description>${escapeXml(line)}</description>`);
        }
      }
      if (typeof location === "string" && location.length > 0) {
        lines.push(`${inner}<location>${location}</location>`);
      }
      lines.push(`${indent}</skill>`);
      return lines.join("\n");
    },
  );
}

/**
 * Compact the skills prompt: every description becomes one line, and the
 * description length steps down (160 -> 80 -> 40 chars, then names +
 * locations only) until the whole prompt fits the budget. Skills are never
 * dropped: the index is the routing key and a missing entry is worse than a
 * terse one.
 */
export function compactSkillsPrompt(
  prompt: string,
  budgetChars: number = SKILLS_PROMPT_BUDGET_CHARS,
): string {
  if (!prompt.includes("<skill>")) {
    return prompt;
  }
  let candidate = renderCompact(prompt, DESCRIPTION_STEPS[0] ?? 160);
  for (const step of DESCRIPTION_STEPS.slice(1)) {
    if (candidate.length <= budgetChars) {
      return candidate;
    }
    candidate = renderCompact(prompt, step);
  }
  if (candidate.length <= budgetChars) {
    return candidate;
  }
  return renderCompact(prompt, null);
}

export function buildSkillsSection(params: {
  skillsPrompt?: string;
  isMinimal: boolean;
  readToolName: string;
  /** PLAN-44 Phase 2: validation sessions are minimal but must see the skills index. */
  skillsInMinimal?: boolean;
  budgetChars?: number;
}): string[] {
  if (params.isMinimal && !params.skillsInMinimal) {
    return [];
  }
  const trimmed = params.skillsPrompt?.trim();
  if (!trimmed) {
    return [];
  }
  return [
    "## Skills (mandatory)",
    "Before replying: scan <available_skills> <description> entries.",
    `- If exactly one skill clearly applies: read its SKILL.md at <location> with \`${params.readToolName}\`, then follow it.`,
    "- If multiple could apply: choose the most specific one, then read/follow it.",
    "- If none clearly apply: do not read any SKILL.md.",
    "Constraints: never read more than one skill up front; only read after selecting.",
    compactSkillsPrompt(trimmed, params.budgetChars),
    "",
  ];
}
