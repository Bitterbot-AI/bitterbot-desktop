/**
 * PLAN-42 Phase 2: the wiki layer store (CONFIG_DIR/skill-wiki/).
 *
 * Layout (beside the Phase 0 impact trail):
 *
 *   skill-wiki/index.md              catalog: one line per pattern
 *   skill-wiki/logs.md               append-only evolution log
 *   skill-wiki/patterns/<name>.md    one page per failure mode / strategy
 *   skill-wiki/skill-impact.md       (Phase 0) proposal audit trail
 *
 * Invariants (fidelity items F2/F3 of the plan):
 *   - The wiki NEVER rolls back and nothing here deletes content. Updates
 *     are wholesale index rewrites, log appends, and patch ops on pattern
 *     pages. Archive/lint comes later and archives, never destroys.
 *   - The wiki directory is not a skill root: nothing under skill-wiki/
 *     is ever loaded into a runtime agent's prompt. The Maintainer writes
 *     it; the Proposer reads it; runtime agents cannot see it.
 *   - Maintainer output is WHITELIST-PARSED into the closed types below;
 *     unknown keys, bad names, oversized pages and injection-critical
 *     content are dropped and reported, never written.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { resolveWikiDir, type ImpactTrailOptions } from "../../agents/skills/impact-trail.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { scanSkillForInjection } from "../../security/skill-injection-scanner.js";

const log = createSubsystemLogger("skill-evolution/wiki");

export const INDEX_FILENAME = "index.md";
export const LOGS_FILENAME = "logs.md";
export const PATTERNS_SUBDIR = "patterns";

/** Paper: pattern pages are 10-30 lines, not essays. Hard char cap. */
export const MAX_PATTERN_CONTENT_CHARS = 8_000;
/** Index and per-iteration log entries stay bounded too. */
export const MAX_INDEX_CHARS = 32_000;
export const MAX_LOG_ENTRY_CHARS = 4_000;
/** Default pattern-count cap (config skills.evolution.wikiMaxPatterns). */
export const DEFAULT_MAX_PATTERNS = 100;

/** Prompt-context budget for the full-wiki view fed to the Maintainer. */
const CONTEXT_PATTERN_BUDGET_CHARS = 60_000;
const CONTEXT_LOG_TAIL_CHARS = 4_000;

const PATTERN_NAME_RE = /^[a-z0-9][a-z0-9._-]*$/;
const MAX_PATTERN_NAME_LENGTH = 64;

export type WikiStoreOptions = ImpactTrailOptions;

export function patternsDir(opts: WikiStoreOptions = {}): string {
  return path.join(resolveWikiDir(opts), PATTERNS_SUBDIR);
}

export function indexPath(opts: WikiStoreOptions = {}): string {
  return path.join(resolveWikiDir(opts), INDEX_FILENAME);
}

export function logsPath(opts: WikiStoreOptions = {}): string {
  return path.join(resolveWikiDir(opts), LOGS_FILENAME);
}

export function isValidPatternName(name: string): boolean {
  const base = name.endsWith(".md") ? name.slice(0, -3) : name;
  return (
    base.length > 0 &&
    base.length <= MAX_PATTERN_NAME_LENGTH &&
    !base.includes("/") &&
    !base.includes("\\") &&
    !base.includes("..") &&
    PATTERN_NAME_RE.test(base)
  );
}

/** Normalize "foo-bar.md" / "foo-bar" to the bare pattern name. */
export function normalizePatternName(name: string): string {
  return name.endsWith(".md") ? name.slice(0, -3) : name;
}

function patternPath(name: string, opts: WikiStoreOptions): string {
  return path.join(patternsDir(opts), `${normalizePatternName(name)}.md`);
}

async function atomicWrite(filePath: string, content: string): Promise<void> {
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    await fs.writeFile(tmp, content, "utf-8");
    await fs.rename(tmp, filePath);
  } catch (err) {
    try {
      await fs.unlink(tmp);
    } catch {
      // ignore
    }
    throw err;
  }
}

async function readOrNull(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf-8");
  } catch {
    return null;
  }
}

// ── Read side ───────────────────────────────────────────────────────────────

export interface WikiPattern {
  name: string;
  content: string;
}

export interface WikiContext {
  index: string;
  logTail: string;
  /** Full pattern pages within the context budget. */
  patterns: WikiPattern[];
  /** Names of patterns elided from the context (budget overflow). */
  elidedPatternNames: string[];
  patternCount: number;
}

export async function listPatternNames(opts: WikiStoreOptions = {}): Promise<string[]> {
  try {
    const entries = await fs.readdir(patternsDir(opts));
    return entries
      .filter((e) => e.endsWith(".md") && isValidPatternName(e))
      .map((e) => normalizePatternName(e))
      .toSorted();
  } catch {
    return [];
  }
}

export async function readPattern(
  name: string,
  opts: WikiStoreOptions = {},
): Promise<string | null> {
  if (!isValidPatternName(name)) {
    return null;
  }
  return readOrNull(patternPath(name, opts));
}

