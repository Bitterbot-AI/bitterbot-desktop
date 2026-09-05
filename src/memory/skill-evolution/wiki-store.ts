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
import { isSuspicious, scanSkillForInjection } from "../../security/skill-injection-scanner.js";
import { atomicWriteFile } from "./fs-atomic.js";
import { extractJsonObjectLenient } from "./json-extract.js";

const log = createSubsystemLogger("skill-evolution/wiki");

export const INDEX_FILENAME = "index.md";
export const LOGS_FILENAME = "logs.md";
export const SCHEMA_FILENAME = "schema.md";
export const PATTERNS_SUBDIR = "patterns";

/**
 * Karpathy's Layer 3: the wiki's own conventions, as a document the
 * Maintainer reads and MAY evolve — not rules hardcoded in a prompt. Seeded
 * on first maintenance; the Maintainer can refine it via `update_schema`.
 */
export const DEFAULT_SCHEMA = `# Wiki Schema

This document defines how this skill-evolution wiki is structured and
maintained. You (the Wiki Maintainer) read it each iteration and may refine
it via "update_schema" as conventions prove out.

## Layout
- index.md — one line per pattern: [name](patterns/name.md): PROBLEM + ROOT CAUSE + FIX.
- logs.md — append-only chronological log, one entry per iteration and lint pass.
- schema.md — this file.
- patterns/<name>.md — one page per failure mode or success strategy.
- patterns/archive/ — retired pages (lint moves them here; never deleted).

## Pattern page conventions
- 10-30 lines. Document root cause + concrete fix, not snapshots.
- Keep volatile specifics (counts, dates, hashes) out of prose, or date-stamp them.
- Cite trace evidence for claims. Update existing pages; do not duplicate.

## Naming
- Pattern names: lowercase-kebab, describe the PROBLEM (e.g. exec-timeout-loop).
`;

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

export function schemaPath(opts: WikiStoreOptions = {}): string {
  return path.join(resolveWikiDir(opts), SCHEMA_FILENAME);
}

