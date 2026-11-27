/**
 * PLAN-64 Phase 1b: follow-up learning end to end, on the real stores, with
 * canned model output.
 *
 * Each owner turn below runs the two paths the gateway runs: the prompt
 * path (task typing with the follow-up deferral, the offer-answer note) and
 * the reply path (beginFollowUpTurn, the correction pass with its single
 * model call, finishFollowUpTurn). Under test: the owner's real follow-ups
 * become candidates on the right task type, the real negatives do not, the
 * one-call bound, the offer and its limits, yes and no, an ambiguous reply,
 * a gateway restart between an answer and its follow-up and between an
 * offer and its answer, repeats of an active practice, and the switches.
 *
 * The model decides gap or other, so those cases test the pipeline around a
 * canned answer and that the prompt carries what the model needs.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BitterbotConfig } from "../config/config.js";
import { runCorrectionCapture } from "./correction-capture.js";
import { ensureMemoryIndexSchema } from "./memory-schema.js";
import { answerPracticeOffer, listAuditLog, savePractice } from "./owner-controls.js";
import {
  beginFollowUpTurn,
  finishFollowUpTurn,
  type FollowUpTurnDeps,
  resolveOfferAnswerBeforeRun,
} from "./practice-followup-turn.js";
import { FollowUpStateStore } from "./practice-followups.js";
import { PracticesStore } from "./practices.js";
import { observeOwnerTurn, TaskTypesStore } from "./task-types.js";

const SESSION = "agent:main:main";
const MIN = 60_000;
const DAY = 24 * 3_600_000;
const T0 = new Date(2026, 10, 7, 9, 0, 0).getTime();
const STATS = "How many clones did your repo get yesterday?";
const STATS_ANSWER = "Yesterday the repo had 68 unique clones (240 total).";
const OFFER_TWICE =
  "You have asked for npm downloads after repo stats twice. Include it every time? (yes / no)";

type Harness = {
  db: DatabaseSync;
  practices: PracticesStore;
  taskTypes: TaskTypesStore;
  state: FollowUpStateStore;
  deps: FollowUpTurnDeps;
};

function open(file = ":memory:"): Harness {
  const db = new DatabaseSync(file);
  db.exec("PRAGMA synchronous = OFF");
  ensureMemoryIndexSchema({
    db,
    embeddingCacheTable: "embedding_cache",
    ftsTable: "chunks_fts",
    ftsEnabled: false,
  });
  const practices = new PracticesStore(db);
  const state = new FollowUpStateStore(db);
  const taskTypes = new TaskTypesStore(db, {
    onMerge: (from, into) => {
      practices.repointTaskScope(from, into);
      state.repointTask(from, into);
    },
  });
  return {
    db,
    practices,
    taskTypes,
    state,
    deps: {
      practices,
      taskTypes,
      state,
      change: async (_label, fn) => fn(),
      answerOffer: async (id, answer) => answerPracticeOffer(db, practices, id, answer),
    },
  };
}

function seedRepoStats(h: Harness): void {
  h.taskTypes.adopt({
    slug: "repo-stats",
    label: "repo stats",
    exemplars: [
      STATS,
      "how did our npm's and clones do yesterday?",
      "Can you check npm, clones and views for yesterday for your repo?",
    ],
    occurrences: 3,
    distinctDays: 3,
    firstSeen: T0 - 10 * DAY,
    lastSeen: T0 - DAY,
    recurring: true,
  });
}

const gap = (missing: string) => JSON.stringify({ kind: "gap", missing });
const OTHER = JSON.stringify({ kind: "other" });

let h: Harness;
const llm = vi.fn<(prompt: string, opts?: { signal?: AbortSignal }) => Promise<string>>();

/** One owner turn through both paths. Returns what the reply would carry. */
async function ownerTurn(params: {
  text: string;
  now: number;
  reply?: string;
  sessionId?: string;
  runId?: string;
  chatType?: string;
  cfg?: BitterbotConfig;
  /** Skip the prompt path's offer-answer step (the prompt carried other blocks). */
  skipPromptPath?: boolean;
}) {
  const cfg = params.cfg ?? {};
  const sessionId = params.sessionId ?? "s1";
  const reply = params.reply ?? "Sure.";
  const callsBefore = llm.mock.calls.length;
  // The prompt path.
  const note = params.skipPromptPath
    ? null
    : await resolveOfferAnswerBeforeRun(h.deps, {
        cfg,
        sessionKey: SESSION,
        text: params.text,
        runId: params.runId,
        now: params.now,
      });
  observeOwnerTurn(
    h.taskTypes,
    {
      text: params.text,
      sessionKey: SESSION,
      turnKey: params.runId,
      now: params.now,
      followUpOf:
        cfg.memory?.practices?.followUps?.enabled === false
          ? null
          : (h.state.pendingAnswer(SESSION, params.now)?.taskSlug ?? null),
    },
    null,
  );
  // The reply path.
  const turn = await beginFollowUpTurn(h.deps, {
    cfg,
    sessionKey: SESSION,
    sessionId,
    userMessage: params.text,
    now: params.now,
  });
  const recent = h.state.recentTaskSlug(SESSION, params.now);
  const type = h.taskTypes.classify(params.text) ?? (recent ? h.taskTypes.get(recent) : null);
  const capture = await runCorrectionCapture({
    cfg,
    sessionKey: SESSION,
    userMessage: params.text,
    assistantReply: reply,
    senderIsOwner: true,
    isHeartbeat: false,
    chatType: params.chatType ?? "direct",
    runStartedAt: params.now,
    store: null,
    practices: {
      save: async (input) => savePractice(h.db, h.practices, input),
      store: h.practices,
      taskType: type ? { slug: type.slug, label: type.label } : null,
    },
    followUp: turn.gapContext,
    pinAsOwner: null,
    llmCall: llm,
    now: params.now,
  });
  const finished = await finishFollowUpTurn(h.deps, turn, {
    cfg,
    sessionKey: SESSION,
    sessionId,
    userMessage: params.text,
    replyText: reply,
    chatType: params.chatType ?? "direct",
    followUp: capture.followUp,
    captured: capture.practices,
    now: params.now,
  });
  return {
    note,
    turn,
    capture,
    finished,
    calls: llm.mock.calls.length - callsBefore,
    lines: [capture.line, turn.answerLine, finished.offerLine].filter((line): line is string =>
      Boolean(line),
    ),
  };
}

