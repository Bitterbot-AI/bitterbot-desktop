/**
 * PLAN-43 Phase 0: read the PLAN-42 validation verdicts off disk so the
 * marketplace can rank listings by verified outcomes instead of price or
 * farmable counts. The authoritative per-skill record is the
 * `.evolution-meta.json` the validation gate writes into each live skill
 * dir on promotion (validation-gate.ts); this module is the sqlite⇄fs join.
 *
 * Synchronous by design: the only caller is MarketplaceEconomics.
 * refreshListings, which runs inside the ~30-min consolidation pass over a
 * handful of skill dirs (maxActiveEvolved defaults to 5).
 */

import fs from "node:fs";
import path from "node:path";
import type { EvolutionMeta } from "./validation-gate.js";
import { resolveStorageRoots, type SkillStorageRoots } from "../../agents/skills/skill-storage.js";

export interface SkillValidationSummary {
  skillName: string;
  mode: "records" | "tasks";
  verdict: string;
  meanDelta?: number;
  ci95Low?: number;
  corpusVersion?: string;
  validatedAt: number;
  /** True when the verdict was scored on a corpus containing the canonical baseline. */
  canonical: boolean;
}

/**
 * Normalize a name for the crystal-listing ⇄ skill-dir join: listing names
 * come from crystal text first lines ("# My Skill"), dirs are slugs
 * ("my-skill"). Lowercase, non-alphanumerics collapse to "-".
 */
export function normalizeSkillName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Scan the live skills root and return validation summaries keyed by
 * normalized skill name. Missing root / unreadable metas are skipped;
 * never throws. If two skill dirs collide post-normalization, BOTH are
 * dropped — an ambiguous verdict must never attach to the wrong skill.
 *
 * Trust scope: this name join is LOCAL and advisory. The crystals it
 * annotates are the node's own (peer-origin crystals are refused by
 * setForSale in Phase 0), and buyer-side re-scoring on the canonical
 * corpus — not this join — is the cross-node trust basis (PLAN-43 §3.4,
 * Phase 3). Exact content-hash binding replaces the name join when the
 * crystal⇄skill-dir lineage exists.
 */
export function readValidationSummaries(
  opts: SkillStorageRoots = {},
): Map<string, SkillValidationSummary> {
  const out = new Map<string, SkillValidationSummary>();
  const ambiguous = new Set<string>();
  const roots = resolveStorageRoots(opts);
  let entries: string[];
  try {
    entries = fs.readdirSync(roots.liveRoot);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(name)) {
      continue;
    }
    let meta: EvolutionMeta;
    try {
      meta = JSON.parse(
        fs.readFileSync(path.join(roots.liveRoot, name, ".evolution-meta.json"), "utf-8"),
      ) as EvolutionMeta;
    } catch {
      continue;
    }
    const v = meta?.validation;
    if (meta?.origin !== "wiki-evolution" || !v || typeof v.validatedAt !== "number") {
      continue;
    }
    const key = normalizeSkillName(name);
    if (ambiguous.has(key)) {
      continue;
    }
    if (out.has(key)) {
      out.delete(key);
      ambiguous.add(key);
      continue;
    }
    out.set(key, {
      skillName: name,
      mode: v.mode,
      verdict: v.verdict,
      ...(typeof v.meanDelta === "number" ? { meanDelta: v.meanDelta } : {}),
      ...(typeof v.ci95Low === "number" ? { ci95Low: v.ci95Low } : {}),
      ...(typeof v.corpusVersion === "string" ? { corpusVersion: v.corpusVersion } : {}),
      validatedAt: v.validatedAt,
      canonical: typeof v.corpusVersion === "string" && v.corpusVersion.startsWith("canonical-"),
    });
  }
  return out;
}
