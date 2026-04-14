/**
 * Cross-source skill reconciliation.
 *
 * PLAN-11 Gap 3: when the same library is scraped from multiple sources
 * (e.g., `react.dev/reference/react` AND `github.com/facebook/react`), each
 * scrape would otherwise produce a separate envelope, cluttering the store
 * and confusing the agent's retrieval.
 *
 * This module reconciles a new envelope against existing scraped skills that
 * share the same `stable_skill_id`. It computes a quality score for each
 * version and decides:
 *
 *   - ingest-new     — no prior version, proceed normally
 *   - skip-incoming  — prior version is meaningfully better; drop the scrape
 *   - replace        — incoming is meaningfully better; mark the existing one
 *                      for replacement and merge its provenance forward
 *   - write-as-variant — both are comparable; keep as `<name>-alt` for manual
 *                        reconciliation later
 *
 * Quality scoring is deliberately simple (no embeddings) because the scraper
 * produces deterministic SKILL.md output — surface signals like length,
 * reference count, and source authority are enough to pick a winner.
 * Embedding-based merge is deferred (see Out of Scope in PLAN-11).
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { SkillEnvelope } from "../agents/skills/ingest.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("skill-seekers-reconciler");

// ── Types ──

export type ReconcileDecision =
  | { action: "ingest-new" }
  | {
      action: "skip-incoming";
      reason: string;
      existingName: string;
      mergedProvenance: Record<string, unknown>;
    }
  | {
      action: "replace";
      reason: string;
      existingName: string;
      mergedProvenance: Record<string, unknown>;
    }
  | {
      action: "write-as-variant";
      reason: string;
      suffix: string;
    };

export type ReconcileOptions = {
  /** Absolute path to the directory where accepted skills live (e.g. ~/.bitterbot/skills). */
  skillsDir: string;
  /** Absolute path to the quarantine directory (e.g. ~/.bitterbot/skills-incoming). */
  quarantineDir: string;
  /**
   * Replace only if the incoming score beats the existing by at least this
   * multiplicative margin. Prevents churn from near-ties. Default: 1.15 (15%).
   */
  replaceMargin?: number;
  /**
   * Skip only if the existing score beats the incoming by at least this
   * multiplicative margin. Default: 1.05 (5%) — easier to skip than to replace.
   */
  skipMargin?: number;
};

type FoundSkill = {
  location: "accepted" | "quarantined";
  directory: string;
  name: string;
  envelope: SkillEnvelope;
  skillMdBytes: number;
  referenceCount: number;
};

// ── Public API ──

export async function reconcileEnvelope(
  incoming: SkillEnvelope,
  incomingBytes: number,
  opts: ReconcileOptions,
): Promise<ReconcileDecision> {
  if (!incoming.stable_skill_id) {
    // No stable ID = no way to dedupe cross-source. Treat as new.
    return { action: "ingest-new" };
  }
  const existing = await findExistingByStableId(incoming.stable_skill_id, opts);
  if (!existing) {
    return { action: "ingest-new" };
  }

  const incomingScore = scoreEnvelope(incoming, incomingBytes);
  const existingScore = scoreEnvelope(existing.envelope, existing.skillMdBytes, {
    referenceCount: existing.referenceCount,
  });
  const replaceMargin = opts.replaceMargin ?? 1.15;
  const skipMargin = opts.skipMargin ?? 1.05;

  log.debug(
    `reconcile ${incoming.stable_skill_id}: incoming=${incomingScore.toFixed(2)} existing=${existingScore.toFixed(2)}`,
  );

  const mergedProvenance = mergeProvenance(existing.envelope, incoming);

  if (incomingScore >= existingScore * replaceMargin) {
    return {
      action: "replace",
      reason: `incoming score ${incomingScore.toFixed(2)} beats existing ${existingScore.toFixed(2)} by ≥${Math.round((replaceMargin - 1) * 100)}%`,
      existingName: existing.name,
      mergedProvenance,
    };
  }

  if (existingScore >= incomingScore * skipMargin) {
    return {
      action: "skip-incoming",
      reason: `existing score ${existingScore.toFixed(2)} beats incoming ${incomingScore.toFixed(2)} by ≥${Math.round((skipMargin - 1) * 100)}%`,
      existingName: existing.name,
      mergedProvenance,
    };
  }

  // Comparable — keep both for now, let the human pick.
  return {
    action: "write-as-variant",
    reason: `comparable quality (incoming ${incomingScore.toFixed(2)} ≈ existing ${existingScore.toFixed(2)})`,
    suffix: "alt",
  };
}

