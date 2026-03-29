/**
 * Session Handover Briefs
 *
 * Structured summaries generated at session boundaries that capture the
 * working state: purpose, milestones, decisions, blockers, and next steps.
 *
 * When a new session starts, the most recent handover brief is loaded into
 * the Working Memory synthesis context, giving the agent instantaneous
 * continuity without requiring the user to re-explain context.
 *
 * Briefs are stored both as:
 * - Markdown files in `memory/handover/YYYY-MM-DD-HH.md` (human-readable)
 * - Chunks in the database with semantic_type='episode' (searchable)
 */

import path from "node:path";
import fs from "node:fs/promises";

export type SessionHandoverBrief = {
  sessionId: string;
  purpose: string;
  milestones: string[];
  decisions: string[];
  blockers: string[];
  nextSteps: string[];
  timestamp: number;
};

/**
 * Format a handover brief as a markdown document for disk storage.
 */
export function formatHandoverBrief(brief: SessionHandoverBrief): string {
  const date = new Date(brief.timestamp);
  const lines: string[] = [
    `# Session Handover Brief`,
    `**Date:** ${date.toISOString()}`,
    `**Session:** ${brief.sessionId}`,
    "",
    `## Purpose`,
    brief.purpose,
    "",
  ];

  if (brief.milestones.length > 0) {
    lines.push(`## Milestones Achieved`);
    for (const m of brief.milestones) lines.push(`- ${m}`);
    lines.push("");
  }

  if (brief.decisions.length > 0) {
    lines.push(`## Decisions Made`);
    for (const d of brief.decisions) lines.push(`- ${d}`);
    lines.push("");
  }

  if (brief.blockers.length > 0) {
    lines.push(`## Open Blockers`);
    for (const b of brief.blockers) lines.push(`- ${b}`);
    lines.push("");
  }

  if (brief.nextSteps.length > 0) {
    lines.push(`## Next Steps`);
    for (const s of brief.nextSteps) lines.push(`- ${s}`);
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Generate the filename for a handover brief based on its timestamp.
 */
export function handoverFilename(timestamp: number): string {
  const d = new Date(timestamp);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}-${hh}.md`;
}

/**
 * Get the full path for a handover brief file within a workspace.
 */
export function handoverPath(workspaceDir: string, timestamp: number): string {
  return path.join(workspaceDir, "memory", "handover", handoverFilename(timestamp));
}

/**
 * Convert a handover brief to a single text chunk for database storage.
 */
export function briefToChunkText(brief: SessionHandoverBrief): string {
  const parts: string[] = [
    `Session Handover: ${brief.purpose}`,
  ];
  if (brief.milestones.length > 0) {
    parts.push(`Milestones: ${brief.milestones.join("; ")}`);
  }
  if (brief.decisions.length > 0) {
    parts.push(`Decisions: ${brief.decisions.join("; ")}`);
  }
  if (brief.blockers.length > 0) {
    parts.push(`Blockers: ${brief.blockers.join("; ")}`);
  }
  if (brief.nextSteps.length > 0) {
    parts.push(`Next steps: ${brief.nextSteps.join("; ")}`);
  }
  return parts.join("\n");
}

/**
 * Condense a handover brief into a compact 1-2 line summary for system prompt injection.
 * Max ~200 chars to keep token budget low.
 */
export function formatCompactSummary(brief: SessionHandoverBrief): string {
  const date = new Date(brief.timestamp);
  const dateStr = `${date.getMonth() + 1}/${date.getDate()}`;

  const highlights = [
    ...brief.milestones.slice(0, 2),
    ...brief.decisions.slice(0, 1),
  ];
  const highlightStr = highlights.length > 0 ? ` Key: ${highlights.join("; ")}` : "";

  const nextStr = brief.nextSteps.length > 0
    ? ` Next: ${brief.nextSteps[0]}`
    : "";

  const summary = `[${dateStr}] ${brief.purpose}.${highlightStr}.${nextStr}`;

  // Truncate gracefully at ~200 chars
  if (summary.length <= 200) return summary;
  return summary.slice(0, 197) + "...";
}

/**
 * Parse a handover brief markdown file back into a structured object.
 */
export function parseHandoverBrief(markdown: string, sessionId?: string): SessionHandoverBrief | null {
  const purposeMatch = markdown.match(/## Purpose\n([^\n]+)/);
  if (!purposeMatch) return null;

  const extractList = (header: string): string[] => {
    const re = new RegExp(`## ${header}\\n([\\s\\S]*?)(?=\\n## |$)`);
    const match = markdown.match(re);
    if (!match) return [];
    return match[1]
      .split("\n")
      .map((l) => l.replace(/^- /, "").trim())
      .filter((l) => l.length > 0);
  };

  const dateMatch = markdown.match(/\*\*Date:\*\*\s*(\S+)/);
  const timestamp = dateMatch ? new Date(dateMatch[1]).getTime() : Date.now();

  const sessionMatch = markdown.match(/\*\*Session:\*\*\s*(.+)/);

  return {
    sessionId: sessionId ?? sessionMatch?.[1]?.trim() ?? "unknown",
    purpose: purposeMatch[1].trim(),
    milestones: extractList("Milestones Achieved"),
    decisions: extractList("Decisions Made"),
    blockers: extractList("Open Blockers"),
    nextSteps: extractList("Next Steps"),
    timestamp: Number.isNaN(timestamp) ? Date.now() : timestamp,
  };
}

