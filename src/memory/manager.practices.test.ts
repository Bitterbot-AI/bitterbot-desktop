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
});