/** A stats request and its answer, then a follow-up two minutes later. */
async function statsThenFollowUp(params: {
  followUp: string;
  now: number;
  sessionId?: string;
  cfg?: BitterbotConfig;
}) {
  const stats = await ownerTurn({
    text: STATS,
    reply: STATS_ANSWER,
    now: params.now,
    sessionId: params.sessionId,
    cfg: params.cfg,
  });
  const followUp = await ownerTurn({
    text: params.followUp,
    now: params.now + 2 * MIN,
    sessionId: params.sessionId,
    cfg: params.cfg,
  });
  return { stats, followUp };
}

beforeEach(() => {
  h = open();
  seedRepoStats(h);
  llm.mockReset();
  llm.mockResolvedValue(OTHER);
});

describe("follow-up gap detection", () => {
  /**
   * The follow-ups from the Phase 0 replay. `real`: the owner's message as
   * quoted in the plan and the build brief. `reconstructed`: the review doc
   * records that a views-or-traffic follow-up happened on that date but not
   * its wording, so the text here is written for the test.
   */
  const FOLLOW_UPS: Array<{ text: string; missing: string; source: "real" | "reconstructed" }> = [
    { text: "how about our npm downloads", missing: "Include npm downloads", source: "real" },
    { text: "how did npm do?", missing: "Include npm", source: "real" },
    {
      text: "what has the traffic been like the past few days?",
      missing: "Include traffic for the past few days",
      source: "real",
    },
    {
      text: "Has github updated any of the traffic and clone stats for your repo?",
      missing: "Include whether github has updated the traffic and clone stats",
      source: "real",
    },
    { text: "what about views?", missing: "Include views", source: "reconstructed" },
    {
      text: "and the views and traffic?",
      missing: "Include views and traffic",
      source: "reconstructed",
    },
  ];

  it.each(FOLLOW_UPS)("a gap ($source): $text", async ({ text, missing }) => {
    llm.mockResolvedValue(gap(missing));
    const { stats, followUp } = await statsThenFollowUp({ followUp: text, now: T0 });
    // The stats turn itself costs nothing.
    expect(stats.calls).toBe(0);
    expect(followUp.calls).toBe(1);
    const prompt = llm.mock.calls[0]![0];
    expect(prompt).toContain(STATS);
    expect(prompt).toContain(STATS_ANSWER);
    expect(prompt).toContain(`Owner (follow-up): ${text}`);
    expect(followUp.finished.sighting).toMatchObject({ kind: "candidate", op: "add" });
    expect(h.practices.list()).toMatchObject([
      {
        statement: missing,
        scope: "task:repo-stats",
        status: "candidate",
        source: "extraction",
        origin: "follow_up",
      },
    ]);
    // A candidate is never rendered and never announced.
    expect(h.practices.listVisible({ taskSlug: "repo-stats" })).toEqual([]);
    expect(followUp.lines).toEqual([]);
  });

  it("a gap (real) that is also an explicit instruction shares the correction pass's one call", async () => {
    const text = "Give me day by day clones and the npm downloads too";
    await ownerTurn({ text: STATS, reply: STATS_ANSWER, now: T0 });
    llm.mockResolvedValue(
      JSON.stringify({
        facts: [],
        practices: [],
        follow_up: { kind: "gap", missing: "Include day by day clones and npm downloads" },
      }),
    );
    const followUp = await ownerTurn({ text, now: T0 + 2 * MIN });
    expect(followUp.capture.prefilter).toBe("give-too");
    expect(followUp.calls).toBe(1);
    const prompt = llm.mock.calls[0]![0];
    expect(prompt).toContain("## Practices");
    expect(prompt).toContain("## Follow-up check");
    expect(prompt).toContain(STATS_ANSWER);
    expect(prompt).toContain(text);
    expect(h.practices.list()).toMatchObject([
      {
        statement: "Include day by day clones and npm downloads",
        scope: "task:repo-stats",
        status: "candidate",
      },
    ]);
    // One sighting, but the owner's words are an instruction: offered at once.
    expect(followUp.lines).toEqual([
      "You asked for day by day clones and npm downloads after repo stats. Include it every time? (yes / no)",
    ]);
  });

  it("when the correction pass already saved the instruction as active, there is no candidate and no offer", async () => {
    await ownerTurn({ text: STATS, reply: STATS_ANSWER, now: T0 });
    llm.mockResolvedValue(
      JSON.stringify({
        facts: [],
        practices: [
          {
            statement: "Give day by day clones and the npm downloads.",
            scope: "task",
            explicit: true,
          },
        ],
        follow_up: { kind: "gap", missing: "Include day by day clones and npm downloads" },
      }),
    );
    const followUp = await ownerTurn({
      text: "Give me day by day clones and the npm downloads too",
      now: T0 + 2 * MIN,
    });
    expect(followUp.calls).toBe(1);
    expect(h.practices.list()).toMatchObject([{ status: "active", scope: "task:repo-stats" }]);
    expect(followUp.finished.sighting).toBeNull();
    expect(followUp.lines).toEqual([
      'Practice saved for repo stats: "Give day by day clones and the npm downloads."',
    ]);
  });

  it.each([
    "hmm, I wonder what drove the 68 unique clones...",
    "Can you review your own code against the wikiskills paper and tell me what is missing?",
    "Please coordinate with Codex on the collective-learning benchmark",
  ])("other (real): %s", async (text) => {
    llm.mockResolvedValue(OTHER);
    const before = h.taskTypes.list().length;
    const { followUp } = await statsThenFollowUp({ followUp: text, now: T0 });
    expect(followUp.calls).toBe(1);
    expect(llm.mock.calls[0]![0]).toContain(`Owner (follow-up): ${text}`);
    expect(followUp.capture.followUp).toEqual({ kind: "other" });
    expect(h.practices.list()).toEqual([]);
    expect(followUp.lines).toEqual([]);
    // Not a follow-up after all: counted as a turn of its own, afterwards.
    expect(h.taskTypes.list()).toHaveLength(before + 1);
    expect(h.taskTypes.get("repo-stats")?.occurrences).toBe(4);
  });

  it("a follow-up never founds a task type of its own", async () => {
    llm.mockResolvedValue(gap("Include npm downloads"));
    await statsThenFollowUp({ followUp: "how about our npm downloads", now: T0 });
    await statsThenFollowUp({
      followUp: "how about our npm downloads",
      now: T0 + DAY,
      sessionId: "s2",
    });
    await statsThenFollowUp({
      followUp: "how about our npm downloads",
      now: T0 + 2 * DAY,
      sessionId: "s3",
    });
    expect(h.taskTypes.list().map((t) => t.slug)).toEqual(["repo-stats"]);
  });

  it("an unusable model answer stores nothing, and the turn is counted as its own", async () => {
    llm.mockResolvedValue("I think the owner wants npm downloads.");
    const { followUp } = await statsThenFollowUp({
      followUp: "how about our npm downloads",
      now: T0,
    });
    expect(followUp.calls).toBe(1);
    expect(followUp.capture.followUp).toBeNull();
    expect(h.practices.list()).toEqual([]);
  });

  it("a gap the owner's words do not support is dropped", async () => {
    llm.mockResolvedValue(gap("Include the wallet balance and gas spend"));
    const { followUp } = await statsThenFollowUp({
      followUp: "how about our npm downloads",
      now: T0,
    });
    expect(followUp.finished.sighting).toEqual({ kind: "ungrounded" });
    expect(h.practices.list()).toEqual([]);
  });

  it("costs at most one call per recurring-task answer", async () => {
    llm.mockResolvedValue(gap("Include npm downloads"));
    await statsThenFollowUp({ followUp: "how about our npm downloads", now: T0 });
    expect(llm).toHaveBeenCalledTimes(1);
    // The next message, still inside 15 minutes: the answer's check is spent.
    const third = await ownerTurn({ text: "and what about views?", now: T0 + 4 * MIN });
    expect(third.calls).toBe(0);
    expect(third.turn.gapContext).toBeNull();
    expect(llm).toHaveBeenCalledTimes(1);
  });

  it("makes no call without a recurring-task answer just before, after 15 minutes, or in another session", async () => {
    // No answer before.
    expect((await ownerTurn({ text: "how about our npm downloads", now: T0 })).calls).toBe(0);
    // Too late.
    await ownerTurn({ text: STATS, reply: STATS_ANSWER, now: T0 + DAY });
    const late = await ownerTurn({
      text: "how about our npm downloads",
      now: T0 + DAY + 16 * MIN,
    });
    expect(late.calls).toBe(0);
    // The session was reset in between (same key, new transcript).
    await ownerTurn({ text: STATS, reply: STATS_ANSWER, now: T0 + 2 * DAY, sessionId: "s2" });
    const other = await ownerTurn({
      text: "how about our npm downloads",
      now: T0 + 2 * DAY + MIN,
      sessionId: "s3",
    });
    expect(other.calls).toBe(0);
    // A turn in between: the stats answer is no longer the turn before.
    await ownerTurn({ text: STATS, reply: STATS_ANSWER, now: T0 + 3 * DAY, sessionId: "s4" });
    llm.mockResolvedValue(OTHER);
    await ownerTurn({
      text: "tell me a joke about penguins",
      now: T0 + 3 * DAY + MIN,
      sessionId: "s4",
    });
    const afterGap = await ownerTurn({
      text: "how about our npm downloads",
      now: T0 + 3 * DAY + 2 * MIN,
      sessionId: "s4",
    });
    expect(afterGap.calls).toBe(0);
    expect(h.practices.list()).toEqual([]);
  });

  it("an answer with no text (delivered by block streaming) arms no check", async () => {
    await ownerTurn({ text: STATS, reply: "", now: T0 });
    const followUp = await ownerTurn({ text: "how about our npm downloads", now: T0 + MIN });
    expect(followUp.calls).toBe(0);
  });

  it("memory.practices.followUps.enabled=false: no check, no candidate", async () => {
    const cfg: BitterbotConfig = { memory: { practices: { followUps: { enabled: false } } } };
    llm.mockResolvedValue(gap("Include npm downloads"));
    const { followUp } = await statsThenFollowUp({
      followUp: "how about our npm downloads",
      now: T0,
      cfg,
    });
    expect(followUp.calls).toBe(0);
    expect(h.practices.list()).toEqual([]);
    expect(h.state.get(SESSION)?.taskSlug ?? null).toBeNull();
  });
});

