/**
 * PLAN-64 Phase 1: the practices store.
 *
 * Under test: the migration's tables, the five-form scope grammar and its
 * rejection of anything else, visibility per turn, tier to status (owner
 * active, everything below candidate), near-duplicate strengthening,
 * owner stickiness (a retired or declined practice cannot be re-created
 * below the owner tier), credential rejection, the applied counter with its
 * per-run de-duplication, the event log, and the owner actions.
 */
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import {
  isCanonicalFactVisibleInScope,
  isScopeVisibleInContext,
  normalizeCanonicalScope,
  normalizeScope,
} from "./canonical-facts.js";
import { ensureMemoryIndexSchema } from "./memory-schema.js";
import { LATEST_SCHEMA_VERSION } from "./migrations.js";
import {
  editPractice,
  listAuditLog,
  retirePractice,
  savePractice,
  setPracticeScope,
  unretirePractice,
} from "./owner-controls.js";
import {
  arePracticesNearDuplicate,
  practiceScopeRank,
  practiceStatementRejection,
  PracticesStore,
} from "./practices.js";

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

const NPM = "Include npm downloads when reporting repo stats.";

let db: DatabaseSync;
let store: PracticesStore;
beforeEach(() => {
  db = makeDb();
  store = new PracticesStore(db);
});

describe("migration v81", () => {
  it("creates practices, practice_events and task_types with the specified columns", () => {
    expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(81);
    const cols = (table: string) =>
      (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
        (c) => c.name,
      );
    expect(cols("practices")).toEqual(
      expect.arrayContaining([
        "id",
        "statement",
        "scope",
        "status",
        "source",
        "evidence_refs",
        "created_at",
        "updated_at",
        "applied_count",
        "last_applied_at",
        "offer_count",
        "origin",
      ]),
    );
    expect(cols("practice_events")).toEqual(
      expect.arrayContaining(["id", "practice_id", "kind", "session_ref", "detail", "ts"]),
    );
    expect(cols("task_types")).toEqual(
      expect.arrayContaining([
        "slug",
        "label",
        "exemplars",
        "occurrences",
        "distinct_days",
        "first_seen",
        "last_seen",
        "recurring",
      ]),
    );
  });
});

describe("scope grammar", () => {
  it("one normaliser validates all five forms and rejects the rest", () => {
    expect(normalizeScope(undefined)).toBe("global");
    expect(normalizeScope(" Global ")).toBe("global");
    expect(normalizeScope("project: Acme Corp")).toBe("project:acme-corp");
    expect(normalizeScope("person:Alice")).toBe("person:alice");
    expect(normalizeScope("task:Repo Stats")).toBe("task:repo-stats");
    expect(normalizeScope("job:3F2A-11")).toBe("job:3f2a-11");
    expect(normalizeScope("team:x")).toBeNull();
    expect(normalizeScope("task:")).toBeNull();
    expect(normalizeScope("task:!!!")).toBeNull();
    expect(normalizeScope("whatever")).toBeNull();
  });

  it("facts keep their three forms: task and job scopes are rejected for a fact", () => {
    expect(normalizeCanonicalScope("project:acme")).toBe("project:acme");
    expect(normalizeCanonicalScope("task:repo-stats")).toBeNull();
    expect(normalizeCanonicalScope("job:abc")).toBeNull();
    expect(isCanonicalFactVisibleInScope("project:acme", "acme")).toBe(true);
  });

  it("visibility: global and person always; project, task and job only on a match", () => {
    const ctx = { activeProject: "Acme", taskSlug: "repo-stats", cronJobId: "JOB-1" };
    expect(isScopeVisibleInContext("global", {})).toBe(true);
    expect(isScopeVisibleInContext("person:alice", {})).toBe(true);
    expect(isScopeVisibleInContext("project:acme", ctx)).toBe(true);
    expect(isScopeVisibleInContext("project:acme", {})).toBe(false);
    expect(isScopeVisibleInContext("project:globex", ctx)).toBe(false);
    expect(isScopeVisibleInContext("task:repo-stats", ctx)).toBe(true);
    expect(isScopeVisibleInContext("task:repo-stats", { taskSlug: "weather" })).toBe(false);
    expect(isScopeVisibleInContext("task:repo-stats", { activeProject: "repo-stats" })).toBe(false);
    expect(isScopeVisibleInContext("job:job-1", ctx)).toBe(true);
    expect(isScopeVisibleInContext("job:job-1", { cronJobId: "job-2" })).toBe(false);
    expect(isScopeVisibleInContext("nonsense:x", ctx)).toBe(false);
  });

  it("an unmatched scope is a rejected write", () => {
    const res = store.upsert({ statement: NPM, scope: "team:x", source: "owner" });
    expect(res).toMatchObject({ ok: false });
    expect(store.list()).toHaveLength(0);
  });

  it("ranks job, task, project, person, global", () => {
    expect(
      ["global", "person:a", "project:a", "task:a", "job:a"].toSorted(
        (a: string, b: string) => practiceScopeRank(a) - practiceScopeRank(b),
      ),
    ).toEqual(["job:a", "task:a", "project:a", "person:a", "global"]);
  });
});

