/**
 * PLAN-55 Phase 0 (closes PLAN-55 gap G10 for the retire pair): the
 * memory.retireFact / memory.unretireFact handlers are thin pass-throughs
 * over the manager's owner methods. The manager singleton is mocked with a
 * real ledger on an in-memory DB so the test covers the wiring (param
 * trimming, payload shape, error mapping) and the sticky semantics the
 * handler is supposed to reach.
 */
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CanonicalFactsStore } from "../../memory/canonical-facts.js";
import { getMemorySearchManager } from "../../memory/index.js";
import { ensureMemoryIndexSchema } from "../../memory/memory-schema.js";
import { listSuppressions } from "../../memory/memory-suppressions.js";
import {
  editPractice,
  listPractices,
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
vi.mock("../../agents/agent-scope.js", () => ({ resolveDefaultAgentId: () => "default" }));

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
  taskTypes = new TaskTypesStore(db);
  const manager = {
    // PLAN-64 Phase 1: the same thin wrappers the real manager has.
    taskTypes: () => taskTypes,
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
