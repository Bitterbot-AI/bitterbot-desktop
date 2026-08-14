import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { generateKeyPair, pubkeyId, type KeyPair } from "../commerce/envelope.js";
import { CirclesStore, DEFAULT_MEMBER_SCOPES } from "../memory/circles-store.js";
import { ensureMemoryIndexSchema } from "../memory/memory-schema.js";
import { runMigrations } from "../memory/migrations.js";
import { generateBoxKeyPair } from "./box-crypto.js";
import {
  circleP2pAvailable,
  dialCircleRpc,
  getLocalPeerId,
  setCircleP2pForTests,
  startCircleP2pTransport,
  type CircleRpcBridge,
} from "./circle-p2p-transport.js";
import { makeCircleEnvelope } from "./envelope.js";

// Stage 4: point-to-point circle RPC over the mesh. These tests drive the
// REAL transport glue and the REAL circle verb dispatcher through an
// in-memory two-node mesh — the same auth outcomes an HTTP dial would get.

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

/** Minimal in-memory mesh: bridges route circleRequest to the target node's
 * registered inbound callback and correlate circleRespond back. */
class FakeMesh {
  private nodes = new Map<
    string,
    {
      cb?: (e: { request_id: number; from_peer_id: string; data_b64: string }) => void;
      pending: Map<number, (dataB64: string) => void>;
      counter: number;
    }
  >();

  private ensure(peerId: string) {
    let n = this.nodes.get(peerId);
    if (!n) {
      n = { pending: new Map(), counter: 0 };
      this.nodes.set(peerId, n);
    }
    return n;
  }

  bridgeFor(peerId: string): CircleRpcBridge {
    const self = this.ensure(peerId);
    return {
      circleRequest: (target, dataB64, timeoutMs = 1_000) => {
        const t = this.nodes.get(target);
        if (!t?.cb) {
          return Promise.reject(new Error("Dial failure: peer unreachable"));
        }
        return new Promise<string>((resolve, reject) => {
          const rid = ++t.counter;
          const timer = setTimeout(() => {
            t.pending.delete(rid);
            reject(new Error("circle rpc timed out"));
          }, timeoutMs);
          t.pending.set(rid, (dataB64) => {
            clearTimeout(timer);
            resolve(dataB64);
          });
          t.cb!({ request_id: rid, from_peer_id: peerId, data_b64: dataB64 });
        });
      },
      circleRespond: async (requestId, dataB64) => {
        self.pending.get(requestId)?.(dataB64);
        self.pending.delete(requestId);
      },
      onCircleRequest: (cb) => {
        self.cb = cb;
        return () => {
          self.cb = undefined;
        };
      },
      getIdentity: async () => ({ pubkey: "node", peerId, nodeTier: "edge" }),
    };
  }
}

const ANA_PEER = "12D3KooWAnaAnaAnaAnaAnaAnaAnaAnaAnaAnaAnaAna";
const BOB_PEER = "12D3KooWBobBobBobBobBobBobBobBobBobBobBobBob";

afterEach(() => {
  setCircleP2pForTests(null);
});

function bobNodeWithAnaMember(anaKey: KeyPair): { db: DatabaseSync; circleId: string } {
  const db = openDb();
  const store = new CirclesStore(db);
  const bobKey = generateKeyPair();
  const circleId = store.createCircle({
    name: "Mesh Crew",
    kind: "connection",
    creatorPubkey: pubkeyId(bobKey),
  });
  store.addMember({
    circleId,
    memberPubkey: pubkeyId(anaKey),
    scopes: DEFAULT_MEMBER_SCOPES,
  });
  return { db, circleId };
}

