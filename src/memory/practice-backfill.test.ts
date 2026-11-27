/**
 * PLAN-64 Phase 1b: the owner-triggered backfill.
 *
 * Under test, over transcript files written for the test: live and `.reset`
 * transcripts are read and `.deleted` ones are not; cron, heartbeat and
 * system turns are not the owner's; the counts are reported before the first
 * model call; a dry run writes nothing to the live database; `apply` writes
 * candidates (origin `backfill`, never active) and the task type they hang
 * on; the call budget holds; the owner's earlier no is honoured.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureMemoryIndexSchema } from "./memory-schema.js";
import { isBackfillTranscript, runPracticeBackfill } from "./practice-backfill.js";
import { PracticesStore } from "./practices.js";
import { TaskTypesStore } from "./task-types.js";

const STATS = "How many clones did your repo get yesterday?";
const ANSWER = "Yesterday the repo had 68 unique clones (240 total).";

type Turn = { role: "user" | "assistant"; text: string; at: string };

function line(turn: Turn): string {
  return JSON.stringify({
    type: "message",
    timestamp: turn.at,
    message: { role: turn.role, content: [{ type: "text", text: turn.text }] },
  });
}

function session(day: number, followUp?: string, extra: Turn[] = []): string {
  const d = String(day).padStart(2, "0");
  const turns: Turn[] = [
    {
      role: "user",
      text: `[Sat 2026-11-${d} 09:00 EST] ${STATS}`,
      at: `2026-11-${d}T14:00:00.000Z`,
    },
    { role: "assistant", text: ANSWER, at: `2026-11-${d}T14:00:20.000Z` },
    ...(followUp
      ? [{ role: "user" as const, text: followUp, at: `2026-11-${d}T14:03:00.000Z` }]
      : []),
    ...extra,
  ];
  return `${JSON.stringify({ type: "session", id: `s${day}` })}\n${turns.map(line).join("\n")}\n`;
}

let dir: string;
let db: DatabaseSync;
let practices: PracticesStore;
let taskTypes: TaskTypesStore;
const llm = vi.fn<(prompt: string) => Promise<string>>();

/** Rows in every table the backfill could touch. */
function liveRowCounts(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const table of [
    "practices",
    "practice_events",
    "task_types",
    "practice_session_state",
    "memory_audit_log",
  ]) {
    out[table] = Number(
      (db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c,
    );
  }
  return out;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-backfill-"));
  fs.writeFileSync(path.join(dir, "s1.jsonl"), session(7, "how about our npm downloads"));
  fs.writeFileSync(
    path.join(dir, "s2.jsonl"),
    session(8, "hmm, I wonder what drove the 68 unique clones..."),
  );
  // An archived (reset) transcript counts.
  fs.writeFileSync(
    path.join(dir, "s3.jsonl.reset.2026-11-09T20-00-00.000Z"),
    session(9, "how did npm do?"),
  );
  // A deleted one does not: its follow-up would be a third sighting.
  fs.writeFileSync(
    path.join(dir, "s4.jsonl.deleted.2026-11-10T20-00-00.000Z"),
    session(10, "how about our npm downloads"),
  );
  // Not the owner typing: a cron fire and a heartbeat after a stats answer.
  fs.writeFileSync(
    path.join(dir, "s5.jsonl"),
    session(11, "[cron: daily-report] how about our npm downloads", [
      { role: "user", text: "Read HEARTBEAT.md and follow it", at: "2026-11-11T14:05:00.000Z" },
    ]),
  );
  fs.writeFileSync(path.join(dir, "sessions.json"), "{}");

  db = new DatabaseSync(":memory:");
  ensureMemoryIndexSchema({
    db,
    embeddingCacheTable: "embedding_cache",
    ftsTable: "chunks_fts",
    ftsEnabled: false,
  });
  practices = new PracticesStore(db);
  taskTypes = new TaskTypesStore(db, {
    onMerge: (from, into) => practices.repointTaskScope(from, into),
  });
  llm.mockReset();
  llm.mockImplementation(async (prompt: string) => {
    if (prompt.includes("Name that kind of request")) {
      return '{"slug":"repo-stats","label":"repo stats"}';
    }
    if (prompt.includes("Owner (follow-up): how about our npm downloads")) {
      return '{"kind":"gap","missing":"Include npm downloads"}';
    }
    if (prompt.includes("Owner (follow-up): how did npm do?")) {
      return '{"kind":"gap","missing":"Include npm"}';
    }
    return '{"kind":"other"}';
  });
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const run = (over: Partial<Parameters<typeof runPracticeBackfill>[0]> = {}) =>
  runPracticeBackfill({
    sessionsDir: dir,
    practices,
    taskTypes,
    llmCall: llm,
    change: async (_label, fn) => fn(),
    ...over,
  });

describe("isBackfillTranscript", () => {
  it("takes live and reset transcripts, never deleted ones or other files", () => {
    expect(isBackfillTranscript("abc.jsonl")).toBe(true);
    expect(isBackfillTranscript("abc.jsonl.reset.2026-11-09T20-00-00.000Z")).toBe(true);
    expect(isBackfillTranscript("abc.jsonl.deleted.2026-11-10T20-00-00.000Z")).toBe(false);
    expect(isBackfillTranscript("abc.deleted.jsonl")).toBe(false);
    expect(isBackfillTranscript("sessions.json")).toBe(false);
  });
});

describe("runPracticeBackfill", () => {
  it("a dry run lists the candidates with their evidence and writes nothing", async () => {
    const before = liveRowCounts();
    const onPlan = vi.fn(() => {
      // The counts come before the first model call.
      expect(llm).not.toHaveBeenCalled();
    });
    const result = await run({ onPlan });
    expect(onPlan).toHaveBeenCalledWith({
      transcripts: 4,
      ownerTurns: 7,
      followUps: 3,
      newTaskTypes: 1,
      maxCalls: 40,
      hasModel: true,
    });
    // One naming call, one per follow-up.
    expect(result.modelCalls).toBe(4);
    expect(llm).toHaveBeenCalledTimes(4);
    expect(result.notExamined).toBe(0);
    expect(result.outcomes).toMatchObject({ other: 1, unusable: 0, specific: 0, ungrounded: 0 });
    // Every follow-up it looked at, oldest first, with what became of it.
    expect(result.examined).toEqual([
      {
        day: "2026-11-7",
        taskSlug: "repo-stats",
        typedBy: "answer",
        text: "how about our npm downloads",
        outcome: "candidate",
        statement: "Include npm downloads",
      },
      {
        day: "2026-11-8",
        taskSlug: "repo-stats",
        typedBy: "answer",
        text: "hmm, I wonder what drove the 68 unique clones...",
        outcome: "other",
        statement: null,
      },
      {
        day: "2026-11-9",
        taskSlug: "repo-stats",
        typedBy: "answer",
        text: "how did npm do?",
        outcome: "candidate",
        statement: "Include npm",
      },
    ]);
    expect(result.taskTypes).toEqual([
      { slug: "repo-stats", label: "repo stats", occurrences: 4, isNew: true },
    ]);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      taskSlug: "repo-stats",
      taskLabel: "repo stats",
      statement: "Include npm downloads",
      state: "new",
      sightings: 2,
      offerReady: true,
    });
    expect(result.candidates[0]!.evidence.map((e) => e.text)).toEqual([
      "how about our npm downloads",
      "how did npm do?",
    ]);
    expect(result.candidates[0]!.evidence[0]!.ref).toMatch(/^session:.*s1\.jsonl#L\d+$/);
    expect(result.applied).toBeNull();
    // The gap prompt carried the previous answer and the follow-up.
    const gapPrompt = llm.mock.calls.map((c) => c[0]).find((p) => p.includes("how did npm do?"))!;
    expect(gapPrompt).toContain(ANSWER);
    expect(gapPrompt).toContain(STATS);
    // Nothing was written.
    expect(liveRowCounts()).toEqual(before);
    expect(practices.list()).toEqual([]);
    expect(taskTypes.list()).toEqual([]);
  });

  it("--apply writes candidates (origin backfill, never active) and their task type", async () => {
    const result = await run({ apply: true });
    expect(result.applied).toEqual({ candidates: 1, sightings: 2, taskTypes: 1 });
    const rows = practices.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      statement: "Include npm downloads",
      scope: "task:repo-stats",
      status: "candidate",
      source: "extraction",
      origin: "backfill",
      offerCount: 0,
    });
    expect(rows[0]!.evidenceRefs).toHaveLength(2);
    // Sightings carry the day the owner asked, not the day of the backfill.
    expect(practices.sightings(rows[0]!.id).map((s) => s.day)).toEqual(["2026-11-7", "2026-11-9"]);
    expect(practices.listVisible({ taskSlug: "repo-stats" })).toEqual([]);
    expect(taskTypes.get("repo-stats")).toMatchObject({ recurring: true, label: "repo stats" });
    expect(taskTypes.classify(STATS)?.slug).toBe("repo-stats");
    // Running it again does not inflate the evidence: same sessions, same days.
    const again = await run({ apply: true });
    expect(again.candidates[0]).toMatchObject({ state: "existing", sightings: 2 });
    expect(practices.list()).toHaveLength(1);
    expect(again.taskTypes[0]).toMatchObject({ slug: "repo-stats", isNew: false });
  });

  it("holds the call budget and reports what it did not examine", async () => {
    const result = await run({ maxCalls: 2 });
    expect(llm).toHaveBeenCalledTimes(2);
    expect(result.modelCalls).toBe(2);
    expect(result.notExamined).toBe(2);
    const none = await run({ maxCalls: 0 });
    expect(none.modelCalls).toBe(0);
    expect(none.notExamined).toBe(3);
    expect(none.candidates).toEqual([]);
  });

  it("stops after the counts when the caller says so, and without a model", async () => {
    const stopped = await run({ onPlan: () => false, apply: true });
    expect(llm).not.toHaveBeenCalled();
    expect(stopped.followUps).toBe(3);
    expect(stopped.notExamined).toBe(3);
    const noModel = await run({ llmCall: null, apply: true });
    expect(noModel.hasModel).toBe(false);
    expect(noModel.notExamined).toBe(3);
    expect(practices.list()).toEqual([]);
    expect(taskTypes.list()).toEqual([]);
  });

  it("honours a practice the owner declined before, and counts a gap an active one covers", async () => {
    taskTypes.adopt({
      slug: "repo-stats",
      label: "repo stats",
      exemplars: [STATS],
      occurrences: 3,
      distinctDays: 3,
      firstSeen: 0,
      lastSeen: 0,
      recurring: true,
    });
    const declined = practices.upsert({
      statement: "Include npm downloads",
      scope: "task:repo-stats",
      source: "extraction",
      origin: "follow_up",
    });
    if (!declined.ok) {
      throw new Error("seed failed");
    }
    practices.suppress(declined.practice.id);
    const result = await run({ apply: true });
    // The type already exists: nothing to name.
    expect(result.newTaskTypes).toBe(0);
    expect(result.modelCalls).toBe(3);
    expect(result.outcomes.declinedBefore).toBe(2);
    expect(result.candidates).toEqual([]);
    expect(result.applied).toBeNull();
    expect(practices.list()).toMatchObject([{ status: "suppressed" }]);

    // Bring it back as active: the same follow-ups are now repeats, counted
    // in the report only (the scratch copy takes the events, not the live store).
    practices.activate(declined.practice.id);
    const withActive = await run({ apply: true });
    expect(withActive.outcomes.repeatOfActive).toBe(2);
    expect(withActive.candidates).toEqual([]);
    expect(practices.counters().overall.repeats).toBe(0);
  });

  it("an unreadable sessions directory is an empty result, not an error", async () => {
    const result = await run({ sessionsDir: path.join(dir, "missing") });
    expect(result).toMatchObject({ transcripts: 0, followUps: 0, modelCalls: 0, candidates: [] });
  });

  /** One transcript: owner and assistant turns at the given UTC times on a day of November 2026. */
  function transcript(day: number, turns: Array<[role: Turn["role"], at: string, text: string]>) {
    const d = String(day).padStart(2, "0");
    return `${JSON.stringify({ type: "session", id: `x${day}` })}\n${turns
      .map(([role, at, text]) => line({ role, text, at: `2026-11-${d}T${at}:00.000Z` }))
      .join("\n")}\n`;
  }

  it("finds the next message hours after the answer, not one after six hours or after another owner turn", async () => {
    // Real timings: 2026-11-07 11:05 and 12:43; 2026-11-11 10:24 and 13:06.
    fs.writeFileSync(
      path.join(dir, "s1.jsonl"),
      transcript(7, [
        ["user", "16:05", STATS],
        ["assistant", "16:06", ANSWER],
        ["user", "17:43", "how about our npm downloads"],
      ]),
    );
    fs.writeFileSync(
      path.join(dir, "s3.jsonl.reset.2026-11-09T20-00-00.000Z"),
      transcript(9, [
        ["user", "15:24", STATS],
        ["assistant", "15:25", ANSWER],
        ["user", "18:06", "how did npm do?"],
      ]),
    );
    // Too late (seven hours), and a message with another owner turn in between.
    fs.writeFileSync(
      path.join(dir, "s6.jsonl"),
      transcript(12, [
        ["user", "09:00", STATS],
        ["assistant", "09:01", ANSWER],
        ["user", "16:02", "how about our npm downloads"],
      ]),
    );
    fs.writeFileSync(
      path.join(dir, "s7.jsonl"),
      transcript(13, [
        ["user", "09:00", STATS],
        ["assistant", "09:01", ANSWER],
        ["user", "09:05", "thanks, that works"],
        ["assistant", "09:05", "Any time."],
        ["user", "09:06", "how did npm do?"],
      ]),
    );
    const result = await run();
    const examined = result.examined.map((e) => `${e.day} ${e.outcome} ${e.text}`);
    expect(examined).toEqual([
      "2026-11-7 candidate how about our npm downloads",
      "2026-11-8 other hmm, I wonder what drove the 68 unique clones...",
      "2026-11-9 candidate how did npm do?",
      "2026-11-13 other thanks, that works",
    ]);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      statement: "Include npm downloads",
      sightings: 2,
      offerReady: true,
    });
  });

  it("a reply to a heartbeat in between is not the answer the follow-up is read against", async () => {
    fs.writeFileSync(
      path.join(dir, "s1.jsonl"),
      transcript(7, [
        ["user", "16:05", STATS],
        ["assistant", "16:06", ANSWER],
        ["user", "16:30", "Read HEARTBEAT.md and follow it"],
        ["assistant", "16:30", "HEARTBEAT_OK"],
        ["user", "17:43", "how about our npm downloads"],
      ]),
    );
    await run();
    const gapPrompt = llm.mock.calls
      .map((c) => c[0])
      .find((p) => p.includes("Owner (follow-up): how about our npm downloads"))!;
    expect(gapPrompt).toContain(ANSWER);
    expect(gapPrompt).not.toContain("HEARTBEAT_OK");
  });

  it("the second trigger: a recurring request right after an untyped one, never the first message of a transcript", async () => {
    // Real, 2026-11-27: "Can you check the latest stats?" matched no type.
    const rest = "And how many clones did the repo get yesterday, day by day?";
    fs.writeFileSync(
      path.join(dir, "s6.jsonl"),
      transcript(12, [
        ["user", "16:36", "Can you check the latest stats?"],
        ["assistant", "16:36", "Clones: 4,022 total. Views: 924 total."],
        ["user", "16:37", rest],
        ["assistant", "16:38", "Day by day: ..."],
      ]),
    );
    // The same message opening a transcript is an occurrence, not a follow-up.
    fs.writeFileSync(path.join(dir, "s7.jsonl"), transcript(13, [["user", "09:00", rest]]));
    llm.mockImplementation(async (prompt: string) => {
      if (prompt.includes("Name that kind of request")) {
        return '{"slug":"repo-stats","label":"repo stats"}';
      }
      return prompt.includes("Owner (request): Can you check the latest stats?")
        ? '{"kind":"gap","missing":"Include day by day clones"}'
        : '{"kind":"other"}';
    });
    const result = await run();
    const second = result.examined.filter((e) => e.typedBy === "message");
    expect(second).toEqual([
      {
        day: "2026-11-12",
        taskSlug: "repo-stats",
        typedBy: "message",
        text: rest,
        outcome: "candidate",
        statement: "Include day by day clones",
      },
    ]);
    const prompt = llm.mock.calls.map((c) => c[0]).find((p) => p.includes("Owner (request):"))!;
    expect(prompt).toContain("Clones: 4,022 total. Views: 924 total.");
    expect(prompt).toContain('it reads like "repo stats"');
  });

  it("counts a gap about one date or number as specific, a fenced answer with prose as usable, a retracted gap as unusable", async () => {
    fs.writeFileSync(
      path.join(dir, "s2.jsonl"),
      session(8, "geez, not clones stats for the 24th to 27th?"),
    );
    llm.mockImplementation(async (prompt: string) => {
      if (prompt.includes("Name that kind of request")) {
        return '```json\n{"slug":"repo-stats","label":"repo stats"}\n```\n\nThis names the general task.';
      }
      if (prompt.includes("24th to 27th?")) {
        return '{"kind":"gap","missing":"Include clone stats for the 24th to 27th"}';
      }
      if (prompt.includes("Owner (follow-up): how about our npm downloads")) {
        return '```json\n{"kind":"gap","missing":"Include npm downloads"}\n```\n\nThe owner asks for a metric the answer left out.';
      }
      return '```json\n{"kind":"gap","missing":"Include npm"}\n```\n\nWait, let me reconsider. This may be a new topic.';
    });
    const result = await run();
    expect(result.taskTypes).toMatchObject([{ slug: "repo-stats", label: "repo stats" }]);
    expect(result.outcomes).toMatchObject({ other: 0, unusable: 1, specific: 1 });
    expect(result.examined.map((e) => e.outcome)).toEqual(["candidate", "specific", "unusable"]);
    expect(result.candidates.map((c) => c.statement)).toEqual(["Include npm downloads"]);
  });

  it("names the largest new type first and offers a later one only already named types to merge into", async () => {
    const npm = [
      "how are the npm downloads of the package doing",
      "npm downloads of the package this week please",
      "what are the npm downloads of the package",
    ];
    npm.forEach((text, i) => {
      fs.writeFileSync(
        path.join(dir, `n${i}.jsonl`),
        transcript(20 + i, [
          ["user", "10:00", text],
          ["assistant", "10:01", "12 downloads."],
        ]),
      );
    });
    // Two more stats requests, so the stats type is clearly the larger one
    // (the base follow-up "how about our npm downloads" joins the npm type).
    fs.writeFileSync(path.join(dir, "s6.jsonl"), session(14));
    fs.writeFileSync(path.join(dir, "s7.jsonl"), session(15));
    const naming: string[] = [];
    llm.mockImplementation(async (prompt: string) => {
      if (!prompt.includes("Name that kind of request")) {
        return '{"kind":"other"}';
      }
      naming.push(prompt);
      return prompt.includes("same_as")
        ? '{"same_as":"repo-stats"}'
        : '{"slug":"repo-stats","label":"repo stats"}';
    });
    const result = await run();
    expect(naming).toHaveLength(2);
    // The larger type (four stats requests) first, with nothing to merge into yet.
    expect(naming[0]).toContain(STATS);
    expect(naming[0]).not.toContain("same_as");
    // The smaller one is shown the named type with its exemplars.
    expect(naming[1]).toContain(npm[0]);
    expect(naming[1]).toContain(`repo-stats (repo stats): ${JSON.stringify(STATS)}`);
    expect(result.taskTypes).toEqual([
      { slug: "repo-stats", label: "repo stats", occurrences: 10, isNew: true },
    ]);
  });
});
