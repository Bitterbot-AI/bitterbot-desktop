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

/**
 * A trigger CLAUSE, not a keyword (adversarial H2: "if you like it" and
 * "when needed" satisfied a bare `when|if` check): either "use/apply/open
 * … when" or "when(ever) the/a/you/…", i.e. `when` followed by a subject.
 */
const TRIGGER_RE =
  /\b(?:use|apply|open|read|load|trigger(?:s|ed)?|fire(?:s)?)\b[^.;]{0,80}\bwhen(?:ever)?\b|\bwhen(?:ever)?\s+(?:the|a|an|you|your|asked|running|handling|debugging|working|tasks?|users?|someone)\b/i;
/** A scope-out CLAUSE: what the skill is not for. Bare `not`/`only` no longer count. */
const SCOPE_OUT_RE =
  /\b(?:not\s+(?:for|when|on|while|if)|never\s+(?:for|when|on)|unless|except\s+(?:when|for|on)|only\s+(?:when|if|for|on)|do(?:es)?\s+not\s+(?:use|apply|fire)|don't\s+(?:use|apply))\b/i;
/** Phrases that satisfy the shape while saying nothing about routing. */
const VACUOUS_RE =
  /\b(?:when\s+(?:needed|required|necessary|appropriate|relevant|asked|applicable)|if\s+you\s+(?:like|want|wish)|not\s+(?:for\s+)?otherwise|not\s+for\s+(?:nothing|anything\s+else)|when\s+the\s+user\s+asks\s+(?:anything|for\s+anything))\b/i;
/** URLs, emoji and maintainer chatter mark a copied tagline, not a trigger. */
const NOISE_RE = /https?:\/\/|\[NOTE\b|(?![©®™])\p{Extended_Pictographic}/u;

export type DescriptionContractIssue =
  | "name-mismatch"
  | "too-short"
  | "too-long"
  | "no-trigger-clause"
  | "no-scope-out-clause"
  | "noise"
  | "vacuous"
  | "variant-suffix";

/** The rule text handed to every author (proposer prompt, crystallize tool). */
export const DESCRIPTION_CONTRACT_PROMPT = [
  `Description contract (enforced by the gate; ${DESCRIPTION_MIN_CHARS}-${DESCRIPTION_MAX_CHARS} characters):`,
  "- Name the SITUATION that should trigger the skill with a 'when' clause (what the task looks like, which tool or error is involved).",
  "- Name what it is NOT for with 'not for', 'never for', 'unless', 'except when' or 'only when', so a similar-looking task does not fire it. 'When needed' or 'not otherwise' say nothing and are refused.",
  "- Describe the situation class in your own words; never copy task wording, repo taglines, URLs or emoji.",
  "- The frontmatter name must equal the skill name; do not suffix variants with -alt.",
].join("\n");

export function checkDescriptionContract(params: {
  skillName: string;
  frontmatterName: string | undefined;
  description: string | undefined;
  /**
   * For a patch over an existing skill: the live file's own frontmatter
   * name. Harvested skills carry `owner/repo` in a dir named `owner-repo`
   * and some end in `-alt`; a patch must not be blocked for identity it
   * did not choose (adversarial H3). Creates get no such allowance.
   */
  liveFrontmatterName?: string | null;
}): DescriptionContractIssue[] {
  const issues: DescriptionContractIssue[] = [];
  const description = (params.description ?? "").trim();
  const fmName = (params.frontmatterName ?? "").trim();
  const live = (params.liveFrontmatterName ?? "").trim();
  const isPatch = live.length > 0;
  if (fmName !== params.skillName && !(isPatch && fmName === live)) {
    issues.push("name-mismatch");
  }
  if (params.skillName.endsWith("-alt") && !isPatch) {
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
  if (VACUOUS_RE.test(description)) {
    issues.push("vacuous");
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
    vacuous:
      "description's trigger or scope-out says nothing ('when needed', 'if you like', 'not otherwise')",
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
  const single = description.replace(/\s+/g, " ").trim();
  const value = /[:#"'\n]/.test(single) ? JSON.stringify(single) : single;
  const m = skillMd.match(/^---\n([\s\S]*?)\n---/);
  if (!m) {
    return skillMd;
  }
  const front = m[1] as string;
  const lines = front.split("\n");
  const idx = lines.findIndex((l) => /^description\s*:/.test(l));
  if (idx >= 0) {
    let end = idx + 1;
    while (end < lines.length && /^\s+\S/.test(lines[end] as string)) {
      end += 1; // continuation lines of a block/folded/multi-line scalar (adversarial M5)
    }
    lines.splice(idx, end - idx, `description: ${value}`);
  } else {
    lines.push(`description: ${value}`);
  }
  return skillMd.replace(m[0], `---\n${lines.join("\n")}\n---`);
}