describe("PracticesStore.upsert", () => {
  it("owner tier writes active; extraction writes a candidate; both log a stored event", () => {
    const owner = store.upsert({
      statement: `  ${NPM}  `,
      scope: "task:repo-stats",
      source: "owner",
      evidenceRef: "session:/s/a.jsonl#L4",
      now: 1000,
    });
    expect(owner).toMatchObject({
      ok: true,
      op: "add",
      practice: {
        statement: NPM,
        scope: "task:repo-stats",
        status: "active",
        source: "owner",
        evidenceRefs: ["session:/s/a.jsonl#L4"],
        appliedCount: 0,
        offerCount: 0,
        origin: "explicit",
      },
    });
    const cand = store.upsert({
      statement: "Keep the summary under five lines.",
      source: "extraction",
    });
    expect(cand).toMatchObject({ ok: true, practice: { status: "candidate", scope: "global" } });
    if (!owner.ok) {
      throw new Error("unreachable");
    }
    expect(store.events(owner.practice.id)).toMatchObject([
      { kind: "stored", sessionRef: "session:/s/a.jsonl#L4", detail: { op: "add" } },
    ]);
  });

  it("a near-duplicate at the same scope strengthens the row instead of inserting a second", () => {
    store.upsert({
      statement: NPM,
      scope: "task:repo-stats",
      source: "owner",
      evidenceRef: "session:a#L1",
    });
    const again = store.upsert({
      statement: "include NPM downloads when reporting repo stats",
      scope: "task:repo-stats",
      source: "owner",
      evidenceRef: "session:b#L9",
    });
    expect(again).toMatchObject({ ok: true, op: "strengthen" });
    expect(store.list()).toHaveLength(1);
    expect(store.list()[0]!.evidenceRefs).toEqual(["session:a#L1", "session:b#L9"]);
    // The same words at another scope are another practice.
    expect(store.upsert({ statement: NPM, scope: "global", source: "owner" })).toMatchObject({
      op: "add",
    });
    expect(store.list()).toHaveLength(2);
  });

  it("near-duplicate is word-level, not substring-level", () => {
    expect(
      arePracticesNearDuplicate(NPM, "Include npm downloads when reporting the repo stats!"),
    ).toBe(true);
    expect(arePracticesNearDuplicate(NPM, "Give the numbers first for repo stats.")).toBe(false);
  });

  it("the owner stating a candidate promotes it; a lower tier never touches an owner row", () => {
    const cand = store.upsert({ statement: NPM, scope: "task:repo-stats", source: "extraction" });
    expect(cand).toMatchObject({ practice: { status: "candidate" } });
    const promoted = store.upsert({ statement: NPM, scope: "task:repo-stats", source: "owner" });
    expect(promoted).toMatchObject({
      ok: true,
      op: "promote",
      practice: { status: "active", source: "owner" },
    });
    const lower = store.upsert({ statement: NPM, scope: "task:repo-stats", source: "extraction" });
    expect(lower).toMatchObject({
      ok: true,
      op: "strengthen",
      practice: { status: "active", source: "owner" },
    });
    expect(store.list()).toHaveLength(1);
  });

  it("owner stickiness: a retired practice is not re-created by a lower tier, at any scope", () => {
    const saved = store.upsert({ statement: NPM, scope: "task:repo-stats", source: "owner" });
    if (!saved.ok) {
      throw new Error("unreachable");
    }
    expect(store.retire(saved.practice.id)).toBe(true);
    for (const scope of ["task:repo-stats", "global"]) {
      for (const source of ["extraction", "agent_pin"] as const) {
        expect(store.upsert({ statement: NPM, scope, source })).toMatchObject({
          ok: false,
          reason: expect.stringContaining("retired"),
        });
      }
    }
    expect(store.list()).toHaveLength(1);
    expect(store.list()[0]!.status).toBe("retired");
    // The owner saying it again brings it back.
    expect(
      store.upsert({ statement: NPM, scope: "task:repo-stats", source: "owner" }),
    ).toMatchObject({
      ok: true,
      op: "promote",
      practice: { status: "active" },
    });
  });

  it("a suppressed practice (the owner's no to an offer) is honoured the same way", () => {
    const saved = store.upsert({ statement: NPM, scope: "task:repo-stats", source: "extraction" });
    if (!saved.ok) {
      throw new Error("unreachable");
    }
    db.prepare(`UPDATE practices SET status = 'suppressed' WHERE id = ?`).run(saved.practice.id);
    expect(
      store.upsert({ statement: NPM, scope: "task:repo-stats", source: "extraction" }),
    ).toMatchObject({
      ok: false,
      reason: expect.stringContaining("declined"),
    });
  });

  it("rejects credentials, fragments and essays", () => {
    expect(practiceStatementRejection("ok")).toMatch(/too short/);
    expect(practiceStatementRejection("x".repeat(301))).toMatch(/at most 300/);
    expect(practiceStatementRejection("Always do it it it")).toMatch(/does not say/);
    const secret = store.upsert({
      statement: "Use the key sk-ant-REDACTED for every deploy.",
      source: "owner",
    });
    expect(secret).toMatchObject({ ok: false, reason: expect.stringContaining("credential") });
    expect(JSON.stringify(secret)).not.toContain("sk-ant");
    expect(store.list()).toHaveLength(0);
  });
});