// ── Scoring ──

/**
 * Heuristic quality score. Higher is better. No embeddings — surface signals
 * only. This is a *ranking* tool; the absolute values aren't meaningful.
 */
export function scoreEnvelope(
  envelope: SkillEnvelope,
  skillMdBytes: number,
  overrides: { referenceCount?: number } = {},
): number {
  let score = 0;

  // Length: 0-4 points. Diminishing returns past 20 KB.
  const lengthKb = skillMdBytes / 1024;
  score += Math.min(4, Math.log2(Math.max(1, lengthKb + 1)));

  // References count: 0-3 points. Scaled by 1 point per 3 refs.
  const refs = overrides.referenceCount ?? countReferencesFromTags(envelope);
  score += Math.min(3, refs / 3);

  // Source authority: boost envelopes from reputable origins.
  const sourceAuth = sourceAuthorityBonus(envelope);
  score += sourceAuth;

  // Recency: very small boost for newer timestamps — fast-moving libraries
  // benefit from fresher docs. Logarithmic so yesterday vs. today matters
  // more than last month vs. last year.
  const ageMs = Math.max(0, Date.now() - envelope.timestamp);
  const ageDays = ageMs / 86_400_000;
  const recency = ageDays < 1 ? 1 : Math.max(0, 1 - Math.log10(ageDays));
  score += recency * 0.5;

  return score;
}

function countReferencesFromTags(envelope: SkillEnvelope): number {
  // No direct count in the envelope; tags may carry a hint.
  const tags = envelope.tags ?? [];
  const refTag = tags.find((t) => typeof t === "string" && t.startsWith("refs:"));
  if (refTag) {
    const n = Number.parseInt(refTag.slice("refs:".length), 10);
    if (Number.isFinite(n)) {
      return n;
    }
  }
  return 0;
}

function sourceAuthorityBonus(envelope: SkillEnvelope): number {
  const sourceTag = envelope.tags?.find((t) => typeof t === "string" && t.startsWith("source:"));
  if (!sourceTag) {
    return 0;
  }
  const url = sourceTag.slice("source:".length);
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return 0;
  }

  // Tiered authority — explicit allowlist of high-signal hosts. Not exhaustive;
  // the goal is to break ties when two scrapers return comparable content.
  if (host === "developer.mozilla.org" || host === "mdn.mozilla.org") return 2;
  if (host === "docs.python.org" || host === "nodejs.org" || host === "kubernetes.io") return 2;
  if (host.startsWith("docs.") || host.startsWith("developer.") || host.startsWith("reference.")) {
    return 1.5;
  }
  if (host === "github.com" || host.endsWith(".github.io")) return 1.5;
  if (host.endsWith(".readthedocs.io") || host.endsWith(".gitbook.io")) return 1.2;
  return 0;
}

// ── Existing-skill discovery ──

async function findExistingByStableId(
  stableId: string,
  opts: ReconcileOptions,
): Promise<FoundSkill | null> {
  // Accepted skills first — they're higher-trust, prefer merging into those.
  const accepted = await scanDir(opts.skillsDir, "accepted", stableId);
  if (accepted) {
    return accepted;
  }
  return scanDir(opts.quarantineDir, "quarantined", stableId);
}

async function scanDir(
  dir: string,
  location: "accepted" | "quarantined",
  stableId: string,
): Promise<FoundSkill | null> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return null;
  }
  for (const entry of entries) {
    const skillDir = path.join(dir, entry);
    const envelopePath = path.join(
      skillDir,
      location === "accepted" ? ".provenance.json" : ".envelope.json",
    );
    let raw: string;
    try {
      raw = await fs.readFile(envelopePath, "utf8");
    } catch {
      continue;
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      continue;
    }
    // For accepted skills, the provenance file contains envelope fields inline.
    // For quarantined skills, it's the full envelope.
    const stable =
      (parsed.stable_skill_id as string | undefined) ??
      (parsed.envelope as { stable_skill_id?: string } | undefined)?.stable_skill_id;
    if (stable !== stableId) {
      continue;
    }

    const skillMdPath = path.join(skillDir, "SKILL.md");
    let bytes = 0;
    try {
      const stat = await fs.stat(skillMdPath);
      bytes = stat.size;
    } catch {
      // No SKILL.md — skip
      continue;
    }

    const referenceCount = await countReferencesOnDisk(skillDir);

    return {
      location,
      directory: skillDir,
      name: entry,
      envelope: normalizeEnvelope(parsed),
      skillMdBytes: bytes,
      referenceCount,
    };
  }
  return null;
}

