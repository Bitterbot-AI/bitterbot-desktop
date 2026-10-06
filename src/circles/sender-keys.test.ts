import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { ensureMemoryIndexSchema } from "../memory/memory-schema.js";
import { runMigrations } from "../memory/migrations.js";
import { generateBoxKeyPair } from "./box-crypto.js";
import {
  buildSenderKeyBody,
  decryptTopicFrame,
  deliveredMembers,
  encryptTopicFrame,
  getOrCreateOwnSenderKey,
  ingestSenderKeyBody,
  maintainSenderKeys,
  markDelivered,
  MAX_KEYS_PER_SENDER,
  OWN_KEY_MAX_AGE_MS,
  RETIRED_KEY_GRACE_MS,
  parseEncryptedTopicFrame,
  rotateOwnSenderKey,
} from "./sender-keys.js";

// Stage 2 of the P2P transport plan: sender-key confidentiality for gossip
// frames. Each member encrypts with their OWN key, distributed sealed per
// member — no group consensus, matching the node-local roster philosophy.

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

const CIRCLE = "c".repeat(64);
const SENDER = `ed25519:${"a".repeat(64)}`;
const TOPIC = `bitterbot/circle/${"e".repeat(64)}/v1`;

describe("own sender keys", () => {
  it("creates once, returns the same key, and rotates on demand", () => {
    const db = openDb();
    const k1 = getOrCreateOwnSenderKey(db, CIRCLE);
    expect(getOrCreateOwnSenderKey(db, CIRCLE)).toEqual(k1);
    const k2 = rotateOwnSenderKey(db, CIRCLE);
    expect(k2.keyId).not.toBe(k1.keyId);
    expect(getOrCreateOwnSenderKey(db, CIRCLE)).toEqual(k2);
    // Delivery bookkeeping is per-key: the rotated key starts undelivered.
    markDelivered(db, CIRCLE, k1.keyId, ["m1"]);
    expect(deliveredMembers(db, CIRCLE, k1.keyId).has("m1")).toBe(true);
    expect(deliveredMembers(db, CIRCLE, k2.keyId).size).toBe(0);
  });
});

describe("distribution seal/ingest", () => {
  it("a recipient opens their entry; a third party cannot use the body", () => {
    const db = openDb();
    const key = getOrCreateOwnSenderKey(db, CIRCLE);
    const bob = generateBoxKeyPair();
    const eve = generateBoxKeyPair();
    const body = buildSenderKeyBody(key, [
      { memberPubkey: "ed25519:bob", boxPubkey: bob.publicKeyB64 },
    ]);
    // Bob ingests: stored under (circle, sender, keyId).
    expect(
      ingestSenderKeyBody(db, { circleId: CIRCLE, senderPubkey: SENDER, boxKeys: bob, body }),
    ).toBe(true);
    // Eve holds a different box key: nothing in the body opens for her.
    const eveDb = openDb();
    expect(
      ingestSenderKeyBody(eveDb, { circleId: CIRCLE, senderPubkey: SENDER, boxKeys: eve, body }),
    ).toBe(false);
  });

  it("ignores malformed bodies", () => {
    const db = openDb();
    const bob = generateBoxKeyPair();
    for (const body of [{}, { key_id: "x" }, { key_id: "x".repeat(65), sealed: {} }]) {
      expect(
        ingestSenderKeyBody(db, {
          circleId: CIRCLE,
          senderPubkey: SENDER,
          boxKeys: bob,
          body: body as never,
        }),
      ).toBe(false);
    }
  });
});

