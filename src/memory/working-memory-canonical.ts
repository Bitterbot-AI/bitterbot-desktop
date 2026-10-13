/**
 * PLAN-55 Phase 2 (G4), consumer 2: the MEMORY.md rewriter and the ledger.
 *
 * Two jobs, both pure and both applied by the dream rewrite in manager.ts:
 *
 * 1. Ledger keys in the synthesis prompt. The rewrite receives the active
 *    canonical facts (key = value) and the last N supersedes / owner
 *    retires (key: old -> new), with the instruction that the ledger wins
 *    and old values are never restated as current. Without this the dream
 *    rewrite kept repeating whatever MEMORY.md said before the correction.
 *
 * 2. Owner sections. Text the owner wraps in
 *
 *        <!-- owner -->            (or <!-- owner:any-label -->)
 *        ...their words...
 *        <!-- /owner -->
 *
 *    is preserved verbatim by every rewrite: the prompt says so, and
 *    preserveOwnerSections() enforces it on the output (restores a block the
 *    model dropped or altered, back in the section it came from, and removes
 *    owner markers the model invented). Only the owner writes these markers;
 *    the old MEMORY.md, read right before the rewrite, is the source of
 *    truth.
 */

import type { DatabaseSync } from "node:sqlite";
import type { CanonicalFactsStore } from "./canonical-facts.js";

export const OWNER_SECTION_BEGIN_RX = /<!--\s*owner(?::[\w.-]{1,64})?\s*-->/;
export const OWNER_SECTION_END = "<!-- /owner -->";
const OWNER_BLOCK_RX = /<!--\s*owner(?::([\w.-]{1,64}))?\s*-->[\s\S]*?<!--\s*\/owner\s*-->/g;

/** How many active facts and recent changes the prompt carries. */
export const MAX_PROMPT_CANONICAL_FACTS = 40;
export const MAX_PROMPT_SUPERSEDES = 10;
const MAX_PROMPT_VALUE_CHARS = 120;

export type CanonicalSynthesisContext = {
  /** Active ledger facts, the authoritative current values. */
  canonicalFacts?: Array<{ key: string; value: string }>;
  /** Newest first: values that stopped being true (newValue null = retired by the owner). */
  recentSupersedes?: Array<{
    key: string;
    oldValue: string;
    newValue: string | null;
    at: number;
  }>;
};

const oneLine = (s: string): string => {
  let out = "";
  for (const ch of s) {
    const cc = ch.codePointAt(0) ?? 0;
    out += cc < 0x20 || cc === 0x7f ? " " : ch;
  }
  const flat = out.replace(/\s+/g, " ").trim();
  return flat.length > MAX_PROMPT_VALUE_CHARS
    ? `${flat.slice(0, MAX_PROMPT_VALUE_CHARS)}...`
    : flat;
};

/**
 * Read the ledger for the rewrite. Best-effort: a missing ledger or table
 * yields an empty context and the prompt section is omitted.
 */
export function loadCanonicalSynthesisContext(
  db: DatabaseSync,
  store: CanonicalFactsStore | null,
  limits?: { facts?: number; supersedes?: number },
): CanonicalSynthesisContext {
  if (!store) {
    return {};
  }
  const maxFacts = limits?.facts ?? MAX_PROMPT_CANONICAL_FACTS;
  const maxChanges = limits?.supersedes ?? MAX_PROMPT_SUPERSEDES;
  const ctx: CanonicalSynthesisContext = {};
  let active: Array<{ key: string; value: string }> = [];
  try {
    active = store.listActive().map((f) => ({ key: f.key, value: f.value }));
    ctx.canonicalFacts = active.slice(0, maxFacts);
  } catch {
    // ledger unavailable
  }
  const currentByKey = new Map(active.map((f) => [f.key, f.value]));
  try {
    const superseded = db
      .prepare(
        `SELECT o.key AS key, o.value AS old_value, n.value AS new_value, o.valid_until AS at
           FROM canonical_facts o
           LEFT JOIN canonical_facts n ON n.id = o.superseded_by
          WHERE o.status = 'superseded' AND o.valid_until IS NOT NULL
          ORDER BY o.valid_until DESC
          LIMIT ?`,
      )
      .all(maxChanges * 3) as unknown as Array<{
      key: string;
      old_value: string;
      new_value: string | null;
      at: number;
    }>;
    const retired = db
      .prepare(
        `SELECT key, value, last_confirmed_at AS at FROM canonical_facts
          WHERE status = 'owner_retired' AND valid_until IS NULL
          ORDER BY last_confirmed_at DESC LIMIT ?`,
      )
      .all(maxChanges) as unknown as Array<{ key: string; value: string; at: number }>;
    const changes = [
      ...superseded
        // A value the key holds again is not stale.
        .filter((r) => r.old_value !== r.new_value && currentByKey.get(r.key) !== r.old_value)
        .map((r) => ({ key: r.key, oldValue: r.old_value, newValue: r.new_value, at: r.at })),
      ...retired.map((r) => ({ key: r.key, oldValue: r.value, newValue: null, at: r.at })),
    ].toSorted((a, b) => b.at - a.at);
    const seen = new Set<string>();
    ctx.recentSupersedes = changes
      .filter((c) => {
        const id = `${c.key}\u0000${c.oldValue}`;
        if (seen.has(id)) {
          return false;
        }
        seen.add(id);
        return true;
      })
      .slice(0, maxChanges);
  } catch {
    // pre-ledger database
  }
  return ctx;
}

/** The owner-marked blocks of a MEMORY.md, verbatim, in order. */
export function extractOwnerSections(content: string): string[] {
  return [...content.matchAll(OWNER_BLOCK_RX)].map((m) => m[0]);
}

