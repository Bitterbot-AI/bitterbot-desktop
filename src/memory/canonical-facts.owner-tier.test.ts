/**
 * PLAN-55 Phase 0: the owner tier and sticky retire.
 *
 * The contract under test: `owner` (and its alias `user_directive`) sits
 * above `agent_pin`; an owner retire sets `owner_retired` and a key/value
 * suppression that every lower tier bounces off, by any path and any
 * case/whitespace variant; an agent/decay/hygiene retire stays soft; an
 * owner pin or unretire lifts it; the rejected re-pins are recorded as
 * `owner_retired` conflicts that never become questions for the owner.
 */
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { CanonicalFactsStore, canonicalSourceTier } from "./canonical-facts.js";
import { EpistemicDirectiveEngine } from "./epistemic-directives.js";
import { ensureMemoryIndexSchema } from "./memory-schema.js";
import { factKeyValueHash, isSuppressed, listSuppressions } from "./memory-suppressions.js";

let db: DatabaseSync;
let store: CanonicalFactsStore;

const KEY = "infra.deploy_endpoint";

function conflicts(): Array<{
  kind: string;
  consumed_at: number | null;
  directive_id: string | null;
}> {
  return db
    .prepare(`SELECT kind, consumed_at, directive_id FROM canonical_conflicts WHERE key = ?`)
    .all(KEY) as unknown as Array<{
    kind: string;
    consumed_at: number | null;
    directive_id: string | null;
  }>;
}

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  ensureMemoryIndexSchema({
    db,
    embeddingCacheTable: "embedding_cache",
    ftsTable: "chunks_fts",
    ftsEnabled: false,
  });
  store = new CanonicalFactsStore(db);
});

describe("owner tier", () => {
  it("is tier 3, above agent_pin, and user_directive is its alias", () => {
    expect(canonicalSourceTier("owner")).toBe(3);
    expect(canonicalSourceTier("user_directive")).toBe(3);
    expect(canonicalSourceTier("agent_pin")).toBe(2);
    expect(canonicalSourceTier("extraction")).toBe(1);
    expect(canonicalSourceTier("not-a-source")).toBe(0);
  });

  it("supersedes an agent pin, and the agent cannot supersede it back", () => {
    expect(store.pin({ key: KEY, value: "api.acme.com", source: "agent_pin" }).op).toBe("add");
    const owner = store.pin({ key: KEY, value: "api2.acme.com", source: "owner" });
    expect(owner.op).toBe("supersede");
    const back = store.pin({ key: KEY, value: "api.acme.com", source: "agent_pin" });
    expect(back.op).toBe("rejected");
    expect(store.get(KEY)?.value).toBe("api2.acme.com");
    expect(store.get(KEY)?.source).toBe("owner");
    expect(conflicts().map((c) => c.kind)).toEqual(["tier_rejection"]);
  });

  it("user_directive supersedes an agent pin exactly like owner", () => {
    store.pin({ key: KEY, value: "api.acme.com", source: "agent_pin" });
    expect(store.pin({ key: KEY, value: "api2.acme.com", source: "user_directive" }).op).toBe(
      "supersede",
    );
    expect(store.pin({ key: KEY, value: "api3.acme.com", source: "agent_pin" }).op).toBe(
      "rejected",
    );
  });
});

