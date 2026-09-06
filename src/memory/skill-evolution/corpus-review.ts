/**
 * PLAN-44 Phase 2: the corpus review surface.
 *
 * The corpus miner only ever DRAFTS capability tasks into
 * `skill-wiki/task-corpus-pending.jsonl`. Until this module existed the
 * only way to promote a draft into the live corpus (`task-corpus.jsonl`)
 * was to edit the file by hand, so tasks mode held every proposal forever
 * on this node (audit finding). Review is a human act: `accept` re-checks
 * every draft the way the miner did, refuses anything non-hermetic
 * (absolute paths, network verbs, injection hits), stamps the reviewer,
 * and appends; `reject` records the id so the miner never redrafts it.
 * Nothing else writes `task-corpus.jsonl`.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { resolveWikiDir, type ImpactTrailOptions } from "../../agents/skills/impact-trail.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { scanSkillForInjection } from "../../security/skill-injection-scanner.js";
import { generateCanonicalCorpus } from "./canonical-corpus.js";
import { pendingCorpusPath } from "./corpus-miner.js";
import { atomicWriteFile } from "./fs-atomic.js";
import { type CorpusTask, corpusPath, MAX_CORPUS_TASKS, parseCorpusTasks } from "./task-corpus.js";

/** Grown tasks the effective corpus actually runs (canonical tasks fill the rest of MAX_CORPUS_TASKS). */
export function grownCorpusBudget(): number {
  return Math.max(0, MAX_CORPUS_TASKS - generateCanonicalCorpus(0).tasks.length);
}

const log = createSubsystemLogger("skill-evolution/corpus-review");

export const REJECTED_CORPUS_FILENAME = "task-corpus-rejected.jsonl";

export function rejectedCorpusPath(opts: ImpactTrailOptions = {}): string {
  return path.join(resolveWikiDir(opts), REJECTED_CORPUS_FILENAME);
}

/** Reasons a draft cannot be accepted; surfaced to the reviewer as hints. */
export type DraftFlag =
  | "absolute-path"
  | "network-verb"
  | "injection"
  | "checker-looks-like-error"
  | "prompt-too-long"
  | "not-final-checker";

