/**
 * PLAN-64 Phase 1b: the pieces of follow-up learning.
 *
 * Under test: the persisted per-session state (it survives a restart: a new
 * store on a reopened database file), the bare yes/no matcher, the follow-up
 * prompt (it carries the previous answer and the owner's message), the
 * classification parser, the grounding rule, gap matching on the real pair
 * "how about our npm downloads" / "how did npm do?", candidate storage (a
 * second matching gap strengthens the same row), the owner's standing no,
 * repeats of an active practice, and the offer limits.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureMemoryIndexSchema } from "./memory-schema.js";
import { LATEST_SCHEMA_VERSION } from "./migrations.js";
import {
  areGapStatementsMatching,
  buildFollowUpGapPrompt,
  buildFollowUpPromptSection,
  countIndependentSightings,
  FOLLOW_UP_WINDOW_MS,
  FollowUpStateStore,
  formatOfferAnswerLine,
  formatOfferAnswerNote,
  formatOfferLine,
  gapElement,
  isGapGrounded,
  isSpecificGapStatement,
  MAX_OFFERS_PER_PRACTICE,
  parseFollowUpGap,
  parseOfferAnswer,
  pickOffer,
  recordGapSighting,
} from "./practice-followups.js";
import { PracticesStore } from "./practices.js";

function schema(db: DatabaseSync): DatabaseSync {
  // A file database in a test: no fsync per migration.
  db.exec("PRAGMA synchronous = OFF");
  ensureMemoryIndexSchema({
    db,
    embeddingCacheTable: "embedding_cache",
    ftsTable: "chunks_fts",
    ftsEnabled: false,
  });
  return db;
}

const SESSION = "agent:main:main";
const T0 = new Date(2026, 10, 7, 9, 0, 0).getTime();
const DAY = 24 * 3_600_000;
const CTX = {
  taskSlug: "repo-stats",
  taskLabel: "repo stats",
  previousOwnerMessage: "How many clones did your repo get yesterday?",
  previousAnswer: "Yesterday the repo had 68 unique clones and 240 total.",
};

describe("migration 82", () => {
  it("creates practice_session_state", () => {
    const db = schema(new DatabaseSync(":memory:"));
    expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(82);
    const columns = (
      db.prepare(`PRAGMA table_info(practice_session_state)`).all() as Array<{ name: string }>
    ).map((c) => c.name);
    expect(columns).toEqual(
      expect.arrayContaining([
        "session_key",
        "session_id",
        "task_slug",
        "owner_text",
        "answer_text",
        "answered_at",
        "gap_checked",
        "offer_practice_id",
        "offered_at",
        "answer_practice_id",
        "answer_kind",
        "answer_run_id",
        "answer_at",
        "updated_at",
      ]),
    );
    db.close();
  });
});

describe("FollowUpStateStore", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-followup-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("keeps the answer, the offer and the owner's answer across a restart", () => {
    const file = path.join(dir, "memory.sqlite");
    let db = schema(new DatabaseSync(file));
    let state = new FollowUpStateStore(db);
    state.recordAnswer(SESSION, {
      sessionId: "s1",
      taskSlug: "repo-stats",
      ownerText: "[Sat 2026-11-07 09:00 EST] How many clones did your repo get yesterday?",
      answerText: CTX.previousAnswer,
      now: T0,
    });
    state.setOffer(SESSION, "practice-1", { sessionId: "s1", now: T0 });
    db.close();

    // The gateway restarts: a new process, a new store, the same file.
    db = schema(new DatabaseSync(file));
    state = new FollowUpStateStore(db);
    expect(state.pendingAnswer(SESSION, T0 + 60_000)).toEqual({
      taskSlug: "repo-stats",
      ownerText: "How many clones did your repo get yesterday?",
      answerText: CTX.previousAnswer,
      answeredAt: T0,
    });
    expect(state.get(SESSION)).toMatchObject({ offerPracticeId: "practice-1", offeredAt: T0 });
    state.setOfferAnswer(SESSION, { practiceId: "practice-1", kind: "confirmed", runId: "r9" });
    db.close();
    db = schema(new DatabaseSync(file));
    expect(new FollowUpStateStore(db).get(SESSION)).toMatchObject({
      offerPracticeId: null,
      answerPracticeId: "practice-1",
      answerKind: "confirmed",
      answerRunId: "r9",
    });
    db.close();
  });

  it("a pending answer lapses after the window, after its one check, or when cleared", () => {
    const state = new FollowUpStateStore(schema(new DatabaseSync(":memory:")));
    const answer = { taskSlug: "repo-stats", ownerText: "q", answerText: "a", now: T0 };
    state.recordAnswer(SESSION, answer);
    expect(state.pendingAnswer(SESSION, T0 + FOLLOW_UP_WINDOW_MS)).not.toBeNull();
    expect(state.pendingAnswer(SESSION, T0 + FOLLOW_UP_WINDOW_MS + 1)).toBeNull();
    expect(state.pendingAnswer("agent:main:other", T0)).toBeNull();
    state.markGapChecked(SESSION, T0 + 1000);
    expect(state.pendingAnswer(SESSION, T0 + 2000)).toBeNull();
    // Still the "turn before" for scoping a correction.
    expect(state.recentTaskSlug(SESSION, T0 + 2000)).toBe("repo-stats");
    expect(state.recentTaskSlug(SESSION, T0 + 31 * 60_000)).toBeNull();
    // A new answer re-arms the check.
    state.recordAnswer(SESSION, { ...answer, now: T0 + 5000 });
    expect(state.pendingAnswer(SESSION, T0 + 6000)).not.toBeNull();
    state.clearAnswer(SESSION, T0 + 7000);
    expect(state.pendingAnswer(SESSION, T0 + 8000)).toBeNull();
    expect(state.recentTaskSlug(SESSION, T0 + 8000)).toBeNull();
  });

  it("the window is six hours: the real follow-ups came one to three hours after the answer", () => {
    expect(FOLLOW_UP_WINDOW_MS).toBe(6 * 3_600_000);
    const state = new FollowUpStateStore(schema(new DatabaseSync(":memory:")));
    state.recordAnswer(SESSION, {
      taskSlug: "repo-stats",
      ownerText: "q",
      answerText: "a",
      now: T0,
    });
    // 2026-11-07: stats question 11:05, "how about our npm downloads" 12:43.
    expect(state.pendingAnswer(SESSION, T0 + 98 * 60_000)).not.toBeNull();
    // 2026-11-11: 10:24 and 13:06.
    expect(state.pendingAnswer(SESSION, T0 + 162 * 60_000)).not.toBeNull();
    expect(state.pendingAnswer(SESSION, T0 + 7 * 3_600_000)).toBeNull();
  });

  it("keeps the answer to an untyped request for the next message, under the same window and one check", () => {
    const state = new FollowUpStateStore(schema(new DatabaseSync(":memory:")));
    expect(state.pendingUntypedAnswer(SESSION, T0)).toBeNull();
    state.recordAnswer(SESSION, {
      sessionId: "s1",
      taskSlug: null,
      ownerText: "[Fri 2026-11-27 11:36 EST] Can you check the latest stats?",
      answerText: "Clones: 4,022 total.",
      now: T0,
    });
    expect(state.pendingAnswer(SESSION, T0 + 1)).toBeNull();
    expect(state.recentTaskSlug(SESSION, T0 + 1)).toBeNull();
    expect(state.pendingUntypedAnswer(SESSION, T0 + 60_000)).toEqual({
      sessionId: "s1",
      ownerText: "Can you check the latest stats?",
      answerText: "Clones: 4,022 total.",
      answeredAt: T0,
    });
    expect(state.pendingUntypedAnswer(SESSION, T0 + FOLLOW_UP_WINDOW_MS + 1)).toBeNull();
    state.markGapChecked(SESSION, T0 + 1000);
    expect(state.pendingUntypedAnswer(SESSION, T0 + 2000)).toBeNull();
    // A typed answer is not an untyped one, and an empty answer arms nothing.
    state.recordAnswer(SESSION, {
      taskSlug: "repo-stats",
      ownerText: "q",
      answerText: "a",
      now: T0,
    });
    expect(state.pendingUntypedAnswer(SESSION, T0 + 1)).toBeNull();
    state.recordAnswer(SESSION, { taskSlug: null, ownerText: "q", answerText: " ", now: T0 });
    expect(state.pendingUntypedAnswer(SESSION, T0 + 1)).toBeNull();
    state.recordAnswer(SESSION, { taskSlug: null, ownerText: "q", answerText: "a", now: T0 });
    state.clearAnswer(SESSION, T0 + 1);
    expect(state.pendingUntypedAnswer(SESSION, T0 + 2)).toBeNull();
  });

  it("follows a task type that was merged or renamed", () => {
    const state = new FollowUpStateStore(schema(new DatabaseSync(":memory:")));
    state.recordAnswer(SESSION, {
      taskSlug: "npm-stats",
      ownerText: "q",
      answerText: "a",
      now: T0,
    });
    state.repointTask("npm-stats", "repo-stats");
    expect(state.pendingAnswer(SESSION, T0 + 1)?.taskSlug).toBe("repo-stats");
  });

  it("is a no-op on a database without the table", () => {
    const state = new FollowUpStateStore(new DatabaseSync(":memory:"));
    expect(state.get(SESSION)).toBeNull();
    state.recordAnswer(SESSION, { taskSlug: "x", ownerText: "q", answerText: "a" });
    state.setOffer(SESSION, "p");
    expect(state.pendingAnswer(SESSION)).toBeNull();
  });
});

describe("parseOfferAnswer", () => {
  it.each([
    "yes",
    "Yes.",
    "YES!",
    "yep",
    "yeah",
    "yup",
    "sure",
    "Sure thing",
    "please do",
    "Yes please",
    "yes, please",
    "yes do that",
    "yes, every time",
    "yes include it every time",
    "go ahead",
    "do it",
    "absolutely",
    "y",
    "[Fri 2026-11-27 09:14 EST] yes",
  ])("yes: %s", (text) => {
    expect(parseOfferAnswer(text)).toBe("yes");
  });

  it.each([
    "no",
    "No.",
    "nope",
    "nah",
    "don't",
    "don’t",
    "dont",
    "do not",
    "please don't",
    "no thanks",
    "no, thank you",
    "no need",
    "never",
    "n",
  ])("no: %s", (text) => {
    expect(parseOfferAnswer(text)).toBe("no");
  });

  it.each([
    "",
    "ok",
    "okay",
    "yes?",
    "yes but only on Mondays",
    "no, the deploy endpoint is api2.acme.com",
    "yes and also the views",
    "not now",
    "maybe",
    "hmm",
    "sure, what about traffic?",
    "yesterday's numbers please",
    "no idea",
    "nothing",
    "how about our npm downloads",
    "yes yes yes yes yes yes yes yes yes yes yes yes yes",
    "thanks",
  ])("neither: %s", (text) => {
    expect(parseOfferAnswer(text)).toBeNull();
  });
});

describe("the follow-up check prompt and parser", () => {
  it("the stand-alone prompt carries the request, the previous answer and the owner's message", () => {
    const prompt = buildFollowUpGapPrompt(CTX, "how about our npm downloads");
    expect(prompt).toContain(CTX.previousOwnerMessage);
    expect(prompt).toContain(CTX.previousAnswer);
    expect(prompt).toContain("Owner (follow-up): how about our npm downloads");
    expect(prompt).toContain('"repo stats"');
    expect(prompt).toContain('{"kind":"other"}');
  });

  it("the folded section carries the same and asks for a follow_up key", () => {
    const section = buildFollowUpPromptSection(CTX, "Give me day by day clones too");
    expect(section).toContain("## Follow-up check");
    expect(section).toContain('"follow_up"');
    expect(section).toContain(CTX.previousAnswer);
    expect(section).toContain("Give me day by day clones too");
  });

  it("parses gap and other, stand-alone or under follow_up", () => {
    expect(parseFollowUpGap('{"kind":"gap","missing":"Include npm downloads"}')).toEqual({
      kind: "gap",
      statement: "Include npm downloads",
    });
    expect(parseFollowUpGap('{"kind":"other"}')).toEqual({ kind: "other" });
    expect(
      parseFollowUpGap(
        '```json\n{"facts":[],"practices":[],"follow_up":{"kind":"gap","missing":"include traffic for the past few days."}}\n```',
      ),
    ).toEqual({ kind: "gap", statement: "Include traffic for the past few days." });
    expect(parseFollowUpGap('{"facts":[],"follow_up":{"kind":"other"}}')).toEqual({
      kind: "other",
    });
  });

  it("the rules say that another metric of the same report is a gap, offered or not", () => {
    const prompt = buildFollowUpGapPrompt(CTX, "What about visitors to the repo?");
    expect(prompt).toContain("another metric, item, breakdown or time range of the same report");
    expect(prompt).toContain("had offered that item");
    expect(prompt).toContain('When unsure, answer "other".');
    expect(prompt).not.toContain("\u2014");
  });

  it("a follow-up to an untyped request says which side made it a candidate", () => {
    const ctx = {
      ...CTX,
      previousOwnerMessage: "Can you check the latest stats?",
      typedBy: "message" as const,
    };
    const prompt = buildFollowUpGapPrompt(
      ctx,
      "Give me day by day clones and the npm downloads too",
    );
    expect(prompt).toContain("Owner (request): Can you check the latest stats?");
    expect(prompt).toContain(
      'Owner (follow-up; it reads like "repo stats", a request the owner makes regularly): Give me day by day clones and the npm downloads too',
    );
    expect(prompt).not.toContain("made a request they make regularly");
    expect(buildFollowUpPromptSection(ctx, "Give me day by day clones too")).toContain(
      "answered an earlier request",
    );
  });

  it("takes the first object of an answer with prose around it (real model answers)", () => {
    // claude-haiku-4-5, 2026-11-27 replay: counted "unusable" before.
    expect(
      parseFollowUpGap(
        '```json\n{"kind":"other"}\n```\n\nThe follow-up is a new, separate request (running `deep_recall` with a specific REPL query) rather than asking for a missing element.',
      ),
    ).toEqual({ kind: "other" });
    expect(
      parseFollowUpGap(
        'The follow-up asks about npm downloads, which is a different metric of repository performance.\n\n```json\n{"kind":"gap","missing":"Include npm downloads"}\n```',
      ),
    ).toEqual({ kind: "gap", statement: "Include npm downloads" });
    expect(
      parseFollowUpGap(
        '```json\n{"kind":"gap","missing":"Include traffic"}\n```\n\nThe owner asks for a metric the answer left out.',
      ),
    ).toEqual({ kind: "gap", statement: "Include traffic" });
  });

  it("a gap the model takes back is unusable; an 'other' it wavers on stays other (real answer)", () => {
    expect(
      parseFollowUpGap(
        '```json\n{"kind":"gap","missing":"Include step 1 confirmation"}\n```\n\nWait, let me reconsider. The follow-up is asking for a different query structure.',
      ),
    ).toBeNull();
    expect(
      parseFollowUpGap(
        '{"facts":[],"follow_up":{"kind":"gap","missing":"Include npm downloads"}}\n\nActually, the answer did contain it.',
      ),
    ).toBeNull();
    expect(
      parseFollowUpGap('{"kind":"other"}\n\nWait, let me reconsider. It could be a gap.'),
    ).toEqual({ kind: "other" });
  });

  it("a gap that names one instance is 'specific', never a gap (real case)", () => {
    // From "geez, not clones stats for the 24th to 27th?".
    expect(
      parseFollowUpGap('{"kind":"gap","missing":"Include clone stats for the 24th to 27th"}'),
    ).toEqual({ kind: "specific", statement: "Include clone stats for the 24th to 27th" });
    for (const statement of [
      "Include the 14-day window",
      "Include the last 7 days",
      "Include clones for yesterday",
      "Include today's views",
      "Include the November totals",
      "Include Friday's clones",
      "Include the numbers for Sept 24",
    ]) {
      expect(isSpecificGapStatement(statement), statement).toBe(true);
    }
    for (const statement of [
      "Include npm downloads",
      "Include day by day clones",
      "Include traffic for the past few days",
      "Include visitors to the repo",
      "Include p95 latency",
      "Include the s3 bucket sizes",
      "Include what may be missing",
    ]) {
      expect(isSpecificGapStatement(statement), statement).toBe(false);
    }
  });

  it("puts 'Include' in front of a bare element", () => {
    expect(parseFollowUpGap('{"kind":"gap","missing":"npm downloads"}')).toEqual({
      kind: "gap",
      statement: "Include npm downloads",
    });
  });

  it("is null for anything unusable", () => {
    for (const raw of [
      "",
      "not json",
      "[]",
      '{"kind":"gap"}',
      '{"kind":"gap","missing":""}',
      '{"kind":"gap","missing":"Include more"}',
      '{"kind":"maybe","missing":"Include npm downloads"}',
      '{"facts":[]}',
      `{"kind":"gap","missing":"Include ${"x".repeat(400)}"}`,
      '{"kind":"gap","missing":"Include the key sk-ant-REDACTED-0123456789abcdefghijklmnop"}',
    ]) {
      expect(parseFollowUpGap(raw), raw).toBeNull();
    }
  });
});

describe("grounding and matching", () => {
  it("the element must be in the owner's words; the verb is not asked of them", () => {
    expect(gapElement("Include npm downloads.")).toBe("npm downloads");
    expect(isGapGrounded("how about our npm downloads", "Include npm downloads")).toBe(true);
    expect(isGapGrounded("how did npm do?", "Include npm")).toBe(true);
    expect(
      isGapGrounded(
        "what has the traffic been like the past few days?",
        "Include traffic for the past few days",
      ),
    ).toBe(true);
    // The owner's typo, the model's spelling (real: "What about vistors to the repo?").
    expect(isGapGrounded("What about vistors to the repo?", "Include visitors to the repo")).toBe(
      true,
    );
    expect(isGapGrounded("and the dowloads?", "Include downloads")).toBe(true);
    expect(isGapGrounded("and the donwloads?", "Include downloads")).toBe(true);
    // Short words get no such slack, and two edits are another word.
    expect(isGapGrounded("how are the stars?", "Include stats")).toBe(false);
    expect(isGapGrounded("what about the visits?", "Include visitors")).toBe(false);
    // The model named something the owner did not say.
    expect(isGapGrounded("how did npm do?", "Include npm downloads")).toBe(false);
    expect(isGapGrounded("thanks, looks good", "Include npm downloads")).toBe(false);
    expect(isGapGrounded("how about our npm downloads", "Include the wallet balance")).toBe(false);
  });

  it("matches the same element said shorter or longer, and nothing else", () => {
    expect(areGapStatementsMatching("Include npm downloads", "Include npm")).toBe(true);
    expect(areGapStatementsMatching("Include npm", "Include the npm downloads.")).toBe(true);
    expect(areGapStatementsMatching("Include npm downloads", "Include npm downloads!")).toBe(true);
    expect(areGapStatementsMatching("Include npm downloads", "Include traffic")).toBe(false);
    expect(areGapStatementsMatching("Include npm downloads", "Include npm audit results")).toBe(
      false,
    );
  });
});

describe("recordGapSighting", () => {
  let store: PracticesStore;
  beforeEach(() => {
    store = new PracticesStore(schema(new DatabaseSync(":memory:")));
  });

  const sighting = (over: Partial<Parameters<typeof recordGapSighting>[0]> = {}) =>
    recordGapSighting({
      store,
      taskSlug: "repo-stats",
      statement: "Include npm downloads",
      ownerProse: "how about our npm downloads",
      evidenceRef: "session:/s/a.jsonl#L4",
      sessionId: "s1",
      explicit: false,
      origin: "follow_up",
      now: T0,
      ...over,
    });

  it("stores a candidate at task scope, origin follow_up, never active", () => {
    const res = sighting();
    expect(res).toMatchObject({
      kind: "candidate",
      op: "add",
      practice: {
        statement: "Include npm downloads",
        scope: "task:repo-stats",
        status: "candidate",
        source: "extraction",
        origin: "follow_up",
        evidenceRefs: ["session:/s/a.jsonl#L4"],
      },
    });
    expect(store.listVisible({ taskSlug: "repo-stats" })).toEqual([]);
  });

  it("the real pair: 'how did npm do?' strengthens the candidate from 'how about our npm downloads'", () => {
    const first = sighting();
    // The model names the element in the owner's words...
    const second = sighting({
      statement: "Include npm",
      ownerProse: "how did npm do?",
      evidenceRef: "session:/s/b.jsonl#L2",
      sessionId: "s2",
      now: T0 + 4 * DAY,
    });
    expect(second).toMatchObject({ kind: "candidate", op: "strengthen" });
    expect(store.list()).toHaveLength(1);
    expect(store.list()[0]).toMatchObject({
      statement: "Include npm downloads",
      status: "candidate",
      evidenceRefs: ["session:/s/a.jsonl#L4", "session:/s/b.jsonl#L2"],
    });
    if (first.kind !== "candidate") {
      throw new Error("no candidate");
    }
    expect(countIndependentSightings(store, first.practice.id)).toEqual({
      independent: 2,
      explicit: false,
    });
    // ...or repeats the stored wording, which this message alone would not
    // ground: still the same row, because the owner did say "npm".
    const third = sighting({
      statement: "Include npm downloads",
      ownerProse: "how did npm do?",
      evidenceRef: "session:/s/c.jsonl#L2",
      sessionId: "s3",
      now: T0 + 5 * DAY,
    });
    expect(third).toMatchObject({ kind: "candidate", op: "strengthen" });
    expect(store.list()).toHaveLength(1);
  });

  it("a statement the owner's words do not support founds nothing", () => {
    expect(sighting({ ownerProse: "how did npm do?" })).toEqual({ kind: "ungrounded" });
    expect(sighting({ ownerProse: "thanks!" })).toEqual({ kind: "ungrounded" });
    expect(store.list()).toHaveLength(0);
  });

  it("a different gap on the same task is a second candidate", () => {
    sighting();
    const views = sighting({
      statement: "Include views and traffic",
      ownerProse: "what about views and traffic?",
    });
    expect(views).toMatchObject({ kind: "candidate", op: "add" });
    expect(store.list()).toHaveLength(2);
  });

  it("two sightings in one session on one day are one independent sighting", () => {
    const first = sighting();
    sighting({ evidenceRef: "session:/s/a.jsonl#L9" });
    if (first.kind !== "candidate") {
      throw new Error("no candidate");
    }
    expect(countIndependentSightings(store, first.practice.id).independent).toBe(1);
  });

  it("the owner's no holds: a declined candidate is not stored again", () => {
    const first = sighting();
    if (first.kind !== "candidate") {
      throw new Error("no candidate");
    }
    expect(store.suppress(first.practice.id)).toBe(true);
    expect(sighting({ sessionId: "s2", now: T0 + DAY })).toEqual({ kind: "refused" });
    expect(sighting({ statement: "Include npm", ownerProse: "and npm?", sessionId: "s3" })).toEqual(
      { kind: "refused" },
    );
    expect(store.list()).toHaveLength(1);
    expect(store.list()[0]?.status).toBe("suppressed");
  });

  it("a gap that an active practice already covers is a repeat, not a candidate", () => {
    const saved = store.upsert({
      statement: "Include npm downloads.",
      scope: "task:repo-stats",
      source: "owner",
    });
    if (!saved.ok) {
      throw new Error("seed failed");
    }
    const res = sighting();
    expect(res).toMatchObject({ kind: "repeat", practice: { id: saved.practice.id } });
    expect(store.list()).toHaveLength(1);
    expect(store.counters().overall.repeats).toBe(1);
    expect(store.counters().byPractice.get(saved.practice.id)?.repeats).toBe(1);
    expect(store.events(saved.practice.id).find((e) => e.kind === "repeat")).toMatchObject({
      kind: "repeat",
      detail: { via: "follow_up" },
      sessionRef: "session:/s/a.jsonl#L4",
    });
    // An active practice for another task is not visible on this turn.
    const other = recordGapSighting({
      store,
      taskSlug: "mailbox-check",
      statement: "Include npm downloads",
      ownerProse: "how about our npm downloads",
      evidenceRef: null,
      sessionId: "s1",
      explicit: false,
      origin: "follow_up",
    });
    expect(other.kind).toBe("candidate");
    expect(store.counters().overall.repeats).toBe(1);
  });
});

describe("offers", () => {
  let store: PracticesStore;
  let id: string;
  beforeEach(() => {
    store = new PracticesStore(schema(new DatabaseSync(":memory:")));
    const res = recordGapSighting({
      store,
      taskSlug: "repo-stats",
      statement: "Include npm downloads",
      ownerProse: "how about our npm downloads",
      evidenceRef: "session:/s/a.jsonl#L4",
      sessionId: "s1",
      explicit: false,
      origin: "follow_up",
      now: T0,
    });
    if (res.kind !== "candidate") {
      throw new Error("no candidate");
    }
    id = res.practice.id;
  });

  const again = (sessionId: string, now: number, explicit = false) =>
    recordGapSighting({
      store,
      taskSlug: "repo-stats",
      statement: "Include npm downloads",
      ownerProse: "how about our npm downloads",
      evidenceRef: `session:/s/${sessionId}.jsonl#L2`,
      sessionId,
      explicit,
      origin: "follow_up",
      now,
    });

  it("one sighting earns no offer", () => {
    expect(pickOffer(store, { taskSlug: "repo-stats", sessionId: "s1" })).toBeNull();
  });

  it("two independent sightings do; a second session or a second day both count", () => {
    again("s2", T0 + 60_000);
    expect(pickOffer(store, { taskSlug: "repo-stats", sessionId: "s2" })).toMatchObject({
      practice: { id },
      sightings: 2,
    });
    expect(pickOffer(store, { taskSlug: "other-task", sessionId: "s2" })).toBeNull();
  });

  it("one explicit instruction is enough", () => {
    const fresh = new PracticesStore(schema(new DatabaseSync(":memory:")));
    recordGapSighting({
      store: fresh,
      taskSlug: "repo-stats",
      statement: "Include day by day clones and npm downloads",
      ownerProse: "Give me day by day clones and the npm downloads too",
      evidenceRef: null,
      sessionId: "s1",
      explicit: true,
      origin: "follow_up",
    });
    expect(pickOffer(fresh, { taskSlug: "repo-stats", sessionId: "s1" })).toMatchObject({
      sightings: 1,
    });
  });

  it("never twice in a session, at most twice in total, and never once it is not a candidate", () => {
    again("s2", T0 + DAY);
    expect(store.recordOffer(id, { sessionId: "s2", now: T0 + DAY })).toBe(true);
    expect(store.get(id)?.offerCount).toBe(1);
    // Same session: no.
    expect(pickOffer(store, { taskSlug: "repo-stats", sessionId: "s2" })).toBeNull();
    // Another session: the second and last offer.
    expect(pickOffer(store, { taskSlug: "repo-stats", sessionId: "s3" })).not.toBeNull();
    expect(store.recordOffer(id, { sessionId: "s3", now: T0 + 2 * DAY })).toBe(true);
    expect(store.get(id)?.offerCount).toBe(MAX_OFFERS_PER_PRACTICE);
    expect(pickOffer(store, { taskSlug: "repo-stats", sessionId: "s4" })).toBeNull();
    expect(store.counters().overall.offers).toBe(2);
    // Confirmed: nothing left to offer, and recordOffer refuses.
    expect(store.activate(id, T0 + 3 * DAY, "offer")).toBe(true);
    expect(store.recordOffer(id, { sessionId: "s5" })).toBe(false);
    expect(store.counters().overall).toMatchObject({ offers: 2, confirmed: 1, declined: 0 });
  });

  it("offers one candidate per reply: the one sighted on this turn, else the most sighted", () => {
    again("s2", T0 + DAY);
    const views = (sessionId: string, now: number) =>
      recordGapSighting({
        store,
        taskSlug: "repo-stats",
        statement: "Include views and traffic",
        ownerProse: "what about views and traffic?",
        evidenceRef: null,
        sessionId,
        explicit: false,
        origin: "follow_up",
        now,
      });
    const v = views("s1", T0);
    views("s2", T0 + DAY);
    views("s3", T0 + 2 * DAY);
    if (v.kind !== "candidate") {
      throw new Error("no candidate");
    }
    expect(pickOffer(store, { taskSlug: "repo-stats", sessionId: "s9" })?.practice.id).toBe(
      v.practice.id,
    );
    expect(
      pickOffer(store, { taskSlug: "repo-stats", sessionId: "s9", preferId: id })?.practice.id,
    ).toBe(id);
  });

  it("the lines are generated, in the documented wording, without em-dashes", () => {
    const twice = formatOfferLine({
      statement: "Include npm downloads",
      taskLabel: "repo stats",
      sightings: 2,
    });
    expect(twice).toBe(
      "You have asked for npm downloads after repo stats twice. Include it every time? (yes / no)",
    );
    expect(
      formatOfferLine({
        statement: "Include npm downloads",
        taskLabel: "repo stats",
        sightings: 4,
      }),
    ).toContain("after repo stats 4 times.");
    expect(
      formatOfferLine({
        statement: "Include day by day clones and npm downloads",
        taskLabel: "repo stats",
        sightings: 1,
      }),
    ).toBe(
      "You asked for day by day clones and npm downloads after repo stats. Include it every time? (yes / no)",
    );
    const saved = formatOfferAnswerLine({
      kind: "confirmed",
      statement: "Include npm downloads",
      taskLabel: "repo stats",
    });
    expect(saved).toBe('Practice saved for repo stats: "Include npm downloads"');
    const declined = formatOfferAnswerLine({
      kind: "declined",
      statement: "Include npm downloads",
      taskLabel: "repo stats",
    });
    expect(declined).toBe("Understood, I will not ask again.");
    const note = formatOfferAnswerNote({
      kind: "confirmed",
      statement: "Include npm downloads",
      taskLabel: "repo stats",
    });
    expect(note).toContain("## Practice offer answered");
    expect(note).toContain('"Include npm downloads"');
    for (const line of [twice, saved, declined, note]) {
      expect(line).not.toContain("—");
    }
  });

  it("the offer-answer note names what was offered, what the answer did, and that nothing else changed", () => {
    // Real, 2026-11-27: after "no" to "Include traffic" the model replied
    // "Got it, dropping the npm add-on going forward" (a different, active
    // practice). The note has to leave no room for that.
    const declined = formatOfferAnswerNote({
      kind: "declined",
      statement: "Include traffic",
      taskLabel: "repo clone metrics",
    });
    expect(declined).toContain('"Include traffic"');
    expect(declined).toContain("repo clone metrics");
    expect(declined).toContain("The owner said no.");
    expect(declined).toContain("It was only a proposal and was never in effect.");
    expect(declined).toContain("No other practice changed");
    expect(declined).toContain("Acknowledge in one short sentence.");
    expect(declined).toContain("do not restate or change any other practice");
    expect(declined).toContain("do not claim that you saved, dropped or changed anything yourself");
    expect(declined).not.toContain("—");

    const confirmed = formatOfferAnswerNote({
      kind: "confirmed",
      statement: "Include npm downloads",
      taskLabel: "repo clone metrics",
    });
    expect(confirmed).toContain(
      'The system saved "Include npm downloads" as a standing practice for repo clone metrics',
    );
    expect(confirmed).toContain("No other practice changed");
    expect(confirmed).not.toContain("dropped the proposal");
    // The question was the system's, not the model's.
    expect(confirmed).toContain("the system (not you) asked the owner one question");
  });
});
