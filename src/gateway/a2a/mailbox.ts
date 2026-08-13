/**
 * PLAN-31 C1 transport: mailbox host verbs — store-and-forward for
 * asymmetric online windows (§3.2). Served by nodes with
 * circles.mailbox.serve=true (the relay fleet runs these; any node can).
 *
 *  mailbox/post — a sender deposits a sealed blob for a recipient pubkey.
 *                 Sender signature REQUIRED for acceptance; per-sender rate
 *                 limits; per-recipient quota; ~30d TTL. The blob is sealed
 *                 to the recipient's box key — this host cannot read it.
 *  mailbox/poll — the recipient (and only the recipient: fresh signature
 *                 proof) lists their pending blobs.
 *  mailbox/ack  — the recipient deletes delivered blobs.
 *
 * Proof format (domain-prefixed, replay-bounded): Ed25519 signature by the
 * claimed pubkey over `circle-mailbox/v1\n<verb>\n<pubkey>\n<ts>\n<extra>`,
 * with ts within ±300s. Post binds the blob (extra = sha256(recipient +
 * blob_json)); poll/ack bind their parameters.
 */

import type { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { A2aErrorCodes } from "./types.js";

const log = createSubsystemLogger("a2a/mailbox");

export const MAILBOX_PROOF_DOMAIN = "circle-mailbox/v1";
export const MAILBOX_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const MAILBOX_PROOF_SKEW_MS = 300_000;
export const MAX_BLOB_BYTES = 65_536;
/** Per-recipient stored-blob ceiling (count) — bounds host storage per box. */
export const RECIPIENT_QUOTA = 500;
/**
 * Per-(sender,recipient) stored-blob sub-quota. Without it, one sender —
 * or one attacker minting throwaway keypairs — could pre-fill an offline
 * recipient's entire RECIPIENT_QUOTA and wedge delivery (PLAN-36 §4
 * follow-up (a)). A full box also EVICTS the largest sender's oldest blob
 * rather than refusing new mail, so quota-stuffing only cycles the
 * stuffer's own blobs and can never block a legitimate sender.
 */
export const SENDER_RECIPIENT_QUOTA = 50;

export type MailboxError = { code: number; message: string };
export type MailboxOutcome<T> = { ok: true; result: T } | { ok: false; error: MailboxError };

function err<T>(code: number, message: string): MailboxOutcome<T> {
  return { ok: false, error: { code, message } };
}

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function verifyProof(args: {
  verb: string;
  pubkey: string;
  ts: number;
  extra: string;
  sig: string;
  now: number;
}): boolean {
  const match = /^ed25519:([0-9a-f]{64})$/.exec(args.pubkey);
  if (!match || !/^[0-9a-f]{128}$/.test(args.sig)) {
    return false;
  }
  if (typeof args.ts !== "number" || Math.abs(args.now - args.ts) > MAILBOX_PROOF_SKEW_MS) {
    return false;
  }
  try {
    const key = crypto.createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(match[1] as string, "hex")]),
      format: "der",
      type: "spki",
    });
    const preimage = Buffer.from(
      `${MAILBOX_PROOF_DOMAIN}\n${args.verb}\n${args.pubkey}\n${args.ts}\n${args.extra}`,
      "utf8",
    );
    return crypto.verify(null, preimage, key, Buffer.from(args.sig, "hex"));
  } catch {
    return false;
  }
}

/** Client-side proof builder (exported for the service + tests). */
export function buildMailboxProof(args: {
  verb: string;
  pubkey: string;
  privateKey: crypto.KeyObject;
  extra: string;
  now?: number;
}): { pubkey: string; ts: number; sig: string } {
  const ts = args.now ?? Date.now();
  const preimage = Buffer.from(
    `${MAILBOX_PROOF_DOMAIN}\n${args.verb}\n${args.pubkey}\n${ts}\n${args.extra}`,
    "utf8",
  );
  return {
    pubkey: args.pubkey,
    ts,
    sig: crypto.sign(null, preimage, args.privateKey).toString("hex"),
  };
}

export function blobDigest(recipient: string, blobJson: string): string {
  return crypto.createHash("sha256").update(`${recipient}\n${blobJson}`, "utf8").digest("hex");
}