async function countReferencesOnDisk(skillDir: string): Promise<number> {
  try {
    const refs = await fs.readdir(path.join(skillDir, "references"));
    return refs.filter((f) => f.endsWith(".md")).length;
  } catch {
    return 0;
  }
}

function normalizeEnvelope(raw: Record<string, unknown>): SkillEnvelope {
  // Quarantined files ARE the envelope. Accepted .provenance.json files are a
  // subset — missing skill_md etc. We pad with empty strings so the quality
  // scorer has all the fields it needs.
  const envelope: SkillEnvelope = {
    version: typeof raw.version === "number" ? raw.version : 1,
    skill_md: typeof raw.skill_md === "string" ? raw.skill_md : "",
    name: typeof raw.name === "string" ? raw.name : "",
    author_peer_id: typeof raw.author_peer_id === "string" ? raw.author_peer_id : "",
    author_pubkey: typeof raw.author_pubkey === "string" ? raw.author_pubkey : "",
    signature: typeof raw.signature === "string" ? raw.signature : "",
    timestamp: typeof raw.timestamp === "number" ? raw.timestamp : 0,
    content_hash: typeof raw.content_hash === "string" ? raw.content_hash : "",
    stable_skill_id: typeof raw.stable_skill_id === "string" ? raw.stable_skill_id : undefined,
    skill_version: typeof raw.skill_version === "number" ? raw.skill_version : undefined,
    tags: Array.isArray(raw.tags) ? (raw.tags as string[]) : undefined,
    category: typeof raw.category === "string" ? raw.category : undefined,
    expires_at: typeof raw.expires_at === "number" ? raw.expires_at : undefined,
    provenance: (raw.provenance as Record<string, unknown> | undefined) ?? undefined,
  };
  return envelope;
}

// ── Provenance merge ──

/**
 * When replacing or skipping, preserve historical knowledge from the existing
 * skill. Specifically:
 *   - accumulate `source_urls` so future reconciliations see all scraped origins
 *   - preserve the earliest `first_seen_at` timestamp
 *   - bump `reconcile_count` so we can see how contested this skill is
 */
export function mergeProvenance(
  existing: SkillEnvelope,
  incoming: SkillEnvelope,
): Record<string, unknown> {
  const merged: Record<string, unknown> = {
    ...existing.provenance,
    ...incoming.provenance,
  };

  const existingUrls = extractSourceUrls(existing);
  const incomingUrls = extractSourceUrls(incoming);
  const urls = Array.from(new Set([...existingUrls, ...incomingUrls]));
  if (urls.length > 0) {
    merged.source_urls = urls;
  }

  const firstSeen =
    (existing.provenance as { first_seen_at?: number } | undefined)?.first_seen_at ??
    existing.timestamp;
  if (typeof firstSeen === "number" && firstSeen > 0) {
    merged.first_seen_at = firstSeen;
  }

  const existingCount =
    (existing.provenance as { reconcile_count?: number } | undefined)?.reconcile_count ?? 0;
  merged.reconcile_count = existingCount + 1;
  merged.last_reconciled_at = Date.now();

  return merged;
}

function extractSourceUrls(envelope: SkillEnvelope): string[] {
  const urls: string[] = [];
  const singleUrl = (envelope.provenance as { source_url?: string } | undefined)?.source_url;
  if (typeof singleUrl === "string") {
    urls.push(singleUrl);
  }
  const manyUrls = (envelope.provenance as { source_urls?: string[] } | undefined)?.source_urls;
  if (Array.isArray(manyUrls)) {
    for (const u of manyUrls) {
      if (typeof u === "string") {
        urls.push(u);
      }
    }
  }
  const tags = envelope.tags ?? [];
  for (const tag of tags) {
    if (typeof tag === "string" && tag.startsWith("source:")) {
      urls.push(tag.slice("source:".length));
    }
  }
  return urls;
}
