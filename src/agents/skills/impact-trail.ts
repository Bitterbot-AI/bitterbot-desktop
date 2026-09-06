/**
 * Skill impact trail — the append-only audit record of every skill mutation
 * attempt, successful or not (PLAN-42 Phase 0).
 *
 * This is the first slice of the WikiSkill wiki layer: `skill-impact.md`
 * plus a machine-readable `.provenance.jsonl` mirror, both living under
 * CONFIG_DIR/skill-wiki/. Later phases add patterns/, index.md and logs.md
 * beside it. Two invariants, enforced here and relied on everywhere else:
 *
 *   1. Append-only. Entries are never rewritten or deleted; when a file
 *      exceeds its size cap it is rolled aside (renamed with a timestamp)
 *      and a fresh file continues the trail. History is never lost.
 *   2. The trail is written PROGRAMMATICALLY by the harness — never by an
 *      LLM. Consumers (the future Skill Proposer, operators, doctors) can
 *      trust that verdicts and scores here reflect what the gate actually
 *      decided, not what a model claims happened.
 *
 * Every path that creates or mutates a live skill must record here,
 * including the deliberately-ungated human editor path, so the trail is a
 * complete history of how the live skill set came to be.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { CONFIG_DIR } from "../../utils.js";

const log = createSubsystemLogger("skills/impact-trail");

export const WIKI_SUBDIR = "skill-wiki";
export const IMPACT_FILENAME = "skill-impact.md";
export const PROVENANCE_FILENAME = ".provenance.jsonl";

/** Roll the markdown trail aside past this size (history retained on disk). */
const IMPACT_MAX_BYTES = 2 * 1024 * 1024;
/** Roll the JSONL mirror aside past this size. */
const PROVENANCE_MAX_BYTES = 1024 * 1024;
/** Cap embedded diffs/content so one entry cannot blow the file cap. */
const MAX_EMBED_CHARS = 8_000;

export type ImpactSource =
  | "crystallize"
  | "editor"
  | "guards"
  | "skill-manage"
  | "curator"
  | "evolution";

export type ImpactVerdict =
  | "accepted"
  | "rejected"
  | "gate-failed"
  | "ungated-human-edit"
  | "rolled-back"
  | "no-action"
  /** Proposal passed the staging gate and awaits the validation gate. */
  | "staged"
  /** PLAN-45 2.6: the gate measured the proposal and held it (retryable). */
  | "held"
  /** PLAN-45 Phase 3: a stable skill sent back to a canary window (model drift). */
  | "canary";

export interface ImpactEntry {
  /** Which subsystem produced the mutation attempt. */
  source: ImpactSource;
  /** Mutation kind (create / edit / patch / promote / rollback / ...). */
  action: string;
  skillName: string;
  verdict: ImpactVerdict;
  /** Free-form context: gate summary, reason, author. */
  detail?: string;
  /** Validation score, when a scored gate ran. */
  score?: number;
  /** Unified diff or full content of the proposal (capped on write). */
  diff?: string;
  /** Evolution iteration tag, when applicable. */
  iteration?: string;
  /** Model the mutation was validated under, when applicable. */
  model?: string;
  /** SHA-1 of the proposed content — rejection dedup key. */
  contentHash?: string;
  /** PLAN-45 2.6: gate statistics kept in the JSONL mirror (pValue, wins, losses, meanDelta, readRate, tokenDelta). */
  stats?: Record<string, number | null>;
  /** Override timestamp (test determinism). */
  timestamp?: number;
}

export interface ImpactTrailOptions {
  /** Defaults to CONFIG_DIR. Tests override with a tmp dir. */
  configDir?: string;
}

export function resolveWikiDir(opts: ImpactTrailOptions = {}): string {
  return path.join(opts.configDir ?? CONFIG_DIR, WIKI_SUBDIR);
}

export function impactTrailPath(opts: ImpactTrailOptions = {}): string {
  return path.join(resolveWikiDir(opts), IMPACT_FILENAME);
}

export function provenancePath(opts: ImpactTrailOptions = {}): string {
  return path.join(resolveWikiDir(opts), PROVENANCE_FILENAME);
}

const IMPACT_HEADER = `# Skill Impact Trail

Append-only record of every skill mutation attempt on this node, written by
the harness after each gate decision. Rejected proposals stay here so later
proposers do not re-propose them. Never edit this file by hand.
`;

function truncateEmbed(text: string): string {
  if (text.length <= MAX_EMBED_CHARS) {
    return text;
  }
  return `${text.slice(0, MAX_EMBED_CHARS)}\n... [truncated ${text.length - MAX_EMBED_CHARS} chars]`;
}