// Per-sender sliding-window post rate limit, persisted in mailbox_post_log so
// a host restart no longer resets the window (PLAN-36 §4 follow-up (a): the
// old in-memory Map was wiped on every boot). Counts proof-verified attempts,
// so unsigned traffic can never grow the table.
export const POST_LIMIT = { windowMs: 300_000, max: 60 };

function postRateLimited(db: DatabaseSync, sender: string, now: number): boolean {
  const n = (
    db
      .prepare(`SELECT COUNT(*) AS n FROM mailbox_post_log WHERE sender_pubkey = ? AND ts > ?`)
      .get(sender, now - POST_LIMIT.windowMs) as { n: number }
  ).n;
  if (n >= POST_LIMIT.max) {
    return true;
  }
  db.prepare(`INSERT INTO mailbox_post_log (sender_pubkey, ts) VALUES (?, ?)`).run(sender, now);
  return false;
}

type Proof = { pubkey?: string; ts?: number; sig?: string };

export function handleMailboxPost(
  params: { to?: string; blob?: string; proof?: Proof },
  db: DatabaseSync,
  now: number = Date.now(),
): MailboxOutcome<{ blobId: string; expiresAt: number }> {
  const { to, blob, proof } = params;
  if (!to || !blob || !proof?.pubkey || !proof.sig || typeof proof.ts !== "number") {
    return err(A2aErrorCodes.INVALID_PARAMS, "to, blob, proof{pubkey,ts,sig} required");
  }
  if (Buffer.byteLength(blob, "utf8") > MAX_BLOB_BYTES) {
    return err(A2aErrorCodes.INVALID_PARAMS, `blob exceeds ${MAX_BLOB_BYTES} bytes`);
  }
  if (
    !verifyProof({
      verb: "post",
      pubkey: proof.pubkey,
      ts: proof.ts,
      extra: blobDigest(to, blob),
      sig: proof.sig,
      now,
    })
  ) {
    return err(A2aErrorCodes.UNAUTHORIZED, "invalid sender proof");
  }
  if (postRateLimited(db, proof.pubkey, now)) {
    return err(A2aErrorCodes.INVALID_REQUEST, "rate limited; slow down");
  }
  const senderHeld = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM mailbox_blobs WHERE recipient_pubkey = ? AND sender_pubkey = ?`,
      )
      .get(to, proof.pubkey) as { n: number }
  ).n;
  if (senderHeld >= SENDER_RECIPIENT_QUOTA) {
    return err(A2aErrorCodes.INVALID_REQUEST, "sender quota for this recipient reached");
  }
  const count = (
    db.prepare(`SELECT COUNT(*) AS n FROM mailbox_blobs WHERE recipient_pubkey = ?`).get(to) as {
      n: number;
    }
  ).n;
  if (count >= RECIPIENT_QUOTA) {
    // Anti-wedge: at the ceiling, evict the largest sender's oldest blob and
    // deliver anyway. Refusing here is what let attacker-minted keypairs
    // pre-fill an offline recipient's box and block real mail; eviction means
    // stuffing the box only ever cycles the stuffer's own blobs. (In the
    // implausible worst case of a box full of distinct single-blob senders,
    // the deterministic tie-break evicts one of them — still better than
    // wedging delivery for everyone.)
    const hog = db
      .prepare(
        `SELECT sender_pubkey AS s, COUNT(*) AS n FROM mailbox_blobs
          WHERE recipient_pubkey = ?
          GROUP BY sender_pubkey ORDER BY n DESC, s LIMIT 1`,
      )
      .get(to) as { s: string } | undefined;
    if (hog) {
      db.prepare(
        `DELETE FROM mailbox_blobs WHERE blob_id = (
           SELECT blob_id FROM mailbox_blobs
            WHERE recipient_pubkey = ? AND sender_pubkey = ?
            ORDER BY created_at ASC, blob_id LIMIT 1)`,
      ).run(to, hog.s);
    }
  }
  const blobId = crypto.randomUUID();
  const expiresAt = now + MAILBOX_TTL_MS;
  db.prepare(
    `INSERT INTO mailbox_blobs
       (blob_id, recipient_pubkey, sender_pubkey, blob_json, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(blobId, to, proof.pubkey, blob, now, expiresAt);
  return { ok: true, result: { blobId, expiresAt } };
}

export function handleMailboxPoll(
  params: { proof?: Proof; since?: number; limit?: number },
  db: DatabaseSync,
  now: number = Date.now(),
): MailboxOutcome<{
  blobs: Array<{ blobId: string; senderPubkey: string; blob: string; createdAt: number }>;
}> {
  const proof = params.proof;
  if (!proof?.pubkey || !proof.sig || typeof proof.ts !== "number") {
    return err(A2aErrorCodes.INVALID_PARAMS, "proof{pubkey,ts,sig} required");
  }
  const since = typeof params.since === "number" ? params.since : 0;
  if (
    !verifyProof({
      verb: "poll",
      pubkey: proof.pubkey,
      ts: proof.ts,
      extra: String(since),
      sig: proof.sig,
      now,
    })
  ) {
    return err(A2aErrorCodes.UNAUTHORIZED, "invalid recipient proof");
  }
  const limit = Math.min(typeof params.limit === "number" ? params.limit : 100, 200);
  const rows = db
    .prepare(
      `SELECT blob_id, sender_pubkey, blob_json, created_at
         FROM mailbox_blobs
        WHERE recipient_pubkey = ? AND created_at > ? AND expires_at > ?
        ORDER BY created_at ASC LIMIT ?`,
    )
    .all(proof.pubkey, since, now, limit) as unknown as Array<{
    blob_id: string;
    sender_pubkey: string;
    blob_json: string;
    created_at: number;
  }>;
  return {
    ok: true,
    result: {
      blobs: rows.map((r) => ({
        blobId: r.blob_id,
        senderPubkey: r.sender_pubkey,
        blob: r.blob_json,
        createdAt: r.created_at,
      })),
    },
  };
}

export function handleMailboxAck(
  params: { proof?: Proof; blobIds?: string[] },
  db: DatabaseSync,
  now: number = Date.now(),
): MailboxOutcome<{ deleted: number }> {
  const proof = params.proof;
  const blobIds = Array.isArray(params.blobIds)
    ? params.blobIds.filter((b): b is string => typeof b === "string").slice(0, 200)
    : [];
  if (!proof?.pubkey || !proof.sig || typeof proof.ts !== "number" || blobIds.length === 0) {
    return err(A2aErrorCodes.INVALID_PARAMS, "proof{pubkey,ts,sig}, blobIds required");
  }
  if (
    !verifyProof({
      verb: "ack",
      pubkey: proof.pubkey,
      ts: proof.ts,
      extra: blobIds.join(","),
      sig: proof.sig,
      now,
    })
  ) {
    return err(A2aErrorCodes.UNAUTHORIZED, "invalid recipient proof");
  }
  let deleted = 0;
  const stmt = db.prepare(`DELETE FROM mailbox_blobs WHERE blob_id = ? AND recipient_pubkey = ?`);
  for (const id of blobIds) {
    deleted += Number(stmt.run(id, proof.pubkey).changes);
  }
  return { ok: true, result: { deleted } };
}

/** TTL sweep — run from the maintenance tick on serving nodes. */
export function sweepExpiredMailboxBlobs(db: DatabaseSync, now: number = Date.now()): number {
  // Rate-window rows outside the sliding window are dead weight; prune them
  // alongside the blob sweep so the log stays bounded by recent traffic.
  db.prepare(`DELETE FROM mailbox_post_log WHERE ts <= ?`).run(now - POST_LIMIT.windowMs);
  const res = db.prepare(`DELETE FROM mailbox_blobs WHERE expires_at <= ?`).run(now);
  const n = Number(res.changes);
  if (n > 0) {
    log.debug(`mailbox sweep: purged ${n} expired blob(s)`);
  }
  return n;
}

export function handleMailboxMethod(
  method: string,
  params: unknown,
  db: DatabaseSync,
  now: number = Date.now(),
): MailboxOutcome<unknown> {
  const p = (params ?? {}) as Record<string, unknown>;
  switch (method) {
    case "mailbox/post":
      return handleMailboxPost(p as Parameters<typeof handleMailboxPost>[0], db, now);
    case "mailbox/poll":
      return handleMailboxPoll(p as Parameters<typeof handleMailboxPoll>[0], db, now);
    case "mailbox/ack":
      return handleMailboxAck(p as Parameters<typeof handleMailboxAck>[0], db, now);
    default:
      return err(A2aErrorCodes.METHOD_NOT_FOUND, `Unknown mailbox method: ${method}`);
  }
}
