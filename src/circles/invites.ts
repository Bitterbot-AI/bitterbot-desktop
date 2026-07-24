/**
 * PLAN-31 C1: circle invites — the product's atom is the accepted invite.
 *
 * Flow (section 4.1):
 *  1. The inviter's human creates an invite (a deliberate act — that IS the
 *     inviter-side consent). We mint a random secret, store ONLY its sha256
 *     at rest, and package a signed `invite` envelope + the secret into a
 *     compact code the human shares (URL wrapping comes with the guest page).
 *  2. The invitee's node parses the code, verifies the inviter's signature
 *     BEFORE dialing anything, shows the human who is asking (invitee-side
 *     consent), then calls `circle/join` on the inviter's node with the
 *     secret + a signed `join` envelope.
 *  3. The inviter's node checks hash/expiry/uses, adds the member (bumping
 *     the key epoch), and returns the roster so both sides hold the same
 *     membership view.
 *
 * Security posture: the secret never exists at rest on the inviter's node;
 * a leaked database cannot forge redemptions. The invite envelope pins the
 * circle id, scopes, and expiry under the inviter's signature, so the code
 * cannot be upgraded in transit. Redemption is default single-use.
 */

import type { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
import type { KeyPair } from "../commerce/envelope.js";
import type { JsonValue } from "../commerce/sku.js";
import type { CircleScope } from "../memory/circles-store.js";
import { makeCircleEnvelope, validateCircleEnvelope, type CircleEnvelope } from "./envelope.js";

/** Default invite lifetime: 7 days (a social ask, not a session token). */
export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const INVITE_CODE_PREFIX = "bbc1";

/**
 * Guest-JOIN page base (PLAN-36 §4). An invite becomes a shareable link
 * `${GUEST_JOIN_URL}#<code>` — the code rides the URL FRAGMENT, which browsers
 * never send to the server, so the hosting page's server never sees the secret;
 * only the page's client-side JS (running for the invitee) reads it.
 */
export const GUEST_JOIN_URL = "https://join.bitterbot.ai/i";

/** Wrap an invite code as its shareable guest-JOIN link. */
export function inviteLink(code: string): string {
  return `${GUEST_JOIN_URL}#${code}`;
}

export type InviteRecord = {
  inviteId: string;
  circleId: string;
  inviterPubkey: string;
  scopes: CircleScope[];
  maxUses: number;
  uses: number;
  expiresAt: number;
  status: "open" | "exhausted" | "revoked";
};

function sha256Hex(input: string): string {
  return crypto.createHash("sha256").update(input, "utf8").digest("hex");
}

function b64url(buf: Buffer): string {
  return buf.toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

function b64urlDecode(input: string): Buffer {
  const normalized = input.replaceAll("-", "+").replaceAll("_", "/");
  return Buffer.from(normalized + "=".repeat((4 - (normalized.length % 4)) % 4), "base64");
}

export type CreateInviteArgs = {
  circleId: string;
  circleName: string;
  circleKind: string;
  inviterKey: KeyPair;
  inviterName?: string;
  /**
   * The inviter's direct a2a URL (fast path). Optional as of §4: a node with no
   * reachable URL can still invite by advertising its mailbox rendezvous below.
   * At least one of {inviterA2aUrl, (inviterMailboxUrl + inviterBoxPubkey)} must
   * be present or the invitee would have no way to reach back.
   */
  inviterA2aUrl?: string;
  /** Where the invitee drops a sealed join request when direct dial is out (§4). */
  inviterMailboxUrl?: string;
  /** The inviter's X25519 box pubkey, so the invitee can seal that request. */
  inviterBoxPubkey?: string;
  /**
   * Bind redemption to ONE pubkey (the "send to someone I know" path). A
   * bound code is useless to an interceptor or a co-member of the delivery
   * circle: redeemInvite refuses any other presenter, checked against the
   * join envelope's SIGNATURE-VERIFIED author key.
   */
  targetPubkey?: string;
  scopes: CircleScope[];
  maxUses?: number;
  ttlMs?: number;
  now?: number;
};

export type CreatedInvite = {
  inviteId: string;
  /** The shareable code. Contains the secret — show once, never persist. */
  code: string;
  expiresAt: number;
};

/**
 * Mint an invite: DB row holds sha256(secret) only; the returned code holds
 * the signed invite envelope + secret.
 */
export function createInvite(db: DatabaseSync, args: CreateInviteArgs): CreatedInvite {
  const now = args.now ?? Date.now();
  const inviteId = crypto.randomUUID();
  const secret = b64url(crypto.randomBytes(32));
  const expiresAt = now + (args.ttlMs ?? INVITE_TTL_MS);

  db.prepare(
    `INSERT INTO circle_invites
       (invite_id, circle_id, inviter_pubkey, token_hash, scopes_json, max_uses, uses,
        expires_at, status, created_at, target_pubkey)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?, 'open', ?, ?)`,
  ).run(
    inviteId,
    args.circleId,
    `ed25519:${args.inviterKey.publicKeyHex}`,
    sha256Hex(secret),
    JSON.stringify(args.scopes),
    args.maxUses ?? 1,
    expiresAt,
    now,
    args.targetPubkey ?? null,
  );

  const envelope = makeCircleEnvelope(
    "invite",
    args.circleId,
    {
      invite_id: inviteId,
      circle_name: args.circleName,
      circle_kind: args.circleKind,
      inviter_name: args.inviterName ?? null,
      inviter_a2a_url: args.inviterA2aUrl ?? null,
      // §4 mailbox rendezvous: lets the invitee reach back when the inviter has
      // no reachable a2a URL (or is offline at join time).
      inviter_mailbox_url: args.inviterMailboxUrl ?? null,
      inviter_box_pubkey: args.inviterBoxPubkey ?? null,
      scopes: args.scopes as unknown as JsonValue,
      expires_at: expiresAt,
    },
    args.inviterKey,
    Math.floor(now / 1000),
  );

  const code = `${INVITE_CODE_PREFIX}.${b64url(
    Buffer.from(JSON.stringify({ env: envelope, secret }), "utf8"),
  )}`;
  return { inviteId, code, expiresAt };
}

export type ParsedInvite = {
  envelope: CircleEnvelope;
  secret: string;
  inviteId: string;
  circleId: string;
  circleName: string;
  circleKind: string;
  inviterPubkey: string;
  inviterName: string | null;
  /** Direct a2a URL, or "" when the inviter is mailbox-only (§4). */
  inviterA2aUrl: string;
  /** Mailbox rendezvous for reaching an unreachable/offline inviter (§4). */
  inviterMailboxUrl: string;
  /** The inviter's box pubkey, to seal the mailbox join request (§4). */
  inviterBoxPubkey: string;
  scopes: CircleScope[];
  expiresAt: number;
};

/**
 * Parse + verify an invite code on the invitee side. Signature and shape are
 * checked BEFORE any network dial — a malformed or forged code never causes
 * an outbound request. Freshness is checked against the embedded expiry (the
 * envelope ts is creation time; invites legitimately outlive the direct-call
 * skew window).
 */
/** Clamp attacker-authored display text: 64 printable chars, no control codes. */
function sanitizeInviterName(raw: string): string | null {
  let out = "";
  for (const ch of raw) {
    const c = ch.codePointAt(0) ?? 0;
    out += c < 32 || c === 127 ? " " : ch;
  }
  return out.trim().slice(0, 64) || null;
}

export function parseInviteCode(
  code: string,
  now: number = Date.now(),
): { ok: true; invite: ParsedInvite } | { ok: false; error: string } {
  const parts = code.trim().split(".");
  if (parts.length !== 2 || parts[0] !== INVITE_CODE_PREFIX) {
    return { ok: false, error: "not a circle invite code" };
  }
  let parsed: { env?: CircleEnvelope; secret?: string };
  try {
    parsed = JSON.parse(b64urlDecode(parts[1] as string).toString("utf8")) as {
      env?: CircleEnvelope;
      secret?: string;
    };
  } catch {
    return { ok: false, error: "malformed invite code" };
  }
  const env = parsed.env;
  if (!env || typeof parsed.secret !== "string" || parsed.secret.length < 16) {
    return { ok: false, error: "malformed invite code" };
  }
  const validation = validateCircleEnvelope(env, {
    now: Math.floor(now / 1000),
    expectedType: "invite",
    // Invites are valid for their whole TTL; expiry enforced below.
    maxSkewSeconds: Math.ceil(INVITE_TTL_MS / 1000) * 5,
  });
  if (!validation.ok) {
    return { ok: false, error: `invalid invite envelope: ${validation.error}` };
  }
  const body = env.body as Record<string, unknown>;
  const expiresAt = typeof body.expires_at === "number" ? body.expires_at : 0;
  if (expiresAt <= now) {
    return { ok: false, error: "invite expired" };
  }
  const inviteId = typeof body.invite_id === "string" ? body.invite_id : "";
  const httpUrl = (v: unknown): string =>
    typeof v === "string" && /^https?:\/\//.test(v) ? v : "";
  const inviterA2aUrl = httpUrl(body.inviter_a2a_url);
  const inviterMailboxUrl = httpUrl(body.inviter_mailbox_url);
  const inviterBoxPubkey =
    typeof body.inviter_box_pubkey === "string" && body.inviter_box_pubkey.length <= 64
      ? body.inviter_box_pubkey
      : "";
  // The invitee must have SOME way to reach back: a direct URL, or a mailbox
  // rendezvous (URL + the inviter's box key to seal the request to).
  const hasMailboxRendezvous = inviterMailboxUrl !== "" && inviterBoxPubkey !== "";
  if (!inviteId || (inviterA2aUrl === "" && !hasMailboxRendezvous)) {
    return { ok: false, error: "malformed invite body" };
  }
  const scopes = Array.isArray(body.scopes)
    ? (body.scopes as unknown[]).filter((s): s is string => typeof s === "string")
    : [];
  return {
    ok: true,
    invite: {
      envelope: env,
      secret: parsed.secret,
      inviteId,
      circleId: env.circle_id,
      circleName: typeof body.circle_name === "string" ? body.circle_name : "circle",
      circleKind: typeof body.circle_kind === "string" ? body.circle_kind : "connection",
      inviterPubkey: env.author_pubkey,
      // Attacker-authored display text rendered in the join confirm (review #3):
      // clamp to 64 chars and strip control characters so a crafted name cannot
      // visually forge a fingerprint line or multi-line "trusted" claims.
      inviterName:
        typeof body.inviter_name === "string" ? sanitizeInviterName(body.inviter_name) : null,
      inviterA2aUrl,
      inviterMailboxUrl,
      inviterBoxPubkey,
      scopes,
      expiresAt,
    },
  };
}

export type RedeemOutcome =
  | { ok: true; record: InviteRecord; rejoin: boolean }
  | { ok: false; error: string };

/**
 * Server-side (inviter node) redemption check + consume. Pure DB logic; the
 * A2A layer validates the join envelope and performs the membership write.
 * `rejoin: true` means the presenter is already an active member re-running
 * the ceremony (a refresh, e.g. new a2aUrl) — allowed without consuming a
 * use so a flaky first run can't burn the invite.
 */
export function redeemInvite(
  db: DatabaseSync,
  args: {
    inviteId: string;
    secret: string;
    presenterPubkey: string;
    presenterIsActiveMember: boolean;
    now?: number;
  },
): RedeemOutcome {
  const now = args.now ?? Date.now();
  const row = db
    .prepare(
      `SELECT invite_id, circle_id, inviter_pubkey, token_hash, scopes_json, max_uses, uses,
              expires_at, status, target_pubkey
         FROM circle_invites WHERE invite_id = ?`,
    )
    .get(args.inviteId) as
    | {
        invite_id: string;
        circle_id: string;
        inviter_pubkey: string;
        token_hash: string;
        scopes_json: string;
        max_uses: number;
        uses: number;
        expires_at: number;
        status: string;
        target_pubkey: string | null;
      }
    | undefined;
  if (!row) {
    return { ok: false, error: "unknown invite" };
  }
  const record: InviteRecord = {
    inviteId: row.invite_id,
    circleId: row.circle_id,
    inviterPubkey: row.inviter_pubkey,
    scopes: safeScopes(row.scopes_json),
    maxUses: row.max_uses,
    uses: row.uses,
    expiresAt: row.expires_at,
    status: row.status as InviteRecord["status"],
  };
  // Constant-time hash compare; the secret is high-entropy so the hash check
  // is the whole proof of possession.
  const presented = sha256Hex(args.secret);
  const matches =
    presented.length === row.token_hash.length &&
    crypto.timingSafeEqual(Buffer.from(presented, "hex"), Buffer.from(row.token_hash, "hex"));
  if (!matches) {
    return { ok: false, error: "invalid invite secret" };
  }
  if (record.status !== "open") {
    return { ok: false, error: `invite ${record.status}` };
  }
  if (record.expiresAt <= now) {
    return { ok: false, error: "invite expired" };
  }
  // Target-bound invite: only the intended pubkey may redeem (or rejoin).
  // presenterPubkey is the join envelope's signature-verified author, so an
  // interceptor cannot satisfy this without the target's private key.
  if (row.target_pubkey && args.presenterPubkey !== row.target_pubkey) {
    return { ok: false, error: "this invite is bound to a different person" };
  }
  if (args.presenterIsActiveMember) {
    return { ok: true, record, rejoin: true };
  }
  if (record.uses >= record.maxUses) {
    return { ok: false, error: "invite exhausted" };
  }
  const nextUses = record.uses + 1;
  db.prepare(
    `UPDATE circle_invites
        SET uses = ?, status = CASE WHEN ? >= max_uses THEN 'exhausted' ELSE 'open' END,
            last_redeemed_at = ?, last_redeemed_by = ?
      WHERE invite_id = ?`,
  ).run(nextUses, nextUses, now, args.presenterPubkey, args.inviteId);
  return { ok: true, record: { ...record, uses: nextUses }, rejoin: false };
}

/** Revoke an open invite (inviter changed their mind). */
export function revokeInvite(db: DatabaseSync, inviteId: string): void {
  db.prepare(
    `UPDATE circle_invites SET status = 'revoked' WHERE invite_id = ? AND status = 'open'`,
  ).run(inviteId);
}

function safeScopes(json: string): CircleScope[] {
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === "string") : [];
  } catch {
    return [];
  }
}