describe("the offer and its answer", () => {
  /** Two sightings on two days: the second reply carries the offer. */
  async function untilOffered(): Promise<string> {
    llm.mockResolvedValue(gap("Include npm downloads"));
    const first = await statsThenFollowUp({ followUp: "how about our npm downloads", now: T0 });
    expect(first.followUp.lines).toEqual([]);
    llm.mockResolvedValue(gap("Include npm"));
    const second = await statsThenFollowUp({
      followUp: "how did npm do?",
      now: T0 + 4 * DAY,
      sessionId: "s2",
    });
    expect(second.followUp.lines).toEqual([OFFER_TWICE]);
    const practice = h.practices.list()[0]!;
    expect(h.practices.list()).toHaveLength(1);
    expect(practice).toMatchObject({ status: "candidate", offerCount: 1 });
    expect(h.practices.events(practice.id).filter((e) => e.kind === "offered")).toHaveLength(1);
    llm.mockClear();
    return practice.id;
  }

  it("the second sighting of the real pair earns the offer; yes makes it an active owner practice", async () => {
    const id = await untilOffered();
    const yes = await ownerTurn({
      text: "yes",
      now: T0 + 4 * DAY + 5 * MIN,
      sessionId: "s2",
      runId: "run-yes",
    });
    // No model call anywhere on the answer.
    expect(yes.calls).toBe(0);
    expect(yes.note).toContain("## Practice offer answered");
    expect(yes.note).toContain('"Include npm downloads"');
    expect(yes.note).toContain("repo stats");
    expect(yes.lines).toEqual(['Practice saved for repo stats: "Include npm downloads"']);
    expect(h.practices.get(id)).toMatchObject({ status: "active", source: "owner" });
    expect(h.practices.events(id).filter((e) => e.kind === "confirmed")).toHaveLength(1);
    expect(h.practices.counters().overall).toMatchObject({ offers: 1, confirmed: 1, declined: 0 });
    expect(listAuditLog(h.db, {}).some((e) => e.event === "owner_confirm_practice")).toBe(true);
    // From now on it is rendered on a repo-stats turn, with both follow-ups as evidence.
    expect(h.practices.listVisible({ taskSlug: "repo-stats" }).map((p) => p.id)).toEqual([id]);
    expect(h.practices.sightings(id)).toHaveLength(2);
    // And asking for npm again after an answer is now a repeat.
    llm.mockResolvedValue(gap("Include npm downloads"));
    const again = await statsThenFollowUp({
      followUp: "how about our npm downloads",
      now: T0 + 6 * DAY,
      sessionId: "s3",
    });
    expect(again.followUp.finished.sighting).toMatchObject({ kind: "repeat" });
    expect(again.followUp.lines).toEqual([]);
    expect(h.practices.counters().byPractice.get(id)?.repeats).toBe(1);
    expect(h.practices.list()).toHaveLength(1);
  });

  it("no suppresses it for good", async () => {
    const id = await untilOffered();
    const no = await ownerTurn({ text: "No.", now: T0 + 4 * DAY + 5 * MIN, sessionId: "s2" });
    expect(no.note).toContain("The owner said no");
    expect(no.lines).toEqual(["Understood, I will not ask again."]);
    expect(h.practices.get(id)?.status).toBe("suppressed");
    expect(h.practices.counters().overall).toMatchObject({ offers: 1, confirmed: 0, declined: 1 });
    expect(listAuditLog(h.db, {}).some((e) => e.event === "owner_decline_practice")).toBe(true);
    // The same gap again: nothing stored, nothing offered.
    llm.mockResolvedValue(gap("Include npm downloads"));
    const again = await statsThenFollowUp({
      followUp: "how about our npm downloads",
      now: T0 + 8 * DAY,
      sessionId: "s3",
    });
    expect(again.followUp.finished.sighting).toEqual({ kind: "refused" });
    expect(again.followUp.lines).toEqual([]);
    expect(h.practices.list()).toHaveLength(1);
  });

  it("an ambiguous reply does nothing and the offer lapses", async () => {
    const id = await untilOffered();
    const vague = await ownerTurn({
      text: "ok, what about the weather",
      now: T0 + 4 * DAY + 5 * MIN,
      sessionId: "s2",
    });
    expect(vague.note).toBeNull();
    expect(vague.lines).toEqual([]);
    expect(h.practices.get(id)?.status).toBe("candidate");
    // A yes one message later answers nothing.
    const lateYes = await ownerTurn({ text: "yes", now: T0 + 4 * DAY + 6 * MIN, sessionId: "s2" });
    expect(lateYes.note).toBeNull();
    expect(lateYes.lines).toEqual([]);
    expect(h.practices.get(id)?.status).toBe("candidate");
  });

  it("a yes that comes after 30 minutes does nothing", async () => {
    const id = await untilOffered();
    const late = await ownerTurn({ text: "yes", now: T0 + 4 * DAY + 40 * MIN, sessionId: "s2" });
    expect(late.note).toBeNull();
    expect(late.lines).toEqual([]);
    expect(h.practices.get(id)?.status).toBe("candidate");
  });

  it("offers at most twice in total and never twice in one session", async () => {
    const id = await untilOffered();
    // Same session, another stats request: no second offer here.
    const sameSession = await ownerTurn({
      text: STATS,
      reply: STATS_ANSWER,
      now: T0 + 4 * DAY + 20 * MIN,
      sessionId: "s2",
    });
    expect(sameSession.lines).toEqual([]);
    // A new session: the candidate is offered on the stats answer itself.
    const s3 = await ownerTurn({
      text: STATS,
      reply: STATS_ANSWER,
      now: T0 + 5 * DAY,
      sessionId: "s3",
    });
    expect(s3.lines).toEqual([OFFER_TWICE]);
    expect(h.practices.get(id)?.offerCount).toBe(2);
    // Never a third.
    const s4 = await ownerTurn({
      text: STATS,
      reply: STATS_ANSWER,
      now: T0 + 6 * DAY,
      sessionId: "s4",
    });
    expect(s4.lines).toEqual([]);
    expect(h.practices.get(id)).toMatchObject({ offerCount: 2, status: "candidate" });
    expect(h.practices.counters().overall.offers).toBe(2);
  });

  it("one offer per reply, even with two candidates ready", async () => {
    await untilOffered();
    for (const [i, sessionId] of ["s5", "s6"].entries()) {
      llm.mockResolvedValue(gap("Include views and traffic"));
      const res = await statsThenFollowUp({
        followUp: "and the views and traffic?",
        now: T0 + (10 + i) * DAY,
        sessionId,
      });
      // s5: the npm candidate gets its second offer on the stats answer.
      // s6: the views candidate reaches two sightings and is the one offered.
      expect(res.stats.lines.length + res.followUp.lines.length).toBe(1);
    }
    expect(h.practices.counters().overall.offers).toBe(3);
  });

  it("is not made outside a direct chat", async () => {
    llm.mockResolvedValue(gap("Include npm downloads"));
    await statsThenFollowUp({ followUp: "how about our npm downloads", now: T0 });
    await ownerTurn({ text: STATS, reply: STATS_ANSWER, now: T0 + DAY, sessionId: "s2" });
    const followUp = await ownerTurn({
      text: "how about our npm downloads",
      now: T0 + DAY + MIN,
      sessionId: "s2",
      chatType: "group",
    });
    expect(followUp.finished.sighting).toMatchObject({ kind: "candidate", op: "strengthen" });
    expect(followUp.lines).toEqual([]);
    expect(h.practices.list()[0]?.offerCount).toBe(0);
  });

  it("memory.practices.offers.enabled=false: candidates are kept, nothing is offered, yes is not read", async () => {
    const cfg: BitterbotConfig = { memory: { practices: { offers: { enabled: false } } } };
    llm.mockResolvedValue(gap("Include npm downloads"));
    await statsThenFollowUp({ followUp: "how about our npm downloads", now: T0, cfg });
    const second = await statsThenFollowUp({
      followUp: "how about our npm downloads",
      now: T0 + DAY,
      sessionId: "s2",
      cfg,
    });
    expect(second.followUp.lines).toEqual([]);
    const practice = h.practices.list()[0]!;
    expect(practice).toMatchObject({ status: "candidate", offerCount: 0 });
    // Even with an offer on record, a yes is not read while the switch is off.
    h.state.setOffer(SESSION, practice.id, { sessionId: "s2", now: T0 + DAY + 3 * MIN });
    const yes = await ownerTurn({ text: "yes", now: T0 + DAY + 4 * MIN, sessionId: "s2", cfg });
    expect(yes.note).toBeNull();
    expect(yes.lines).toEqual([]);
    expect(h.practices.get(practice.id)?.status).toBe("candidate");
  });

  it("the reply path applies a bare answer the prompt path did not see", async () => {
    const id = await untilOffered();
    const yes = await ownerTurn({
      text: "yes please",
      now: T0 + 4 * DAY + 5 * MIN,
      sessionId: "s2",
      skipPromptPath: true,
    });
    expect(yes.lines).toEqual(['Practice saved for repo stats: "Include npm downloads"']);
    expect(h.practices.get(id)?.status).toBe("active");
  });

  it("a retried attempt of the answering run gets the same note and applies the answer once", async () => {
    const id = await untilOffered();
    const params = {
      cfg: {},
      sessionKey: SESSION,
      text: "yes",
      runId: "run-7",
      now: T0 + 4 * DAY + 5 * MIN,
    };
    const first = await resolveOfferAnswerBeforeRun(h.deps, params);
    const retry = await resolveOfferAnswerBeforeRun(h.deps, params);
    expect(first).toContain("## Practice offer answered");
    expect(retry).toBe(first);
    expect(h.practices.events(id).filter((e) => e.kind === "confirmed")).toHaveLength(1);
    // Another run in the session does not inherit the note.
    expect(await resolveOfferAnswerBeforeRun(h.deps, { ...params, runId: "run-8" })).toBeNull();
  });
});

