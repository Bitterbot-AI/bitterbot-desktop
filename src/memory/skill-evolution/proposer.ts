/**
 * PLAN-42 Phase 3: the Skill Proposer — a ReAct agent with EXACTLY the
 * paper's two tools (Appendix E.3): `read_file` over the wiki + this
 * iteration's traces + live skills, and `finish` with one atomic proposal.
 *
 * The loop is implemented directly over the injected LLM call rather than a
 * general embedded agent: the paper's proposer has a two-tool surface, and
 * resolving every read through our own allowlisted resolver makes sandbox
 * escape structurally impossible — there is no filesystem tool to police.
 *
 * Fidelity notes:
 *   - F1: initial context is the wiki index + skill-impact trail + the
 *     iteration's outcome summary; pattern pages and traces are fetched on
 *     demand (never pre-stuffed).
 *   - F4: one atomic proposal — create XOR patch XOR no_action.
 *   - F11: no_action is a valid, expected outcome (also forced at turn cap).
 *   - Anti-vanity: reading a wiki pattern stamps its dream_utility
 *     consumption (set-once), so "producer with no consumer" is measurable.
 *
 * The proposal is STAGED through the SICA gate but NEVER promoted here —
 * promotion belongs to the Phase 4 validation gate (strict F7). Until that
 * gate runs, staged proposals are visible to operators via skills.promote.
 */

import type { DatabaseSync } from "node:sqlite";
import fs from "node:fs/promises";
import path from "node:path";
import type { EventJournal } from "../../infra/event-journal.js";
import type { LlmCallFn } from "./maintainer.js";
import type { LabeledTrace } from "./types.js";
import { impactTrailPath, type ImpactTrailOptions } from "../../agents/skills/impact-trail.js";
import { liveSkillDir, readLive, resolveStorageRoots } from "../../agents/skills/skill-storage.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { markDreamConsumption } from "../dream-utility.js";
import { extractJsonObjectLenient } from "./json-extract.js";
import {
  isValidPatternName,
  logsPath,
  normalizePatternName,
  readIndex,
  readPattern,
  type WikiPatchOp,
} from "./wiki-store.js";

const log = createSubsystemLogger("skill-evolution/proposer");

export const DEFAULT_MAX_PROPOSER_TURNS = 24;
const READ_RESULT_MAX_CHARS = 8_000;
const TRANSCRIPT_BUDGET_CHARS = 120_000;
const IMPACT_TAIL_CHARS = 6_000;

export type SkillProposal =
  | { action: "no_action"; reason?: string }
  | { action: "create"; name: string; skillMd: string; purposeMd: string }
  | { action: "patch"; name: string; edits: WikiPatchOp[]; purposeNote?: string };

export interface ProposerRunResult {
  proposal: SkillProposal;
  turns: number;
  reads: string[];
  /** True when no_action was forced (turn cap / repeated protocol errors). */
  forced: boolean;
}