describe("visibility and the applied counter", () => {
  beforeEach(() => {
    store.upsert({ statement: "Keep answers short.", scope: "global", source: "owner", now: 1 });
    store.upsert({ statement: NPM, scope: "task:repo-stats", source: "owner", now: 2 });
    store.upsert({
      statement: "Use British spelling for Acme.",
      scope: "project:acme",
      source: "owner",
      now: 3,
    });
    store.upsert({
      statement: "Send the digest as a table.",
      scope: "job:job-1",
      source: "owner",
      now: 4,
    });
    store.upsert({
      statement: "Mention open pull requests too.",
      scope: "task:repo-stats",
      source: "extraction",
      now: 5,
    });
  });

  it("lists only active practices that match the turn, most specific scope first", () => {
    expect(store.listVisible({}).map((p) => p.scope)).toEqual(["global"]);
    expect(
      store.listVisible({ taskSlug: "repo-stats", activeProject: "acme" }).map((p) => p.scope),
    ).toEqual(["task:repo-stats", "project:acme", "global"]);
    expect(
      store.listVisible({ cronJobId: "job-1" }, { kinds: new Set(["job"]) }).map((p) => p.scope),
    ).toEqual(["job:job-1"]);
    // The candidate is never visible.
    expect(store.listVisible({ taskSlug: "repo-stats" }).some((p) => p.status !== "active")).toBe(
      false,
    );
  });

  it("recordApplied bumps the counter and logs an applied event once per run", () => {
    const [task] = store.listVisible({ taskSlug: "repo-stats" });
    expect(
      store.recordApplied([task!.id], { turnKey: "run-1", sessionRef: "session:x", now: 50 }),
    ).toBe(1);
    expect(store.recordApplied([task!.id], { turnKey: "run-1", now: 60 })).toBe(0);
    expect(store.recordApplied([task!.id], { turnKey: "run-2", now: 70 })).toBe(1);
    expect(store.get(task!.id)).toMatchObject({ appliedCount: 2, lastAppliedAt: 70 });
    expect(store.events(task!.id).filter((e) => e.kind === "applied")).toHaveLength(2);
    // A retired practice is not counted.
    store.retire(task!.id);
    expect(store.recordApplied([task!.id], { turnKey: "run-3" })).toBe(0);
  });
});