export async function readIndex(opts: WikiStoreOptions = {}): Promise<string> {
  return (await readOrNull(indexPath(opts))) ?? "";
}

/** Assemble the Maintainer's full-wiki view under a context budget. */
export async function readWikiContext(opts: WikiStoreOptions = {}): Promise<WikiContext> {
  const index = await readIndex(opts);
  const logs = (await readOrNull(logsPath(opts))) ?? "";
  const logTail = logs.length > CONTEXT_LOG_TAIL_CHARS ? logs.slice(-CONTEXT_LOG_TAIL_CHARS) : logs;
  const names = await listPatternNames(opts);
  const patterns: WikiPattern[] = [];
  const elidedPatternNames: string[] = [];
  let budget = CONTEXT_PATTERN_BUDGET_CHARS;
  for (const name of names) {
    const content = await readPattern(name, opts);
    if (content === null) {
      continue;
    }
    if (content.length <= budget) {
      patterns.push({ name, content });
      budget -= content.length;
    } else {
      elidedPatternNames.push(name);
    }
  }
  return { index, logTail, patterns, elidedPatternNames, patternCount: names.length };
}

// ── Write side (whitelist-parsed maintainer output) ─────────────────────────

export type WikiPatchOp =
  | { op: "append"; content: string }
  | { op: "replace"; target: string; content: string }
  | { op: "insert_after"; target: string; content: string };

export interface MaintainerOutput {
  createPatterns: Array<{ name: string; content: string }>;
  updatePatterns: Array<{ name: string; edits: WikiPatchOp[] }>;
  updateIndex: string;
  appendLog: string;
}

export interface ParseIssue {
  where: string;
  detail: string;
}

/**
 * Parse raw LLM output into the closed MaintainerOutput shape. Returns null
 * when the required fields (update_index, append_log) are missing or the
 * payload is not JSON. Unknown keys and malformed entries are dropped and
 * reported as issues — they are structurally unreachable from the writers.
 */
export function parseMaintainerOutput(raw: string): {
  output: MaintainerOutput | null;
  issues: ParseIssue[];
} {
  const issues: ParseIssue[] = [];
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const jsonText = (fenced ? fenced[1] : raw)?.trim() ?? "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    // Fall back to the first {...} block in the text.
    const start = jsonText.indexOf("{");
    const end = jsonText.lastIndexOf("}");
    if (start < 0 || end <= start) {
      return { output: null, issues: [{ where: "root", detail: "no JSON object found" }] };
    }
    try {
      parsed = JSON.parse(jsonText.slice(start, end + 1));
    } catch (err) {
      return {
        output: null,
        issues: [{ where: "root", detail: `JSON parse failed: ${String(err)}` }],
      };
    }
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { output: null, issues: [{ where: "root", detail: "payload is not an object" }] };
  }
  const obj = parsed as Record<string, unknown>;

  const updateIndex = typeof obj.update_index === "string" ? obj.update_index : null;
  const appendLog = typeof obj.append_log === "string" ? obj.append_log : null;
  if (!updateIndex || !appendLog) {
    return {
      output: null,
      issues: [{ where: "root", detail: "update_index and append_log are required" }],
    };
  }

  const createPatterns: MaintainerOutput["createPatterns"] = [];
  if (Array.isArray(obj.create_patterns)) {
    for (const [i, entry] of obj.create_patterns.entries()) {
      const e = entry as Record<string, unknown>;
      const name = typeof e?.name === "string" ? normalizePatternName(e.name.trim()) : "";
      const content = typeof e?.content === "string" ? e.content : "";
      if (!isValidPatternName(name)) {
        issues.push({ where: `create_patterns[${i}]`, detail: `invalid name "${name}"` });
        continue;
      }
      if (!content.trim()) {
        issues.push({ where: `create_patterns[${i}]`, detail: "empty content" });
        continue;
      }
      createPatterns.push({ name, content: content.slice(0, MAX_PATTERN_CONTENT_CHARS) });
    }
  }

  const updatePatterns: MaintainerOutput["updatePatterns"] = [];
  if (Array.isArray(obj.update_patterns)) {
    for (const [i, entry] of obj.update_patterns.entries()) {
      const e = entry as Record<string, unknown>;
      const name = typeof e?.name === "string" ? normalizePatternName(e.name.trim()) : "";
      if (!isValidPatternName(name)) {
        issues.push({ where: `update_patterns[${i}]`, detail: `invalid name "${name}"` });
        continue;
      }
      const edits: WikiPatchOp[] = [];
      if (Array.isArray(e.edits)) {
        for (const [j, editRaw] of e.edits.entries()) {
          const edit = editRaw as Record<string, unknown>;
          const op = edit?.op;
          const content = typeof edit?.content === "string" ? edit.content : "";
          const target = typeof edit?.target === "string" ? edit.target : "";
          if (op === "append" && content) {
            edits.push({ op: "append", content });
          } else if ((op === "replace" || op === "insert_after") && content && target) {
            edits.push({ op, target, content });
          } else {
            issues.push({ where: `update_patterns[${i}].edits[${j}]`, detail: "malformed op" });
          }
        }
      }
      if (edits.length > 0) {
        updatePatterns.push({ name, edits });
      }
    }
  }

  return {
    output: {
      createPatterns,
      updatePatterns,
      updateIndex: updateIndex.slice(0, MAX_INDEX_CHARS),
      appendLog: appendLog.slice(0, MAX_LOG_ENTRY_CHARS),
    },
    issues,
  };
}

