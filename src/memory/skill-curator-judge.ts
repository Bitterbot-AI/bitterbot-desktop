/**
 * LLM-judge pass for the procedural-memory curator.
 *
 * Phase 1c of PLAN-15. Heuristic classification flags a skill as borderline
 * when error-rate is high but the row is otherwise active; the judge reads
 * the actual SKILL.md text and decides whether to:
 *
 *   - `keep`         leave the skill alone (the failures are situational).
 *   - `archive`      stop offering this skill to the agent.
 *   - `consolidate`  archive the skill in favour of another existing skill
 *                    whose responsibilities subsume it.
 *   - `patch`        rewrite the description / frontmatter (no body edits at
 *                    this layer — body rewrites land in Phase 2b's
 *                    skill_manage tool with staging + gate).
 *
 * Hard rule (mirrors Hermes' curator prompt): **the judge cannot delete.**
 * Archival is recoverable; deletion is not. The behavioural gate in Phase
 * 2c is the only path that can remove a SKILL.md from disk.
 */

import fs from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import type { TransitionProposal } from "./skill-curator-heuristics.js";
import type { SkillLifecycleRow } from "./skill-lifecycle.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("memory/skill-curator-judge");

export type JudgeDecision =
  | { action: "keep"; reason: string }
  | { action: "archive"; reason: string }
  | { action: "consolidate"; into: string; reason: string }
  | { action: "patch"; newDescription: string; reason: string };

export interface JudgeInput {
  /** The borderline proposal from the heuristic pass. */
  borderline: TransitionProposal;
  /** Current lifecycle row, for usage/error metrics in the prompt. */
  lifecycle: SkillLifecycleRow;
  /** SKILL.md file contents, including frontmatter. */
  skillMarkdown: string;
  /** Concise per-skill summaries of other active skills for consolidate decisions. */
  peerSkills: ReadonlyArray<{ name: string; description: string }>;
}

export type LlmCall = (prompt: string) => Promise<string>;

const MAX_SKILL_BODY_PROMPT = 4_000;
const MAX_PEER_LIST = 30;

/**
 * Build the prompt sent to the auxiliary model. Deliberately concise — the
 * judge has one decision per call, no chain-of-thought required.
 */
export function buildJudgePrompt(input: JudgeInput): string {
  const successRate =
    input.lifecycle.usageCount > 0 ? input.lifecycle.successCount / input.lifecycle.usageCount : 0;
  const peerList = input.peerSkills
    .slice(0, MAX_PEER_LIST)
    .map((p) => `- ${p.name}: ${p.description.slice(0, 200)}`)
    .join("\n");
  const bodySnippet =
    input.skillMarkdown.length > MAX_SKILL_BODY_PROMPT
      ? `${input.skillMarkdown.slice(0, MAX_SKILL_BODY_PROMPT)}\n[…truncated…]`
      : input.skillMarkdown;

  return `You are the curator deciding what to do with an under-performing agent-authored skill. Be conservative. Archive only when the skill is clearly broken, redundant, or misleading. Never delete — archival is reversible.

## Skill telemetry
- Name: ${input.borderline.skillName}
- Lifecycle state: ${input.lifecycle.state}
- Total runs: ${input.lifecycle.usageCount}
- Success rate: ${(successRate * 100).toFixed(1)}%
- Errors: ${input.lifecycle.errorCount}
- Heuristic flag reason: ${input.borderline.reason}

## Current SKILL.md
\`\`\`md
${bodySnippet}
\`\`\`

## Sibling skills (potential consolidation targets)
${peerList || "(no other active skills)"}

## Decision
Return ONE of these YAML decisions in a fenced \`\`\`yaml ... \`\`\` block, nothing else:

\`\`\`yaml
# Option A: leave the skill alone (failures look situational, not the skill's fault).
action: keep
reason: "<= 30 words >"
\`\`\`

\`\`\`yaml
# Option B: archive the skill (clearly broken or no longer useful).
action: archive
reason: "<= 30 words >"
\`\`\`

\`\`\`yaml
# Option C: archive in favour of another existing skill that already covers it.
action: consolidate
into: "<exact peer skill name from the list>"
reason: "<= 30 words >"
\`\`\`

\`\`\`yaml
# Option D: rewrite the SKILL.md description field (frontmatter only — no body edits).
action: patch
new_description: "<the new description text, <= 200 chars >"
reason: "<= 30 words >"
\`\`\`
`;
}

const YAML_FENCE_RE = /```yaml\s*\n([\s\S]*?)```/i;
const ANY_FENCE_RE = /```(?:[\w-]+)?\s*\n([\s\S]*?)```/i;

interface RawJudgeYaml {
  action?: unknown;
  reason?: unknown;
  into?: unknown;
  new_description?: unknown;
}

