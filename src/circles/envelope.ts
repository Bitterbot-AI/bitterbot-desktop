/**
 * PLAN-31 C1: circle/v1 protocol envelope — signing, verification, validation.
 *
 * Every circle message (invite / join / message / presence / ask / answer /
 * event / poll / vote) is a signed JSON envelope, the same construction as the
 * Aubaine protocol (src/commerce/envelope.ts): Ed25519 over a domain-prefixed
 * JCS preimage. The domain prefix here is `circle/v1\n`, which gives strict
 * domain separation — a signature produced for any other protocol (aubaine/v1
 * included) can never verify as a circle message, and vice versa.
 *
 * Identity is the raw Ed25519 public key (`ed25519:<hex>`), the node's device
 * identity adapted via keyPairFromPrivateKeyPem — portable, no registry. The
 * trust anchor is circle membership (CirclesStore, default-deny scopes), never
 * a registry: friendship is the Sybil resistance (PLAN-31 §2).
 *
 * Unlike commerce envelopes, circle envelopes carry `circle_id` at the top
 * level (inside the signed preimage) so the A2A friend-auth branch can resolve
 * membership BEFORE trusting anything in the body. A connection between two
 * people is a 2-member circle of kind "connection" — one membership machinery
 * serves the pairwise edge and the 4-15 group alike.
 *
 * Timestamp policy: direct A2A calls validate with the tight default skew
 * (±300s). Mailbox-delivered envelopes (store-and-forward, PLAN-31 §3.2) may
 * legitimately arrive days later — receivers validate those with
 * `maxSkewSeconds` up to MAILBOX_MAX_AGE_SECONDS, never more.
 */
import crypto from "node:crypto";
import { pubkeyId, type KeyPair } from "../commerce/envelope.js";
import { canonicalJson, type JsonValue } from "../commerce/sku.js";

export const CIRCLE_PROTOCOL = "circle/v1";
/** Conversation payloads are digest-batched prose, not commerce blobs. */
export const MAX_CIRCLE_ENVELOPE_BYTES = 65_536;
/** Tight window for direct (online) A2A calls. */
export const CLOCK_SKEW_SECONDS = 300;
/** Ceiling for mailbox-delivered envelopes (30d, the mailbox TTL). */
export const MAILBOX_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

export type CircleEnvelopeType =
  | "invite" // inviter-signed invite payload (token flow, invites.ts)
  | "join" // invitee's signed acceptance — the pairing ceremony's second half
  | "welcome" // inviter-signed roster reply to a mailbox-mediated join (§4)
  | "message" // agent-to-agent conversation (hostile principal on receipt)
  | "presence" // liveness heartbeat (the one always-allowed disclosure)
  | "ask" // graph question fan-out
  | "answer" // consented answer to an ask
  | "event" // typed shared-state event append (the tab, C2; domain-agnostic)
  | "poll" // group decision
  | "vote" // poll response
  | "sender_key"; // sender-key distribution (mesh confidentiality, Stage 2)

export interface CircleEnvelope {
  protocol: string;
  type: CircleEnvelopeType;
  id: string;
  /** The circle this envelope speaks within; membership is checked first. */
  circle_id: string;
  author_pubkey: string;
  ts: number;
  body: Record<string, JsonValue>;
  signature?: string;
}

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function publicKeyFromHex(hex: string): crypto.KeyObject {
  return crypto.createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(hex, "hex")]),
    format: "der",
    type: "spki",
  });
}

/** Domain-prefixed JCS signing preimage. `circle/v1\n` + canonical JSON. */
export function circleSigningPreimage(env: CircleEnvelope): Buffer {
  const { signature: _omit, ...unsigned } = env;
  return Buffer.from(`${CIRCLE_PROTOCOL}\n${canonicalJson(unsigned as JsonValue)}`, "utf8");
}