const PROPOSER_RULES = `You are a Skill Proposer Agent for an LLM agent platform.
Your job is to explore the wiki knowledge base and execution traces, diagnose root
causes of failures, and propose ONE skill change (create, patch, or no_action).

## Tools Available
You have two tools. Respond with EXACTLY one JSON object per turn, nothing else:
1. {"tool": "read_file", "path": "<path>"} -- read a wiki file, trace, or live skill.
   Allowed paths:
   - "index.md" (wiki pattern catalog)
   - "logs.md" (wiki evolution log)
   - "skill-impact.md" (history of every prior proposal and its verdict)
   - "patterns/<pattern-name>.md" (full pattern page)
   - "traces/<run_id>" (an execution trace from this iteration)
   - "skills/<skill-name>/SKILL.md" (a live skill's current content)
2. {"tool": "finish", "proposal": {...}} -- submit your final proposal.

## Workflow
1. Start by reading "index.md" to understand what patterns exist.
2. Read "skill-impact.md" to see what was tried before -- do NOT repeat rejected approaches.
3. Read specific pattern pages that seem relevant to the current failures.
4. You MUST read at least 4 execution traces via "traces/<run_id>" before proposing a skill change.
5. Decide: create (new skill), patch (edit existing skill), or no_action.
6. Call finish with the full proposal.

## finish() Proposal Format
For creating a new skill:
{"action": "create", "name": "<snake-or-kebab-case>",
 "skill_md": "<full SKILL.md content with YAML frontmatter (name matching the skill name, description saying WHAT it does and WHEN to apply it), a 'When to Apply' section, a 'When NOT to Apply' section, and concrete instructions>",
 "purpose_md": "<full PURPOSE.md content with sections: Origin, Patterns Addressed (link the wiki patterns that motivated this), Evolution History>"}

For patching an existing skill:
{"action": "patch", "name": "<existing skill name>",
 "edits": [{"op": "append", "content": "..."} | {"op": "replace", "target": "<exact text>", "content": "..."} | {"op": "insert_after", "target": "<exact text>", "content": "..."}],
 "purpose_note": "<one paragraph: what changed and which wiki patterns motivated it>"}

If no change is warranted: {"action": "no_action", "reason": "<why>"}

## Rules
1. Read the wiki FIRST -- don't propose something that was already tried and rejected.
2. Focus on action patterns and concrete strategies, not vague advice.
3. Keep skills concise and actionable; the description field is the triggering surface.
4. Prefer patching existing skills over creating new ones when the existing skill is partially correct.
5. Each "replace" target must be a short, specific section -- not the entire file.
6. no_action is a perfectly good outcome when the evidence is thin.`;

function extractJsonObject(raw: string): Record<string, unknown> | null {
  return extractJsonObjectLenient(raw);
}

function capRead(text: string): string {
  if (text.length <= READ_RESULT_MAX_CHARS) {
    return text;
  }
  return `${text.slice(0, READ_RESULT_MAX_CHARS)}\n... [truncated ${text.length - READ_RESULT_MAX_CHARS} chars]`;
}

const SKILL_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

function parseProposal(value: unknown): { proposal: SkillProposal | null; detail?: string } {
  if (typeof value !== "object" || value === null) {
    return { proposal: null, detail: "proposal is not an object" };
  }
  const p = value as Record<string, unknown>;
  if (p.action === "no_action") {
    return {
      proposal: {
        action: "no_action",
        ...(typeof p.reason === "string" ? { reason: p.reason } : {}),
      },
    };
  }
  const name = typeof p.name === "string" ? p.name.trim() : "";
  if (!SKILL_NAME_RE.test(name) || name.includes("..")) {
    return { proposal: null, detail: `invalid skill name "${name}"` };
  }
  if (p.action === "create") {
    const skillMd = typeof p.skill_md === "string" ? p.skill_md : "";
    const purposeMd = typeof p.purpose_md === "string" ? p.purpose_md : "";
    if (!skillMd.startsWith("---")) {
      return { proposal: null, detail: "skill_md must start with YAML frontmatter" };
    }
    if (!purposeMd.trim()) {
      return { proposal: null, detail: "purpose_md is required for create" };
    }
    return { proposal: { action: "create", name, skillMd, purposeMd } };
  }
  if (p.action === "patch") {
    const editsRaw = Array.isArray(p.edits) ? p.edits : [];
    const edits: WikiPatchOp[] = [];
    for (const editRaw of editsRaw) {
      const edit = editRaw as Record<string, unknown>;
      const content = typeof edit?.content === "string" ? edit.content : "";
      const target = typeof edit?.target === "string" ? edit.target : "";
      if (edit?.op === "append" && content) {
        edits.push({ op: "append", content });
      } else if ((edit?.op === "replace" || edit?.op === "insert_after") && content && target) {
        edits.push({ op: edit.op, target, content });
      }
    }
    if (edits.length === 0) {
      return { proposal: null, detail: "patch has no valid edits" };
    }
    return {
      proposal: {
        action: "patch",
        name,
        edits,
        ...(typeof p.purpose_note === "string" ? { purposeNote: p.purpose_note } : {}),
      },
    };
  }
  return { proposal: null, detail: `unknown action "${String(p.action)}"` };
}