/**
 * Parse the model's response. Tolerant: accepts plain YAML, ``` fences, or
 * ```yaml fences. Returns null when the output is unparseable or contains
 * an action the judge is not allowed to take (e.g. "delete").
 */
export function parseJudgeResponse(raw: string): JudgeDecision | null {
  const yamlBlock = raw.match(YAML_FENCE_RE)?.[1] ?? raw.match(ANY_FENCE_RE)?.[1] ?? raw;
  let parsed: RawJudgeYaml;
  try {
    parsed = YAML.parse(yamlBlock) as RawJudgeYaml;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") {
    return null;
  }
  const action = typeof parsed.action === "string" ? parsed.action.trim() : "";
  const reason = typeof parsed.reason === "string" ? parsed.reason.trim() : "(no reason)";
  switch (action) {
    case "keep":
      return { action: "keep", reason };
    case "archive":
      return { action: "archive", reason };
    case "consolidate": {
      const into = typeof parsed.into === "string" ? parsed.into.trim() : "";
      if (!into) {
        return null;
      }
      return { action: "consolidate", into, reason };
    }
    case "patch": {
      const newDescription =
        typeof parsed.new_description === "string" ? parsed.new_description.trim() : "";
      if (!newDescription) {
        return null;
      }
      return { action: "patch", newDescription, reason };
    }
    default:
      return null;
  }
}

export interface JudgeSkillResult {
  skillName: string;
  decision: JudgeDecision | null;
  /** Raw model output (truncated) on parse failure, for the REPORT.md trail. */
  rawOnFailure?: string;
}

/**
 * Call the LLM judge for one borderline. Pure wrapper around prompt-build +
 * llmCall + parse; no I/O of its own besides the LLM round-trip.
 */
export async function judgeBorderline(
  input: JudgeInput,
  llmCall: LlmCall,
): Promise<JudgeSkillResult> {
  const prompt = buildJudgePrompt(input);
  let raw = "";
  try {
    raw = await llmCall(prompt);
  } catch (err) {
    log.warn(`judge llm call failed for ${input.borderline.skillName}: ${String(err)}`);
    return { skillName: input.borderline.skillName, decision: null };
  }
  const decision = parseJudgeResponse(raw);
  if (!decision) {
    return {
      skillName: input.borderline.skillName,
      decision: null,
      rawOnFailure: raw.slice(0, 400),
    };
  }
  return { skillName: input.borderline.skillName, decision };
}

// ── SKILL.md filesystem helpers ──────────────────────────────────────────

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;

interface ParsedSkill {
  frontmatter: Record<string, unknown>;
  body: string;
}

export function parseSkillMarkdown(text: string): ParsedSkill | null {
  const match = text.match(FRONTMATTER_RE);
  if (!match) {
    return null;
  }
  try {
    const fm = (YAML.parse(match[1] ?? "") ?? {}) as Record<string, unknown>;
    return { frontmatter: fm, body: match[2] ?? "" };
  } catch {
    return null;
  }
}

export function stringifySkillMarkdown(parsed: ParsedSkill): string {
  const fmText = YAML.stringify(parsed.frontmatter).trimEnd();
  return `---\n${fmText}\n---\n${parsed.body.startsWith("\n") ? parsed.body.slice(1) : parsed.body}`;
}

/**
 * Read a SKILL.md from a candidate set of root directories. Returns the
 * first match. Used by the judge driver to load skill content for the
 * prompt.
 */
export async function readSkillMarkdownFromRoots(params: {
  skillName: string;
  roots: ReadonlyArray<string>;
}): Promise<{ filePath: string; content: string } | null> {
  for (const root of params.roots) {
    const candidate = path.join(root, params.skillName, "SKILL.md");
    try {
      const content = await fs.readFile(candidate, "utf-8");
      return { filePath: candidate, content };
    } catch {
      // try next root
    }
  }
  return null;
}

/**
 * Apply a `patch` decision: rewrite the `description` field in the
 * frontmatter, preserving all other frontmatter keys and the body. Atomic
 * via temp-file rename. Returns true on success.
 */
export async function applyPatchDecision(params: {
  filePath: string;
  newDescription: string;
}): Promise<boolean> {
  let original: string;
  try {
    original = await fs.readFile(params.filePath, "utf-8");
  } catch {
    return false;
  }
  const parsed = parseSkillMarkdown(original);
  if (!parsed) {
    return false;
  }
  parsed.frontmatter.description = params.newDescription;
  const next = stringifySkillMarkdown(parsed);
  const tmp = `${params.filePath}.tmp-${process.pid}`;
  try {
    await fs.writeFile(tmp, next, "utf-8");
    await fs.rename(tmp, params.filePath);
    return true;
  } catch (err) {
    log.warn(`patch write failed for ${params.filePath}: ${String(err)}`);
    try {
      await fs.unlink(tmp);
    } catch {
      // ignore
    }
    return false;
  }
}