describe("a gateway restart", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-followup-turn-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("between the answer and the follow-up, and between the offer and the yes, loses nothing", async () => {
    const file = path.join(dir, "memory.sqlite");
    h = open(file);
    seedRepoStats(h);
    llm.mockResolvedValue(gap("Include npm downloads"));
    await statsThenFollowUp({ followUp: "how about our npm downloads", now: T0 });

    await ownerTurn({ text: STATS, reply: STATS_ANSWER, now: T0 + DAY, sessionId: "s2" });
    // Restart: every in-process map is gone; only the database file remains.
    h.db.close();
    h = open(file);
    llm.mockResolvedValue(gap("Include npm"));
    const followUp = await ownerTurn({
      text: "how did npm do?",
      now: T0 + DAY + 3 * MIN,
      sessionId: "s2",
    });
    expect(followUp.calls).toBe(1);
    expect(llm.mock.calls.at(-1)![0]).toContain(STATS_ANSWER);
    expect(followUp.finished.sighting).toMatchObject({ kind: "candidate", op: "strengthen" });
    expect(followUp.lines).toEqual([OFFER_TWICE]);

    // Restart again, then the owner answers.
    h.db.close();
    h = open(file);
    const yes = await ownerTurn({ text: "yep", now: T0 + DAY + 6 * MIN, sessionId: "s2" });
    expect(yes.note).toContain("## Practice offer answered");
    expect(yes.lines).toEqual(['Practice saved for repo stats: "Include npm downloads"']);
    expect(h.practices.list()).toMatchObject([{ status: "active", source: "owner" }]);
    h.db.close();
  });
});

