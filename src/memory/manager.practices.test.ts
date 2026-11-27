/**
 * PLAN-64 Phase 1: the memory manager's practices glue, called on the real
 * prototype with a minimal `this` (the pattern of
 * manager.extraction-wiring.test.ts). Under test: the stores are bound to
 * the current database handle, task typing and capture typing honour
 * `memory.practices.enabled`, a type that turns recurring is named without
 * a model when none is configured, and the owner wrappers write through the
 * maintenance mutex with an audit entry.
 */
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { MaintenanceMutex } from "./maintenance-mutex.js";
import { MemoryIndexManager } from "./manager.js";
import { ensureMemoryIndexSchema } from "./memory-schema.js";
import { listAuditLog } from "./owner-controls.js";

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  ensureMemoryIndexSchema({
    db,
    embeddingCacheTable: "embedding_cache",
    ftsTable: "chunks_fts",
    ftsEnabled: false,
  });
  return db;
}

type Glue = Pick<
  MemoryIndexManager,
  | "practices"
  | "taskTypes"
  | "observeOwnerTurnTaskType"
  | "resolveCaptureTaskType"
  | "ownerListPractices"
  | "ownerSavePractice"
  | "ownerEditPractice"
  | "ownerSetPracticeScope"
  | "ownerRetirePractice"
  | "ownerUnretirePractice"
  | "followUpState"
  | "practiceFollowUpDeps"
  | "answerPracticeOffer"
  | "resolvePracticeOfferNote"
  | "ownerMergeTaskTypes"
  | "practiceCounters"
>;

function makeManager(cfg: Record<string, unknown> = {}): {
  m: Glue;
  db: DatabaseSync;
  raw: Record<string, unknown>;
} {
  const db = makeDb();
  const raw = Object.assign(
    Object.create(MemoryIndexManager.prototype) as Record<string, unknown>,
    {
      cfg,
      db,
      syncing: null,
      maintenanceMutex: new MaintenanceMutex(),
      practicesStore: null,
      taskTypesStore: null,
      // No model configured: a newly recurring type gets the fallback name.
      correctionLlmCall: () => null,
    },
  );
  return { m: raw as unknown as Glue, db, raw };
}

const NPM = "Include npm downloads when reporting repo stats.";
const QUESTIONS = [
  "How many clones did your repo get yesterday?",
  "how did our npm's and clones do yesterday?",
  "Can you check npm, clones and views for yesterday for your repo?",
];
const DAY = 24 * 3_600_000;

