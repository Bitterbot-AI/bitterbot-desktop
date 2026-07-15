import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import type { BitterbotConfig } from "../config/types.bitterbot.js";
import { generateKeyPair, type KeyPair } from "../commerce/envelope.js";
import { handleCircleMethod } from "../gateway/a2a/circles.js";
import { handleMailboxMethod } from "../gateway/a2a/mailbox.js";
import { ensureMemoryIndexSchema } from "../memory/memory-schema.js";
import { runMigrations } from "../memory/migrations.js";
import {
  bridgeCircleTopicBus,
  circleTopicId,
  onBridgeCircleFrame,
  publishCircleFrame,
  receiveCircleFrame,
  type CircleTopicBridge,
  type CircleTopicBus,
} from "./circle-topic.js";
import { makeCircleEnvelope } from "./envelope.js";
import { CirclesService, type FetchLike } from "./service.js";

// PLAN-36 Phase 4 (PROTOTYPE): prove circle messaging over a per-circle gossip
// topic at the application layer — a signed message reaches a member with NO
// a2a_url over an in-process fake bus (standing in for the Rust dynamic pub/sub
// primitive), dispatched through the same authenticated path as any carrier.

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

/** Routes https://<host>.test/a2a to that host's DB — only used here for JOIN. */
function meshFetch(nodes: Record<string, DatabaseSync>): FetchLike {
  return async (url, init) => {
    const host = /https:\/\/([a-z]+)\.test\//.exec(url)?.[1];
    const db = host ? nodes[host] : undefined;
    if (!db) return { ok: false, status: 502, text: async () => "no node" };
    const rpc = JSON.parse(init?.body ?? "{}") as { id: string; method: string; params: unknown };
    const outcome = rpc.method.startsWith("mailbox/")
      ? handleMailboxMethod(rpc.method, rpc.params, db, Date.now())
      : handleCircleMethod(rpc.method, rpc.params, db, Date.now());
    const body = outcome.ok
      ? { jsonrpc: "2.0", result: outcome.result, id: rpc.id }
      : { jsonrpc: "2.0", error: outcome.error, id: rpc.id };
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };
}

function makeConfig(name: string, host?: string): BitterbotConfig {
  return {
    circles: {
      enabled: true,
      ...(host ? { a2aPublicUrl: `https://${host}.test` } : {}),
      displayName: name,
    },
  } as BitterbotConfig;
}

/** In-process gossip bus: publish() fans a frame to every subscriber of a topic. */
function fakeBus(): CircleTopicBus & { subscribers: Map<string, Set<(f: string) => void>> } {
  const subscribers = new Map<string, Set<(f: string) => void>>();
  return {
    subscribers,
    async publish(topic, frameJson) {
      for (const cb of subscribers.get(topic) ?? []) cb(frameJson);
    },
    async subscribe(topic) {
      if (!subscribers.has(topic)) subscribers.set(topic, new Set());
    },
    async unsubscribe(topic) {
      subscribers.delete(topic);
    },
  };
}

