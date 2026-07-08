import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import type { BitterbotConfig } from "../config/types.bitterbot.js";
import { generateKeyPair, pubkeyId, type KeyPair } from "../commerce/envelope.js";
import { handleCircleMethod, resetCircleRateLimits } from "../gateway/a2a/circles.js";
import { ensureMemoryIndexSchema } from "../memory/memory-schema.js";
import { runMigrations } from "../memory/migrations.js";
import { CirclesService, type FetchLike } from "./service.js";

// PLAN-31 C1 end-to-end: two nodes (two DBs, two keys), a fake fetch that
// routes each dial to the OTHER node's real A2A handlers. Exercises the full
// ceremony: invite -> join -> roster mirror -> message -> presence ->
// reciprocity, with no HTTP server involved.

function openDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  ensureMemoryIndexSchema({
    db,
    embeddingCacheTable: "embedding_cache",
    ftsTable: "chunks_fts",
    ftsEnabled: false,
  });
  runMigrations(db);
  return db;
}

/** Routes https://<host>.test/a2a to that host's DB via the real handlers. */
function meshFetch(nodes: Record<string, DatabaseSync>): FetchLike {
  return async (url, init) => {
    const host = /https:\/\/([a-z]+)\.test\//.exec(url)?.[1];
    const db = host ? nodes[host] : undefined;
    if (!db) {
      return { ok: false, status: 502, text: async () => "no such node" };
    }
    const rpc = JSON.parse(init?.body ?? "{}") as {
      id: string;
      method: string;
      params: unknown;
    };
    const outcome = handleCircleMethod(rpc.method, rpc.params, db, Date.now());
    const body = outcome.ok
      ? { jsonrpc: "2.0", result: outcome.result, id: rpc.id }
      : { jsonrpc: "2.0", error: outcome.error, id: rpc.id };
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };
}

function makeConfig(name: string, host: string): BitterbotConfig {
  return {
    circles: {
      enabled: true,
      a2aPublicUrl: `https://${host}.test`,
      displayName: name,
    },
  };
}

