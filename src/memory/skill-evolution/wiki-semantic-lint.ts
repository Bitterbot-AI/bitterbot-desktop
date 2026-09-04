/**
 * PLAN-42: semantic wiki lint (Karpathy's real "lint" operation).
 *
 * The mechanical lint (wiki-lint.ts) archives exact duplicates and over-cap
 * pages. This pass adds what Karpathy actually described: an LLM health
 * check for CONTRADICTIONS between pages and STALE claims superseded by
 * newer evidence, plus semantic (not byte-exact) near-duplicates.
 *
 * Conservative by construction — the wiki is append-durable and only skills
 * are gated, so lint must not destroy knowledge on an LLM's say-so:
 *   - It ARCHIVES (never deletes) only pages the model explicitly marks
 *     superseded or as a redundant near-duplicate, and never more than a
 *     fraction of the wiki in one pass, and never below a floor.
 *   - CONTRADICTIONS are only FLAGGED into logs.md for the next Wiki
 *     Maintainer to reconcile with fresh trace evidence — lint never edits
 *     a page's content itself.
 * Cadence-gated separately from the per-iteration mechanical lint.
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { LlmCallFn } from "./maintainer.js";
import { resolveWikiDir, type ImpactTrailOptions } from "../../agents/skills/impact-trail.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { atomicWriteJson } from "./fs-atomic.js";
import {
  appendWikiLog,
  archivePattern,
  isValidPatternName,
  listPatternNames,
  normalizePatternName,
  readIndex,
  readPattern,
  type WikiStoreOptions,
} from "./wiki-store.js";

const log = createSubsystemLogger("skill-evolution/semantic-lint");

const STATE_FILENAME = ".semantic-lint-state.json";
/** Never archive more than this fraction of the wiki in one pass. */
const MAX_ARCHIVE_FRACTION = 0.25;
/** Never archive below this many live patterns. */
const MIN_PATTERNS_KEPT = 3;
const PATTERN_BUDGET_CHARS = 60_000;

export interface SemanticLintResult {
  ran: boolean;
  reason?: "no-llm" | "too-few-patterns" | "parse-failed";
  archived: string[];
  contradictionsFlagged: number;
  findings: number;
}

interface LintFinding {
  type: "contradiction" | "stale" | "duplicate";
  pages: string[];
  action: "archive" | "flag";
  detail: string;
}

function statePath(opts: ImpactTrailOptions): string {
  return path.join(resolveWikiDir(opts), STATE_FILENAME);
}

export async function readSemanticLintState(
  opts: ImpactTrailOptions = {},
): Promise<{ lastRunAt: number }> {
  try {
    const parsed = JSON.parse(await fs.readFile(statePath(opts), "utf-8")) as {
      lastRunAt?: unknown;
    };
    return { lastRunAt: typeof parsed.lastRunAt === "number" ? parsed.lastRunAt : 0 };
  } catch {
    return { lastRunAt: 0 };
  }
}

async function writeSemanticLintState(opts: ImpactTrailOptions, now: number): Promise<void> {
  await atomicWriteJson(statePath(opts), { lastRunAt: now });
}

const LINT_PROMPT_HEADER = `You are linting a knowledge wiki of agent failure/success patterns for HEALTH.
Find only genuine problems across the pattern pages below:
- "contradiction": two pages assert conflicting things.
- "stale": a page's claim is superseded by a newer page or clearly dated evidence.
- "duplicate": two pages cover the same pattern (semantic overlap, not byte-identical).

Be conservative — only report clear problems. For duplicate/stale, name the
page that should be RETIRED (action "archive"); keep the better/newer one.
For contradictions, use action "flag" (a human/maintainer reconciles them).

Respond with ONLY a JSON array (empty if the wiki is healthy):
[{"type":"stale","pages":["page-a"],"action":"archive","detail":"superseded by page-b"}]
`;

