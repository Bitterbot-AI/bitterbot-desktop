import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import type { BitterbotConfig } from "../config/types.bitterbot.js";
import { generateKeyPair, pubkeyId, type KeyPair } from "../commerce/envelope.js";
import { handleCircleMethod, resetCircleRateLimits } from "../gateway/a2a/circles.js";
import { handleMailboxMethod, resetMailboxRateLimits } from "../gateway/a2a/mailbox.js";
import { ensureMemoryIndexSchema } from "../memory/memory-schema.js";
import { runMigrations } from "../memory/migrations.js";
import { generateBoxKeyPair } from "./box-crypto.js";
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

/**
 * Routes https://<host>.test/a2a to that host's DB via the real handlers.
 * mailbox/* verbs are served even when a host is marked offline — the
 * asymmetric-window case: the relay stays up while the friend's laptop is
 * closed, so circle/* dials fail but deposited mail persists.
 */
function meshFetch(
  nodes: Record<string, DatabaseSync>,
  opts: { offline?: Set<string> } = {},
): FetchLike {
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
    const isMailbox = rpc.method.startsWith("mailbox/");
    if (!isMailbox && opts.offline?.has(host as string)) {
      return { ok: false, status: 502, text: async () => "node offline" };
    }
    const outcome = isMailbox
      ? handleMailboxMethod(rpc.method, rpc.params, db, Date.now())
      : handleCircleMethod(rpc.method, rpc.params, db, Date.now());
    const body = outcome.ok
      ? { jsonrpc: "2.0", result: outcome.result, id: rpc.id }
      : { jsonrpc: "2.0", error: outcome.error, id: rpc.id };
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };
}

function makeConfig(name: string, host: string, mailboxHost?: string): BitterbotConfig {
  return {
    circles: {
      enabled: true,
      a2aPublicUrl: `https://${host}.test`,
      displayName: name,
      ...(mailboxHost ? { mailbox: { url: `https://${mailboxHost}.test`, serve: false } } : {}),
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
    resetMailboxRateLimits();
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

  it("delivers through the mailbox when the peer is offline (store-and-forward §3.2)", async () => {
    // relay = a third node hosting mailboxes; bob's laptop will be closed.
    const relayDb = openDb();
    const offline = new Set<string>();
    const nodes = { ana: anaDb, bob: bobDb, relay: relayDb };
    const fetchImpl = meshFetch(nodes, { offline });
    const anaBox = generateBoxKeyPair();
    const bobBox = generateBoxKeyPair();
    ana = new CirclesService({
      db: anaDb,
      config: makeConfig("Ana's agent", "ana", "relay"),
      fetchImpl,
      keyPair: anaKey,
      boxKeys: anaBox,
    });
    bob = new CirclesService({
      db: bobDb,
      config: makeConfig("Bob's agent", "bob", "relay"),
      fetchImpl,
      keyPair: bobKey,
      boxKeys: bobBox,
    });

    // Connect while both are online (join advertises box key + mailbox URL).
    const invite = ana.createInviteCode({ name: "Ana & Bob" });
    await bob.redeemInviteCode(invite.code);
    const circleId = invite.circleId;

    // Bob's laptop closes. Ana's send falls back to the relay mailbox.
    offline.add("bob");
    const report = await ana.sendMessage({ circleId, text: "logged the pizza, $42 split 2" });
    expect(report.delivered).toEqual([pubkeyId(bobKey)]);
    expect(report.failed).toEqual([]);

    // Nothing reached Bob's node yet.
    expect(bob.messages(circleId).filter((m) => m.direction === "in")).toHaveLength(0);
    // The relay stored ciphertext only — the plaintext appears nowhere.
    const stored = relayDb.prepare(`SELECT blob_json FROM mailbox_blobs`).all() as Array<{
      blob_json: string;
    }>;
    expect(stored).toHaveLength(1);
    expect(stored[0]?.blob_json).not.toContain("pizza");

    // Bob wakes and drains his mailbox: the message lands through the SAME
    // hostile-principal path (wrapped), and the relay is emptied by the ack.
    offline.delete("bob");
    const drained = await bob.pollMailbox();
    expect(drained).toEqual({ received: 1, dispatched: 1 });
    const inbox = bob.messages(circleId).filter((m) => m.direction === "in");
    expect(inbox).toHaveLength(1);
    expect(inbox[0]?.content).toContain("pizza");
    expect(inbox[0]?.content.toLowerCase()).toContain("untrusted");
    expect(relayDb.prepare(`SELECT COUNT(*) AS n FROM mailbox_blobs`).get()).toEqual({ n: 0 });

    // A second poll is a no-op (acked), and a replayed live dial of the same
    // envelope would be deduped — delivered exactly once.
    expect(await bob.pollMailbox()).toEqual({ received: 0, dispatched: 0 });
    expect(bob.messages(circleId).filter((m) => m.direction === "in")).toHaveLength(1);
  });
});