describe("repeat counter", () => {
  it("an explicit correction that restates an active practice for the turn is a repeat", async () => {
    const saved = savePractice(h.db, h.practices, {
      statement: "Include the npm downloads.",
      scope: "task:repo-stats",
    });
    if (!saved.ok) {
      throw new Error("seed failed");
    }
    await ownerTurn({ text: STATS, reply: STATS_ANSWER, now: T0 });
    llm.mockResolvedValue(
      JSON.stringify({
        facts: [],
        practices: [{ statement: "Include the npm downloads.", scope: "task", explicit: true }],
        follow_up: { kind: "gap", missing: "Include the npm downloads" },
      }),
    );
    const again = await ownerTurn({ text: "Include the npm downloads too", now: T0 + MIN });
    expect(again.capture.practices).toMatchObject([
      { op: "strengthen", status: "active", repeatOf: saved.practice.id },
    ]);
    expect(h.practices.list()).toHaveLength(1);
    const repeats = h.practices.events(saved.practice.id).filter((e) => e.kind === "repeat");
    // Once, by the correction: the follow-up half does not count it again.
    expect(repeats).toHaveLength(1);
    expect(repeats[0]?.detail).toEqual({ via: "correction" });
    expect(h.practices.counters().overall.repeats).toBe(1);
  });

  it("a first statement of a practice is not a repeat", async () => {
    await ownerTurn({ text: STATS, reply: STATS_ANSWER, now: T0 });
    llm.mockResolvedValue(
      JSON.stringify({
        facts: [],
        practices: [{ statement: "Include the npm downloads.", scope: "task", explicit: true }],
      }),
    );
    const first = await ownerTurn({ text: "Include the npm downloads too", now: T0 + MIN });
    expect(first.capture.practices).toMatchObject([{ op: "add", status: "active" }]);
    expect(first.capture.practices[0]?.repeatOf).toBeUndefined();
    expect(h.practices.counters().overall.repeats).toBe(0);
  });
});