function parseFindings(raw: string): LintFinding[] | null {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const text = (fenced ? fenced[1] : raw)?.trim() ?? "";
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end <= start) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) {
    return null;
  }
  const out: LintFinding[] = [];
  for (const entry of parsed) {
    const e = entry as Record<string, unknown>;
    const type = e?.type;
    const action = e?.action;
    if (
      (type === "contradiction" || type === "stale" || type === "duplicate") &&
      (action === "archive" || action === "flag") &&
      Array.isArray(e.pages)
    ) {
      out.push({
        type,
        action,
        pages: e.pages.filter((p): p is string => typeof p === "string").map(normalizePatternName),
        detail: typeof e.detail === "string" ? e.detail : "",
      });
    }
  }
  return out;
}

/**
 * Run one semantic lint pass. Cadence is the caller's concern (see the
 * evolution housekeeping gate). Never throws.
 */
export async function runSemanticLint(deps: {
  llmCall: LlmCallFn | null;
  storeOpts?: WikiStoreOptions;
  now?: number;
}): Promise<SemanticLintResult> {
  const storeOpts = deps.storeOpts ?? {};
  const result: SemanticLintResult = {
    ran: false,
    archived: [],
    contradictionsFlagged: 0,
    findings: 0,
  };
  if (!deps.llmCall) {
    result.reason = "no-llm";
    return result;
  }
  try {
    const names = await listPatternNames(storeOpts);
    if (names.length < MIN_PATTERNS_KEPT + 1) {
      result.reason = "too-few-patterns";
      await writeSemanticLintState(storeOpts, deps.now ?? Date.now());
      return result;
    }
    const index = await readIndex(storeOpts);
    const sections: string[] = [`## index.md\n${index}`];
    let budget = PATTERN_BUDGET_CHARS;
    for (const name of names) {
      const content = await readPattern(name, storeOpts);
      if (content && content.length <= budget) {
        sections.push(`## patterns/${name}.md\n${content}`);
        budget -= content.length;
      }
    }
    const raw = await deps.llmCall(`${LINT_PROMPT_HEADER}\n${sections.join("\n\n")}`);
    const findings = parseFindings(raw);
    if (!findings) {
      result.reason = "parse-failed";
      return result;
    }
    result.ran = true;
    result.findings = findings.length;

    const archiveBudget = Math.max(
      0,
      Math.min(Math.floor(names.length * MAX_ARCHIVE_FRACTION), names.length - MIN_PATTERNS_KEPT),
    );
    const flagged: string[] = [];
    for (const f of findings) {
      if (f.action === "archive" && (f.type === "stale" || f.type === "duplicate")) {
        // Archive the LAST-named page (the one to retire), keeping the rest.
        const target = f.pages.at(-1);
        if (
          target &&
          isValidPatternName(target) &&
          result.archived.length < archiveBudget &&
          !result.archived.includes(target)
        ) {
          if (await archivePattern(target, storeOpts)) {
            result.archived.push(target);
          }
        }
      } else {
        result.contradictionsFlagged += 1;
        flagged.push(`- [${f.type}] ${f.pages.join(", ")}: ${f.detail}`);
      }
    }

    const logLines = [`(semantic lint) ${findings.length} finding(s)`];
    if (result.archived.length > 0) {
      logLines.push(`archived (superseded/duplicate): ${result.archived.join(", ")}`);
    }
    if (flagged.length > 0) {
      logLines.push(
        "flagged for maintainer to reconcile (index may need repair after archives):",
        ...flagged,
      );
    }
    if (result.archived.length > 0 || flagged.length > 0) {
      await appendWikiLog(logLines.join("\n"), storeOpts);
    }
    await writeSemanticLintState(storeOpts, deps.now ?? Date.now());
    log.info(
      `semantic lint: ${findings.length} finding(s), ${result.archived.length} archived, ${result.contradictionsFlagged} flagged`,
    );
    return result;
  } catch (err) {
    log.warn(`semantic lint failed: ${String(err)}`);
    return result;
  }
}
