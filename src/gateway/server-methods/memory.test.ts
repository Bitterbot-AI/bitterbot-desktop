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
import { pinFact, retireFact, unretireFact } from "../../memory/owner-controls.js";
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
  const manager = {
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
    });
    expect(store.get("infra.deploy_endpoint")?.status).toBe("active");
    expect(store.get("infra.deploy_endpoint")?.source).toBe("owner");
    expect(listSuppressions(db)).toHaveLength(0);
    // Outranks the agent from now on.
    expect(
      store.pin({ key: "infra.deploy_endpoint", value: "api9.acme.com", source: "agent_pin" }).op,
    ).toBe("rejected");
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
