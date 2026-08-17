/**
 * Stage 2 of the circles P2P transport plan: per-circle SENDER KEYS — the
 * confidentiality layer for the gossip-topic path.
 *
 * Design (Signal-style sender keys, adapted to node-local rosters): every
 * member encrypts mesh frames with their OWN symmetric sending key, and
 * distributes that key sealed to each member's X25519 box key over the
 * reliable HTTP paths (direct dial + mailbox — never the topic itself).
 * Receivers store per-(circle, sender, keyId) keys and decrypt on arrival.
 *
 * Why sender keys and not one group key: a circle has NO authority — rosters
 * are node-local, any member can mint invites, and removal is per-node
 * informed consent (PLAN-31 §5.5). A single group key would need a key
 * authority or consensus; sender keys need neither. Each node governs its own
 * key exactly as it governs its own roster:
 *  - a member who processes a removal ROTATES their sender key and
 *    redistributes to the remaining members, so the evictee cannot read THAT
 *    member's future mesh frames.
 *  - a new member is sent each existing member's CURRENT key (no rotation on
 *    add — a joiner is deliberately given current context, same as chat
 *    history semantics).
 *
 * HONEST LIMIT of removal read-exclusion: it is PER-NODE and only as complete
 * as the removal propagates. `removeMember` rotates only the removing node's
 * key; another member's key rotates only once THAT member also removes the
 * evictee on their own node (removal is informed consent, not global
 * revocation — PLAN-31 §5.5). So immediately after one node evicts, the
 * evictee can still read the OTHER members' frames until each of them acts.
 * There is no mechanism that forces the others to rotate.
 *
 * The gossip TOPIC name stays keyed by key_epoch exactly as before (naming,
 * not encryption) — this layer is deliberately orthogonal, so it introduces
 * no topic-desync risk (§5.5 F2/F3 stands).
 *
 * Frames: AES-256-GCM over the plaintext topic frame, with the blinded topic
 * id as AAD (a frame lifted from one topic cannot be replayed onto another).
 * Wrapper: { enc: 1, s: <senderPubkey>, k: <keyId>, iv, ct, tag }.
 * Receivers accept BOTH encrypted and legacy plaintext frames during the
 * fleet transition (the mesh is additive and default-off; plaintext
 * acceptance is the status quo, not a regression). Sender-key material lives
 * as base64 in the circles sqlite (`circle_own_sender_keys` /
 * `circle_sender_keys`). NOTE: that DB is NOT chmod'd 0600 the way
 * `identity/box.json` is — it lands at the process umask (typically 0644). So
 * the custody is the DB file's, which today is WEAKER than the box key's, not
 * equal. Tightening the DB perms (or wrapping key_b64 under the box key) is a
 * tracked follow-up (security pass M6).
 */