/**
 * Load the most recent handover brief from disk.
 * Returns null if no handover briefs exist.
 */
export async function loadLatestHandoverBrief(workspaceDir: string): Promise<SessionHandoverBrief | null> {
  const handoverDir = path.join(workspaceDir, "memory", "handover");
  try {
    const entries = await fs.readdir(handoverDir);
    const mdFiles = entries
      .filter((name) => name.endsWith(".md"))
      .sort(); // YYYY-MM-DD-HH.md sorts chronologically

    if (mdFiles.length === 0) return null;

    const latestFile = mdFiles[mdFiles.length - 1]!;
    const content = await fs.readFile(path.join(handoverDir, latestFile), "utf-8");
    return parseHandoverBrief(content);
  } catch {
    // No handover directory or read error — no briefs yet
    return null;
  }
}

// ── Plan 7, Phase 6: Handover Brief Quality Gate ──

export interface HandoverQualityScore {
  coverage: number;
  specificity: number;
  overall: number;
  missingFacts: string[];
}

/** Minimum quality threshold. Below this, the brief should be enriched. */
export const HANDOVER_QUALITY_THRESHOLD = 0.4;

/**
 * Score a handover brief against extracted session facts.
 *
 * Coverage: for each high-confidence fact, check if the brief text
 * contains significant keyword overlap (>30% of fact's content words).
 *
 * Specificity: count concrete tokens (proper nouns, numbers, technical terms)
 * as a ratio of total tokens.
 */
export function scoreHandoverBrief(
  brief: SessionHandoverBrief,
  extractedFacts: Array<{ text: string; confidence: number }>,
  minConfidence: number = 0.5,
): HandoverQualityScore {
  const briefText = [
    brief.purpose,
    ...brief.milestones,
    ...brief.decisions,
    ...brief.blockers,
    ...brief.nextSteps,
  ]
    .join(" ")
    .toLowerCase();

  const briefWords = new Set(
    briefText.split(/\s+/).filter((w) => w.length > 3),
  );

  const keyFacts = extractedFacts.filter((f) => f.confidence >= minConfidence);
  let covered = 0;
  const missingFacts: string[] = [];

  for (const fact of keyFacts) {
    const factWords = fact.text
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 3);
    const overlap = factWords.filter((w) => briefWords.has(w)).length;
    const overlapRatio = factWords.length > 0 ? overlap / factWords.length : 0;
    if (overlapRatio >= 0.3) {
      covered++;
    } else {
      missingFacts.push(fact.text);
    }
  }

  const coverage = keyFacts.length > 0 ? covered / keyFacts.length : 1.0;

  // Specificity: concrete detail density
  const allBriefWords = briefText.split(/\s+/);
  const concretePattern = /^(?:[A-Z][a-z]+|[0-9]+(?:\.[0-9]+)?|v[0-9]|[A-Z]{2,}|https?:)/;
  const concreteCount = allBriefWords.filter((w) => concretePattern.test(w)).length;
  const specificity =
    allBriefWords.length > 0
      ? Math.min(1, concreteCount / (allBriefWords.length * 0.15))
      : 0;

  const overall = coverage * 0.7 + specificity * 0.3;

  return { coverage, specificity, overall, missingFacts };
}
