/**
 * PLAN-44 Phase 4b: the DESCRIPTION OVERLAP check.
 *
 * The runtime opens a skill only when EXACTLY ONE description clearly
 * applies. Two skills whose descriptions route the same situation do not
 * double the coverage; they cancel it (the rule says: choose the most
 * specific, else read nothing). The proposer used to see only live skill
 * NAMES, so it could not know it was writing a near-duplicate, and the
 * gate never checked. Now the proposer sees the live index (name +
 * description) and the staging gate refuses a synthesized create whose
 * description overlaps a live one; the fix is a patch to that skill.
 *
 * Similarity is lexical and cheap: Jaccard over content words and over
 * word bigrams after normalization and stop-word removal. Deliberately
 * not embeddings — the check must run keyless and deterministically inside
 * the gate.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { parseSkillMarkdown } from "../../memory/skill-curator-judge.js";
import { liveSkillPath, type StorageRoots } from "./skill-storage.js";

/** Token-set Jaccard at or above this is an overlap. */
export const OVERLAP_TOKEN_THRESHOLD = 0.5;
/**
 * Overlap coefficient (shared / smaller set) at or above this is an
 * overlap: a rewording that says the same thing with a few extra words
 * keeps Jaccard low but containment high.
 */
export const OVERLAP_CONTAINMENT_THRESHOLD = 0.6;
/** Bigram Jaccard at or above this is an overlap (catches same phrasing with a few extra words). */
export const OVERLAP_BIGRAM_THRESHOLD = 0.4;

const STOP = new Set(
  (
    "a an the and or of to in on at for with by from as is are be this that these those it its " +
    "when whenever if not never unless except only use apply skill task tasks user users you your " +
    "do does don't should must can will any all every each also then than so into onto"
  ).split(" "),
);

export function contentWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOP.has(w));
}

function intersection(a: Set<string>, b: Set<string>): number {
  let inter = 0;
  for (const x of a) {
    if (b.has(x)) {
      inter += 1;
    }
  }
  return inter;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) {
    return 0;
  }
  const inter = intersection(a, b);
  return inter / (a.size + b.size - inter);
}

function containment(a: Set<string>, b: Set<string>): number {
  const min = Math.min(a.size, b.size);
  // Tiny sets contain trivially; require some substance before it counts.
  return min < 4 ? 0 : intersection(a, b) / min;
}

function bigrams(words: string[]): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i + 1 < words.length; i++) {
    out.add(`${words[i]} ${words[i + 1]}`);
  }
  return out;
}

export interface DescriptionSimilarity {
  tokens: number;
  containment: number;
  bigrams: number;
  overlap: boolean;
}

export function descriptionSimilarity(a: string, b: string): DescriptionSimilarity {
  const wa = contentWords(a);
  const wb = contentWords(b);
  const sa = new Set(wa);
  const sb = new Set(wb);
  // Too little substance to call anything a duplicate (contract-compliant
  // descriptions always carry more; "Retry git push" vs "Retry git pull"
  // must not collide).
  const substantive = Math.min(sa.size, sb.size) >= 4;
  const tokens = jaccard(sa, sb);
  const cont = containment(sa, sb);
  const bg = jaccard(bigrams(wa), bigrams(wb));
  return {
    tokens,
    containment: cont,
    bigrams: bg,
    overlap:
      substantive &&
      (tokens >= OVERLAP_TOKEN_THRESHOLD ||
        cont >= OVERLAP_CONTAINMENT_THRESHOLD ||
        bg >= OVERLAP_BIGRAM_THRESHOLD),
  };
}

export interface LiveSkillIndexEntry {
  name: string;
  description: string;
}

/** name + description of every live skill (what the runtime index shows). */
export async function listLiveSkillIndex(roots: StorageRoots): Promise<LiveSkillIndexEntry[]> {
  let names: string[];
  try {
    names = (await fs.readdir(roots.liveRoot)).filter((n) => !n.startsWith("."));
  } catch {
    return [];
  }
  const out: LiveSkillIndexEntry[] = [];
  for (const name of names.toSorted()) {
    let md: string;
    try {
      md = await fs.readFile(liveSkillPath(roots, name), "utf-8");
    } catch {
      try {
        // Skills stored as a bare <name>.md (legacy layout).
        md = await fs.readFile(path.join(roots.liveRoot, name), "utf-8");
      } catch {
        continue;
      }
    }
    const fm = (parseSkillMarkdown(md)?.frontmatter ?? {}) as Record<string, unknown>;
    const description = typeof fm.description === "string" ? fm.description.trim() : "";
    out.push({ name, description });
  }
  return out;
}

export interface OverlapHit extends DescriptionSimilarity {
  name: string;
}

/** The most similar OTHER live description, when it crosses a threshold. */
export function findDescriptionOverlap(
  description: string,
  index: LiveSkillIndexEntry[],
  opts: { excludeName?: string } = {},
): OverlapHit | null {
  let best: OverlapHit | null = null;
  for (const entry of index) {
    if (entry.name === opts.excludeName || !entry.description) {
      continue;
    }
    const sim = descriptionSimilarity(description, entry.description);
    if (!sim.overlap) {
      continue;
    }
    if (
      !best ||
      Math.max(sim.tokens, sim.containment, sim.bigrams) >
        Math.max(best.tokens, best.containment, best.bigrams)
    ) {
      best = { name: entry.name, ...sim };
    }
  }
  return best;
}