/**
 * The synthesis prompt section: settled facts, values that are no longer
 * true, and the owner-section rule. Empty string when there is nothing to
 * say (no ledger, no owner sections).
 */
export function buildCanonicalKeysInputBlock(
  ctx: CanonicalSynthesisContext & { oldState?: string },
): string {
  const facts = ctx.canonicalFacts ?? [];
  const changes = ctx.recentSupersedes ?? [];
  const owner = extractOwnerSections(ctx.oldState ?? "");
  if (facts.length === 0 && changes.length === 0 && owner.length === 0) {
    return "";
  }
  const lines: string[] = [];
  if (facts.length > 0 || changes.length > 0) {
    lines.push(
      "## Input: Settled Facts (canonical ledger, authoritative)",
      "These are the current values. Where the Old State, a crystal, an insight or a scratch note disagrees, the ledger wins. Use these exact values; do not paraphrase them.",
    );
    for (const f of facts) {
      lines.push(`- ${oneLine(f.key)} = ${oneLine(f.value)}`);
    }
    if (changes.length > 0) {
      lines.push(
        "",
        "No longer true (recent corrections). Never write the old value as current; if the Old State states it, replace it with the current value or drop it:",
      );
      for (const c of changes) {
        lines.push(
          c.newValue === null
            ? `- ${oneLine(c.key)}: "${oneLine(c.oldValue)}" was retired by the owner`
            : `- ${oneLine(c.key)}: "${oneLine(c.oldValue)}" -> now "${oneLine(c.newValue)}"`,
        );
      }
    }
  }
  if (owner.length > 0) {
    if (lines.length > 0) {
      lines.push("");
    }
    lines.push(
      "## Owner Sections (copy verbatim)",
      `The Old State contains ${owner.length} block(s) the owner wrote between \`<!-- owner -->\` and \`${OWNER_SECTION_END}\` markers. Copy each block, markers included, character for character into the same section of the new state. Do not edit, summarise or move them, and never create new owner markers.`,
    );
  }
  return lines.join("\n");
}

const sectionName = (headingLine: string): string =>
  headingLine
    .replace(/^##\s+/, "")
    .replace(/\s*\(.*$/, "")
    .trim()
    .toLowerCase();

/** The `## ` heading line that precedes `index` in `content`, or null (preamble). */
function headingBefore(content: string, index: number): string | null {
  const before = content.slice(0, index);
  const matches = [...before.matchAll(/^## .*$/gm)];
  return matches.length > 0 ? matches[matches.length - 1]![0] : null;
}

/**
 * Enforce owner sections on a rewritten MEMORY.md. Blocks from `oldState`
 * missing from `newState` (dropped or altered) are put back at the end of
 * the section they were in (matched by heading name), or at the end of the
 * preamble / document when that section is gone. Owner blocks in
 * `newState` that are not verbatim copies of an old block are removed:
 * the model may not mint or edit owner text. Idempotent.
 */
export function preserveOwnerSections(oldState: string, newState: string): string {
  const oldBlocks = extractOwnerSections(oldState);
  // How many copies of each block the owner wrote (duplicates are kept).
  const allowance = new Map<string, number>();
  for (const b of oldBlocks) {
    allowance.set(b, (allowance.get(b) ?? 0) + 1);
  }
  // Drop forged, altered or extra copies of owner blocks from the output.
  const kept = new Map<string, number>();
  let out = newState.replace(OWNER_BLOCK_RX, (block) => {
    const used = kept.get(block) ?? 0;
    if (used < (allowance.get(block) ?? 0)) {
      kept.set(block, used + 1);
      return block;
    }
    return "";
  });
  if (oldBlocks.length === 0) {
    return out === newState ? newState : out.replace(/\n{3,}/g, "\n\n");
  }
  // Put back each missing copy, in the section its occurrence was in.
  const seen = new Map<string, number>();
  let searchFrom = 0;
  for (const block of oldBlocks) {
    const at = oldState.indexOf(block, searchFrom);
    searchFrom = at >= 0 ? at + block.length : searchFrom;
    const nth = (seen.get(block) ?? 0) + 1;
    seen.set(block, nth);
    if ((kept.get(block) ?? 0) >= nth) {
      continue;
    }
    const heading = at >= 0 ? headingBefore(oldState, at) : null;
    out = insertIntoSection(out, heading, block);
    kept.set(block, (kept.get(block) ?? 0) + 1);
  }
  return out.replace(/\n{3,}/g, "\n\n");
}

/**
 * Remove every owner-marked block from text the model produced where no
 * owner block may come from it: the first synthesis (the previous content is
 * kept verbatim above it, owner blocks included) and any other path that
 * has no previous state to compare against.
 */
export function stripOwnerSections(newState: string): string {
  const out = newState.replace(OWNER_BLOCK_RX, "");
  return out === newState ? newState : out.replace(/\n{3,}/g, "\n\n");
}

function insertIntoSection(content: string, heading: string | null, block: string): string {
  const headings = [...content.matchAll(/^## .*$/gm)];
  let insertAt: number;
  if (heading === null) {
    // Preamble: before the first section.
    insertAt = headings.length > 0 ? (headings[0]!.index ?? content.length) : content.length;
  } else {
    const name = sectionName(heading);
    const idx = headings.findIndex((h) => sectionName(h[0]) === name);
    if (idx < 0) {
      insertAt = content.length;
    } else {
      const next = headings[idx + 1];
      insertAt = next ? (next.index ?? content.length) : content.length;
    }
  }
  const before = content.slice(0, insertAt).replace(/\s*$/, "");
  const after = content.slice(insertAt);
  return `${before}\n\n${block}\n${after.length > 0 ? `\n${after}` : ""}`;
}