describe("CirclesService end-to-end (two nodes)", () => {
  let anaDb: DatabaseSync;
  let bobDb: DatabaseSync;
  let ana: CirclesService;
  let bob: CirclesService;
  let anaKey: KeyPair;
  let bobKey: KeyPair;

  beforeEach(() => {
    resetCircleRateLimits();
    anaDb = openDb();
    bobDb = openDb();
    anaKey = generateKeyPair();
    bobKey = generateKeyPair();
    const fetchImpl = meshFetch({ ana: anaDb, bob: bobDb });
    ana = new CirclesService({
      db: anaDb,
      config: makeConfig("Ana's agent", "ana"),
      fetchImpl,
      keyPair: anaKey,
    });
    bob = new CirclesService({
      db: bobDb,
      config: makeConfig("Bob's agent", "bob"),
      fetchImpl,
      keyPair: bobKey,
    });
  });

  it("connects two nodes: invite -> join -> mirrored rosters on both sides", async () => {
    const invite = ana.createInviteCode({ name: "Ana & Bob" });
    const joined = await bob.redeemInviteCode(invite.code);
    expect(joined.circleId).toBe(invite.circleId);
    expect(joined.members).toBe(2);

    // Ana's node (the server side) has Bob as an active member.
    const anaView = ana.store.getMembers(invite.circleId).map((m) => m.memberPubkey);
    expect(anaView.toSorted()).toEqual([pubkeyId(anaKey), pubkeyId(bobKey)].toSorted());

    // Bob's node mirrored the same circle id + roster.
    const bobView = bob.store.getMembers(invite.circleId).map((m) => m.memberPubkey);
    expect(bobView.toSorted()).toEqual(anaView.toSorted());

    // Both count exactly one connection (the friend-node count).
    expect(ana.connectionCount()).toBe(1);
    expect(bob.connectionCount()).toBe(1);
  });

  it("carries a conversation both ways and computes reciprocity", async () => {
    const invite = ana.createInviteCode({ name: "Ana & Bob" });
    await bob.redeemInviteCode(invite.code);
    const circleId = invite.circleId;

    const bobSend = await bob.sendMessage({
      circleId,
      text: "my human wants to plan Tahoe",
    });
    expect(bobSend.delivered).toEqual([pubkeyId(anaKey)]);
    expect(bobSend.failed).toEqual([]);

    // Ana's inbound buffer holds Bob's message, wrapped.
    const anaInbox = ana.messages(circleId).filter((m) => m.direction === "in");
    expect(anaInbox).toHaveLength(1);
    expect(anaInbox[0]?.content).toContain("plan Tahoe");
    expect(anaInbox[0]?.content.toLowerCase()).toContain("untrusted");

    const anaSend = await ana.sendMessage({ circleId, text: "the 14th works for us" });
    expect(anaSend.delivered).toEqual([pubkeyId(bobKey)]);

    // Reciprocity: each side has one reciprocated peer this week.
    expect(ana.reciprocity()).toEqual({ reciprocatedPeers: 1, activePeers: 1 });
    expect(bob.reciprocity()).toEqual({ reciprocatedPeers: 1, activePeers: 1 });
  });

  it("propagates presence heartbeats into the peer-presence table", async () => {
    const invite = ana.createInviteCode({ name: "Ana & Bob" });
    await bob.redeemInviteCode(invite.code);
    await bob.heartbeat();
    const seen = ana.peerPresence();
    expect(seen).toHaveLength(1);
    expect(seen[0]?.peerPubkey).toBe(pubkeyId(bobKey));
    expect(seen[0]?.lastStatus).toBe("online");
  });

  it("refuses to mint invites without a public URL and on inactive circles", () => {
    const lonely = new CirclesService({
      db: openDb(),
      config: { circles: { enabled: true } },
      fetchImpl: meshFetch({}),
      keyPair: generateKeyPair(),
    });
    expect(() => lonely.createInviteCode({})).toThrow(/a2aPublicUrl/);

    const circleId = ana.createCircle({ name: "Frozen" });
    ana.store.freezeCircle(circleId);
    expect(() => ana.createInviteCode({ circleId })).toThrow(/frozen/);
  });

  it("supports a 3-node circle: one invite each, fan-out reaches everyone", async () => {
    const carolDb = openDb();
    const carolKey = generateKeyPair();
    const fetchImpl = meshFetch({ ana: anaDb, bob: bobDb, carol: carolDb });
    ana = new CirclesService({
      db: anaDb,
      config: makeConfig("Ana's agent", "ana"),
      fetchImpl,
      keyPair: anaKey,
    });
    bob = new CirclesService({
      db: bobDb,
      config: makeConfig("Bob's agent", "bob"),
      fetchImpl,
      keyPair: bobKey,
    });
    const carol = new CirclesService({
      db: carolDb,
      config: makeConfig("Carol's agent", "carol"),
      fetchImpl,
      keyPair: carolKey,
    });

    const circleId = ana.createCircle({ name: "Tahoe Crew", kind: "trip" });
    await bob.redeemInviteCode(ana.createInviteCode({ circleId }).code);
    await carol.redeemInviteCode(ana.createInviteCode({ circleId }).code);

    // Carol re-syncs the roster through her join (Bob joined first); Ana's
    // fan-out reaches both.
    const report = await ana.sendMessage({ circleId, text: "kickoff: dates poll tomorrow" });
    expect(report.delivered.toSorted()).toEqual([pubkeyId(bobKey), pubkeyId(carolKey)].toSorted());
    expect(bob.messages(circleId).some((m) => m.content.includes("kickoff"))).toBe(true);
    expect(carol.messages(circleId).some((m) => m.content.includes("kickoff"))).toBe(true);
  });
});