describe("circle messaging over a gossip topic (prototype)", () => {
  let anaDb: DatabaseSync;
  let bobDb: DatabaseSync;
  let anaKey: KeyPair;
  let bobKey: KeyPair;
  let ana: CirclesService;
  let bob: CirclesService;

  beforeEach(() => {
    anaDb = openDb();
    bobDb = openDb();
    anaKey = generateKeyPair();
    bobKey = generateKeyPair();
    const fetchImpl = meshFetch({ ana: anaDb, bob: bobDb });
    // Ana can originate (has a2a_url, used only for the JOIN handshake).
    ana = new CirclesService({
      db: anaDb,
      config: makeConfig("Ana", "ana"),
      fetchImpl,
      keyPair: anaKey,
    });
    // Bob has NO a2a_url — he is only reachable over the topic.
    bob = new CirclesService({ db: bobDb, config: makeConfig("Bob"), fetchImpl, keyPair: bobKey });
  });

  it("blinds the topic name (raw circle id is not on the wire)", () => {
    const t = circleTopicId("circle-abc-123", 0);
    expect(t).toMatch(/^bitterbot\/circle\/[0-9a-f]{64}\/v1$/);
    expect(t).not.toContain("circle-abc-123");
    // Rotates with the key epoch (a removed member's old topic goes stale).
    expect(circleTopicId("circle-abc-123", 1)).not.toBe(t);
  });

  it("delivers a signed message to a member with NO a2a_url, over the topic only", async () => {
    // Establish membership via the normal invite/join (join uses Ana's a2a url).
    const invite = ana.createInviteCode({ name: "Ana & Bob" });
    await bob.redeemInviteCode(invite.code);
    const circleId = invite.circleId;
    const epoch = ana.store.getCircle(circleId)!.keyEpoch;

    // Bob subscribes his receive path to the circle's blinded topic.
    const bus = fakeBus();
    const topic = circleTopicId(circleId, epoch);
    await bus.subscribe(topic);
    bus.subscribers.get(topic)!.add((frame) => {
      receiveCircleFrame(frame, bobDb);
    });

    // Ana sends a circle/message purely over the topic — no HTTP dial at all.
    const envelope = makeCircleEnvelope("message", circleId, { text: "over gossip 👋" }, anaKey);
    await publishCircleFrame(bus, circleId, epoch, "circle/message", envelope);

    // Bob received it, wrapped as untrusted external content, though he has no
    // a2a_url and nothing was dialed.
    const inbox = bob.messages(circleId).filter((m) => m.direction === "in");
    expect(inbox).toHaveLength(1);
    expect(inbox[0]?.content).toContain("over gossip");
    expect(inbox[0]?.content.toLowerCase()).toContain("untrusted");
  });

  it("round-trips through the orchestrator-bridge adapter (base64 on the wire)", async () => {
    const invite = ana.createInviteCode({ name: "Ana & Bob" });
    await bob.redeemInviteCode(invite.code);
    const circleId = invite.circleId;
    const epoch = ana.store.getCircle(circleId)!.keyEpoch;

    // A mock bridge: publishCircleTopic fans the base64 frame to every
    // onCircleTopicMessage subscriber, exactly like the Rust primitive would.
    const listeners: Array<(e: { topic: string; from_peer_id: string; data_b64: string }) => void> =
      [];
    const mockBridge: CircleTopicBridge = {
      async subscribeCircleTopic() {},
      async unsubscribeCircleTopic() {},
      async publishCircleTopic(topic, dataB64) {
        for (const cb of listeners) cb({ topic, from_peer_id: "12D3KooWpeer", data_b64: dataB64 });
      },
      onCircleTopicMessage(cb) {
        listeners.push(cb);
        return () => {};
      },
    };

    // Bob's node dispatches inbound bridge frames into his DB.
    onBridgeCircleFrame(mockBridge, (frameJson) => {
      receiveCircleFrame(frameJson, bobDb);
    });

    // Ana publishes through the bus adapter (base64-encodes under the hood).
    const bus = bridgeCircleTopicBus(mockBridge);
    const envelope = makeCircleEnvelope(
      "message",
      circleId,
      { text: "bridged over gossip" },
      anaKey,
    );
    await publishCircleFrame(bus, circleId, epoch, "circle/message", envelope);

    const inbox = bob.messages(circleId).filter((m) => m.direction === "in");
    expect(inbox).toHaveLength(1);
    expect(inbox[0]?.content).toContain("bridged over gossip");
  });

  it("rejects a frame from a non-member (same auth as any carrier)", async () => {
    const invite = ana.createInviteCode({ name: "Ana & Bob" });
    await bob.redeemInviteCode(invite.code);
    const circleId = invite.circleId;

    // Eve is not a member; her signed frame published to the topic is refused.
    const eve = generateKeyPair();
    const hostile = makeCircleEnvelope("message", circleId, { text: "let me in" }, eve);
    const res = receiveCircleFrame(
      JSON.stringify({ method: "circle/message", envelope: hostile }),
      bobDb,
    );
    expect(res.ok).toBe(false);
    expect(bob.messages(circleId).filter((m) => m.direction === "in")).toHaveLength(0);
  });
});