const ABSOLUTE_PATH_RE =
  /(?:^|[\s"'`(=:])(?:\/(?:tmp|home|etc|var|usr|root|opt|mnt|proc|sys|dev)\b|~\/|\$HOME|\$\{HOME\}|\.\.\/)/;
const NETWORK_VERB_RE =
  /\b(curl|wget|fetch|ssh|scp|sftp|nc|ncat|netcat|socat|telnet|rsync|ftp|dig|nslookup|git\s+clone|docker|aws|gcloud|pip\s+install|npm\s+install|apt(-get)?\s+install|http\.server|urllib|requests\.get|import\s+socket)\b|https?:\/\/|\/dev\/tcp/i;
const ERROR_LIKE_RE = /^(fatal:|ENOENT|Error:|Traceback|Command exited)/i;

export interface ReviewableDraft {
  id: string;
  prompt: string;
  checker: CorpusTask["checker"];
  tags: string[];
  flags: DraftFlag[];
  /** True when `accept` would take it as-is. */
  acceptable: boolean;
}

/** Hermeticity + safety flags for one draft. Pure. */
export function flagDraft(task: CorpusTask): DraftFlag[] {
  const flags: DraftFlag[] = [];
  if (task.checker.kind !== "final") {
    flags.push("not-final-checker");
  }
  if (task.prompt.length > 2_000) {
    flags.push("prompt-too-long");
  }
  const scanned = `${task.prompt}\n${task.checker.value}`;
  if (ABSOLUTE_PATH_RE.test(scanned)) {
    // A trial runs in a fresh scratch workspace; a prompt that names
    // /tmp/... or /home/... escapes it and leaks state between trials.
    flags.push("absolute-path");
  }
  if (NETWORK_VERB_RE.test(scanned)) {
    flags.push("network-verb");
  }
  if (ERROR_LIKE_RE.test(task.checker.value)) {
    // "FINAL: fatal: not a git repository ..." rewards reproducing an error
    // string verbatim, which is brittle across tool versions and teaches
    // nothing; the reviewer should rewrite the checker to a stable value.
    flags.push("checker-looks-like-error");
  }
  const scan = scanSkillForInjection(`${task.prompt}\n${task.checker.value}`);
  if (scan.severity === "critical" || scan.severity === "medium") {
    flags.push("injection");
  }
  return flags;
}

async function readJsonl(file: string): Promise<string> {
  try {
    return await fs.readFile(file, "utf-8");
  } catch {
    return "";
  }
}

/** Pending drafts with review hints, in file order. */
export async function listPendingDrafts(opts: ImpactTrailOptions = {}): Promise<ReviewableDraft[]> {
  const raw = await readJsonl(pendingCorpusPath(opts));
  return parseCorpusTasks(raw, { maxTasks: 500 }).map((task) => {
    const flags = flagDraft(task);
    return {
      id: task.id,
      prompt: task.prompt,
      checker: task.checker,
      tags: task.tags ?? [],
      flags,
      acceptable: flags.length === 0,
    };
  });
}

/** Ids the miner must never redraft: everything already reviewed either way. */
export async function reviewedDraftIds(opts: ImpactTrailOptions = {}): Promise<Set<string>> {
  const rejected = await readJsonl(rejectedCorpusPath(opts));
  const live = await readJsonl(corpusPath(opts));
  const ids = new Set<string>();
  for (const line of `${rejected}\n${live}`.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const id = (JSON.parse(trimmed) as { id?: unknown }).id;
      if (typeof id === "string") {
        ids.add(id);
      }
    } catch {
      // skip torn line
    }
  }
  return ids;
}

async function rewritePending(keep: CorpusTask[], opts: ImpactTrailOptions): Promise<void> {
  const p = pendingCorpusPath(opts);
  await atomicWriteFile(p, keep.length ? `${keep.map((t) => JSON.stringify(t)).join("\n")}\n` : "");
}

export interface AcceptResult {
  accepted: string[];
  refused: Array<{ id: string; reason: string }>;
  liveTaskCount: number;
}

/**
 * Promote reviewed drafts into the live capability suite. Every id is
 * re-flagged at accept time (the file may have changed since listing);
 * flagged drafts are refused with the reason, never silently skipped.
 */
export async function acceptDrafts(
  ids: string[],
  params: { reviewedBy: string } & ImpactTrailOptions = { reviewedBy: "operator" },
): Promise<AcceptResult> {
  const opts: ImpactTrailOptions = params.configDir ? { configDir: params.configDir } : {};
  const pendingRaw = await readJsonl(pendingCorpusPath(opts));
  const pending = parseCorpusTasks(pendingRaw, { maxTasks: 500 });
  const liveRaw = await readJsonl(corpusPath(opts));
  const live = parseCorpusTasks(liveRaw, { maxTasks: MAX_CORPUS_TASKS * 2 });
  const liveIds = new Set(live.map((t) => t.id));
  const wanted = new Set(ids);
  const accepted: string[] = [];
  const refused: AcceptResult["refused"] = [];
  const lines: string[] = [];
  let liveCount = live.length;
  for (const id of ids) {
    const task = pending.find((t) => t.id === id);
    if (!task) {
      refused.push({ id, reason: "not in pending file" });
      continue;
    }
    if (liveIds.has(id)) {
      refused.push({ id, reason: "already in the live corpus" });
      continue;
    }
    const flags = flagDraft(task);
    if (flags.length > 0) {
      refused.push({ id, reason: `flagged: ${flags.join(", ")}` });
      continue;
    }
    if (liveCount >= grownCorpusBudget()) {
      // Adversarial M4: loadEffectiveCorpus only runs this many grown tasks.
      refused.push({
        id,
        reason: `live corpus is at its cap (${grownCorpusBudget()} grown tasks)`,
      });
      continue;
    }
    lines.push(
      JSON.stringify({
        id: task.id,
        prompt: task.prompt,
        checker: task.checker,
        suite: "capability",
        tags: [...new Set([...(task.tags ?? []), "reviewed"])],
        ...(task.sourceRunId ? { sourceRunId: task.sourceRunId } : {}),
        ...(task.sourceIteration ? { sourceIteration: task.sourceIteration } : {}),
        reviewedBy: params.reviewedBy,
        reviewedAt: new Date().toISOString(),
      }),
    );
    accepted.push(id);
    liveIds.add(id);
    liveCount += 1;
  }
  if (lines.length > 0) {
    const p = corpusPath(opts);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.appendFile(p, `${lines.join("\n")}\n`, "utf-8");
    await rewritePending(
      pending.filter((t) => !accepted.includes(t.id)),
      opts,
    );
    log.info(`corpus review: accepted ${accepted.join(", ")} (live corpus now ${liveCount})`);
  }
  // Ids that were requested but neither accepted nor refused cannot exist;
  // keep the invariant explicit.
  for (const id of wanted) {
    if (!accepted.includes(id) && !refused.some((r) => r.id === id)) {
      refused.push({ id, reason: "unhandled" });
    }
  }
  return { accepted, refused, liveTaskCount: liveCount };
}

export interface RejectResult {
  rejected: string[];
  missing: string[];
}

/** Drop drafts from the pending file and remember the ids so the miner never redrafts them. */
export async function rejectDrafts(
  ids: string[],
  params: { reviewedBy: string; reason?: string } & ImpactTrailOptions = { reviewedBy: "operator" },
): Promise<RejectResult> {
  const opts: ImpactTrailOptions = params.configDir ? { configDir: params.configDir } : {};
  const pending = parseCorpusTasks(await readJsonl(pendingCorpusPath(opts)), { maxTasks: 500 });
  const present = new Set(pending.map((t) => t.id));
  const rejected = ids.filter((id) => present.has(id));
  const missing = ids.filter((id) => !present.has(id));
  if (rejected.length > 0) {
    const p = rejectedCorpusPath(opts);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.appendFile(
      p,
      `${rejected
        .map((id) =>
          JSON.stringify({
            id,
            rejectedBy: params.reviewedBy,
            rejectedAt: new Date().toISOString(),
            ...(params.reason ? { reason: params.reason } : {}),
          }),
        )
        .join("\n")}\n`,
      "utf-8",
    );
    await rewritePending(
      pending.filter((t) => !rejected.includes(t.id)),
      opts,
    );
    log.info(`corpus review: rejected ${rejected.join(", ")}`);
  }
  return { rejected, missing };
}
