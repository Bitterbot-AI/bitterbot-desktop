import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { generateKeyPair, pubkeyId, type KeyPair } from "../../commerce/envelope.js";
import { ensureMemoryIndexSchema } from "../../memory/memory-schema.js";
import { runMigrations } from "../../memory/migrations.js";
import {
  MAILBOX_TTL_MS,
  POST_LIMIT,
  RECIPIENT_QUOTA,
  SENDER_RECIPIENT_QUOTA,
  blobDigest,
  buildMailboxProof,
  handleMailboxMethod,
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
    // The post-rate window lives in the database (mailbox_post_log), so a
    // fresh in-memory db per test is a full limiter reset.
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

  it("evicts the largest sender's oldest blob at the ceiling instead of wedging", () => {
    // An attacker (one sender key — or many; the hog query finds the largest)
    // pre-fills the recipient's entire quota. The old behavior refused all new
    // mail, wedging delivery. Now the legitimate post lands and only the
    // stuffer's own oldest blob is cycled out.
    const seed = db.prepare(
      `INSERT INTO mailbox_blobs (blob_id, recipient_pubkey, sender_pubkey, blob_json, created_at, expires_at)
       VALUES (?, ?, 'ed25519:attacker', '{}', ?, ?)`,
    );
    for (let i = 0; i < RECIPIENT_QUOTA; i++) {
      seed.run(`seed-${i}`, pubkeyId(recipient), NOW + i, NOW + MAILBOX_TTL_MS);
    }
    const delivered = post();
    expect(delivered.ok).toBe(true);
    // Storage stays bounded at the ceiling.
    const total = (
      db
        .prepare(`SELECT COUNT(*) AS n FROM mailbox_blobs WHERE recipient_pubkey = ?`)
        .get(pubkeyId(recipient)) as { n: number }
    ).n;
    expect(total).toBe(RECIPIENT_QUOTA);
    // The evicted blob is the attacker's oldest, not anyone else's mail.
    const oldest = db.prepare(`SELECT blob_id FROM mailbox_blobs WHERE blob_id = 'seed-0'`).get();
    expect(oldest).toBeUndefined();
    // The recipient actually receives the legitimate message.
    const mine = poll();
    expect(mine.ok).toBe(true);
    if (mine.ok) {
      const senders = (mine.result as { blobs: Array<{ senderPubkey: string }> }).blobs.map(
        (b) => b.senderPubkey,
      );
      expect(senders).toContain(pubkeyId(sender));
    }
  });

  it("refuses a sender who is over their per-recipient sub-quota", () => {
    const seed = db.prepare(
      `INSERT INTO mailbox_blobs (blob_id, recipient_pubkey, sender_pubkey, blob_json, created_at, expires_at)
       VALUES (?, ?, ?, '{}', ?, ?)`,
    );
    for (let i = 0; i < SENDER_RECIPIENT_QUOTA; i++) {
      seed.run(`mine-${i}`, pubkeyId(recipient), pubkeyId(sender), NOW, NOW + MAILBOX_TTL_MS);
    }
    const refused = post();
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.message).toMatch(/sender quota/);
    // A different sender is unaffected — the box is nowhere near the ceiling.
    const other = generateKeyPair();
    const to = pubkeyId(recipient);
    const blob = `{"sealed":"other"}`;
    const proof = buildMailboxProof({
      verb: "post",
      pubkey: pubkeyId(other),
      privateKey: other.privateKey,
      extra: blobDigest(to, blob),
      now: NOW,
    });
    expect(handleMailboxMethod("mailbox/post", { to, blob, proof }, db, NOW).ok).toBe(true);
  });

  it("rate-limits posts through a window persisted in the database", () => {
    // Distinct recipients per post: the rate window is per-SENDER, and a
    // single recipient would trip the per-recipient sub-quota (50) first.
    const postTo = (i: number, now = NOW) => {
      const to = pubkeyId(generateKeyPair());
      const blob = `{"sealed":"blob-${i}"}`;
      const proof = buildMailboxProof({
        verb: "post",
        pubkey: pubkeyId(sender),
        privateKey: sender.privateKey,
        extra: blobDigest(to, blob),
        now,
      });
      return handleMailboxMethod("mailbox/post", { to, blob, proof }, db, now);
    };
    for (let i = 0; i < POST_LIMIT.max; i++) {
      expect(postTo(i).ok).toBe(true);
    }
    // The 61st verified post inside the window is refused…
    const over = postTo(POST_LIMIT.max);
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.error.message).toMatch(/rate limited/);
    // …and the window state is rows in mailbox_post_log, not process memory —
    // a host restart (new process, same db file) keeps refusing.
    const logged = (
      db
        .prepare(`SELECT COUNT(*) AS n FROM mailbox_post_log WHERE sender_pubkey = ?`)
        .get(pubkeyId(sender)) as { n: number }
    ).n;
    expect(logged).toBe(POST_LIMIT.max);
    // Once the window slides past, posting resumes.
    const later = NOW + POST_LIMIT.windowMs + 1;
    expect(post(`{"sealed":"after-window"}`, later).ok).toBe(true);
    // The sweep prunes stale window rows so the log stays bounded.
    sweepExpiredMailboxBlobs(db, later + POST_LIMIT.windowMs + 1);
    const remaining = (
      db.prepare(`SELECT COUNT(*) AS n FROM mailbox_post_log`).get() as { n: number }
    ).n;
    expect(remaining).toBe(0);
  });

  it("sweeps expired blobs", () => {
    expect(post().ok).toBe(true);
    expect(sweepExpiredMailboxBlobs(db, NOW + MAILBOX_TTL_MS + 1)).toBe(1);
    const after = poll(recipient, NOW + MAILBOX_TTL_MS + 2000);
    expect(after.ok).toBe(true);
    if (after.ok) expect((after.result as { blobs: unknown[] }).blobs).toHaveLength(0);
  });
});
