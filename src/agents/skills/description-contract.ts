/**
 * PLAN-44 Phase 4a: the DESCRIPTION CONTRACT for synthesized skills.
 *
 * The runtime shows the agent an index of `<name>` + `<description>` and a
 * rule ("read the file when exactly one description clearly applies"), so
 * the description is the entire routing key. WikiSkill makes the same
 * point: the description is what triggers a skill, the body is what it
 * does once triggered. Free text with no contract produced descriptions
 * that describe a source ("A collective list of free APIs") rather than a
 * situation, and the evolution proposer had no rule to write against.
 *
 * The contract is enforced by the staging gate for SYNTHESIZED content
 * (evolution proposals, crystallized sequences) and used verbatim in the
 * prompts that author them. Human-edited skills are not held to it.
 */

import { parseSkillMarkdown } from "../../memory/skill-curator-judge.js";

export const DESCRIPTION_MIN_CHARS = 40;
export const DESCRIPTION_MAX_CHARS = 240;

/** "when" / "whenever" / "if" — the situation the skill fires on. */
const TRIGGER_RE = /\b(when|whenever|if)\b/i;
/** A scoping word — what the skill is NOT for. */
const SCOPE_OUT_RE = /\b(not|never|unless|except|only|don't|do not)\b/i;
/** URLs, emoji and maintainer chatter mark a copied tagline, not a trigger. */
const NOISE_RE = /https?:\/\/|\[NOTE\b|\p{Extended_Pictographic}/u;

export type DescriptionContractIssue =
  | "name-mismatch"
  | "too-short"
  | "too-long"
  | "no-trigger-clause"
  | "no-scope-out-clause"
  | "noise"
  | "variant-suffix";

/** The rule text handed to every author (proposer prompt, crystallize tool). */
export const DESCRIPTION_CONTRACT_PROMPT = [
  `Description contract (enforced by the gate; ${DESCRIPTION_MIN_CHARS}-${DESCRIPTION_MAX_CHARS} characters):`,
  "- Name the SITUATION that should trigger the skill with a 'when' clause (what the task looks like, which tool or error is involved).",
  "- Name what it is NOT for with 'not', 'never', 'unless', 'except' or 'only', so a similar-looking task does not fire it.",
  "- Describe the situation class in your own words; never copy task wording, repo taglines, URLs or emoji.",
  "- The frontmatter name must equal the skill name; do not suffix variants with -alt.",
].join("\n");

export function checkDescriptionContract(params: {
  skillName: string;
  frontmatterName: string | undefined;
  description: string | undefined;
}): DescriptionContractIssue[] {
  const issues: DescriptionContractIssue[] = [];
  const description = (params.description ?? "").trim();
  if ((params.frontmatterName ?? "").trim() !== params.skillName) {
    issues.push("name-mismatch");
  }
  if (params.skillName.endsWith("-alt")) {
    issues.push("variant-suffix");
  }
  if (description.length < DESCRIPTION_MIN_CHARS) {
    issues.push("too-short");
  }
  if (description.length > DESCRIPTION_MAX_CHARS) {
    issues.push("too-long");
  }
  if (!TRIGGER_RE.test(description)) {
    issues.push("no-trigger-clause");
  }
  if (!SCOPE_OUT_RE.test(description)) {
    issues.push("no-scope-out-clause");
  }
  if (NOISE_RE.test(description)) {
    issues.push("noise");
  }
  return issues;
}

/** Convenience over a whole SKILL.md. Unparseable content yields every structural issue. */
export function checkSkillDescriptionContract(
  skillName: string,
  skillMd: string,
): DescriptionContractIssue[] {
  const parsed = parseSkillMarkdown(skillMd);
  const fm = (parsed?.frontmatter ?? {}) as Record<string, unknown>;
  return checkDescriptionContract({
    skillName,
    frontmatterName: typeof fm.name === "string" ? fm.name : undefined,
    description: typeof fm.description === "string" ? fm.description : undefined,
  });
}

export function describeContractIssues(issues: DescriptionContractIssue[]): string {
  const text: Record<DescriptionContractIssue, string> = {
    "name-mismatch": "frontmatter name must equal the skill name",
    "too-short": `description shorter than ${DESCRIPTION_MIN_CHARS} chars`,
    "too-long": `description longer than ${DESCRIPTION_MAX_CHARS} chars`,
    "no-trigger-clause": "description has no 'when' clause naming the triggering situation",
    "no-scope-out-clause":
      "description has no 'not/never/unless/except/only' clause scoping it out",
    noise: "description carries a URL, emoji or copied maintainer note",
    "variant-suffix": "skill name ends in -alt (indistinguishable variant)",
  };
  return issues.map((i) => text[i]).join("; ");
}

/**
 * Replace (or insert) the `description:` line of a SKILL.md's frontmatter.
 * Used by the repair loop; the value is JSON-quoted when YAML would
 * otherwise misread it.
 */
export function rewriteDescriptionLine(skillMd: string, description: string): string {
  const value = /[:#"'\n]/.test(description) ? JSON.stringify(description) : description;
  const m = skillMd.match(/^---\n([\s\S]*?)\n---/);
  if (!m) {
    return skillMd;
  }
  const front = m[1] as string;
  const lines = front.split("\n");
  const idx = lines.findIndex((l) => /^description\s*:/.test(l));
  if (idx >= 0) {
    lines[idx] = `description: ${value}`;
  } else {
    lines.push(`description: ${value}`);
  }
  return skillMd.replace(m[0], `---\n${lines.join("\n")}\n---`);
}