describe("sticky owner retire", () => {
  beforeEach(() => {
    store.pin({ key: KEY, value: "api.acme.com", source: "extraction", confidence: 0.8 });
  });

  it("sets owner_retired and records a key/value suppression", () => {
    expect(store.retire(KEY, { reason: "owner" })).toBe(true);
    expect(store.get(KEY)?.status).toBe("owner_retired");
    expect(store.listActive()).toHaveLength(0);
    expect(
      isSuppressed(db, "fact_key_value", factKeyValueHash(KEY, "api.acme.com")),
    ).not.toBeNull();
    // Retiring again is a no-op, not a second row.
    expect(store.retire(KEY, { reason: "owner" })).toBe(false);
    expect(listSuppressions(db, { kind: "fact_key_value" })).toHaveLength(1);
  });

  it("rejects the same value from extraction and from the agent, keeping owner_retired", () => {
    store.retire(KEY, { reason: "owner" });
    const fromExtraction = store.pin({ key: KEY, value: "api.acme.com", source: "extraction" });
    expect(fromExtraction.op).toBe("rejected");
    expect(fromExtraction.op === "rejected" && fromExtraction.reason).toMatch(/owner retired/);
    const fromAgent = store.pin({ key: KEY, value: "api.acme.com", source: "agent_pin" });
    expect(fromAgent.op).toBe("rejected");
    const fromPromotion = store.pin({ key: KEY, value: "api.acme.com", source: "promotion" });
    expect(fromPromotion.op).toBe("rejected");
    expect(store.get(KEY)?.status).toBe("owner_retired");
    expect(store.get(KEY)?.mentionCount).toBe(1);
  });

  it("rejects case and whitespace variants of the retired value", () => {
    store.retire(KEY, { reason: "owner" });
    expect(store.pin({ key: KEY, value: "API.acme.com", source: "extraction" }).op).toBe(
      "rejected",
    );
    expect(store.pin({ key: KEY, value: "api.acme.com ", source: "agent_pin" }).op).toBe(
      "rejected",
    );
    expect(store.get(KEY)?.status).toBe("owner_retired");
  });

  it("still lets a NEW value in below the owner tier, and the old one stays out", () => {
    store.retire(KEY, { reason: "owner" });
    // The owner retired a value, not the key: a different belief is new
    // information and supersedes the owner_retired row like any other.
    expect(store.pin({ key: KEY, value: "api2.acme.com", source: "extraction" }).op).toBe(
      "supersede",
    );
    expect(store.get(KEY)?.status).toBe("active");
    expect(store.get(KEY)?.value).toBe("api2.acme.com");
    // The retired value cannot supersede its way back even though the
    // current row no longer carries owner_retired.
    expect(store.pin({ key: KEY, value: "api.acme.com", source: "extraction" }).op).toBe(
      "rejected",
    );
    expect(store.get(KEY)?.value).toBe("api2.acme.com");
  });

  it("an owner pin of the same value reactivates it and lifts the suppression", () => {
    store.retire(KEY, { reason: "owner" });
    const result = store.pin({ key: KEY, value: "api.acme.com", source: "owner" });
    expect(result.op).toBe("strengthen");
    expect(store.get(KEY)?.status).toBe("active");
    expect(isSuppressed(db, "fact_key_value", factKeyValueHash(KEY, "api.acme.com"))).toBeNull();
    // Extraction corroborates normally again.
    expect(store.pin({ key: KEY, value: "api.acme.com", source: "extraction" }).op).toBe(
      "strengthen",
    );
  });

  it("unretire reactivates and lifts the suppression", () => {
    store.retire(KEY, { reason: "owner" });
    expect(store.unretire(KEY)).toBe(true);
    expect(store.get(KEY)?.status).toBe("active");
    expect(isSuppressed(db, "fact_key_value", factKeyValueHash(KEY, "api.acme.com"))).toBeNull();
    expect(store.unretire(KEY)).toBe(false); // already active
    expect(store.pin({ key: KEY, value: "api.acme.com", source: "extraction" }).op).toBe(
      "strengthen",
    );
  });

  it("upgrades a decay-retired fact to owner_retired", () => {
    store.retire(KEY, { reason: "decay" });
    expect(store.get(KEY)?.status).toBe("retired");
    expect(store.retire(KEY, { reason: "owner" })).toBe(true);
    expect(store.get(KEY)?.status).toBe("owner_retired");
  });

  it("an owner_retired row without a suppression (pre-v76 data) still rejects below owner", () => {
    db.prepare(`UPDATE canonical_facts SET status = 'owner_retired' WHERE key = ?`).run(KEY);
    expect(listSuppressions(db)).toHaveLength(0);
    expect(store.pin({ key: KEY, value: "api.acme.com", source: "agent_pin" }).op).toBe("rejected");
    expect(store.get(KEY)?.status).toBe("owner_retired");
    expect(store.pin({ key: KEY, value: "api.acme.com", source: "owner" }).op).toBe("strengthen");
    expect(store.get(KEY)?.status).toBe("active");
  });

  it("records owner_retired conflicts that the sweep consumes without asking the owner", () => {
    store.retire(KEY, { reason: "owner" });
    store.pin({ key: KEY, value: "api.acme.com", source: "extraction" });
    expect(conflicts()).toEqual([{ kind: "owner_retired", consumed_at: null, directive_id: null }]);
    const engine = new EpistemicDirectiveEngine(db);
    expect(engine.sweepCanonicalConflicts()).toBe(0);
    expect(engine.listOpenDirectives(10)).toHaveLength(0);
    const [row] = conflicts();
    expect(row?.consumed_at).not.toBeNull();
    expect(row?.directive_id).toBeNull();
  });
});