describe("MemoryIndexManager practices glue", () => {
  let m: Glue;
  let db: DatabaseSync;
  let raw: Record<string, unknown>;
  beforeEach(() => {
    ({ m, db, raw } = makeManager());
  });

  it("keeps one store per database handle and rebuilds it after a swap", () => {
    const first = m.practices();
    expect(m.practices()).toBe(first);
    expect(m.taskTypes()).toBe(m.taskTypes());
    raw.db = makeDb();
    expect(m.practices()).not.toBe(first);
  });

  it("types owner turns: recurring on the third day, named without a model, then returned", () => {
    // Two earlier days, seeded through the store with their dates.
    QUESTIONS.slice(0, 2).forEach((text, i) => {
      m.taskTypes().observe(text, { now: Date.now() - (3 - i) * DAY });
    });
    // Today, through the manager: the third day makes it recurring.
    const typed = m.observeOwnerTurnTaskType({
      text: QUESTIONS[2]!,
      sessionKey: "agent:main:main",
      turnKey: "run-1",
    });
    expect(typed).toMatchObject({ slug: expect.stringContaining("clone") });
    expect(m.taskTypes().list({ recurringOnly: true })).toHaveLength(1);
    // A retried attempt of the run does not count twice.
    m.observeOwnerTurnTaskType({
      text: QUESTIONS[2]!,
      sessionKey: "agent:main:main",
      turnKey: "run-1",
    });
    expect(m.taskTypes().get(typed!.slug)?.occurrences).toBe(3);
    // Capture scoping: the message itself, or the owner turn just before it.
    expect(
      m.resolveCaptureTaskType(
        "agent:main:main",
        "How did the repo do on clones and views yesterday?",
      ),
    ).toEqual(typed);
    expect(m.resolveCaptureTaskType("agent:main:main", "stop asking me that please")).toEqual(
      typed,
    );
    expect(
      m.resolveCaptureTaskType("agent:main:elsewhere", "stop asking me that please"),
    ).toBeNull();
  });

  it("memory.practices.enabled=false: no typing writes and no capture task type", () => {
    const off = makeManager({ memory: { practices: { enabled: false } } });
    for (let i = 0; i < 3; i++) {
      expect(off.m.observeOwnerTurnTaskType({ text: QUESTIONS[i]!, turnKey: `r${i}` })).toBeNull();
    }
    expect(off.m.taskTypes().list()).toHaveLength(0);
    expect(off.m.resolveCaptureTaskType("agent:main:main", QUESTIONS[0]!)).toBeNull();
    // The owner can still list and retire what is stored.
    expect(off.m.ownerListPractices()).toEqual([]);
  });

  it('session.memory "off": turns are matched read-only, never recorded', () => {
    const incognito = makeManager({ session: { memory: "off" } });
    for (let i = 0; i < 3; i++) {
      expect(
        incognito.m.observeOwnerTurnTaskType({ text: QUESTIONS[i]!, turnKey: `r${i}` }),
      ).toBeNull();
    }
    expect(incognito.m.taskTypes().list()).toHaveLength(0);
    // An existing recurring type is still recognised, without being counted.
    QUESTIONS.forEach((text, i) => {
      incognito.m.taskTypes().observe(text, { now: Date.now() - (5 - i) * DAY });
    });
    const pending = incognito.m.taskTypes().list()[0]!.slug;
    const type = incognito.m.taskTypes().promoteWithFallback(pending)!;
    expect(
      incognito.m.observeOwnerTurnTaskType({ text: QUESTIONS[0]!, turnKey: "r9" }),
    ).toMatchObject({
      slug: type.slug,
    });
    expect(incognito.m.taskTypes().get(type.slug)?.occurrences).toBe(3);
  });

  it("owner wrappers: save, edit, re-scope, retire, un-retire, all audited", async () => {
    const saved = await m.ownerSavePractice({ statement: NPM, scope: "task:repo-stats" });
    if (!saved.ok) {
      throw new Error("unreachable");
    }
    const id = saved.practice.id;
    expect(m.ownerListPractices()).toMatchObject([{ id, status: "active", source: "owner" }]);
    expect(
      await m.ownerEditPractice(id, "Include npm and PyPI downloads in repo stats."),
    ).toMatchObject({ ok: true });
    expect(await m.ownerSetPracticeScope(id, "global")).toMatchObject({
      ok: true,
      practice: { scope: "global" },
    });
    expect(await m.ownerRetirePractice(id)).toBe(true);
    expect(m.ownerListPractices({ statuses: ["retired"] })).toHaveLength(1);
    expect(await m.ownerUnretirePractice(id)).toBe(true);
    expect(m.practices().get(id)?.status).toBe("active");
    expect(listAuditLog(db, { limit: 20 }).map((e) => e.event)).toEqual(
      expect.arrayContaining([
        "practice_saved",
        "owner_edit_practice",
        "owner_scope_practice",
        "owner_retire_practice",
        "owner_unretire_practice",
      ]),
    );
  });

  // ── PLAN-64 Phase 1b ────────────────────────────────────────────────────

  function seedType(slug: string, exemplars: string[]): void {
    m.taskTypes().adopt({
      slug,
      label: slug.replace(/-/g, " "),
      exemplars,
      occurrences: 3,
      distinctDays: 3,
      firstSeen: Date.now() - 5 * DAY,
      lastSeen: Date.now() - DAY,
      recurring: true,
    });
  }

  it("a turn right after a recurring-task answer is not typed as a new kind of request", () => {
    seedType("repo-stats", QUESTIONS);
    m.followUpState().recordAnswer("agent:main:main", {
      sessionId: "s1",
      taskSlug: "repo-stats",
      ownerText: QUESTIONS[0]!,
      answerText: "68 unique clones.",
    });
    expect(
      m.observeOwnerTurnTaskType({
        text: "how about our npm downloads",
        sessionKey: "agent:main:main",
        turnKey: "run-2",
      }),
    ).toBeNull();
    expect(m.taskTypes().list()).toHaveLength(1);
    // In another session the same words do found a pending type.
    m.observeOwnerTurnTaskType({
      text: "how about our npm downloads",
      sessionKey: "agent:main:other",
      turnKey: "run-3",
    });
    expect(m.taskTypes().list()).toHaveLength(2);
  });

  it("memory.practices.followUps.enabled=false: the turn is typed as before", () => {
    const off = makeManager({ memory: { practices: { followUps: { enabled: false } } } });
    off.m.followUpState().recordAnswer("agent:main:main", {
      taskSlug: "repo-stats",
      ownerText: "q",
      answerText: "a",
    });
    off.m.observeOwnerTurnTaskType({
      text: "how about our npm downloads",
      sessionKey: "agent:main:main",
      turnKey: "run-2",
    });
    expect(off.m.taskTypes().list()).toHaveLength(1);
  });

  it("capture scoping survives a restart: the persisted answer names the task of the turn before", () => {
    seedType("repo-stats", QUESTIONS);
    // Nothing in process memory (a fresh manager), only the state row.
    m.followUpState().recordAnswer("agent:main:main", {
      taskSlug: "repo-stats",
      ownerText: QUESTIONS[0]!,
      answerText: "68 unique clones.",
    });
    expect(m.resolveCaptureTaskType("agent:main:main", "stop asking me that please")).toEqual({
      slug: "repo-stats",
      label: "repo stats",
    });
    expect(
      m.resolveCaptureTaskType("agent:main:elsewhere", "stop asking me that please"),
    ).toBeNull();
  });

  it("merging task types by hand re-points practices and the follow-up state, audited", async () => {
    seedType("repo-stats", QUESTIONS);
    seedType("npm-download-clone", ["how about our npm downloads"]);
    const saved = await m.ownerSavePractice({
      statement: NPM,
      scope: "task:npm-download-clone",
    });
    m.followUpState().recordAnswer("agent:main:main", {
      taskSlug: "npm-download-clone",
      ownerText: "q",
      answerText: "a",
    });
    expect(await m.ownerMergeTaskTypes("npm-download-clone", "repo-stats")).toMatchObject({
      ok: true,
      type: { slug: "repo-stats", occurrences: 6 },
    });
    expect(m.taskTypes().get("npm-download-clone")).toBeNull();
    expect(saved.ok && m.practices().get(saved.practice.id)?.scope).toBe("task:repo-stats");
    expect(m.followUpState().get("agent:main:main")?.taskSlug).toBe("repo-stats");
    expect(listAuditLog(db, { limit: 20 }).map((e) => e.event)).toContain("owner_merge_task_types");
    expect(await m.ownerMergeTaskTypes("nope", "repo-stats")).toMatchObject({ ok: false });
  });

  it("answering an offer goes through the mutex with an audit entry, and shows in the counters", async () => {
    const yes = m.practices().upsert({
      statement: "Include npm downloads",
      scope: "task:repo-stats",
      source: "extraction",
      origin: "follow_up",
    });
    const no = m.practices().upsert({
      statement: "Include views and traffic",
      scope: "task:repo-stats",
      source: "extraction",
      origin: "follow_up",
    });
    if (!yes.ok || !no.ok) {
      throw new Error("unreachable");
    }
    m.practices().recordOffer(yes.practice.id, { sessionId: "s1" });
    m.practices().recordOffer(no.practice.id, { sessionId: "s2" });
    expect(await m.answerPracticeOffer(yes.practice.id, "yes")).toBe(true);
    expect(await m.answerPracticeOffer(no.practice.id, "no")).toBe(true);
    // Answered once: a second answer finds no candidate.
    expect(await m.answerPracticeOffer(yes.practice.id, "no")).toBe(false);
    expect(m.practices().get(yes.practice.id)).toMatchObject({ status: "active", source: "owner" });
    expect(m.practices().get(no.practice.id)?.status).toBe("suppressed");
    expect(m.practiceCounters().overall).toEqual({
      applied: 0,
      repeats: 0,
      offers: 2,
      confirmed: 1,
      declined: 1,
    });
    // Un-retiring is the owner's action too, but not a yes to an offer.
    await m.ownerRetirePractice(yes.practice.id);
    await m.ownerUnretirePractice(yes.practice.id);
    expect(m.practiceCounters().overall.confirmed).toBe(1);
    expect(listAuditLog(db, { limit: 20 }).map((e) => e.event)).toEqual(
      expect.arrayContaining(["owner_confirm_practice", "owner_decline_practice"]),
    );
  });

  it("the prompt path's offer note: applied for a bare yes, nothing in incognito", async () => {
    seedType("repo-stats", QUESTIONS);
    const candidate = m.practices().upsert({
      statement: "Include npm downloads",
      scope: "task:repo-stats",
      source: "extraction",
      origin: "follow_up",
    });
    if (!candidate.ok) {
      throw new Error("unreachable");
    }
    m.followUpState().setOffer("agent:main:main", candidate.practice.id);
    expect(
      await m.resolvePracticeOfferNote({ sessionKey: "agent:main:main", text: "maybe later" }),
    ).toBeNull();
    const note = await m.resolvePracticeOfferNote({
      sessionKey: "agent:main:main",
      text: "yes",
      runId: "r1",
    });
    expect(note).toContain("## Practice offer answered");
    expect(m.practices().get(candidate.practice.id)?.status).toBe("active");

    const incognito = makeManager({ session: { memory: "off" } });
    const held = incognito.m.practices().upsert({
      statement: "Include npm downloads",
      scope: "task:repo-stats",
      source: "extraction",
    });
    if (!held.ok) {
      throw new Error("unreachable");
    }
    incognito.m.followUpState().setOffer("agent:main:main", held.practice.id);
    expect(
      await incognito.m.resolvePracticeOfferNote({ sessionKey: "agent:main:main", text: "yes" }),
    ).toBeNull();
    expect(incognito.m.practices().get(held.practice.id)?.status).toBe("candidate");
  });
});