/** Read the wiki schema, falling back to the default (not yet seeded on disk). */
export async function readSchema(opts: WikiStoreOptions = {}): Promise<string> {
  return (await readOrNull(schemaPath(opts))) ?? DEFAULT_SCHEMA;
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

/** PLAN-44 Phase 0: shared primitive (fs-atomic.ts) so every state file is torn-write safe. */
async function atomicWrite(filePath: string, content: string): Promise<void> {
  await atomicWriteFile(filePath, content);
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
  schema: string;
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

export const PATTERN_ARCHIVE_SUBDIR = "archive";

/**
 * Retire a pattern page to patterns/archive/ (never deleted — the wiki is
 * append-durable). Returns false when the page does not exist. Shared by the
 * mechanical and semantic lint passes.
 */
export async function archivePattern(name: string, opts: WikiStoreOptions = {}): Promise<boolean> {
  if (!isValidPatternName(name)) {
    return false;
  }
  const src = patternPath(name, opts);
  if ((await readOrNull(src)) === null) {
    return false;
  }
  const dir = path.join(patternsDir(opts), PATTERN_ARCHIVE_SUBDIR);
  await fs.mkdir(dir, { recursive: true });
  let dest = path.join(dir, `${name}.md`);
  try {
    await fs.access(dest);
    dest = path.join(dir, `${name}.${Date.now()}.md`);
  } catch {
    // dest free
  }
  await fs.rename(src, dest);
  return true;
}

/** Append a freeform entry to logs.md (lint passes, out-of-band notes). */
export async function appendWikiLog(entry: string, opts: WikiStoreOptions = {}): Promise<void> {
  await fs.mkdir(resolveWikiDir(opts), { recursive: true });
  await fs.appendFile(
    logsPath(opts),
    `\n## ${new Date().toISOString()}\n\n${entry.trim()}\n`,
    "utf-8",
  );
}

/** Assemble the Maintainer's full-wiki view under a context budget. */
export async function readWikiContext(opts: WikiStoreOptions = {}): Promise<WikiContext> {
  const index = await readIndex(opts);
  const schema = await readSchema(opts);
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
  return { index, schema, logTail, patterns, elidedPatternNames, patternCount: names.length };
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
  /** Optional full rewrite of schema.md (Karpathy Layer 3, evolvable). */
  updateSchema?: string;
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
  // Lenient extraction: inner code fences inside pattern content must not
  // truncate the payload (live finding 2026-09-02).
  const obj = extractJsonObjectLenient(raw);
  if (!obj) {
    return { output: null, issues: [{ where: "root", detail: "no parseable JSON object found" }] };
  }

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
      ...(typeof obj.update_schema === "string" && obj.update_schema.trim()
        ? { updateSchema: obj.update_schema.slice(0, MAX_INDEX_CHARS) }
        : {}),
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
  schemaUpdated: boolean;
}

/**
 * Apply paper-style patch ops to a text body. Shared by the wiki writer and
 * the Skill Proposer's patch path. Missing targets are recorded in
 * `dropped`, never guessed at.
 */
export function applyPatchOps(
  source: string,
  edits: WikiPatchOp[],
  dropped: ParseIssue[],
  name: string,
) {
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
    schemaUpdated: false,
  };
  const maxPatterns = opts.maxPatterns ?? DEFAULT_MAX_PATTERNS;
  await fs.mkdir(patternsDir(opts), { recursive: true });

  // Seed schema.md on first run so the Maintainer always sees it on disk.
  try {
    await fs.access(schemaPath(opts));
  } catch {
    await atomicWrite(schemaPath(opts), DEFAULT_SCHEMA);
  }

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
    // D-7: `medium` is dropped like `critical` (the wiki is not the place
    // to keep suspect text — the proposer reads it raw); `low` is written
    // and logged so a reviewer can find it.
    const scan = scanSkillForInjection(create.content);
    if (scan.severity === "low") {
      log.info(`wiki create ${create.name}: injection scan low (${scan.reason}); written`);
    }
    if (isSuspicious(scan.severity)) {
      result.dropped.push({
        where: `create:${create.name}`,
        detail: `injection scan ${scan.severity}: ${scan.reason}`,
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
    if (scan.severity === "low") {
      log.info(`wiki update ${update.name}: injection scan low (${scan.reason}); written`);
    }
    if (isSuspicious(scan.severity)) {
      result.dropped.push({
        where: `update:${update.name}`,
        detail: `injection scan ${scan.severity} after edit: ${scan.reason}`,
      });
      continue;
    }
    await atomicWrite(patternPath(update.name, opts), next.slice(0, MAX_PATTERN_CONTENT_CHARS));
    result.updated.push(update.name);
  }

  const indexScan = scanSkillForInjection(output.updateIndex);
  if (isSuspicious(indexScan.severity)) {
    result.dropped.push({
      where: "index",
      detail: `injection scan ${indexScan.severity}: ${indexScan.reason}`,
    });
  } else {
    await atomicWrite(indexPath(opts), output.updateIndex);
    result.indexUpdated = true;
  }

  if (output.updateSchema) {
    const schemaScan = scanSkillForInjection(output.updateSchema);
    if (isSuspicious(schemaScan.severity)) {
      result.dropped.push({
        where: "schema",
        detail: `injection scan ${schemaScan.severity}: ${schemaScan.reason}`,
      });
    } else {
      await atomicWrite(schemaPath(opts), output.updateSchema);
      result.schemaUpdated = true;
    }
  }

  const logEntry = `\n## ${new Date().toISOString()}\n\n${output.appendLog.trim()}\n`;
  const logScan = scanSkillForInjection(logEntry);
  if (isSuspicious(logScan.severity)) {
    result.dropped.push({
      where: "log",
      detail: `injection scan ${logScan.severity}: ${logScan.reason}`,
    });
  } else {
    await fs.appendFile(logsPath(opts), logEntry, "utf-8");
    result.logAppended = true;
  }

  if (result.dropped.length > 0) {
    log.debug(`maintainer apply dropped ${result.dropped.length} item(s)`);
  }
  return result;
}
