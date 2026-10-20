/**
 * PLAN-43 Phase 3 (§3.3, invariant I4): registry-origin lookup for the
 * revenue split. Skills imported from agentskills.io carry a
 * `.provenance.json` ({registry, slug, upstream_url, content_hash}) in their
 * live skill dir; a sale of such a skill owes the registry its configured
 * royalty (skills.agentskills.royaltyBps) — a sale can never silently keep
 * 100%. Join is by normalized skill name, like the validation-summaries
 * join (sqlite crystal ⇄ fs skill dir).
 */

import fs from "node:fs";
import path from "node:path";
import { resolveStorageRoots, type SkillStorageRoots } from "../agents/skills/skill-storage.js";
import { normalizeSkillName } from "./skill-evolution/validation-summaries.js";

export interface RegistryProvenance {
  registry: string;
  slug?: string;
  upstreamUrl?: string;
  /** SHA-256 of the imported SKILL.md content (the reliable join key). */
  contentHash?: string;
}

/** Map of normalized skill name → registry provenance, for every live skill that has one. */
export function readRegistryProvenances(
  opts: SkillStorageRoots = {},
): Map<string, RegistryProvenance> {
  const out = new Map<string, RegistryProvenance>();
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
    try {
      const raw = JSON.parse(
        fs.readFileSync(path.join(roots.liveRoot, name, ".provenance.json"), "utf-8"),
      ) as { registry?: unknown; slug?: unknown; upstream_url?: unknown; content_hash?: unknown };
      if (typeof raw.registry === "string" && raw.registry) {
        const prov: RegistryProvenance = {
          registry: raw.registry,
          ...(typeof raw.slug === "string" ? { slug: raw.slug } : {}),
          ...(typeof raw.upstream_url === "string" ? { upstreamUrl: raw.upstream_url } : {}),
          ...(typeof raw.content_hash === "string" ? { contentHash: raw.content_hash } : {}),
        };
        // Keyed by BOTH the content hash (exact, `sha256:<hex>`) and the
        // normalized name; callers try the hash first.
        out.set(normalizeSkillName(name), prov);
        if (prov.contentHash) {
          out.set(`sha256:${prov.contentHash}`, prov);
        }
      }
    } catch {
      /* not a registry import */
    }
  }
  return out;
}