export interface ApplyResult {
  created: string[];
  updated: string[];
  /** {where, detail} for every dropped create/edit. */
  dropped: ParseIssue[];
  indexUpdated: boolean;
  logAppended: boolean;
}

function applyPatchOps(source: string, edits: WikiPatchOp[], dropped: ParseIssue[], name: string) {
  let next = source;
  for (const edit of edits) {
    if (edit.op === "append") {
      next = `${next.replace(/\n+$/, "")}\n${edit.content}\n`;
      continue;
    }
    const idx = next.indexOf(edit.target);
    if (idx < 0) {
      dropped.push({
        where: `update:${name}`,
        detail: `${edit.op} target not found: ${edit.target.slice(0, 60)}`,
      });
      continue;
    }
    if (edit.op === "replace") {
      next = next.slice(0, idx) + edit.content + next.slice(idx + edit.target.length);
    } else {
      const insertAt = idx + edit.target.length;
      next = `${next.slice(0, insertAt)}\n${edit.content}${next.slice(insertAt)}`;
    }
  }
  return next;
}

/**
 * Apply a parsed MaintainerOutput to the wiki. Creates and updates pattern
 * pages, rewrites the index, appends the log. Injection-critical content is
 * dropped per item (traces contain open-web text; the wiki is a
 * prompt-injection write-primitive into the Proposer). Never deletes.
 */
export async function applyMaintainerOutput(
  output: MaintainerOutput,
  opts: WikiStoreOptions & { maxPatterns?: number } = {},
): Promise<ApplyResult> {
  const result: ApplyResult = {
    created: [],
    updated: [],
    dropped: [],
    indexUpdated: false,
    logAppended: false,
  };
  const maxPatterns = opts.maxPatterns ?? DEFAULT_MAX_PATTERNS;
  await fs.mkdir(patternsDir(opts), { recursive: true });

  let patternCount = (await listPatternNames(opts)).length;
  for (const create of output.createPatterns) {
    if (patternCount >= maxPatterns) {
      result.dropped.push({
        where: `create:${create.name}`,
        detail: `pattern cap reached (${maxPatterns}); lint/archive pass required`,
      });
      continue;
    }
    const existing = await readPattern(create.name, opts);
    if (existing !== null) {
      result.dropped.push({
        where: `create:${create.name}`,
        detail: "pattern already exists; use update_patterns",
      });
      continue;
    }
    const scan = scanSkillForInjection(create.content);
    if (scan.severity === "critical") {
      result.dropped.push({
        where: `create:${create.name}`,
        detail: `injection scan critical: ${scan.reason}`,
      });
      continue;
    }
    await atomicWrite(patternPath(create.name, opts), create.content);
    result.created.push(create.name);
    patternCount += 1;
  }

  for (const update of output.updatePatterns) {
    const existing = await readPattern(update.name, opts);
    if (existing === null) {
      result.dropped.push({ where: `update:${update.name}`, detail: "pattern does not exist" });
      continue;
    }
    const next = applyPatchOps(existing, update.edits, result.dropped, update.name);
    if (next === existing) {
      continue;
    }
    const scan = scanSkillForInjection(next);
    if (scan.severity === "critical") {
      result.dropped.push({
        where: `update:${update.name}`,
        detail: `injection scan critical after edit: ${scan.reason}`,
      });
      continue;
    }
    await atomicWrite(patternPath(update.name, opts), next.slice(0, MAX_PATTERN_CONTENT_CHARS));
    result.updated.push(update.name);
  }

  const indexScan = scanSkillForInjection(output.updateIndex);
  if (indexScan.severity === "critical") {
    result.dropped.push({ where: "index", detail: `injection scan critical: ${indexScan.reason}` });
  } else {
    await atomicWrite(indexPath(opts), output.updateIndex);
    result.indexUpdated = true;
  }

  const logEntry = `\n## ${new Date().toISOString()}\n\n${output.appendLog.trim()}\n`;
  const logScan = scanSkillForInjection(logEntry);
  if (logScan.severity === "critical") {
    result.dropped.push({ where: "log", detail: `injection scan critical: ${logScan.reason}` });
  } else {
    await fs.appendFile(logsPath(opts), logEntry, "utf-8");
    result.logAppended = true;
  }

  if (result.dropped.length > 0) {
    log.debug(`maintainer apply dropped ${result.dropped.length} item(s)`);
  }
  return result;
}
