/**
 * PLAN-64 Phase 1b: owner-triggered backfill of follow-up candidates from
 * the session transcripts that already exist.
 *
 * `bitterbot memory practices backfill` replays the agent's transcripts
 * (live and `.reset` archives, never `.deleted` ones) through the same
 * task typing and the same follow-up gap logic the reply path uses, and
 * lists the candidate practices it would create with their evidence.
 *
 * Read-only by default. The replay runs against a scratch in-memory
 * database seeded with the live recurring task types and practices, so the
 * dry run applies exactly the rules a write would (matching, the owner's
 * standing no, repeats of an active practice) without writing anything.
 * With `apply`, the same recorded gaps are written to the live store as
 * `candidate` rows with origin `backfill`. Never active: the owner confirms
 * a candidate through the normal offer or the RPC.
 *
 * Model calls: at most `maxCalls` in total (naming or merging the task
 * types the replay found, largest first, then one call per candidate
 * follow-up: the owner's next message after an answer, see pass 2). The
 * caller is told the counts before the first call (`onPlan`).
 */

import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  type CorrectionLlmCall,
  isExplicitStandingInstruction,
  resolveUserMessageEvidenceRef,
  stripNonProse,
} from "./correction-capture.js";
import { yieldToEventLoop } from "./event-loop.js";
import { ensureMemoryIndexSchema } from "./memory-schema.js";
import {
  buildFollowUpGapPrompt,
  countIndependentSightings,
  FOLLOW_UP_WINDOW_MS,
  type GapSightingInput,
  parseFollowUpGap,
  recordGapSighting,
} from "./practice-followups.js";
import {
  type Practice,
  practiceDayKey,
  PracticesStore,
  practiceStatementHash,
} from "./practices.js";
import { extractSessionText } from "./session-files.js";
import { stripMessageEnvelope, type TaskType, TaskTypesStore } from "./task-types.js";

const log = createSubsystemLogger("memory/practice-backfill");

export const BACKFILL_DEFAULT_MAX_CALLS = 40;

/**
 * Turns that are not the owner typing: cron fires, heartbeats, system
 * events, subagent announcements. As far as transcript text allows, the
 * trust skips of the correction capture.
 */