describe("frame encryption", () => {
  function ingestedDb(key: ReturnType<typeof getOrCreateOwnSenderKey>): DatabaseSync {
    const db = openDb();
    const bob = generateBoxKeyPair();
    const body = buildSenderKeyBody(key, [
      { memberPubkey: "ed25519:bob", boxPubkey: bob.publicKeyB64 },
    ]);
    ingestSenderKeyBody(db, { circleId: CIRCLE, senderPubkey: SENDER, boxKeys: bob, body });
    return db;
  }

  it("round-trips a frame for a member who holds the key", () => {
    const senderDb = openDb();
    const key = getOrCreateOwnSenderKey(senderDb, CIRCLE);
    const receiverDb = ingestedDb(key);
    const frameJson = JSON.stringify({ method: "circle/message", envelope: { body: "hello" } });
    const wire = encryptTopicFrame({ topicId: TOPIC, frameJson, senderPubkey: SENDER, key });
    // The wire form leaks neither the plaintext nor anything but the header.
    expect(wire).not.toContain("hello");
    const wrapper = parseEncryptedTopicFrame(wire);
    expect(wrapper?.s).toBe(SENDER);
    expect(
      decryptTopicFrame(receiverDb, { circleId: CIRCLE, topicId: TOPIC, wrapper: wrapper! }),
    ).toBe(frameJson);
  });

  it("fails without the key, on a tampered frame, and across topics (AAD)", () => {
    const senderDb = openDb();
    const key = getOrCreateOwnSenderKey(senderDb, CIRCLE);
    const receiverDb = ingestedDb(key);
    const wire = encryptTopicFrame({
      topicId: TOPIC,
      frameJson: "{}",
      senderPubkey: SENDER,
      key,
    });
    const wrapper = parseEncryptedTopicFrame(wire)!;
    // No key stored: null.
    expect(decryptTopicFrame(openDb(), { circleId: CIRCLE, topicId: TOPIC, wrapper })).toBeNull();
    // Tampered ciphertext: null.
    const tampered = { ...wrapper, ct: Buffer.from("forged").toString("base64") };
    expect(
      decryptTopicFrame(receiverDb, { circleId: CIRCLE, topicId: TOPIC, wrapper: tampered }),
    ).toBeNull();
    // Replayed onto a different topic: AAD mismatch, null.
    const otherTopic = `bitterbot/circle/${"f".repeat(64)}/v1`;
    expect(
      decryptTopicFrame(receiverDb, { circleId: CIRCLE, topicId: otherTopic, wrapper }),
    ).toBeNull();
    // Plaintext frames are recognizably NOT wrappers.
    expect(parseEncryptedTopicFrame('{"method":"circle/message"}')).toBeNull();
    expect(parseEncryptedTopicFrame("not json")).toBeNull();
  });

  it("rejects a truncated GCM tag or non-96-bit IV at parse (no auth downgrade)", () => {
    const senderDb = openDb();
    const key = getOrCreateOwnSenderKey(senderDb, CIRCLE);
    const wire = encryptTopicFrame({
      topicId: TOPIC,
      frameJson: "{}",
      senderPubkey: SENDER,
      key,
    });
    const good = parseEncryptedTopicFrame(wire)!;
    expect(good).not.toBeNull();
    // A 4-byte tag would decrypt+validate under Node's default (2^32 forgery
    // work); parse must refuse it (security pass M1).
    const shortTag = JSON.stringify({
      ...good,
      tag: Buffer.from(good.tag, "base64").subarray(0, 4).toString("base64"),
    });
    expect(parseEncryptedTopicFrame(shortTag)).toBeNull();
    // A non-96-bit IV pushes GCM onto the GHASH-J0 path — also refused.
    const longIv = JSON.stringify({
      ...good,
      iv: Buffer.alloc(16).toString("base64"),
    });
    expect(parseEncryptedTopicFrame(longIv)).toBeNull();
  });
});

describe("key lifecycle (security pass M5/M7)", () => {
  const countReceived = (db: DatabaseSync) =>
    (
      db
        .prepare(`SELECT COUNT(*) AS n FROM circle_sender_keys WHERE sender_pubkey = ?`)
        .get(SENDER) as { n: number }
    ).n;

  it("caps how many keys one sender can park on this node", () => {
    const db = openDb();
    const me = generateBoxKeyPair();
    for (let i = 0; i < MAX_KEYS_PER_SENDER + 5; i += 1) {
      const body = buildSenderKeyBody(
        { keyId: `k${i}`, keyB64: Buffer.alloc(32, i).toString("base64") },
        [{ memberPubkey: "me", boxPubkey: me.publicKeyB64 }],
      );
      expect(
        ingestSenderKeyBody(db, { circleId: CIRCLE, senderPubkey: SENDER, boxKeys: me, body }),
      ).toBe(true);
    }
    expect(countReceived(db)).toBe(MAX_KEYS_PER_SENDER);
    // The newest key survived the cap.
    const newest = db
      .prepare(`SELECT 1 FROM circle_sender_keys WHERE key_id = ?`)
      .get(`k${MAX_KEYS_PER_SENDER + 4}`);
    expect(newest).toBeDefined();
  });

  it("age-rotates the own key and purges superseded material after the grace", () => {
    const db = openDb();
    const t0 = 1_800_000_000_000;
    const k1 = getOrCreateOwnSenderKey(db, CIRCLE);
    db.prepare(`UPDATE circle_own_sender_keys SET created_at = ?`).run(t0);
    // Young key: nothing happens.
    expect(maintainSenderKeys(db, CIRCLE, t0 + 1000)).toBe(false);
    // Old key: rotates; the retired one is kept through the grace…
    const t1 = t0 + OWN_KEY_MAX_AGE_MS;
    expect(maintainSenderKeys(db, CIRCLE, t1)).toBe(true);
    expect(getOrCreateOwnSenderKey(db, CIRCLE).keyId).not.toBe(k1.keyId);
    const own = () =>
      (db.prepare(`SELECT COUNT(*) AS n FROM circle_own_sender_keys`).get() as { n: number }).n;
    expect(own()).toBe(2);
    // …and deleted after it.
    maintainSenderKeys(db, CIRCLE, t1 + RETIRED_KEY_GRACE_MS + 1);
    expect(own()).toBe(1);

    // Received keys: a superseded one goes once its successor has been held
    // for the grace; the newest is always kept.
    const ins = db.prepare(
      `INSERT INTO circle_sender_keys (circle_id, sender_pubkey, key_id, key_b64, created_at)
       VALUES (?, ?, ?, 'x', ?)`,
    );
    ins.run(CIRCLE, SENDER, "old", t0);
    ins.run(CIRCLE, SENDER, "new", t0 + 1000);
    maintainSenderKeys(db, CIRCLE, t0 + 2000);
    expect(countReceived(db)).toBe(2);
    maintainSenderKeys(db, CIRCLE, t0 + 1000 + RETIRED_KEY_GRACE_MS + 1);
    expect(countReceived(db)).toBe(1);
  });
});
