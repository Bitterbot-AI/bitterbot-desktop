/**
 * PLAN-42 Phase 2: the Wiki Maintainer — one LLM call per evolution
 * iteration that consolidates sampled traces into the persistent wiki.
 *
 * Prompt structure follows the paper's Appendix E.2 (JSON incremental-edit
 * mode: create_patterns / update_patterns / update_index / append_log, the
 * last two REQUIRED), with the pattern-documentation and index-quality
 * rules carried verbatim in spirit: pages are 10-30 lines documenting
 * description + root cause + exact command sequences + concrete fix, both
 * failure AND success patterns, update-don't-duplicate; every index entry
 * is "PROBLEM + ROOT CAUSE + FIX in one or two sentences" because the index
 * is the Proposer's entire triggering surface.
 *
 * The output is whitelist-parsed by wiki-store.ts — this module never
 * writes the wiki from free-form model text.
 */

import type { LabeledTrace } from "./types.js";
import {
  type ApplyResult,
  applyMaintainerOutput,
  parseMaintainerOutput,
  readWikiContext,
  type WikiContext,
  type WikiStoreOptions,
} from "./wiki-store.js";

export type LlmCallFn = (prompt: string) => Promise<string>;

const MAINTAINER_RULES = `You are a Wiki Maintainer Agent for an LLM skill evolution system.

Your job is to maintain a structured knowledge base (wiki) that documents patterns
observed during agent execution -- both successes and failures. You must perform DEEP
ANALYSIS of execution logs to identify root causes, not just surface-level symptoms.

## Wiki Structure
- index.md -- Concise catalog of known patterns (one line per pattern)
- logs.md -- Chronological evolution log (iterations, findings)
- patterns/ -- One page per pattern with detailed evidence and analysis

## Your Output (Incremental Edit Mode)
Return a JSON object with these keys:
- "create_patterns": list of {"name": "pattern-name", "content": "..."} -- new patterns (full content)
- "update_patterns": list of {"name": "existing-pattern", "edits": [...]} -- patch existing patterns
- "update_index": full updated content of index.md (always provide the complete index)
- "append_log": brief summary of this iteration's findings and actions

"update_index" and "append_log" are REQUIRED. Always provide them, even if there are no
new patterns. For "update_index", always provide the complete updated index content
including all existing entries plus any new ones.

### Patch Operations (for update_patterns only)
For "update_patterns", each entry uses an "edits" list of patch operations:
- {"op": "append", "content": "text to add at end"}
- {"op": "replace", "target": "exact text to find", "content": "replacement text"}
- {"op": "insert_after", "target": "exact text to find", "content": "text to insert after"}

Rules for patch operations:
1. "target" must be an EXACT substring of the existing content.
2. Use "append" to add new evidence. Use "replace" to fix or refine existing text.
3. Keep each edit minimal -- only change what's needed.
4. For NEW patterns (create_patterns), use full "content".

## Analysis Guidelines

### Deep Trace Analysis (CRITICAL)
When execution logs are provided, you MUST:
1. Read the agent's actual actions -- what commands did it issue?
2. Compare successful vs failed tasks -- what did successful tasks do differently?
3. Identify ACTION PATTERNS and strategies, not just error messages.
4. Check whether the agent followed any active skills, and whether the skill guidance was helpful or not.

### Pattern Documentation Rules
1. Each pattern page should document:
   - What the pattern is (description)
   - Root cause analysis (WHY it happens, not just WHAT happens)
   - Exact command sequences from traces (what the agent did wrong / right)
   - Known solutions or workarounds (concrete action patterns with exact syntax)
2. Capture BOTH success and failure patterns:
   - **Failure patterns**: Document what went wrong and how to avoid it
   - **Success patterns**: Document strategies that consistently lead to task completion
3. Do NOT create duplicate patterns -- update existing ones with new evidence.
4. Be concise. Pattern pages should be 10-30 lines, not essays.
5. Only create patterns for meaningful, generalizable observations.

### Index Description Quality (CRITICAL)
The index.md entries are the MOST IMPORTANT part of the wiki because they determine
whether readers will open the full pattern pages.

Each index entry MUST follow this format:
- [pattern-name](patterns/pattern-name.md): PROBLEM + ROOT CAUSE + FIX in one or two sentences.

The description must be specific enough that a reader can judge relevance without
reading the full page. Include the problem, root cause, AND solution.`;

export function buildMaintainerPrompt(ctx: WikiContext, samples: LabeledTrace[]): string {
  const wikiSection: string[] = ["## Current Wiki", "", "### index.md", ctx.index || "(empty)", ""];
  wikiSection.push("### logs.md (tail)", ctx.logTail || "(empty)", "");
  for (const pattern of ctx.patterns) {
    wikiSection.push(`### patterns/${pattern.name}.md`, pattern.content, "");
  }
  if (ctx.elidedPatternNames.length > 0) {
    wikiSection.push(
      `(Not shown for space, but they EXIST — do not recreate: ${ctx.elidedPatternNames.join(", ")})`,
      "",
    );
  }

  const traceSection: string[] = ["## Execution Traces From The Latest Iteration", ""];
  for (const [i, sample] of samples.entries()) {
    traceSection.push(
      `### Trace ${i + 1} — labeled ${sample.label.label.toUpperCase()} (${sample.label.reason})`,
      "```",
      sample.formattedLog,
      "```",
      "",
    );
  }

  return [
    MAINTAINER_RULES,
    "",
    wikiSection.join("\n"),
    traceSection.join("\n"),
    "Return ONLY the JSON object.",
  ].join("\n");
}

export interface MaintenanceResult {
  /** False when the model output could not be parsed (nothing was written). */
  applied: boolean;
  apply?: ApplyResult;
  parseIssueCount: number;
  promptChars: number;
  /** Head+tail of the raw model output on parse failure (diagnostics). */
  rawSample?: string;
}

/**
 * Run one maintenance step over already-sampled traces: read the wiki, one
 * LLM call, whitelist-parse, apply. The caller owns cursor advancement (only
 * after an applied step) and dream-utility recording.
 */
export async function runWikiMaintenance(deps: {
  samples: LabeledTrace[];
  llmCall: LlmCallFn;
  storeOpts?: WikiStoreOptions & { maxPatterns?: number };
}): Promise<MaintenanceResult> {
  const storeOpts = deps.storeOpts ?? {};
  const ctx = await readWikiContext(storeOpts);
  const prompt = buildMaintainerPrompt(ctx, deps.samples);
  const raw = await deps.llmCall(prompt);
  const { output, issues } = parseMaintainerOutput(raw);
  if (!output) {
    // Keep enough of the raw output to diagnose truncation vs formatting.
    const rawSample =
      raw.length > 700
        ? `${raw.slice(0, 400)} ... [${raw.length} chars] ... ${raw.slice(-200)}`
        : raw;
    return {
      applied: false,
      parseIssueCount: issues.length,
      promptChars: prompt.length,
      rawSample,
    };
  }
  const apply = await applyMaintainerOutput(output, storeOpts);
  return {
    applied: true,
    apply,
    parseIssueCount: issues.length,
    promptChars: prompt.length,
  };
}