describe("owner controls", () => {
  it("edit, widen, narrow, retire and un-retire, each logged and audited", () => {
    const saved = savePractice(db, store, { statement: NPM, scope: "task:repo-stats" });
    if (!saved.ok) {
      throw new Error("unreachable");
    }
    const id = saved.practice.id;
    expect(saved.practice).toMatchObject({ status: "active", source: "owner", origin: "owner_ui" });

    expect(
      editPractice(db, store, id, "Include npm and PyPI downloads in repo stats."),
    ).toMatchObject({
      ok: true,
      practice: { statement: "Include npm and PyPI downloads in repo stats." },
    });
    expect(editPractice(db, store, id, "x")).toMatchObject({ ok: false });
    expect(editPractice(db, store, "missing", NPM)).toMatchObject({ ok: false });

    expect(setPracticeScope(db, store, id, "global")).toMatchObject({
      ok: true,
      practice: { scope: "global" },
    });
    expect(setPracticeScope(db, store, id, "job:job-1")).toMatchObject({
      ok: true,
      practice: { scope: "job:job-1" },
    });
    expect(setPracticeScope(db, store, id, "team:x")).toMatchObject({ ok: false });
    expect(setPracticeScope(db, store, id, "")).toMatchObject({ ok: false });

    expect(retirePractice(db, store, id)).toBe(true);
    expect(retirePractice(db, store, id)).toBe(false);
    expect(store.get(id)?.status).toBe("retired");
    expect(unretirePractice(db, store, id)).toBe(true);
    expect(store.get(id)).toMatchObject({ status: "active", source: "owner" });

    expect(
      store
        .events(id)
        .map((e) => e.kind)
        .toReversed(),
    ).toEqual(["stored", "edited", "widened", "narrowed", "retired", "confirmed"]);
    const audit = listAuditLog(db, { limit: 20 }).map((e) => e.event);
    expect(audit).toEqual(
      expect.arrayContaining([
        "practice_saved",
        "owner_edit_practice",
        "owner_scope_practice",
        "owner_retire_practice",
        "owner_unretire_practice",
      ]),
    );
  });

  it("un-retire activates a candidate at the owner tier", () => {
    const cand = savePractice(db, store, {
      statement: NPM,
      source: "extraction",
      origin: "explicit",
    });
    if (!cand.ok) {
      throw new Error("unreachable");
    }
    expect(cand.practice.status).toBe("candidate");
    expect(unretirePractice(db, store, cand.practice.id)).toBe(true);
    expect(store.get(cand.practice.id)).toMatchObject({ status: "active", source: "owner" });
  });

  it("refuses an edit or a scope change that would duplicate another live practice", () => {
    const a = savePractice(db, store, { statement: NPM, scope: "global" });
    const b = savePractice(db, store, { statement: "Give the numbers first.", scope: "global" });
    const c = savePractice(db, store, { statement: NPM, scope: "task:repo-stats" });
    if (!a.ok || !b.ok || !c.ok) {
      throw new Error("unreachable");
    }
    expect(editPractice(db, store, b.practice.id, NPM)).toMatchObject({ ok: false });
    expect(setPracticeScope(db, store, c.practice.id, "global")).toMatchObject({ ok: false });
  });
});
