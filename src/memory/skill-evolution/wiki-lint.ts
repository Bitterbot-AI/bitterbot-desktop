/**
 * PLAN-42 Phase 5: wiki lint — the hygiene pass the paper admits it lacks
 * (its acknowledged open problem) and Karpathy flags as the pattern's
 * historical killer (maintenance burden and drift).
 *
 * Deterministic, fs-only, runs at the end of each evolution iteration:
 *   1. Exact-duplicate pattern pages -> ARCHIVE the later names (append
 *      durability: patterns/archive/<name>.md, never deleted).
 *   2. Pattern count over the cap -> archive the least-recently-modified
 *      overflow (the maintainer keeps hot pages fresh; stale ones rotate
 *      out first).
 *   3. Orphans (pattern pages the index never mentions) -> reported in the
 *      lint result and appended to logs.md so the NEXT maintainer call
 *      repairs the index (the index is LLM-owned; lint never edits it).
 *
 * Semantic near-duplicate merging stays LLM work for a later pass; this
 * bounds growth mechanically so the wiki cannot rot unattended.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  archivePattern,
  DEFAULT_MAX_PATTERNS,
  listPatternNames,
  logsPath,
  patternsDir,
  readIndex,
  readPattern,
  type WikiStoreOptions,
} from "./wiki-store.js";

const log = createSubsystemLogger("skill-evolution/wiki-lint");

export interface WikiLintResult {
  archivedDuplicates: string[];
  archivedOverflow: string[];
  orphans: string[];
  patternCountAfter: number;
}

/** Run the mechanical lint pass. Archive-only; never deletes, never edits the index. */
export async function runWikiLint(
  opts: WikiStoreOptions & { maxPatterns?: number } = {},
): Promise<WikiLintResult> {
  const maxPatterns = opts.maxPatterns ?? DEFAULT_MAX_PATTERNS;
  const result: WikiLintResult = {
    archivedDuplicates: [],
    archivedOverflow: [],
    orphans: [],
    patternCountAfter: 0,
  };

  // 1. Exact duplicates (first name alphabetically survives).
  const names = await listPatternNames(opts);
  const byContent = new Map<string, string>();
  for (const name of names) {
    const content = (await readPattern(name, opts))?.trim();
    if (!content) {
      continue;
    }
    const keeper = byContent.get(content);
    if (keeper === undefined) {
      byContent.set(content, name);
    } else {
      await archivePattern(name, opts);
      result.archivedDuplicates.push(name);
    }
  }

  // 2. Overflow past the cap: least-recently-modified first.
  let remaining = await listPatternNames(opts);
  if (remaining.length > maxPatterns) {
    const withMtime = await Promise.all(
      remaining.map(async (name) => {
        try {
          const stat = await fs.stat(path.join(patternsDir(opts), `${name}.md`));
          return { name, mtime: stat.mtimeMs };
        } catch {
          return { name, mtime: 0 };
        }
      }),
    );
    const overflow = withMtime
      .toSorted((a, b) => a.mtime - b.mtime)
      .slice(0, remaining.length - maxPatterns);
    for (const { name } of overflow) {
      await archivePattern(name, opts);
      result.archivedOverflow.push(name);
    }
    remaining = await listPatternNames(opts);
  }

  // 3. Orphans: pages the index never mentions.
  const index = await readIndex(opts);
  result.orphans = remaining.filter((name) => !index.includes(name));
  result.patternCountAfter = remaining.length;

  const touched =
    result.archivedDuplicates.length + result.archivedOverflow.length + result.orphans.length;
  if (touched > 0) {
    const lines: string[] = [`\n## ${new Date().toISOString()} (lint)`, ""];
    if (result.archivedDuplicates.length > 0) {
      lines.push(`- archived exact duplicates: ${result.archivedDuplicates.join(", ")}`);
    }
    if (result.archivedOverflow.length > 0) {
      lines.push(`- archived over-cap (LRU): ${result.archivedOverflow.join(", ")}`);
    }
    if (result.orphans.length > 0) {
      lines.push(
        `- ORPHANED patterns missing from index.md (repair the index next iteration): ${result.orphans.join(", ")}`,
      );
    }
    try {
      await fs.appendFile(logsPath(opts), `${lines.join("\n")}\n`, "utf-8");
    } catch (err) {
      log.debug(`lint log append failed: ${String(err)}`);
    }
    log.info(
      `wiki lint: ${result.archivedDuplicates.length} dup(s), ${result.archivedOverflow.length} overflow archived, ${result.orphans.length} orphan(s) flagged`,
    );
  }
  return result;
}
