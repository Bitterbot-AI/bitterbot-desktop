/**
 * PLAN-45 2.6 (I11): rejected-edit memory for the proposer.
 *
 * SkillOpt keeps a buffer of rejected edits with their score drops and hands
 * it to the optimizer; GEPA records ancestry for every candidate. Here the
 * provenance trail (.provenance.jsonl) already holds every gate verdict per
 * skill name, which is the lineage key. This module renders the last few
 * verdicts per lineage as a `## Previously tried` block the proposer reads
 * before it proposes, and counts a lineage's measured attempts for alpha
 * spending.
 */

import { fenceUntrusted } from "./traces.js";

export const PREVIOUSLY_TRIED_PER_LINEAGE = 5;
export const PREVIOUSLY_TRIED_MAX_LINEAGES = 8;
export const PREVIOUSLY_TRIED_MAX_CHARS = 6_000;
/** Lineages with a verdict older than this are left to the on-demand impact file. */
export const PREVIOUSLY_TRIED_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export type ProvenanceRow = Record<string, unknown>;

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}
function rowTs(r: ProvenanceRow): number | null {
  return num(r.ts) ?? num(r.timestamp);
}

/** Lineage history rows: gate verdicts plus PLAN-45 Phase 3 monitor demotions, oldest first. */
const LINEAGE_ACTIONS = new Set(["validate", "rollback", "retire"]);

/** Gate verdicts (source evolution, action validate / rollback / retire) for one lineage, oldest first. */
export function lineageVerdicts(provenance: ProvenanceRow[], skillName: string): ProvenanceRow[] {
  return provenance
    .filter(
      (r) =>
        r.source === "evolution" &&
        LINEAGE_ACTIONS.has(str(r.action)) &&
        r.skillName === skillName &&
        rowTs(r) !== null,
    )
    .toSorted((a, b) => (rowTs(a) as number) - (rowTs(b) as number));
}

/** Measured attempts (accepted / rejected / held) a lineage has consumed. */
export function lineageAttempts(provenance: ProvenanceRow[], skillName: string): number {
  return lineageVerdicts(provenance, skillName).filter((r) =>
    ["accepted", "rejected", "held"].includes(str(r.verdict)),
  ).length;
}

function formatStats(r: ProvenanceRow): string {
  const stats = (r.stats ?? {}) as Record<string, unknown>;
  const parts: string[] = [];
  const delta = num(stats.meanDelta) ?? num(r.score);
  if (delta !== null) {
    parts.push(`delta ${delta >= 0 ? "+" : ""}${delta.toFixed(2)}`);
  }
  const p = num(stats.pValue);
  if (p !== null) {
    parts.push(`p=${p.toFixed(3)}`);
  }
  const w = num(stats.wins);
  const l = num(stats.losses);
  if (w !== null && l !== null) {
    parts.push(`w${w}/l${l}`);
  }
  const rr = num(stats.readRate);
  if (rr !== null) {
    parts.push(`reads ${rr.toFixed(2)}`);
  }
  const td = num(stats.tokenDelta);
  if (td !== null) {
    parts.push(`tokens ${td >= 0 ? "+" : ""}${(td * 100).toFixed(0)}%`);
  }
  return parts.join(", ");
}

function reasonOf(r: ProvenanceRow): string {
  const detail = str(r.detail);
  // "tasks: never-triggered; incumbent ..." -> "never-triggered"
  const m = /^(?:tasks|records):\s*([a-z-]+)/i.exec(detail);
  if (m) {
    return m[1] as string;
  }
  return detail.split(";")[0]?.slice(0, 80) ?? "";
}

/**
 * The `## Previously tried` block: for every lineage with a verdict in the
 * window (or in `focus`), its last `PREVIOUSLY_TRIED_PER_LINEAGE` verdicts,
 * newest first, with the statistics the gate recorded and the head of the
 * rejected content. Everything model-authored is fenced as untrusted.
 * Empty string when nothing was tried.
 */
export function buildPreviouslyTried(
  provenance: ProvenanceRow[],
  opts: { now?: number; focus?: readonly string[]; maxChars?: number } = {},
): string {
  const now = opts.now ?? Date.now();
  const since = now - PREVIOUSLY_TRIED_WINDOW_MS;
  const names = new Set<string>(opts.focus ?? []);
  for (const r of provenance) {
    if (r.source === "evolution" && r.action === "validate" && (rowTs(r) ?? 0) >= since) {
      names.add(str(r.skillName));
    }
  }
  const lineages = [...names]
    .filter((n) => n.length > 0)
    .map((name) => ({ name, verdicts: lineageVerdicts(provenance, name) }))
    .filter((l) => l.verdicts.length > 0)
    .toSorted(
      (a, b) => (rowTs(b.verdicts.at(-1)!) as number) - (rowTs(a.verdicts.at(-1)!) as number),
    )
    .slice(0, PREVIOUSLY_TRIED_MAX_LINEAGES);
  if (lineages.length === 0) {
    return "";
  }
  const maxChars = opts.maxChars ?? PREVIOUSLY_TRIED_MAX_CHARS;
  const out: string[] = [
    "## Previously tried (gate verdicts per skill; do NOT re-propose a rejected approach)",
  ];
  for (const l of lineages) {
    const attempts = lineageAttempts(provenance, l.name);
    const last = new Date(rowTs(l.verdicts.at(-1)!) as number).toISOString().slice(0, 10);
    out.push(
      `### ${l.name} (${attempts} measured attempt${attempts === 1 ? "" : "s"}, last ${last})`,
    );
    for (const r of l.verdicts.slice(-PREVIOUSLY_TRIED_PER_LINEAGE).toReversed()) {
      const day = new Date(rowTs(r) as number).toISOString().slice(0, 10);
      const verdict = str(r.verdict).toUpperCase();
      const stats = formatStats(r);
      const hash = str(r.contentHash).slice(0, 8);
      const head = str(r.diffHead);
      out.push(
        `- ${day} ${verdict} ${reasonOf(r)}${stats ? ` (${stats})` : ""}${hash ? `; content ${hash}` : ""}${
          head ? `; begins: ${fenceUntrusted(head.replace(/\s+/g, " ").slice(0, 200))}` : ""
        }`,
      );
    }
    if (out.join("\n").length > maxChars) {
      out.push("- … (older lineages omitted; read skill-impact.md for the rest)");
      break;
    }
  }
  return out.join("\n");
}
