/**
 * PLAN-55 Phase 0 (closes PLAN-55 gap G10 for the retire pair): the
 * memory.retireFact / memory.unretireFact handlers are thin pass-throughs
 * over the manager's owner methods. The manager singleton is mocked with a
 * real ledger on an in-memory DB so the test covers the wiring (param
 * trimming, payload shape, error mapping) and the sticky semantics the
 * handler is supposed to reach.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CanonicalFactsStore } from "../../memory/canonical-facts.js";
import { getMemorySearchManager } from "../../memory/index.js";
import { ensureMemoryIndexSchema } from "../../memory/memory-schema.js";
import { listSuppressions } from "../../memory/memory-suppressions.js";
import {
  answerPracticeOffer,
  editPractice,
  listAuditLog,
  listPractices,
  mergeTaskTypes,
  pinFact,
  retireFact,
  retirePractice,
  savePractice,
  setPracticeScope,
  unretireFact,
  unretirePractice,
} from "../../memory/owner-controls.js";
import { PracticesStore } from "../../memory/practices.js";
import { TaskTypesStore } from "../../memory/task-types.js";
import { ErrorCodes } from "../protocol/index.js";
import { memoryHandlers } from "./memory.js";

vi.mock("../../memory/index.js", () => ({
  getMemorySearchManager: vi.fn(),
}));
vi.mock("../../config/config.js", () => ({ loadConfig: () => ({}) }));
vi.mock("../../agents/agent-scope.js", () => ({
  resolveDefaultAgentId: () => "default",
  resolveAgentWorkspaceDir: () => "/srv/agents/acme",
}));
// PLAN-64 Phase 3: evidence lines are read only from the agent's sessions directory.
const sessions = vi.hoisted(() => ({ dir: "/nonexistent/bitterbot-sessions" }));
vi.mock("../../config/sessions/paths.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/sessions/paths.js")>()),
  resolveSessionTranscriptsDirForAgent: () => sessions.dir,
}));

const retire = memoryHandlers["memory.retireFact"]!;
const unretire = memoryHandlers["memory.unretireFact"]!;

type Call = { ok: boolean; payload?: unknown; error?: { code?: string; message?: string } };

function capture() {
  const calls: Call[] = [];
  const respond = (ok: boolean, payload?: unknown, error?: unknown) =>
    calls.push({ ok, payload, error: error as Call["error"] });
  return { calls, respond };
}

async function call(handler: typeof retire, params: Record<string, unknown>): Promise<Call> {
  const { calls, respond } = capture();
  await handler({ params, respond } as unknown as Parameters<typeof handler>[0]);
  return calls[0]!;
}

let db: DatabaseSync;
let store: CanonicalFactsStore;
let practices: PracticesStore;
let taskTypes: TaskTypesStore;

beforeEach(() => {
  vi.mocked(getMemorySearchManager).mockReset();
  db = new DatabaseSync(":memory:");
  ensureMemoryIndexSchema({
    db,
    embeddingCacheTable: "embedding_cache",
    ftsTable: "chunks_fts",
    ftsEnabled: false,
  });
  store = new CanonicalFactsStore(db);
  store.pin({ key: "infra.deploy_endpoint", value: "api.acme.com", source: "extraction" });
  practices = new PracticesStore(db);
  taskTypes = new TaskTypesStore(db, {
    onMerge: (from, into) => practices.repointTaskScope(from, into),
  });
  const manager = {
    // PLAN-64 Phase 1: the same thin wrappers the real manager has.
    taskTypes: () => taskTypes,
    practices: () => practices,
    ownerListPractices: (opts: Parameters<typeof listPractices>[1]) =>
      listPractices(practices, opts),
    ownerSavePractice: async (input: Parameters<typeof savePractice>[2]) =>
      savePractice(db, practices, input),
    ownerEditPractice: async (id: string, statement: string) =>
      editPractice(db, practices, id, statement),
    ownerSetPracticeScope: async (id: string, scope: string) =>
      setPracticeScope(db, practices, id, scope),
    ownerRetirePractice: async (id: string) => retirePractice(db, practices, id),
    ownerUnretirePractice: async (id: string) => unretirePractice(db, practices, id),
    // PLAN-64 Phase 1b.
    practiceCounters: () => practices.counters(),
    ownerMergeTaskTypes: async (from: string, into: string) =>
      mergeTaskTypes(db, taskTypes, from, into),
    // PLAN-64 Phase 3.
    answerPracticeOffer: async (id: string, answer: "yes" | "no") =>
      answerPracticeOffer(db, practices, id, answer),
    canonicalFacts: () => store,
    ownerRetireFact: async (key: string) => retireFact(db, store, key),
    ownerUnretireFact: async (key: string) => unretireFact(db, store, key),
    ownerPinFact: async (input: Parameters<typeof pinFact>[2]) => pinFact(db, store, input),
  };
  vi.mocked(getMemorySearchManager).mockResolvedValue({
    manager: manager as never,
    error: null,
  } as never);
});

describe("memory.retireFact / memory.unretireFact (PLAN-55 Phase 0)", () => {
  it("retires as the owner: owner_retired plus a key/value suppression", async () => {
    const res = await call(retire, { key: "  infra.deploy_endpoint " });
    expect(res).toEqual({ ok: true, payload: { ok: true }, error: undefined });
    expect(store.get("infra.deploy_endpoint")?.status).toBe("owner_retired");
    expect(listSuppressions(db, { kind: "fact_key_value" })).toHaveLength(1);
    // What the agent's extraction would do next is refused.
    expect(
      store.pin({ key: "infra.deploy_endpoint", value: "api.acme.com", source: "extraction" }).op,
    ).toBe("rejected");
  });

  it("unretires and lifts the suppression", async () => {
    await call(retire, { key: "infra.deploy_endpoint" });
    const res = await call(unretire, { key: "infra.deploy_endpoint" });
    expect(res.ok).toBe(true);
    expect(res.payload).toEqual({ ok: true });
    expect(store.get("infra.deploy_endpoint")?.status).toBe("active");
    expect(listSuppressions(db)).toHaveLength(0);
  });

  it("reports ok=false for an unknown key instead of failing", async () => {
    expect((await call(retire, { key: "nope.nothing" })).payload).toEqual({ ok: false });
    expect((await call(unretire, { key: "nope.nothing" })).payload).toEqual({ ok: false });
    expect((await call(retire, {})).payload).toEqual({ ok: false });
  });

  it("memory.pinFact pins at the owner tier and brings a retired fact back", async () => {
    const pin = memoryHandlers["memory.pinFact"]!;
    await call(retire, { key: "infra.deploy_endpoint" });
    const res = await call(pin, { key: " infra.deploy_endpoint ", value: " api.acme.com " });
    expect(res.ok).toBe(true);
    expect(res.payload).toEqual({
      ok: true,
      op: "strengthen",
      key: "infra.deploy_endpoint",
      value: "api.acme.com",
      scope: "global",
    });
    expect(store.get("infra.deploy_endpoint")?.status).toBe("active");
    expect(store.get("infra.deploy_endpoint")?.source).toBe("owner");
    expect(listSuppressions(db)).toHaveLength(0);
    // Outranks the agent from now on (Phase 1: the agent's replacement is held
    // for the owner instead of rejected outright; nothing is written either way).
    expect(
      store.pin({ key: "infra.deploy_endpoint", value: "api9.acme.com", source: "agent_pin" }).op,
    ).toBe("held");
    expect(store.get("infra.deploy_endpoint")?.value).toBe("api.acme.com");
    expect(
      db.prepare(`SELECT event FROM memory_audit_log WHERE event = 'owner_pin_fact'`).all(),
    ).toHaveLength(1);
    // A bad pin is INVALID_REQUEST with the ledger's reason.
    const bad = await call(pin, { key: "???", value: "x" });
    expect(bad.ok).toBe(false);
    expect(bad.error?.code).toBe(ErrorCodes.INVALID_REQUEST);
  });

  it("memory.facts lists active by default, retired on request, both with a status", async () => {
    const facts = memoryHandlers["memory.facts"]!;
    store.pin({ key: "identity.user.name", value: "Victor", source: "agent_pin" });
    await call(retire, { key: "identity.user.name" });
    const keys = (res: Call) =>
      (res.payload as { facts: Array<{ key: string; status: string }> }).facts;
    expect(keys(await call(facts, {}))).toEqual([
      expect.objectContaining({ key: "infra.deploy_endpoint", status: "active" }),
    ]);
    expect(keys(await call(facts, { status: "retired" }))).toEqual([
      expect.objectContaining({ key: "identity.user.name", status: "owner_retired" }),
    ]);
    expect(
      keys(await call(facts, { status: "all" }))
        .map((f) => f.key)
        .toSorted(),
    ).toEqual(["identity.user.name", "infra.deploy_endpoint"]);
  });

  it("maps an unavailable memory manager to UNAVAILABLE", async () => {
    vi.mocked(getMemorySearchManager).mockResolvedValue({
      manager: null,
      error: "memory is off",
    } as never);
    const res = await call(retire, { key: "infra.deploy_endpoint" });
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe(ErrorCodes.UNAVAILABLE);
    expect(res.error?.message).toContain("memory is off");
  });
});

describe("memory.facts / memory.pinFact scope and evidence (PLAN-55 Phase 1)", () => {
  const facts = memoryHandlers["memory.facts"]!;
  const pin = memoryHandlers["memory.pinFact"]!;

  it("memory.facts returns scope (global by default) and evidenceRef", async () => {
    const res = await call(facts, {});
    expect(res.ok).toBe(true);
    const list = (res.payload as { facts: Array<Record<string, unknown>> }).facts;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      key: "infra.deploy_endpoint",
      scope: "global",
      evidenceRef: null,
      status: "active",
    });
  });

  it("memory.pinFact stores scope and evidence, and memory.facts shows them", async () => {
    const res = await call(pin, {
      key: "infra.deploy_endpoint",
      value: "api2.acme.com",
      scope: "project: Acme",
      evidence: "session:/s/main.jsonl#L12",
    });
    expect(res).toMatchObject({
      ok: true,
      payload: {
        ok: true,
        op: "supersede",
        key: "infra.deploy_endpoint",
        value: "api2.acme.com",
        scope: "project:acme",
        previousValue: "api.acme.com",
      },
    });
    const listed = (await call(facts, { status: "all" })).payload as {
      facts: Array<Record<string, unknown>>;
    };
    expect(listed.facts.find((f) => f.key === "infra.deploy_endpoint")).toMatchObject({
      value: "api2.acme.com",
      scope: "project:acme",
      evidenceRef: "session:/s/main.jsonl#L12",
    });
  });

  it("memory.pinFact refuses a scope nothing could match", async () => {
    const res = await call(pin, { key: "a.b", value: "v", scope: "team:x" });
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe(ErrorCodes.INVALID_REQUEST);
    expect(res.error?.message).toMatch(/scope must be/);
  });
});

describe("memory.practices and its mutations (PLAN-64 Phase 1)", () => {
  const list = memoryHandlers["memory.practices"]!;
  const save = memoryHandlers["memory.savePractice"]!;
  const edit = memoryHandlers["memory.editPractice"]!;
  const setScope = memoryHandlers["memory.setPracticeScope"]!;
  const retirePr = memoryHandlers["memory.retirePractice"]!;
  const unretirePr = memoryHandlers["memory.unretirePractice"]!;
  const NPM = "Include npm downloads when reporting repo stats.";

  type Listed = {
    practices: Array<{
      id: string;
      statement: string;
      scope: string;
      status: string;
      source: string;
    }>;
    taskTypes: Array<{ slug: string; label: string }>;
  };

  it("saves as the owner, lists every status, and filters by status", async () => {
    const saved = await call(save, { statement: `  ${NPM} `, scope: "task:Repo Stats" });
    expect(saved.ok).toBe(true);
    expect(saved.payload).toMatchObject({
      ok: true,
      op: "add",
      practice: {
        statement: NPM,
        scope: "task:repo-stats",
        status: "active",
        source: "owner",
        origin: "owner_ui",
      },
    });
    // A candidate (what capture writes below the owner tier) and a retired one.
    practices.upsert({ statement: "Mention open pull requests too.", source: "extraction" });
    const other = practices.upsert({ statement: "Keep answers short.", source: "owner" });
    if (!other.ok) {
      throw new Error("unreachable");
    }
    practices.retire(other.practice.id);

    const all = (await call(list, {})).payload as Listed;
    expect(all.practices.map((p) => p.status).toSorted()).toEqual([
      "active",
      "candidate",
      "retired",
    ]);
    expect(all.taskTypes).toEqual([]);
    const candidates = (await call(list, { status: "candidate" })).payload as Listed;
    expect(candidates.practices).toHaveLength(1);
    // An unknown status filter is ignored, not an error.
    expect(((await call(list, { status: "bogus" })).payload as Listed).practices).toHaveLength(3);
  });

  it("refuses a bad scope, an unusable statement and a credential with INVALID_REQUEST", async () => {
    for (const params of [
      { statement: NPM, scope: "team:x" },
      { statement: "ok" },
      { statement: "Use the token sk-ant-REDACTED when deploying." },
    ]) {
      const res = await call(save, params);
      expect(res.ok).toBe(false);
      expect(res.error?.code).toBe(ErrorCodes.INVALID_REQUEST);
      expect(res.error?.message ?? "").not.toContain("sk-ant");
    }
    expect(practices.list()).toHaveLength(0);
  });

  it("edits, widens, narrows, retires and un-retires by id", async () => {
    const saved = (await call(save, { statement: NPM, scope: "task:repo-stats" })).payload as {
      practice: { id: string };
    };
    const id = saved.practice.id;

    const edited = await call(edit, {
      id,
      statement: "Include npm and PyPI downloads in repo stats.",
    });
    expect(edited.payload).toMatchObject({
      ok: true,
      practice: { statement: "Include npm and PyPI downloads in repo stats." },
    });
    expect((await call(edit, { id: "missing", statement: NPM })).error?.code).toBe(
      ErrorCodes.INVALID_REQUEST,
    );

    expect((await call(setScope, { id, scope: "global" })).payload).toMatchObject({
      practice: { scope: "global" },
    });
    expect((await call(setScope, { id, scope: "job:job-7" })).payload).toMatchObject({
      practice: { scope: "job:job-7" },
    });
    expect((await call(setScope, { id, scope: "nope" })).error?.code).toBe(
      ErrorCodes.INVALID_REQUEST,
    );
    expect((await call(setScope, { id })).error?.code).toBe(ErrorCodes.INVALID_REQUEST);

    expect((await call(retirePr, { id })).payload).toEqual({ ok: true });
    expect((await call(retirePr, { id })).payload).toEqual({ ok: false });
    expect(practices.get(id)?.status).toBe("retired");
    // Sticky: capture below the owner tier cannot bring it back.
    expect(
      practices.upsert({
        statement: "Include npm and PyPI downloads in repo stats.",
        source: "extraction",
      }),
    ).toMatchObject({ ok: false });
    expect((await call(unretirePr, { id })).payload).toEqual({ ok: true });
    expect(practices.get(id)?.status).toBe("active");
    expect(
      practices
        .events(id)
        .map((e) => e.kind)
        .toReversed(),
    ).toEqual(["stored", "edited", "widened", "narrowed", "retired", "confirmed"]);
  });

  it("lists recurring task types so a task scope can be shown by its label", async () => {
    const day = 24 * 3_600_000;
    let pending = "";
    [
      "How many clones did your repo get yesterday?",
      "how did our npm's and clones do yesterday?",
      "Can you check npm, clones and views for yesterday for your repo?",
    ].forEach((text, i) => {
      pending = taskTypes.observe(text, { now: Date.now() - (4 - i) * day }).type!.slug;
    });
    // Pending types are not listed.
    expect(((await call(list, {})).payload as Listed).taskTypes).toEqual([]);
    await taskTypes.promote(pending, async () => '{"slug":"repo-stats","label":"repo stats"}');
    expect(((await call(list, {})).payload as Listed).taskTypes).toMatchObject([
      { slug: "repo-stats", label: "repo stats", occurrences: 3, distinctDays: 3 },
    ]);
  });
});

describe("practice counters and memory.mergeTaskTypes (PLAN-64 Phase 1b)", () => {
  const list = memoryHandlers["memory.practices"]!;
  const merge = memoryHandlers["memory.mergeTaskTypes"]!;
  const seedType = (slug: string, exemplar: string) =>
    taskTypes.adopt({
      slug,
      label: slug.replace(/-/g, " "),
      exemplars: [exemplar],
      occurrences: 3,
      distinctDays: 3,
      firstSeen: 1,
      lastSeen: 2,
      recurring: true,
    });

  it("memory.practices returns counts per practice and overall", async () => {
    const active = practices.upsert({
      statement: "Include npm downloads.",
      scope: "task:repo-stats",
      source: "owner",
    });
    const candidate = practices.upsert({
      statement: "Include views and traffic.",
      scope: "task:repo-stats",
      source: "extraction",
      origin: "follow_up",
    });
    if (!active.ok || !candidate.ok) {
      throw new Error("unreachable");
    }
    practices.recordApplied([active.practice.id], { turnKey: "r1" });
    practices.recordApplied([active.practice.id], { turnKey: "r2" });
    practices.recordRepeat(active.practice.id, { via: "follow_up" });
    practices.recordOffer(candidate.practice.id, { sessionId: "s1" });
    practices.suppress(candidate.practice.id);
    const payload = (await call(list, {})).payload as {
      practices: Array<{ id: string; counts: Record<string, number> }>;
      counters: Record<string, number>;
    };
    expect(payload.counters).toEqual({
      applied: 2,
      repeats: 1,
      offers: 1,
      confirmed: 0,
      declined: 1,
    });
    expect(payload.practices.find((p) => p.id === active.practice.id)?.counts).toEqual({
      applied: 2,
      repeats: 1,
      offers: 0,
      confirmed: 0,
      declined: 0,
    });
    expect(payload.practices.find((p) => p.id === candidate.practice.id)?.counts).toMatchObject({
      offers: 1,
      declined: 1,
    });
  });

  it("memory.mergeTaskTypes folds one type into another and moves its practices", async () => {
    seedType("repo-stats", "How many clones did your repo get yesterday?");
    seedType("npm-download-clone", "how about our npm downloads");
    const saved = practices.upsert({
      statement: "Include npm downloads.",
      scope: "task:npm-download-clone",
      source: "owner",
    });
    const res = await call(merge, { from: "npm-download-clone", into: "repo-stats" });
    expect(res.ok).toBe(true);
    expect(res.payload).toMatchObject({
      ok: true,
      taskType: { slug: "repo-stats", occurrences: 6 },
    });
    expect(taskTypes.get("npm-download-clone")).toBeNull();
    expect(saved.ok && practices.get(saved.practice.id)?.scope).toBe("task:repo-stats");
    expect(listAuditLog(db, {}).some((e) => e.event === "owner_merge_task_types")).toBe(true);
    // Unknown or missing slugs are a refused request, nothing changes.
    expect((await call(merge, { from: "nope", into: "repo-stats" })).ok).toBe(false);
    expect((await call(merge, { from: "", into: "repo-stats" })).ok).toBe(false);
    expect(taskTypes.get("repo-stats")?.occurrences).toBe(6);
  });
});

describe("memory.practices: what the Memory tab shows (PLAN-64 Phase 3)", () => {
  const list = memoryHandlers["memory.practices"]!;
  type Row = {
    id: string;
    scope: string;
    scopeLabel: string;
    savedAt: number;
    evidence: Array<{ ref: string; text: string | null }>;
  };
  type Payload = {
    practices: Row[];
    taskTypes: Array<{
      slug: string;
      label: string;
      occurrences: number;
      recurring: boolean;
      example: string | null;
    }>;
  };
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-practices-rpc-"));
    sessions.dir = dir;
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    sessions.dir = "/nonexistent/bitterbot-sessions";
  });

  const message = (role: string, text: string) =>
    JSON.stringify({ type: "message", message: { role, content: [{ type: "text", text }] } });

  it("returns the scope in words, by task label, project, job and everything", async () => {
    taskTypes.adopt({
      slug: "repo-stats",
      label: "repo stats",
      exemplars: ["How many clones did your repo get yesterday?"],
      occurrences: 4,
      distinctDays: 3,
      firstSeen: 1,
      lastSeen: 2,
      recurring: true,
    });
    const statements: Array<[string, string]> = [
      ["task:repo-stats", "Include npm downloads."],
      ["task:unnamed-thing", "Give the numbers first."],
      ["project:acme", "Answer in British English."],
      ["job:job-7", "Skip the weather section."],
      ["global", "Keep answers under ten lines."],
    ];
    for (const [scope, statement] of statements) {
      expect(practices.upsert({ statement, scope, source: "owner" }).ok).toBe(true);
    }
    const payload = (await call(list, {})).payload as Payload;
    expect(Object.fromEntries(payload.practices.map((p) => [p.scope, p.scopeLabel]))).toEqual({
      "task:repo-stats": "repo stats",
      "task:unnamed-thing": "unnamed thing",
      "project:acme": "project acme",
      "job:job-7": "this scheduled job",
      global: "everything",
    });
  });

  it("returns savedAt: the creation of an owner practice, or the day a candidate was confirmed", async () => {
    const owner = practices.upsert({
      statement: "Include npm downloads.",
      source: "owner",
      now: 1_000,
    });
    const candidate = practices.upsert({
      statement: "Include views and traffic.",
      source: "extraction",
      now: 2_000,
    });
    if (!owner.ok || !candidate.ok) {
      throw new Error("unreachable");
    }
    practices.activate(candidate.practice.id, 9_000, "offer");
    // A later edit does not move the saved date.
    practices.editStatement(owner.practice.id, "Include npm downloads per day.", 12_000);
    const byId = new Map(
      ((await call(list, {})).payload as Payload).practices.map((p) => [p.id, p.savedAt]),
    );
    expect(byId.get(owner.practice.id)).toBe(1_000);
    expect(byId.get(candidate.practice.id)).toBe(9_000);
  });

  it("returns the owner's evidence line from the agent's own transcripts, and null otherwise", async () => {
    const file = path.join(dir, "s1.jsonl");
    fs.writeFileSync(
      file,
      [
        message("user", "How many clones did your repo get yesterday?"),
        message("assistant", "Yesterday the repo had 68 unique clones."),
        message("user", "how about our   npm downloads"),
      ].join("\n"),
    );
    const outside = path.join(os.tmpdir(), `bb-outside-${process.pid}.jsonl`);
    fs.writeFileSync(outside, message("user", "a line from somewhere else"));
    try {
      const saved = practices.upsert({
        statement: "Include npm downloads.",
        scope: "task:repo-stats",
        source: "owner",
        evidenceRef: `session:${file}#L3`,
      });
      if (!saved.ok) {
        throw new Error("unreachable");
      }
      for (const evidenceRef of [
        `session:${file}#L2`, // the assistant's line: not the owner's words
        `session:${file}#L40`, // past the end
        `session:${outside}#L1`, // readable, but not the agent's sessions directory
        "a short quote, not a line ref",
      ]) {
        practices.addSighting(saved.practice.id, { evidenceRef });
      }
      const row = ((await call(list, {})).payload as Payload).practices[0]!;
      expect(row.evidence).toEqual([
        { ref: `session:${file}#L3`, text: "how about our npm downloads" },
        { ref: `session:${file}#L2`, text: null },
        { ref: `session:${file}#L40`, text: null },
        { ref: `session:${outside}#L1`, text: null },
        { ref: "a short quote, not a line ref", text: null },
      ]);
    } finally {
      fs.rmSync(outside, { force: true });
    }
  });

  it("flags recurring task types, and lists pending ones with an example only on request", async () => {
    taskTypes.adopt({
      slug: "repo-stats",
      label: "repo stats",
      exemplars: ["How many clones did your repo get yesterday?"],
      occurrences: 4,
      distinctDays: 3,
      firstSeen: 1,
      lastSeen: 2,
      recurring: true,
    });
    const pending = taskTypes.observe("What is the weather in Lisbon this weekend?", {
      now: Date.now(),
    }).type!.slug;
    const recurringOnly = (await call(list, {})).payload as Payload;
    expect(recurringOnly.taskTypes).toMatchObject([
      {
        slug: "repo-stats",
        label: "repo stats",
        occurrences: 4,
        recurring: true,
        example: "How many clones did your repo get yesterday?",
      },
    ]);
    const all = (await call(list, { includePendingTaskTypes: true })).payload as Payload;
    expect(all.taskTypes.map((t) => [t.slug, t.recurring])).toEqual([
      ["repo-stats", true],
      [pending, false],
    ]);
    expect(all.taskTypes[1]?.example).toBeTruthy();
  });

  it("returns the agent's project, the one a project scope would match", async () => {
    expect(((await call(list, {})).payload as { activeProject: string | null }).activeProject).toBe(
      "acme",
    );
  });

  it("memory.answerPracticeOffer: yes activates a candidate, no declines it for good", async () => {
    const answer = memoryHandlers["memory.answerPracticeOffer"]!;
    const a = practices.upsert({ statement: "Include views and traffic.", source: "extraction" });
    const b = practices.upsert({ statement: "Mention open pull requests.", source: "extraction" });
    if (!a.ok || !b.ok) {
      throw new Error("unreachable");
    }
    expect((await call(answer, { id: a.practice.id, answer: "yes" })).payload).toEqual({
      ok: true,
    });
    expect(practices.get(a.practice.id)).toMatchObject({ status: "active", source: "owner" });
    expect((await call(answer, { id: b.practice.id, answer: "No" })).payload).toEqual({ ok: true });
    expect(practices.get(b.practice.id)?.status).toBe("suppressed");
    // Counted like an answer to the offer line.
    expect(practices.counters().overall).toMatchObject({ confirmed: 1, declined: 1 });
    // Not a candidate any more, an unknown id, a bad answer.
    expect((await call(answer, { id: a.practice.id, answer: "no" })).payload).toEqual({
      ok: false,
    });
    expect((await call(answer, { id: "missing", answer: "yes" })).payload).toEqual({ ok: false });
    expect((await call(answer, { id: b.practice.id, answer: "maybe" })).error?.code).toBe(
      ErrorCodes.INVALID_REQUEST,
    );
  });
});