const NOT_OWNER_RX =
  /^\s*(\[cron[:\s]|\[heartbeat|HEARTBEAT|\[system|System:|\[subagent|\[task[:\s]|Read HEARTBEAT\.md)/i;

/** A transcript file the backfill reads: live or `.reset` archive, never a deleted one. */
export function isBackfillTranscript(name: string): boolean {
  if (name.includes(".deleted")) {
    return false;
  }
  return name.endsWith(".jsonl") || /\.jsonl\.reset\./.test(name);
}

type Message = { role: "user" | "assistant"; text: string; ts: number };

async function readTranscript(absPath: string): Promise<Message[]> {
  const out: Message[] = [];
  let raw: string;
  let fallbackTs: number;
  try {
    raw = await fs.readFile(absPath, "utf-8");
    fallbackTs = (await fs.stat(absPath)).mtimeMs;
  } catch (err) {
    log.debug(`transcript unreadable: ${String(err)}`);
    return out;
  }
  for (const line of raw.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    let record: {
      type?: unknown;
      timestamp?: unknown;
      message?: { role?: unknown; content?: unknown; timestamp?: unknown };
    };
    try {
      record = JSON.parse(line) as typeof record;
    } catch {
      continue;
    }
    const role = record?.message?.role;
    if (record?.type !== "message" || (role !== "user" && role !== "assistant")) {
      continue;
    }
    const text = extractSessionText(record.message?.content);
    if (!text) {
      continue;
    }
    const stamp = record.timestamp ?? record.message?.timestamp;
    const parsed =
      typeof stamp === "number" ? stamp : typeof stamp === "string" ? Date.parse(stamp) : NaN;
    out.push({ role, text, ts: Number.isFinite(parsed) ? parsed : fallbackTs });
  }
  return out;
}

/**
 * One owner message that may be a follow-up: the owner's next message in the
 * session after an answer, within FOLLOW_UP_WINDOW_MS, when the answered turn
 * was a recurring task (`typedBy: "answer"`) or, that turn being untyped,
 * when the message itself matches a recurring type (`typedBy: "message"`).
 */
export type BackfillFollowUp = {
  file: string;
  ts: number;
  /** The recurring type a gap would be attributed to. */
  taskSlug: string;
  typedBy: "answer" | "message";
  previousOwnerMessage: string;
  previousAnswer: string;
  /** The owner's follow-up, prose only. */
  text: string;
  /** The follow-up as the transcript holds it (for the evidence ref). */
  rawText: string;
};

export type BackfillPlan = {
  transcripts: number;
  ownerTurns: number;
  /** Follow-ups that would each cost one model call. */
  followUps: number;
  /** Task types the replay found that the live store does not have. */
  newTaskTypes: number;
  maxCalls: number;
  hasModel: boolean;
};

export type BackfillCandidate = {
  taskSlug: string;
  taskLabel: string;
  statement: string;
  /** `new`: the backfill would create it. `existing`: it would add sightings to a stored candidate. */
  state: "new" | "existing";
  /** Independent sightings (different sessions or days) after the backfill. */
  sightings: number;
  /** It would be offered on the next matching turn. */
  offerReady: boolean;
  evidence: Array<{ text: string; ref: string | null; day: string; explicit: boolean }>;
};

export type BackfillExamined = {
  day: string;
  taskSlug: string;
  typedBy: "answer" | "message";
  /** The owner's follow-up, prose only. */
  text: string;
  outcome:
    | "candidate"
    | "other"
    | "unusable"
    | "specific"
    | "ungrounded"
    | "repeatOfActive"
    | "declinedBefore"
    | "rejected";
  /** The gap statement, when the model gave one. */
  statement: string | null;
};

export type BackfillResult = BackfillPlan & {
  modelCalls: number;
  /** Follow-ups left unexamined because the call budget ran out or no model was available. */
  notExamined: number;
  outcomes: {
    other: number;
    unusable: number;
    /** A gap that named one instance (a date, a number, "yesterday"): not kept. */
    specific: number;
    ungrounded: number;
    repeatOfActive: number;
    declinedBefore: number;
    rejected: number;
  };
  taskTypes: Array<{ slug: string; label: string; occurrences: number; isNew: boolean }>;
  candidates: BackfillCandidate[];
  /** Every follow-up the backfill looked at, oldest first, with what became of it. */
  examined: BackfillExamined[];
  /** Null on a dry run. */
  applied: { candidates: number; sightings: number; taskTypes: number } | null;
};

export type BackfillOptions = {
  sessionsDir: string;
  /** The live stores. Read on a dry run, written with `apply`. */
  practices: PracticesStore;
  taskTypes: TaskTypesStore;
  /** The cheap-model lane (the correction lane); null lists follow-ups without classifying them. */
  llmCall: CorrectionLlmCall | null;
  maxCalls?: number;
  apply?: boolean;
  /** Serialised write (manager.practiceFollowUpDeps().change). Required with `apply`. */
  change?: <T>(label: string, fn: () => T) => Promise<T>;
  /** Called with the counts before the first model call. Return false to stop there. */
  onPlan?: (plan: BackfillPlan) => boolean | void | Promise<boolean | void>;
  signal?: AbortSignal;
};

function scratchDatabase(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  ensureMemoryIndexSchema({
    db,
    embeddingCacheTable: "embedding_cache",
    ftsTable: "chunks_fts",
    ftsEnabled: false,
  });
  return db;
}

/** Copy the live practices (with their sightings and offers) into the scratch store's database. */
function seedPractices(scratch: DatabaseSync, live: PracticesStore): void {
  const insert = scratch.prepare(
    `INSERT INTO practices (id, statement, statement_hash, scope, status, source, evidence_refs,
       created_at, updated_at, applied_count, last_applied_at, offer_count, origin)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const event = scratch.prepare(
    `INSERT INTO practice_events (id, practice_id, kind, session_ref, detail, ts)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  for (const p of live.list()) {
    insert.run(
      p.id,
      p.statement,
      practiceStatementHash(p.statement),
      p.scope,
      p.status,
      p.source,
      JSON.stringify(p.evidenceRefs),
      p.createdAt,
      p.updatedAt,
      p.appliedCount,
      p.lastAppliedAt,
      p.offerCount,
      p.origin,
    );
    if (p.status !== "candidate") {
      continue;
    }
    for (const e of live.events(p.id, 200)) {
      if (e.kind === "stored" || e.kind === "offered") {
        event.run(
          e.id,
          p.id,
          e.kind,
          e.sessionRef,
          e.detail ? JSON.stringify(e.detail) : null,
          e.ts,
        );
      }
    }
  }
}

/**
 * Run the backfill. Never writes without `apply`. Never throws for a bad
 * transcript or a failed model call (the follow-up is counted as not
 * examined or unusable).
 */
export async function runPracticeBackfill(opts: BackfillOptions): Promise<BackfillResult> {
  const maxCalls = Math.max(0, Math.floor(opts.maxCalls ?? BACKFILL_DEFAULT_MAX_CALLS));
  const scratch = scratchDatabase();
  try {
    return await backfill(opts, scratch, maxCalls);
  } finally {
    try {
      scratch.close();
    } catch {
      // nothing to release
    }
  }
}

async function backfill(
  opts: BackfillOptions,
  scratch: DatabaseSync,
  maxCalls: number,
): Promise<BackfillResult> {
  // ── Read ────────────────────────────────────────────────────────────────
  let names: string[] = [];
  try {
    names = (await fs.readdir(opts.sessionsDir)).filter(isBackfillTranscript).toSorted();
  } catch (err) {
    log.debug(`sessions directory unreadable: ${String(err)}`);
  }
  const sessions: Array<{ file: string; messages: Message[] }> = [];
  for (const name of names) {
    const file = path.join(opts.sessionsDir, name);
    const messages = await readTranscript(file);
    if (messages.length > 0) {
      sessions.push({ file, messages });
    }
    await yieldToEventLoop();
  }
  const ownerProse = (text: string): string | null => {
    if (NOT_OWNER_RX.test(text)) {
      return null;
    }
    const prose = stripMessageEnvelope(stripNonProse(text)).replace(/\s+/g, " ").trim();
    return prose || null;
  };

  // ── Scratch stores, seeded from the live ones ───────────────────────────
  const merges = new Map<string, string>();
  const scratchPractices = new PracticesStore(scratch);
  const scratchTypes = new TaskTypesStore(scratch, {
    onMerge: (from, into) => {
      merges.set(from, into);
      scratchPractices.repointTaskScope(from, into);
    },
  });
  const liveRecurring = new Set<string>();
  for (const type of opts.taskTypes.list({ recurringOnly: true })) {
    liveRecurring.add(type.slug);
    scratchTypes.adopt(type);
  }
  seedPractices(scratch, opts.practices);
  const seededCandidates = new Set(
    scratchPractices.list({ statuses: ["candidate"] }).map((p) => p.id),
  );

  // ── Pass 1: task typing over every owner turn, oldest first ─────────────
  const ownerTurns: Array<{ text: string; ts: number }> = [];
  for (const session of sessions) {
    for (const message of session.messages) {
      const prose = message.role === "user" ? ownerProse(message.text) : null;
      if (prose) {
        ownerTurns.push({ text: prose, ts: message.ts });
      }
    }
  }
  ownerTurns.sort((a, b) => a.ts - b.ts);
  let n = 0;
  for (const turn of ownerTurns) {
    const observed = scratchTypes.observe(turn.text, { now: turn.ts });
    if (observed.type && observed.needsPromotion) {
      // Named with the fallback first: the counts are shown before any call.
      scratchTypes.promoteWithFallback(observed.type.slug);
    }
    if (++n % 50 === 0) {
      await yieldToEventLoop();
    }
  }
  const newTypes = scratchTypes
    .list({ recurringOnly: true })
    .filter((t) => !liveRecurring.has(t.slug))
    .toSorted((a, b) => b.occurrences - a.occurrences);

  // ── Pass 2: the owner's next message after an answer ────────────────────
  // The reply path's two triggers (practice-followup-turn.ts): the answered
  // turn was a recurring task, or it was untyped and the next message itself
  // matches a recurring type. `last` is the previous owner turn of the same
  // transcript, so a message that opens a session is never a follow-up.
  const followUps: BackfillFollowUp[] = [];
  for (const session of sessions) {
    let last: { slug: string | null; owner: string; answer: string; answeredAt: number } | null =
      null;
    // A reply to a turn that was not the owner typing (a heartbeat, a cron
    // fire) is not the answer to the owner's request before it.
    let answering = false;
    for (const message of session.messages) {
      if (message.role === "assistant") {
        if (last && answering) {
          last.answer = message.text;
          last.answeredAt = message.ts;
        }
        continue;
      }
      const prose = ownerProse(message.text);
      if (!prose) {
        answering = false;
        continue;
      }
      answering = true;
      const type = scratchTypes.classify(prose);
      const taskSlug = last?.slug ?? type?.slug ?? null;
      if (
        last?.answer.trim() &&
        taskSlug &&
        message.ts >= last.answeredAt &&
        message.ts - last.answeredAt <= FOLLOW_UP_WINDOW_MS
      ) {
        followUps.push({
          file: session.file,
          ts: message.ts,
          taskSlug,
          typedBy: last.slug ? "answer" : "message",
          previousOwnerMessage: last.owner,
          previousAnswer: last.answer,
          text: prose,
          rawText: message.text,
        });
      }
      // One follow-up per answer; this turn is the next one's "previous turn".
      last = { slug: type?.slug ?? null, owner: prose, answer: "", answeredAt: 0 };
    }
    await yieldToEventLoop();
  }
  followUps.sort((a, b) => a.ts - b.ts);

  const plan: BackfillPlan = {
    transcripts: sessions.length,
    ownerTurns: ownerTurns.length,
    followUps: followUps.length,
    newTaskTypes: newTypes.length,
    maxCalls,
    hasModel: Boolean(opts.llmCall),
  };
  const result: BackfillResult = {
    ...plan,
    modelCalls: 0,
    notExamined: followUps.length,
    outcomes: {
      other: 0,
      unusable: 0,
      specific: 0,
      ungrounded: 0,
      repeatOfActive: 0,
      declinedBefore: 0,
      rejected: 0,
    },
    taskTypes: [],
    candidates: [],
    examined: [],
    applied: null,
  };
  const describeTypes = () =>
    scratchTypes.list({ recurringOnly: true }).map((t) => ({
      slug: t.slug,
      label: t.label,
      occurrences: t.occurrences,
      isNew: !liveRecurring.has(t.slug),
    }));
  result.taskTypes = describeTypes();
  if ((await opts.onPlan?.(plan)) === false || !opts.llmCall) {
    return result;
  }

  // ── Model calls: name or merge the new types, then one per follow-up ────
  const llmCall = opts.llmCall;
  const spend = () => result.modelCalls < maxCalls && !opts.signal?.aborted;
  // Largest first, and a type may only be folded into one that already has
  // its name (a live type, or one named earlier in this loop): the smaller
  // variants of a task merge into its main type, never the other way round.
  const named = new Set(liveRecurring);
  for (const type of newTypes) {
    if (!spend()) {
      break;
    }
    if (!scratchTypes.get(type.slug)) {
      continue; // folded into another type by an earlier answer
    }
    result.modelCalls += 1;
    const after = await scratchTypes.relabel(type.slug, llmCall, { mergeInto: named });
    if (after) {
      named.add(after.slug);
    }
  }
  const resolveSlug = (slug: string): string => {
    let current = slug;
    for (let hops = 0; merges.has(current) && hops < 10; hops++) {
      current = merges.get(current)!;
    }
    return current;
  };

  const recorded: Array<{
    input: Omit<GapSightingInput, "store">;
    text: string;
    practiceId: string;
  }> = [];
  for (const followUp of followUps) {
    if (!spend()) {
      break;
    }
    const taskSlug = resolveSlug(followUp.taskSlug);
    const type = scratchTypes.get(taskSlug);
    if (!type) {
      continue;
    }
    result.modelCalls += 1;
    result.notExamined -= 1;
    const note = (outcome: BackfillExamined["outcome"], statement: string | null = null) => {
      if (outcome !== "candidate") {
        result.outcomes[outcome] += 1;
      }
      result.examined.push({
        day: practiceDayKey(followUp.ts),
        taskSlug,
        typedBy: followUp.typedBy,
        text: followUp.text.slice(0, 300),
        outcome,
        statement,
      });
    };
    let raw = "";
    try {
      raw = await llmCall(
        buildFollowUpGapPrompt(
          {
            taskSlug,
            taskLabel: type.label,
            previousOwnerMessage: followUp.previousOwnerMessage,
            previousAnswer: followUp.previousAnswer,
            typedBy: followUp.typedBy,
          },
          followUp.text,
        ),
        { signal: opts.signal },
      );
    } catch (err) {
      // Owner-triggered command: say why a call was lost, do not hide it.
      log.warn(`backfill follow-up call failed: ${String(err).slice(0, 300)}`);
    }
    const gap = parseFollowUpGap(raw);
    if (!gap) {
      if (raw.trim()) {
        log.warn(`backfill follow-up answer not usable: ${raw.replace(/\s+/g, " ").slice(0, 300)}`);
      }
      note("unusable");
      continue;
    }
    if (gap.kind === "other") {
      note("other");
      continue;
    }
    if (gap.kind === "specific") {
      note("specific", gap.statement);
      continue;
    }
    const input: Omit<GapSightingInput, "store"> = {
      taskSlug,
      statement: gap.statement,
      ownerProse: followUp.text,
      evidenceRef: await resolveUserMessageEvidenceRef(followUp.file, followUp.rawText),
      sessionId: path.basename(followUp.file),
      explicit: isExplicitStandingInstruction(followUp.rawText),
      origin: "backfill",
      sightedAt: followUp.ts,
    };
    const outcome = recordGapSighting({ ...input, store: scratchPractices });
    if (outcome.kind === "candidate") {
      recorded.push({ input, text: followUp.text, practiceId: outcome.practice.id });
      note("candidate", gap.statement);
    } else if (outcome.kind === "repeat") {
      note("repeatOfActive", gap.statement);
    } else if (outcome.kind === "refused") {
      note("declinedBefore", gap.statement);
    } else if (outcome.kind === "ungrounded") {
      note("ungrounded", gap.statement);
    } else {
      note("rejected", gap.statement);
    }
  }
  result.taskTypes = describeTypes();
  // A type merged or renamed after a follow-up was examined: report the slug it has now.
  for (const item of result.examined) {
    item.taskSlug = resolveSlug(item.taskSlug);
  }

  // ── What it found ───────────────────────────────────────────────────────
  const byPractice = new Map<string, { practice: Practice; items: typeof recorded }>();
  for (const item of recorded) {
    const practice = scratchPractices.get(item.practiceId);
    if (!practice) {
      continue;
    }
    const entry = byPractice.get(practice.id) ?? { practice, items: [] };
    entry.items.push(item);
    byPractice.set(practice.id, entry);
  }
  for (const { practice, items } of byPractice.values()) {
    const slug = practice.scope.slice("task:".length);
    const { independent, explicit } = countIndependentSightings(scratchPractices, practice.id);
    result.candidates.push({
      taskSlug: slug,
      taskLabel: scratchTypes.get(slug)?.label || slug.replace(/-/g, " "),
      statement: practice.statement,
      state: seededCandidates.has(practice.id) ? "existing" : "new",
      sightings: independent,
      offerReady: independent >= 2 || explicit,
      evidence: items.map((item) => ({
        text: item.text,
        ref: item.input.evidenceRef,
        day: practiceDayKey(item.input.sightedAt ?? 0),
        explicit: item.input.explicit,
      })),
    });
  }

  // ── Apply: the same gaps, against the live store ────────────────────────
  if (opts.apply && recorded.length > 0) {
    if (!opts.change) {
      throw new Error("backfill apply needs a serialised writer");
    }
    const slugs = new Set(recorded.map((item) => resolveSlug(item.input.taskSlug)));
    const types = [...slugs]
      .map((slug) => scratchTypes.get(slug))
      .filter((t): t is TaskType => Boolean(t));
    result.applied = await opts.change("practice-backfill", () => {
      const applied = { candidates: 0, sightings: 0, taskTypes: 0 };
      for (const type of types) {
        if (opts.taskTypes.adopt(type) === "added") {
          applied.taskTypes += 1;
        }
      }
      for (const item of recorded) {
        const outcome = recordGapSighting({
          ...item.input,
          taskSlug: resolveSlug(item.input.taskSlug),
          store: opts.practices,
        });
        if (outcome.kind === "candidate") {
          applied.sightings += 1;
          if (outcome.op === "add") {
            applied.candidates += 1;
          }
        }
      }
      return applied;
    });
  }
  return result;
}