function formatEntryMarkdown(entry: ImpactEntry, ts: number): string {
  const iso = new Date(ts).toISOString();
  const lines: string[] = [
    `### ${iso} [${entry.source}] action=${entry.action} skill=\`${entry.skillName}\` verdict=${entry.verdict}`,
  ];
  if (typeof entry.score === "number") {
    lines.push(`- score: ${entry.score}`);
  }
  if (entry.model) {
    lines.push(`- model: ${entry.model}`);
  }
  if (entry.iteration) {
    lines.push(`- iteration: ${entry.iteration}`);
  }
  if (entry.detail) {
    lines.push(`- detail: ${entry.detail.replace(/\r?\n/g, " ").trim()}`);
  }
  if (entry.stats) {
    lines.push(`- stats: ${JSON.stringify(entry.stats)}`);
  }
  if (entry.diff) {
    lines.push("", "```diff", truncateEmbed(entry.diff), "```");
  }
  lines.push("");
  return lines.join("\n");
}

async function fileSize(filePath: string): Promise<number> {
  try {
    const stat = await fs.stat(filePath);
    return stat.size;
  } catch {
    return 0;
  }
}

/**
 * Roll a trail file aside when it exceeds its cap. The rolled file keeps its
 * full content under a timestamped name; the fresh file continues appending.
 */
async function rollIfNeeded(filePath: string, maxBytes: number): Promise<void> {
  const size = await fileSize(filePath);
  if (size < maxBytes) {
    return;
  }
  const rolled = `${filePath}.${Date.now()}.rolled`;
  try {
    await fs.rename(filePath, rolled);
    log.info(`rolled ${path.basename(filePath)} aside to ${path.basename(rolled)} (${size} bytes)`);
  } catch (err) {
    // Roll failure must never block trail writes; keep appending to the
    // oversized file rather than dropping the entry.
    log.warn(`failed to roll ${filePath}: ${String(err)}`);
  }
}

/**
 * Append one entry to the impact trail (markdown + JSONL mirror). Failures
 * are logged and swallowed: the trail must never break the mutation path it
 * observes. Returns true when both writes landed.
 */
export async function appendImpactEntry(
  entry: ImpactEntry,
  opts: ImpactTrailOptions = {},
): Promise<boolean> {
  const ts = entry.timestamp ?? Date.now();
  const dir = resolveWikiDir(opts);
  const mdPath = impactTrailPath(opts);
  const jsonlPath = provenancePath(opts);
  try {
    await fs.mkdir(dir, { recursive: true });
    await rollIfNeeded(mdPath, IMPACT_MAX_BYTES);
    await rollIfNeeded(jsonlPath, PROVENANCE_MAX_BYTES);
    const mdExists = (await fileSize(mdPath)) > 0;
    const mdBlock = formatEntryMarkdown(entry, ts);
    await fs.appendFile(
      mdPath,
      mdExists ? `${mdBlock}\n` : `${IMPACT_HEADER}\n${mdBlock}\n`,
      "utf-8",
    );
    const record = {
      ts,
      source: entry.source,
      action: entry.action,
      skillName: entry.skillName,
      verdict: entry.verdict,
      ...(typeof entry.score === "number" ? { score: entry.score } : {}),
      ...(entry.model ? { model: entry.model } : {}),
      ...(entry.iteration ? { iteration: entry.iteration } : {}),
      ...(entry.detail ? { detail: entry.detail } : {}),
      ...(entry.diff ? { diffChars: entry.diff.length, diffHead: entry.diff.slice(0, 240) } : {}),
      ...(entry.contentHash ? { contentHash: entry.contentHash } : {}),
      ...(entry.stats ? { stats: entry.stats } : {}),
    };
    await fs.appendFile(jsonlPath, `${JSON.stringify(record)}\n`, "utf-8");
    return true;
  } catch (err) {
    log.warn(`failed to append impact entry for ${entry.skillName}: ${String(err)}`);
    return false;
  }
}

/** Read the machine mirror back (for tests, doctors, and the proposer). */
export async function readProvenance(
  opts: ImpactTrailOptions = {},
): Promise<Array<Record<string, unknown>>> {
  try {
    const text = await fs.readFile(provenancePath(opts), "utf-8");
    const out: Array<Record<string, unknown>> = [];
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      try {
        out.push(JSON.parse(trimmed) as Record<string, unknown>);
      } catch {
        // skip torn line
      }
    }
    return out;
  } catch {
    return [];
  }
}