describe("soft retire (agent, decay, hygiene)", () => {
  beforeEach(() => {
    store.pin({ key: KEY, value: "api.acme.com", source: "extraction", confidence: 0.8 });
  });

  it("the agent's retire is reactivated by a later same-value extraction pin", () => {
    expect(store.retire(KEY, { reason: "agent" })).toBe(true);
    expect(store.get(KEY)?.status).toBe("retired");
    expect(listSuppressions(db)).toHaveLength(0);
    expect(store.pin({ key: KEY, value: "api.acme.com", source: "extraction" }).op).toBe(
      "strengthen",
    );
    expect(store.get(KEY)?.status).toBe("active");
  });

  it("a retire without a reason is the agent's, never the owner's", () => {
    expect(store.retire(KEY)).toBe(true);
    expect(store.get(KEY)?.status).toBe("retired");
    expect(listSuppressions(db)).toHaveLength(0);
  });

  it("decay never touches an owner_retired row", () => {
    store.retire(KEY, { reason: "owner" });
    const farFuture = Date.now() + 400 * 86_400_000;
    expect(store.decayTick(farFuture)).toBe(0);
    expect(store.get(KEY)?.status).toBe("owner_retired");
  });

  it("decay retires through retire(reason decay): soft, no suppression", () => {
    const farFuture = Date.now() + 400 * 86_400_000;
    expect(store.decayTick(farFuture)).toBe(1);
    expect(store.get(KEY)?.status).toBe("retired");
    expect(listSuppressions(db)).toHaveLength(0);
  });
});

describe("review-round fixes", () => {
  it("an owner-retired agent_pin row does not lock the key: a new value supersedes, no conflict", () => {
    store.pin({ key: KEY, value: "Victor", source: "agent_pin" });
    expect(store.retire(KEY, { reason: "owner" })).toBe(true);
    const result = store.pin({ key: KEY, value: "Vic", source: "extraction" });
    expect(result.op).toBe("supersede");
    expect(store.get(KEY)?.value).toBe("Vic");
    expect(store.get(KEY)?.status).toBe("active");
    expect(conflicts()).toEqual([]);
    // The superseded row keeps its history, and unretire has nothing to lift.
    expect(store.history(KEY).map((f) => f.status)).toEqual(["active", "superseded"]);
    expect(store.unretire(KEY)).toBe(false);
    // The retired value itself is still out, by any lower tier.
    expect(store.pin({ key: KEY, value: "Victor", source: "extraction" }).op).toBe("rejected");
    expect(store.pin({ key: KEY, value: "victor", source: "agent_pin" }).op).toBe("rejected");
  });

  it("a soft-retired agent_pin row is not a current belief either (extraction may replace it)", () => {
    store.pin({ key: KEY, value: "Victor", source: "agent_pin" });
    store.retire(KEY, { reason: "agent" });
    expect(store.pin({ key: KEY, value: "Vic", source: "extraction" }).op).toBe("supersede");
    expect(conflicts()).toEqual([]);
  });

  it("the sweep never asks about a key whose current row is not active", () => {
    store.pin({ key: KEY, value: "Victor", source: "agent_pin" });
    // A stale tier_rejection left behind before the retire.
    db.prepare(
      `INSERT INTO canonical_conflicts (id, key, kind, current_value, proposed_value,
         current_source, proposed_source, created_at)
       VALUES ('c1', ?, 'tier_rejection', 'Victor', 'Vic', 'agent_pin', 'extraction', ?)`,
    ).run(KEY, Date.now());
    store.retire(KEY, { reason: "owner" });
    const engine = new EpistemicDirectiveEngine(db);
    expect(engine.sweepCanonicalConflicts()).toBe(0);
    expect(engine.listOpenDirectives(10)).toHaveLength(0);
    expect(conflicts()[0]?.consumed_at).not.toBeNull();
  });

  it("rejects an unknown source instead of treating it as a tier above everything", () => {
    store.pin({ key: KEY, value: "Victor", source: "owner" });
    const result = store.pin({
      key: KEY,
      value: "Mallory",
      source: "not_a_source" as unknown as "owner",
    });
    expect(result.op).toBe("rejected");
    expect(result.op === "rejected" && result.reason).toMatch(/unknown source/);
    expect(store.get(KEY)?.value).toBe("Victor");
    // Same for a retired value: unknown sources cannot bypass the suppression.
    store.retire(KEY, { reason: "owner" });
    expect(store.pin({ key: KEY, value: "Victor", source: "nope" as unknown as "owner" }).op).toBe(
      "rejected",
    );
    expect(store.get(KEY)?.status).toBe("owner_retired");
  });

  it("an owner retire whose suppression cannot be written does not flip the status", () => {
    store.pin({ key: KEY, value: "Victor", source: "agent_pin" });
    db.exec(`DROP TABLE memory_suppressions`);
    expect(() => store.retire(KEY, { reason: "owner" })).toThrow();
    expect(store.get(KEY)?.status).toBe("active");
  });
});
