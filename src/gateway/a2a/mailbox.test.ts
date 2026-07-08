import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { generateKeyPair, pubkeyId, type KeyPair } from "../../commerce/envelope.js";
import { ensureMemoryIndexSchema } from "../../memory/memory-schema.js";
import { runMigrations } from "../../memory/migrations.js";
import {
  MAILBOX_TTL_MS,
  RECIPIENT_QUOTA,
  blobDigest,
  buildMailboxProof,
  handleMailboxMethod,
  resetMailboxRateLimits,
  sweepExpiredMailboxBlobs,
} from "./mailbox.js";

// PLAN-31 C1 §3.2 host verbs: sender-signature required for post, only the
// recipient polls/acks, quotas, TTL sweep. The host never inspects blob
// contents — they are opaque strings here by design.

const NOW = 1_800_000_000_000;

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

describe("mailbox host verbs", () => {
  let db: DatabaseSync;
  let sender: KeyPair;
  let recipient: KeyPair;

  beforeEach(() => {
    resetMailboxRateLimits();
    db = openDb();
    sender = generateKeyPair();
    recipient = generateKeyPair();
  });

  function post(blob = `{"sealed":"blob"}`, now = NOW) {
    const to = pubkeyId(recipient);
    const proof = buildMailboxProof({
      verb: "post",
      pubkey: pubkeyId(sender),
      privateKey: sender.privateKey,
      extra: blobDigest(to, blob),
      now,
    });
    return handleMailboxMethod("mailbox/post", { to, blob, proof }, db, now);
  }

  function poll(key: KeyPair = recipient, now = NOW + 1000) {
    const proof = buildMailboxProof({
      verb: "poll",
      pubkey: pubkeyId(key),
      privateKey: key.privateKey,
      extra: "0",
      now,
    });
    return handleMailboxMethod("mailbox/poll", { proof, since: 0 }, db, now);
  }

  it("accepts a signed post and serves it only to the recipient", () => {
    expect(post().ok).toBe(true);
    const mine = poll();
    expect(mine.ok).toBe(true);
    if (mine.ok) {
      const blobs = (mine.result as { blobs: Array<{ senderPubkey: string }> }).blobs;
      expect(blobs).toHaveLength(1);
      expect(blobs[0]?.senderPubkey).toBe(pubkeyId(sender));
    }
    // A third party polling gets an empty box, not the recipient's mail.
    const eve = generateKeyPair();
    const theirs = poll(eve);
    expect(theirs.ok).toBe(true);
    if (theirs.ok) {
      expect((theirs.result as { blobs: unknown[] }).blobs).toHaveLength(0);
    }
  });

  it("refuses posts with a bad or stale proof", () => {
    const to = pubkeyId(recipient);
    const blob = `{"sealed":"x"}`;
    // Signature over a DIFFERENT blob.
    const proof = buildMailboxProof({
      verb: "post",
      pubkey: pubkeyId(sender),
      privateKey: sender.privateKey,
      extra: blobDigest(to, "other-blob"),
      now: NOW,
    });
    const swapped = handleMailboxMethod("mailbox/post", { to, blob, proof }, db, NOW);
    expect(swapped.ok).toBe(false);
    // Stale timestamp (older than the 300s proof window).
    const stale = buildMailboxProof({
      verb: "post",
      pubkey: pubkeyId(sender),
      privateKey: sender.privateKey,
      extra: blobDigest(to, blob),
      now: NOW - 600_000,
    });
    expect(handleMailboxMethod("mailbox/post", { to, blob, proof: stale }, db, NOW).ok).toBe(false);
  });

  it("acks delete only the recipient's own blobs", () => {
    expect(post().ok).toBe(true);
    const listed = poll();
    if (!listed.ok) throw new Error("poll failed");
    const blobId = (listed.result as { blobs: Array<{ blobId: string }> }).blobs[0]
      ?.blobId as string;

    // Eve cannot ack someone else's mail.
    const eve = generateKeyPair();
    const eveProof = buildMailboxProof({
      verb: "ack",
      pubkey: pubkeyId(eve),
      privateKey: eve.privateKey,
      extra: blobId,
      now: NOW + 1000,
    });
    const eveAck = handleMailboxMethod(
      "mailbox/ack",
      { proof: eveProof, blobIds: [blobId] },
      db,
      NOW + 1000,
    );
    expect(eveAck.ok).toBe(true);
    if (eveAck.ok) expect((eveAck.result as { deleted: number }).deleted).toBe(0);

    const proof = buildMailboxProof({
      verb: "ack",
      pubkey: pubkeyId(recipient),
      privateKey: recipient.privateKey,
      extra: blobId,
      now: NOW + 1000,
    });
    const ack = handleMailboxMethod("mailbox/ack", { proof, blobIds: [blobId] }, db, NOW + 1000);
    expect(ack.ok).toBe(true);
    if (ack.ok) expect((ack.result as { deleted: number }).deleted).toBe(1);
  });

  it("enforces the recipient quota", () => {
    const seed = db.prepare(
      `INSERT INTO mailbox_blobs (blob_id, recipient_pubkey, sender_pubkey, blob_json, created_at, expires_at)
       VALUES (?, ?, 'ed25519:seed', '{}', ?, ?)`,
    );
    for (let i = 0; i < RECIPIENT_QUOTA; i++) {
      seed.run(`seed-${i}`, pubkeyId(recipient), NOW, NOW + MAILBOX_TTL_MS);
    }
    const full = post();
    expect(full.ok).toBe(false);
    if (!full.ok) expect(full.error.message).toMatch(/full/);
  });

  it("sweeps expired blobs", () => {
    expect(post().ok).toBe(true);
    expect(sweepExpiredMailboxBlobs(db, NOW + MAILBOX_TTL_MS + 1)).toBe(1);
    const after = poll(recipient, NOW + MAILBOX_TTL_MS + 2000);
    expect(after.ok).toBe(true);
    if (after.ok) expect((after.result as { blobs: unknown[] }).blobs).toHaveLength(0);
  });
});