describe("circle p2p rpc transport", () => {
  it("delivers a signed circle verb peer-to-peer through the real dispatcher", async () => {
    const mesh = new FakeMesh();
    const anaKey = generateKeyPair();
    const bob = bobNodeWithAnaMember(anaKey);

    // Bob's node answers mesh requests; Ana's node dials.
    const bobT = startCircleP2pTransport({
      bridge: mesh.bridgeFor(BOB_PEER),
      resolveCirclesDb: async () => bob.db,
      boxKeys: generateBoxKeyPair(),
    });
    const anaT = startCircleP2pTransport({
      bridge: mesh.bridgeFor(ANA_PEER),
      resolveCirclesDb: async () => undefined,
      boxKeys: generateBoxKeyPair(),
    });
    expect(circleP2pAvailable()).toBe(true);

    const envelope = makeCircleEnvelope(
      "message",
      bob.circleId,
      { text: "hello over the mesh, no URLs anywhere" },
      anaKey,
    );
    const out = await dialCircleRpc(BOB_PEER, "circle/message", { envelope });
    expect(out.ok).toBe(true);
    const stored = (
      bob.db
        .prepare(`SELECT COUNT(*) AS n FROM circle_messages WHERE circle_id = ?`)
        .get(bob.circleId) as { n: number }
    ).n;
    expect(stored).toBe(1);
    anaT.stop();
    bobT.stop();
  });

  it("refuses strangers and non-circle methods definitively (no mailbox retry)", async () => {
    const mesh = new FakeMesh();
    const anaKey = generateKeyPair();
    const mallory = generateKeyPair();
    const bob = bobNodeWithAnaMember(anaKey);
    const bobT = startCircleP2pTransport({
      bridge: mesh.bridgeFor(BOB_PEER),
      resolveCirclesDb: async () => bob.db,
      boxKeys: generateBoxKeyPair(),
    });
    const anaT = startCircleP2pTransport({
      bridge: mesh.bridgeFor(ANA_PEER),
      resolveCirclesDb: async () => undefined,
      boxKeys: generateBoxKeyPair(),
    });

    const hostile = makeCircleEnvelope("message", bob.circleId, { text: "let me in" }, mallory);
    const refused = await dialCircleRpc(BOB_PEER, "circle/message", { envelope: hostile });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.refused).toBe(true);

    const wrongSurface = await dialCircleRpc(BOB_PEER, "mailbox/post", {});
    expect(wrongSurface.ok).toBe(false);
    if (!wrongSurface.ok) expect(wrongSurface.error).toMatch(/not allowed/);
    anaT.stop();
    bobT.stop();
  });

  it("does NOT latch on a busy-daemon enqueue timeout (only on unknown-verb)", async () => {
    // A flooded daemon rejects the enqueue with the IPC timeout string; that
    // must stay a transient failure, never disable P2P for the process
    // (security pass CRIT-1).
    const bridge: CircleRpcBridge = {
      circleRequest: async () => {
        throw new Error("IPC command circle_request timed out");
      },
      circleRespond: async () => {},
      onCircleRequest: () => () => {},
      getIdentity: async () => ({ pubkey: "", peerId: ANA_PEER, nodeTier: "edge" }),
    };
    const t = startCircleP2pTransport({
      bridge,
      resolveCirclesDb: async () => undefined,
      boxKeys: generateBoxKeyPair(),
    });
    const out = await dialCircleRpc(BOB_PEER, "circle/message", {});
    expect(out.ok).toBe(false);
    expect(circleP2pAvailable()).toBe(true); // NOT latched
    t.stop();
  });

  it("treats a responder shim error as a soft failure, not a refusal (HIGH-6)", async () => {
    // Bob's node is up on the mesh but its circles DB has not loaded yet, so
    // it answers "node not ready". The dialer must NOT see that as a
    // definitive refusal (which would skip HTTP + mailbox and strand
    // delivery); refused must be false so the caller falls back.
    const mesh = new FakeMesh();
    const bobT = startCircleP2pTransport({
      bridge: mesh.bridgeFor(BOB_PEER),
      resolveCirclesDb: async () => undefined, // still booting
      boxKeys: generateBoxKeyPair(),
    });
    const anaT = startCircleP2pTransport({
      bridge: mesh.bridgeFor(ANA_PEER),
      resolveCirclesDb: async () => undefined,
      boxKeys: generateBoxKeyPair(),
    });
    const out = await dialCircleRpc(BOB_PEER, "circle/message", {});
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.refused).toBeFalsy();
      expect(out.error).toMatch(/not ready/);
    }
    anaT.stop();
    bobT.stop();
  });

  it("survives a rejecting resolveCirclesDb without an unhandled rejection (HIGH-3)", async () => {
    // resolveCirclesDb rejecting (DB busy) must be caught inside the callback
    // and answered as a shim error, never escape as an unhandled rejection.
    const mesh = new FakeMesh();
    const bobT = startCircleP2pTransport({
      bridge: mesh.bridgeFor(BOB_PEER),
      resolveCirclesDb: async () => {
        throw new Error("SQLITE_BUSY: database is locked");
      },
      boxKeys: generateBoxKeyPair(),
    });
    const anaT = startCircleP2pTransport({
      bridge: mesh.bridgeFor(ANA_PEER),
      resolveCirclesDb: async () => undefined,
      boxKeys: generateBoxKeyPair(),
    });
    const out = await dialCircleRpc(BOB_PEER, "circle/message", {});
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.refused).toBeFalsy(); // shim error, falls back
    anaT.stop();
    bobT.stop();
  });

  it("fails soft on unreachable peers without latching", async () => {
    const mesh = new FakeMesh();
    const anaT = startCircleP2pTransport({
      bridge: mesh.bridgeFor(ANA_PEER),
      resolveCirclesDb: async () => undefined,
      boxKeys: generateBoxKeyPair(),
    });
    const out = await dialCircleRpc(BOB_PEER, "circle/message", {});
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.refused).toBeUndefined();
    expect(circleP2pAvailable()).toBe(true);
    anaT.stop();
  });

  it("latches off when the daemon does not know the verbs", async () => {
    const bridge: CircleRpcBridge = {
      circleRequest: async () => {
        throw new Error("circle_request refused: unknown message type: circle_request");
      },
      circleRespond: async () => {},
      onCircleRequest: () => () => {},
      getIdentity: async () => ({ pubkey: "", peerId: ANA_PEER, nodeTier: "edge" }),
    };
    const t = startCircleP2pTransport({
      bridge,
      resolveCirclesDb: async () => undefined,
      boxKeys: generateBoxKeyPair(),
    });
    const out = await dialCircleRpc(BOB_PEER, "circle/message", {});
    expect(out.ok).toBe(false);
    expect(circleP2pAvailable()).toBe(false);
    const again = await dialCircleRpc(BOB_PEER, "circle/message", {});
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error).toMatch(/unavailable/);
    t.stop();
  });

  it("caches the local PeerId for envelope bindings", async () => {
    const mesh = new FakeMesh();
    const t = startCircleP2pTransport({
      bridge: mesh.bridgeFor(ANA_PEER),
      resolveCirclesDb: async () => undefined,
      boxKeys: generateBoxKeyPair(),
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(getLocalPeerId()).toBe(ANA_PEER);
    t.stop();
  });
});