export interface ProposerDeps {
  llmCall: LlmCallFn;
  samples: LabeledTrace[];
  storeOpts?: ImpactTrailOptions;
  maxTurns?: number;
  /** For pattern-consumption stamping (optional in tests). */
  db?: DatabaseSync;
  /** Unused today; reserved so trace reads can widen beyond the sample set. */
  journal?: EventJournal | null;
}

async function readAllowedPath(
  rawPath: string,
  deps: ProposerDeps,
): Promise<{ content: string; patternRead?: string }> {
  const p = rawPath.trim().replace(/^\.?\//, "");
  if (p.includes("..") || p.includes("\\")) {
    return { content: "ERROR: path not allowed." };
  }
  const storeOpts = deps.storeOpts ?? {};
  if (p === "index.md") {
    return { content: (await readIndex(storeOpts)) || "(empty index — no patterns yet)" };
  }
  if (p === "logs.md") {
    try {
      const logs = await fs.readFile(logsPath(storeOpts), "utf-8");
      return { content: capRead(logs.slice(-READ_RESULT_MAX_CHARS)) };
    } catch {
      return { content: "(empty log)" };
    }
  }
  if (p === "skill-impact.md") {
    try {
      const impact = await fs.readFile(impactTrailPath(storeOpts), "utf-8");
      return { content: capRead(impact.slice(-IMPACT_TAIL_CHARS)) };
    } catch {
      return { content: "(no prior proposals recorded)" };
    }
  }
  const patternMatch = p.match(/^patterns\/(.+?)(?:\.md)?$/);
  if (patternMatch) {
    const name = normalizePatternName(patternMatch[1] as string);
    if (!isValidPatternName(name)) {
      return { content: "ERROR: invalid pattern name." };
    }
    const content = await readPattern(name, storeOpts);
    return content === null
      ? { content: `ERROR: pattern "${name}" does not exist. Check index.md.` }
      : { content: capRead(content), patternRead: name };
  }
  const traceMatch = p.match(/^traces\/(.+)$/);
  if (traceMatch) {
    const runId = traceMatch[1] as string;
    const sample = deps.samples.find((s) => s.trace.runId === runId);
    return sample
      ? { content: capRead(sample.formattedLog) }
      : { content: `ERROR: trace "${runId}" is not part of this iteration.` };
  }
  const skillMatch = p.match(/^skills\/([^/]+)\/(SKILL|PURPOSE)\.md$/);
  if (skillMatch) {
    const name = skillMatch[1] as string;
    if (!SKILL_NAME_RE.test(name)) {
      return { content: "ERROR: invalid skill name." };
    }
    const roots = resolveStorageRoots(
      storeOpts.configDir ? { configDir: storeOpts.configDir } : {},
    );
    if (skillMatch[2] === "SKILL") {
      const content = await readLive(roots, name);
      return content === null
        ? { content: `ERROR: no live skill named "${name}".` }
        : { content: capRead(content) };
    }
    try {
      const content = await fs.readFile(
        path.join(liveSkillDir(roots, name), "PURPOSE.md"),
        "utf-8",
      );
      return { content: capRead(content) };
    } catch {
      return { content: `ERROR: no PURPOSE.md for "${name}".` };
    }
  }
  return {
    content:
      "ERROR: path not allowed. Allowed: index.md, logs.md, skill-impact.md, patterns/<name>.md, traces/<run_id>, skills/<name>/SKILL.md",
  };
}

async function listLiveSkillNames(deps: ProposerDeps): Promise<string[]> {
  const roots = resolveStorageRoots(
    deps.storeOpts?.configDir ? { configDir: deps.storeOpts.configDir } : {},
  );
  try {
    const entries = await fs.readdir(roots.liveRoot);
    return entries.filter((e) => SKILL_NAME_RE.test(e)).toSorted();
  } catch {
    return [];
  }
}

/** Run the ReAct loop. Returns a proposal (no_action when forced). */
export async function runSkillProposer(deps: ProposerDeps): Promise<ProposerRunResult> {
  const maxTurns = deps.maxTurns ?? DEFAULT_MAX_PROPOSER_TURNS;
  const outcomeSummary = deps.samples
    .map(
      (s) =>
        `- traces/${s.trace.runId}: ${s.label.label.toUpperCase()} (${s.label.reason}; ${s.trace.toolCallCount} tool calls, ${s.trace.toolErrorCount} errors)`,
    )
    .join("\n");
  const liveSkills = await listLiveSkillNames(deps);
  const transcript: string[] = [
    PROPOSER_RULES,
    "",
    "## This Iteration's Task Outcomes",
    outcomeSummary || "(no traces this iteration)",
    "",
    "## Live Skills On This Node",
    liveSkills.length > 0 ? liveSkills.map((n) => `- ${n}`).join("\n") : "(none)",
    "",
    "Begin. Respond with exactly one JSON tool call.",
  ];
  const reads: string[] = [];
  let protocolErrors = 0;

  for (let turn = 1; turn <= maxTurns; turn++) {
    // Bound the growing transcript: elide the oldest observations first.
    let joined = transcript.join("\n");
    if (joined.length > TRANSCRIPT_BUDGET_CHARS) {
      for (let i = 9; i < transcript.length - 8 && joined.length > TRANSCRIPT_BUDGET_CHARS; i++) {
        const entry = transcript[i] as string;
        if (entry.startsWith("OBSERVATION")) {
          transcript[i] = "OBSERVATION: [elided for space — re-read the file if needed]";
          joined = transcript.join("\n");
        }
      }
    }
    const raw = await deps.llmCall(joined);
    const call = extractJsonObject(raw);
    if (!call) {
      protocolErrors += 1;
      // Live finding 2026-09-02: three unparseable replies force no_action
      // with no trace of WHAT the model said. Keep a sample in the log so
      // format drift is diagnosable.
      log.info(
        `proposer protocol error ${protocolErrors}/3 on turn ${turn}: ${raw.replace(/\s+/g, " ").slice(0, 300)}`,
      );
      if (protocolErrors >= 3) {
        return {
          proposal: { action: "no_action", reason: "proposer protocol errors" },
          turns: turn,
          reads,
          forced: true,
        };
      }
      transcript.push(
        `ASSISTANT: ${raw.slice(0, 400)}`,
        "OBSERVATION: ERROR — respond with exactly one JSON object: a read_file or finish tool call.",
      );
      continue;
    }
    if (call.tool === "read_file" && typeof call.path === "string") {
      const { content, patternRead } = await readAllowedPath(call.path, deps);
      reads.push(call.path);
      if (patternRead && deps.db) {
        markDreamConsumption(deps.db, `wiki-pattern:${patternRead}`, "referenced");
      }
      transcript.push(
        `ASSISTANT: {"tool":"read_file","path":${JSON.stringify(call.path)}}`,
        `OBSERVATION (${call.path}):\n${content}`,
      );
      continue;
    }
    if (call.tool === "finish") {
      const { proposal, detail } = parseProposal(call.proposal);
      if (!proposal) {
        protocolErrors += 1;
        if (protocolErrors >= 3) {
          return {
            proposal: { action: "no_action", reason: `malformed proposal: ${detail}` },
            turns: turn,
            reads,
            forced: true,
          };
        }
        transcript.push(
          `ASSISTANT: {"tool":"finish",...}`,
          `OBSERVATION: ERROR — malformed proposal (${detail}). Fix it and call finish again.`,
        );
        continue;
      }
      return { proposal, turns: turn, reads, forced: false };
    }
    protocolErrors += 1;
    transcript.push(
      `ASSISTANT: ${JSON.stringify(call).slice(0, 300)}`,
      'OBSERVATION: ERROR — unknown tool. Use "read_file" or "finish".',
    );
    if (protocolErrors >= 3) {
      break;
    }
  }
  return {
    proposal: { action: "no_action", reason: "turn cap reached without a proposal" },
    turns: maxTurns,
    reads,
    forced: true,
  };
}