import type { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { openBox, sealToBox, type BoxKeyPair, type SealedBlob } from "./box-crypto.js";

const log = createSubsystemLogger("circles/sender-keys");

/** Encrypted topic-frame wrapper (JSON on the wire, base64 fields). */
export type EncryptedTopicFrame = {
  enc: 1;
  /** Sender's circle identity (ed25519:<hex>) — the key lookup handle. */
  s: string;
  /** Sender key id. */
  k: string;
  iv: string;
  ct: string;
  tag: string;
};

export type OwnSenderKey = { keyId: string; keyB64: string };

// ---------------------------------------------------------------------------
// Own sending keys
// ---------------------------------------------------------------------------

/** Current (non-retired) sending key for a circle, creating one if absent. */
export function getOrCreateOwnSenderKey(db: DatabaseSync, circleId: string): OwnSenderKey {
  const row = db
    .prepare(
      `SELECT key_id, key_b64 FROM circle_own_sender_keys
        WHERE circle_id = ? AND retired_at IS NULL
        ORDER BY created_at DESC LIMIT 1`,
    )
    .get(circleId) as { key_id: string; key_b64: string } | undefined;
  if (row) {
    return { keyId: row.key_id, keyB64: row.key_b64 };
  }
  const fresh: OwnSenderKey = {
    keyId: crypto.randomUUID(),
    keyB64: crypto.randomBytes(32).toString("base64"),
  };
  db.prepare(
    `INSERT INTO circle_own_sender_keys (circle_id, key_id, key_b64, created_at, delivered_json)
     VALUES (?, ?, ?, ?, '[]')`,
  ).run(circleId, fresh.keyId, fresh.keyB64, Date.now());
  return fresh;
}

/**
 * Rotate the sending key for a circle (call when THIS node removes a member:
 * the evictee must not read this node's future mesh frames). The old key is
 * retired, not deleted — peers may still have frames in flight.
 */
export function rotateOwnSenderKey(db: DatabaseSync, circleId: string): OwnSenderKey {
  db.prepare(
    `UPDATE circle_own_sender_keys SET retired_at = ? WHERE circle_id = ? AND retired_at IS NULL`,
  ).run(Date.now(), circleId);
  return getOrCreateOwnSenderKey(db, circleId);
}

/** Members already sent the current key (delivery bookkeeping). */
export function deliveredMembers(db: DatabaseSync, circleId: string, keyId: string): Set<string> {
  const row = db
    .prepare(`SELECT delivered_json FROM circle_own_sender_keys WHERE circle_id = ? AND key_id = ?`)
    .get(circleId, keyId) as { delivered_json: string } | undefined;
  try {
    const arr = JSON.parse(row?.delivered_json ?? "[]") as unknown;
    return new Set(Array.isArray(arr) ? arr.filter((m): m is string => typeof m === "string") : []);
  } catch {
    return new Set();
  }
}

export function markDelivered(
  db: DatabaseSync,
  circleId: string,
  keyId: string,
  members: string[],
): void {
  if (members.length === 0) return;
  const merged = deliveredMembers(db, circleId, keyId);
  for (const m of members) merged.add(m);
  db.prepare(
    `UPDATE circle_own_sender_keys SET delivered_json = ? WHERE circle_id = ? AND key_id = ?`,
  ).run(JSON.stringify([...merged].toSorted()), circleId, keyId);
}

// ---------------------------------------------------------------------------
// Distribution bodies (ride signed circle envelopes over HTTP dial/mailbox)
// ---------------------------------------------------------------------------

/**
 * Build the body of a `circle/sender_key` envelope: the key sealed to each
 * recipient's box key. Only members WITH a box pubkey can receive one —
 * members without stay on plaintext-HTTP delivery and simply cannot read
 * this sender's mesh frames (which are additive anyway).
 */
export function buildSenderKeyBody(
  key: OwnSenderKey,
  recipients: Array<{ memberPubkey: string; boxPubkey: string }>,
): { key_id: string; sealed: Record<string, SealedBlob> } {
  const sealed: Record<string, SealedBlob> = {};
  for (const r of recipients) {
    try {
      sealed[r.memberPubkey] = sealToBox(r.boxPubkey, key.keyB64);
    } catch (err) {
      log.debug(`sender-key seal for ${r.memberPubkey.slice(0, 24)}… failed: ${String(err)}`);
    }
  }
  return { key_id: key.keyId, sealed };
}

/**
 * Ingest a received `circle/sender_key` body: try to open each sealed entry
 * with OUR box key (a sealed box for someone else fails cleanly, so no
 * self-pubkey bookkeeping is needed) and store the sender's key. Idempotent
 * on (circle, sender, keyId). Bounded: a body may carry at most one entry
 * per roster member, and the roster is capped, but a hostile sender could
 * pad the map — cap the attempts.
 */
const MAX_SEALED_ENTRIES = 32;

export function ingestSenderKeyBody(
  db: DatabaseSync,
  args: {
    circleId: string;
    senderPubkey: string;
    boxKeys: BoxKeyPair;
    body: { key_id?: unknown; sealed?: unknown };
  },
): boolean {
  const keyId = typeof args.body.key_id === "string" ? args.body.key_id : "";
  const sealed = (args.body.sealed ?? {}) as Record<string, SealedBlob>;
  if (!keyId || keyId.length > 64 || typeof sealed !== "object") {
    return false;
  }
  for (const blob of Object.values(sealed).slice(0, MAX_SEALED_ENTRIES)) {
    const keyB64 = openBox(args.boxKeys, blob);
    if (keyB64 && Buffer.from(keyB64, "base64").length === 32) {
      db.prepare(
        `INSERT INTO circle_sender_keys (circle_id, sender_pubkey, key_id, key_b64, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(circle_id, sender_pubkey, key_id) DO NOTHING`,
      ).run(args.circleId, args.senderPubkey, keyId, keyB64, Date.now());
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Frame encryption
// ---------------------------------------------------------------------------

export function encryptTopicFrame(args: {
  topicId: string;
  frameJson: string;
  senderPubkey: string;
  key: OwnSenderKey;
}): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", Buffer.from(args.key.keyB64, "base64"), iv);
  cipher.setAAD(Buffer.from(args.topicId, "utf8"));
  const ct = Buffer.concat([cipher.update(args.frameJson, "utf8"), cipher.final()]);
  const wrapper: EncryptedTopicFrame = {
    enc: 1,
    s: args.senderPubkey,
    k: args.key.keyId,
    iv: iv.toString("base64"),
    ct: ct.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  };
  return JSON.stringify(wrapper);
}

/** Parse a frame as the encrypted wrapper, or null when it is not one. */
export function parseEncryptedTopicFrame(frameJson: string): EncryptedTopicFrame | null {
  try {
    const v = JSON.parse(frameJson) as EncryptedTopicFrame;
    if (
      v?.enc === 1 &&
      typeof v.s === "string" &&
      v.s.length <= 80 &&
      typeof v.k === "string" &&
      v.k.length <= 64 &&
      typeof v.iv === "string" &&
      typeof v.ct === "string" &&
      typeof v.tag === "string" &&
      // Pin the GCM parameters: a 96-bit IV (the fast, unique-by-random path
      // the nonce argument relies on) and a full 128-bit tag. Node's
      // setAuthTag otherwise accepts a 4-byte tag and validates it,
      // downgrading forgery resistance from 2^128 to 2^32 (security pass M1).
      Buffer.from(v.iv, "base64").length === 12 &&
      Buffer.from(v.tag, "base64").length === 16
    ) {
      return v;
    }
  } catch {
    // not JSON — definitely not ours
  }
  return null;
}

/**
 * Decrypt an encrypted topic frame using the stored key for (circle, sender,
 * keyId). Returns the inner plaintext frame JSON, or null (no key yet /
 * tamper / wrong topic) — callers drop at debug; the HTTP copy delivers.
 */
export function decryptTopicFrame(
  db: DatabaseSync,
  args: { circleId: string; topicId: string; wrapper: EncryptedTopicFrame },
): string | null {
  const row = db
    .prepare(
      `SELECT key_b64 FROM circle_sender_keys
        WHERE circle_id = ? AND sender_pubkey = ? AND key_id = ?`,
    )
    .get(args.circleId, args.wrapper.s, args.wrapper.k) as { key_b64: string } | undefined;
  if (!row) {
    return null;
  }
  try {
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      Buffer.from(row.key_b64, "base64"),
      Buffer.from(args.wrapper.iv, "base64"),
      { authTagLength: 16 },
    );
    decipher.setAAD(Buffer.from(args.topicId, "utf8"));
    decipher.setAuthTag(Buffer.from(args.wrapper.tag, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(args.wrapper.ct, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    return null;
  }
}