/** Sign an unsigned circle envelope, returning a copy with `signature` set. */
export function signCircleEnvelope(
  env: Omit<CircleEnvelope, "signature">,
  key: KeyPair,
): CircleEnvelope {
  const full: CircleEnvelope = { ...env };
  full.signature = crypto.sign(null, circleSigningPreimage(full), key.privateKey).toString("hex");
  return full;
}

/** Verify the Ed25519 signature against the envelope's `author_pubkey`. */
export function verifyCircleEnvelope(env: CircleEnvelope): boolean {
  if (typeof env.signature !== "string") {
    return false;
  }
  const match = /^ed25519:([0-9a-f]{64})$/.exec(env.author_pubkey);
  if (!match || !/^[0-9a-f]{128}$/.test(env.signature)) {
    return false;
  }
  try {
    return crypto.verify(
      null,
      circleSigningPreimage(env),
      publicKeyFromHex(match[1] as string),
      Buffer.from(env.signature, "hex"),
    );
  } catch {
    return false;
  }
}

export interface ValidateCircleOptions {
  now?: number;
  /**
   * Acceptance window in seconds. Defaults to the tight direct-call window;
   * mailbox consumers pass up to MAILBOX_MAX_AGE_SECONDS. Values above the
   * mailbox ceiling are clamped — nothing should accept older signatures.
   */
  maxSkewSeconds?: number;
  maxBytes?: number;
  expectedType?: CircleEnvelopeType;
  /** When set, the envelope must speak within this circle. */
  expectedCircleId?: string;
}

export interface CircleValidationResult {
  ok: boolean;
  error?: string;
}

/**
 * Full receiver-side validation: protocol, type, circle binding, size,
 * timestamp window, signature. Callers still MUST check membership + scope
 * (CirclesStore.memberHasScope) — a valid signature from a non-member is
 * exactly the hostile-principal case, and validation here says nothing about
 * trust (PLAN-31 §3.5).
 */
export function validateCircleEnvelope(
  env: CircleEnvelope,
  opts: ValidateCircleOptions = {},
): CircleValidationResult {
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const skew = Math.min(opts.maxSkewSeconds ?? CLOCK_SKEW_SECONDS, MAILBOX_MAX_AGE_SECONDS);
  const maxBytes = opts.maxBytes ?? MAX_CIRCLE_ENVELOPE_BYTES;

  if (env.protocol !== CIRCLE_PROTOCOL) {
    return { ok: false, error: "unsupported protocol" };
  }
  if (opts.expectedType && env.type !== opts.expectedType) {
    return { ok: false, error: `expected type ${opts.expectedType}, got ${env.type}` };
  }
  if (typeof env.circle_id !== "string" || env.circle_id.length === 0) {
    return { ok: false, error: "missing circle_id" };
  }
  if (opts.expectedCircleId && env.circle_id !== opts.expectedCircleId) {
    return { ok: false, error: "envelope is for a different circle" };
  }
  if (typeof env.ts !== "number" || Math.abs(now - env.ts) > skew) {
    return { ok: false, error: "timestamp outside acceptance window" };
  }
  if (Buffer.byteLength(JSON.stringify(env), "utf8") > maxBytes) {
    return { ok: false, error: "envelope exceeds size limit" };
  }
  if (!verifyCircleEnvelope(env)) {
    return { ok: false, error: "invalid signature" };
  }
  return { ok: true };
}

/** Construct + sign a fresh circle envelope. */
export function makeCircleEnvelope(
  type: CircleEnvelopeType,
  circleId: string,
  body: Record<string, JsonValue>,
  key: KeyPair,
  now: number = Math.floor(Date.now() / 1000),
): CircleEnvelope {
  return signCircleEnvelope(
    {
      protocol: CIRCLE_PROTOCOL,
      type,
      id: crypto.randomUUID(),
      circle_id: circleId,
      author_pubkey: pubkeyId(key),
      ts: now,
      body,
    },
    key,
  );
}
