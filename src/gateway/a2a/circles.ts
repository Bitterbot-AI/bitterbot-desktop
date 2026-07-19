/**
 * PLAN-31 C1/C2: circle A2A verbs — the friend branch of the A2A surface.
 *
 * JSON-RPC methods spoken between connected nodes (the forage.ts pattern:
 * pure handlers, db + params + now in, outcome out; a2a-http.ts does
 * transport). Auth here is NOT the gateway bearer token: a friend proves
 * itself with a circle/v1 signed envelope whose author is an ACTIVE member
 * of the target circle holding the verb's scope (default-deny,
 * CirclesStore.memberHasScope). The single exception is circle/join, whose
 * proof is the invite secret — that is the pairing ceremony.
 *
 *  - circle/join       — redeem an invite; adds the member, returns roster.
 *  - circle/roster     — membership view sync (scope roster.read).
 *  - circle/presence   — liveness heartbeat (scope presence.share).
 *  - circle/message    — agent-to-agent conversation (scope message.send).
 *  - circle/ask        — graph question (scope ask.send).
 *  - circle/answer     — consented answer to an ask (scope answer.send).
 *  - circle/event.append — typed shared-state event, the tab (scope
 *                          ledger.append); per-author hash chain, fork freeze.
 *  - circle/events.since — event sync (scope ledger.read).
 *
 * THE HOSTILE-PRINCIPAL RULE (PLAN-31 §3.5) is enforced at this boundary:
 * every inbound text field is injection-scanned on receipt; message/ask/
 * answer content is stored WRAPPED as external content and can never reach
 * an agent unwrapped; nothing here triggers tools; per-member rate limits
 * apply to every authenticated verb. A valid signature buys a friend the
 * right to be QUARANTINED POLITELY, not trusted.
 */

import type { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
import { detectAgentSummon, queueAgentDraft } from "../../circles/agent-drafts.js";
import {
  MAILBOX_MAX_AGE_SECONDS,
  validateCircleEnvelope,
  type CircleEnvelope,
} from "../../circles/envelope.js";
import { redeemInvite } from "../../circles/invites.js";
import { canonicalJson, type JsonValue } from "../../commerce/sku.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { CirclesStore, KNOWN_SCOPES } from "../../memory/circles-store.js";
import { wrapExternalContent } from "../../security/external-content.js";
import { scanSkillForInjection } from "../../security/skill-injection-scanner.js";
import { A2aErrorCodes } from "./types.js";

const log = createSubsystemLogger("a2a/circles");

export type CircleError = { code: number; message: string };
export type CircleOutcome<T> = { ok: true; result: T } | { ok: false; error: CircleError };

function err<T>(code: number, message: string): CircleOutcome<T> {
  return { ok: false, error: { code, message } };
}

// ---------------------------------------------------------------------------
// Per-member rate limiting — PERSISTED sliding window (PLAN-36 §5.2). A
// compromised friend node must not be able to flood; limits are per (pubkey,
// verb-class). The window state lives in circle_rate_hits (not memory) so a
// gateway restart cannot reset an attacker's budget more permissively — a worm
// that saturates its limit stays saturated across a bounce.
// ---------------------------------------------------------------------------

const RATE_LIMITS: Record<string, { windowMs: number; max: number }> = {
  join: { windowMs: 60_000, max: 6 },
  read: { windowMs: 60_000, max: 60 },
  // PLAN-36 Phase 0 raised this from 12: the fast scheduler beats presence on a
  // ~30s sub-cadence (2/min per shared circle), so 30 gives headroom for a peer
  // we share many circles with. Version-skew note: an OLDER peer still enforces
  // 12, so the SENDER cadence (30s, not 15s) is deliberately chosen to keep
  // typical circle-sharing under that legacy budget — do not beat presence
  // faster than ~30s or old nodes will rate-limit us back to looking offline.
  presence: { windowMs: 60_000, max: 30 },
  message: { windowMs: 60_000, max: 30 },
  // Higher than message: event replays also arrive in sync batches
  // (service.syncEvents) and converge across sweeps via idempotent appends.
  event: { windowMs: 60_000, max: 120 },
};

/**
 * The widest window across all classes — the global GC horizon. Kept DERIVED
 * (never hardcode it): the GC deletes rows older than this, so it must always
 * be ≥ every class window or a COUNT could miss a row it still needs. Adding a
 * longer-window class automatically raises it.
 */
const MAX_RATE_WINDOW_MS = Math.max(...Object.values(RATE_LIMITS).map((l) => l.windowMs));

/**
 * Table-size hygiene runs at most this often, not on every request — the GC
 * only bounds row count (it never affects the windowed COUNT, which filters by
 * `hit_at` itself), so amortizing it keeps the limiter from doing a write on
 * every inbound call (review F1). Module-local, not security state — a restart
 * just triggers one GC on the first call after boot.
 */
const GC_INTERVAL_MS = MAX_RATE_WINDOW_MS;
let lastRateGcAt = 0;

/**
 * Reset the rate limiter for tests. Pass the db to clear its persisted
 * `circle_rate_hits` table (needed by cases that share a long-lived db); the
 * GC throttle clock is always reset so test timelines are deterministic. Fresh
 * per-test `:memory:` dbs start empty, so those cases need only the clock reset.
 */
export function resetCircleRateLimits(db?: DatabaseSync): void {
  lastRateGcAt = 0;
  db?.prepare(`DELETE FROM circle_rate_hits`).run();
}

function rateLimited(
  db: DatabaseSync,
  pubkey: string,
  cls: keyof typeof RATE_LIMITS,
  now: number,
): boolean {
  const limit = RATE_LIMITS[cls] ?? RATE_LIMITS.read!;
  const key = `${cls}:${pubkey}`;
  // Read-only window count FIRST: a refused request must do zero write I/O, so
  // the limiter cannot be turned into DB load by the flood it exists to stop
  // (review F1). The `hit_at >=` filter makes the count correct without the GC.
  const count = db
    .prepare(`SELECT COUNT(*) AS n FROM circle_rate_hits WHERE bucket_key = ? AND hit_at >= ?`)
    .get(key, now - limit.windowMs) as { n: number };
  if (count.n >= limit.max) {
    return true; // over budget — no writes, no GC
  }
  db.prepare(`INSERT INTO circle_rate_hits (bucket_key, hit_at) VALUES (?, ?)`).run(key, now);
  // Amortized global GC (bounds the table to ~a minute of traffic). Only
  // accepted requests reach here, so it runs at most ~once per window.
  if (now - lastRateGcAt >= GC_INTERVAL_MS) {
    lastRateGcAt = now;
    db.prepare(`DELETE FROM circle_rate_hits WHERE hit_at < ?`).run(now - MAX_RATE_WINDOW_MS);
  }
  return false;
}

// ---------------------------------------------------------------------------
// Envelope auth — the friend branch. Validates the signed envelope, then
// membership + scope (default-deny), then rate limit.
// ---------------------------------------------------------------------------

export type CircleAuthResult =
  | { ok: true; envelope: CircleEnvelope; store: CirclesStore }
  | { ok: false; error: CircleError };

export function authorizeCircleEnvelope(
  db: DatabaseSync,
  rawEnvelope: unknown,
  requiredScope: string,
  opts: { now?: number; maxSkewSeconds?: number; rateClass?: keyof typeof RATE_LIMITS } = {},
): CircleAuthResult {
  const now = opts.now ?? Date.now();
  const env = rawEnvelope as CircleEnvelope;
  if (!env || typeof env !== "object") {
    return {
      ok: false,
      error: { code: A2aErrorCodes.INVALID_PARAMS, message: "envelope required" },
    };
  }
  const validation = validateCircleEnvelope(env, {
    now: Math.floor(now / 1000),
    maxSkewSeconds: opts.maxSkewSeconds,
  });
  if (!validation.ok) {
    return {
      ok: false,
      error: { code: A2aErrorCodes.UNAUTHORIZED, message: `invalid envelope: ${validation.error}` },
    };
  }
  const store = new CirclesStore(db);
  const circle = store.getCircle(env.circle_id);
  if (!circle) {
    // Deliberately the same shape as a scope failure: strangers cannot probe
    // which circle ids exist on this node.
    return { ok: false, error: { code: A2aErrorCodes.UNAUTHORIZED, message: "not authorized" } };
  }
  if (!store.memberHasScope(env.circle_id, env.author_pubkey, requiredScope)) {
    return { ok: false, error: { code: A2aErrorCodes.UNAUTHORIZED, message: "not authorized" } };
  }
  if (rateLimited(db, env.author_pubkey, opts.rateClass ?? "read", now)) {
    return {
      ok: false,
      error: { code: A2aErrorCodes.INVALID_REQUEST, message: "rate limited; slow down" },
    };
  }
  return { ok: true, envelope: env, store };
}

// ---------------------------------------------------------------------------
// Inbound text hygiene: scan + wrap. Critical hits are neutralized to a
// refusal stub (the task-executor Phase-0 pattern); everything else is
// stored WRAPPED so no downstream consumer can mistake it for instructions.
// ---------------------------------------------------------------------------

export function sanitizeInboundCircleText(
  text: string,
  senderPubkey: string,
): { content: string; severity: string } {
  const scan = scanSkillForInjection(text);
  const effective =
    scan.severity === "critical" ? "[message removed: failed security scan on receipt]" : text;
  const wrapped = wrapExternalContent(effective, {
    source: "circle_agent",
    sender: senderPubkey,
  });
  return { content: wrapped, severity: scan.severity };
}

// ---------------------------------------------------------------------------
// circle/join — invite redemption (the pairing ceremony's network half).
// ---------------------------------------------------------------------------

export type CircleJoinParams = {
  inviteId?: string;
  secret?: string;
  /** Signed `join` envelope from the invitee: display_name, a2a_url. */
  join?: unknown;
};

export type RosterMember = {
  memberPubkey: string;
  displayName: string | null;
  a2aUrl: string | null;
  boxPubkey: string | null;
  mailboxUrl: string | null;
  role: string;
  scopes: string[];
  joinedAt: number;
};

export type CircleJoinResult = {
  circle: {
    circleId: string;
    name: string;
    kind: string;
    creatorPubkey: string;
    keyEpoch: number;
    createdAt: number;
  };
  members: RosterMember[];
};

export function handleCircleJoin(
  params: CircleJoinParams,
  db: DatabaseSync,
  now: number = Date.now(),
): CircleOutcome<CircleJoinResult> {
  if (!params.inviteId || !params.secret || !params.join) {
    return err(A2aErrorCodes.INVALID_PARAMS, "inviteId, secret, join envelope required");
  }
  const env = params.join as CircleEnvelope;
  const validation = validateCircleEnvelope(env, {
    now: Math.floor(now / 1000),
    expectedType: "join",
    // A mailbox-mediated join (§4) may sleep in the inviter's mailbox until it
    // next polls, so the join envelope's ts can legitimately be old. The real
    // freshness boundary is the invite's own expiry (checked in redeemInvite),
    // not this ts — so allow up to the mailbox ceiling, like message/presence.
    maxSkewSeconds: MAILBOX_MAX_AGE_SECONDS,
  });
  if (!validation.ok) {
    return err(A2aErrorCodes.UNAUTHORIZED, `invalid join envelope: ${validation.error}`);
  }
  if (rateLimited(db, env.author_pubkey, "join", now)) {
    return err(A2aErrorCodes.INVALID_REQUEST, "rate limited; slow down");
  }
  const store = new CirclesStore(db);
  const circle = store.getCircle(env.circle_id);
  if (!circle || circle.status !== "active") {
    return err(A2aErrorCodes.UNAUTHORIZED, "not authorized");
  }
  const existing = store.getMember(env.circle_id, env.author_pubkey);
  const outcome = redeemInvite(db, {
    inviteId: params.inviteId,
    secret: params.secret,
    presenterPubkey: env.author_pubkey,
    presenterIsActiveMember: existing?.status === "active",
    now,
  });
  if (!outcome.ok) {
    return err(A2aErrorCodes.UNAUTHORIZED, outcome.error);
  }
  if (outcome.record.circleId !== env.circle_id) {
    return err(A2aErrorCodes.UNAUTHORIZED, "invite is for a different circle");
  }
  const body = env.body as Record<string, unknown>;
  const displayName =
    typeof body.display_name === "string" ? body.display_name.slice(0, 80) : undefined;
  const a2aUrl =
    typeof body.a2a_url === "string" && /^https?:\/\//.test(body.a2a_url)
      ? body.a2a_url
      : undefined;
  const boxPubkey =
    typeof body.box_pubkey === "string" && body.box_pubkey.length <= 64
      ? body.box_pubkey
      : undefined;
  const mailboxUrl =
    typeof body.mailbox_url === "string" && /^https?:\/\//.test(body.mailbox_url)
      ? body.mailbox_url
      : undefined;
  store.addMember({
    circleId: env.circle_id,
    memberPubkey: env.author_pubkey,
    displayName,
    a2aUrl,
    boxPubkey,
    mailboxUrl,
    scopes: outcome.record.scopes,
    now,
  });
  log.info(
    `circle/join: ${env.author_pubkey.slice(0, 24)}… ${outcome.rejoin ? "re-paired" : "joined"} circle ${env.circle_id}`,
  );
  const updated = store.getCircle(env.circle_id);
  return {
    ok: true,
    result: {
      circle: {
        circleId: circle.circleId,
        name: circle.name,
        kind: circle.kind,
        creatorPubkey: circle.creatorPubkey,
        keyEpoch: updated?.keyEpoch ?? circle.keyEpoch,
        createdAt: circle.createdAt,
      },
      members: store.getMembers(env.circle_id).map(toRosterMember),
    },
  };
}

function toRosterMember(m: {
  memberPubkey: string;
  displayName: string | null;
  a2aUrl: string | null;
  boxPubkey: string | null;
  mailboxUrl: string | null;
  role: string;
  scopes: string[];
  joinedAt: number;
}): RosterMember {
  return {
    memberPubkey: m.memberPubkey,
    displayName: m.displayName,
    a2aUrl: m.a2aUrl,
    boxPubkey: m.boxPubkey,
    mailboxUrl: m.mailboxUrl,
    role: m.role,
    scopes: m.scopes,
    joinedAt: m.joinedAt,
  };
}

// ---------------------------------------------------------------------------
// circle/roster — membership sync (scope roster.read).
// ---------------------------------------------------------------------------

export function handleCircleRoster(
  params: { envelope?: unknown },
  db: DatabaseSync,
  now: number = Date.now(),
): CircleOutcome<CircleJoinResult> {
  const auth = authorizeCircleEnvelope(db, params.envelope, KNOWN_SCOPES.rosterRead, { now });
  if (!auth.ok) {
    return { ok: false, error: auth.error };
  }
  const circle = auth.store.getCircle(auth.envelope.circle_id);
  if (!circle) {
    return err(A2aErrorCodes.UNAUTHORIZED, "not authorized");
  }
  return {
    ok: true,
    result: {
      circle: {
        circleId: circle.circleId,
        name: circle.name,
        kind: circle.kind,
        creatorPubkey: circle.creatorPubkey,
        keyEpoch: circle.keyEpoch,
        createdAt: circle.createdAt,
      },
      members: auth.store.getMembers(circle.circleId).map(toRosterMember),
    },
  };
}

// ---------------------------------------------------------------------------
// circle/presence — liveness heartbeat (scope presence.share). Presence is
// the ONE disclosure allowed by default (PLAN-31 §3.5).
// ---------------------------------------------------------------------------

export function handleCirclePresence(
  params: { envelope?: unknown },
  db: DatabaseSync,
  now: number = Date.now(),
): CircleOutcome<{ seenAt: number }> {
  const auth = authorizeCircleEnvelope(db, params.envelope, KNOWN_SCOPES.presenceShare, {
    now,
    rateClass: "presence",
  });
  if (!auth.ok) {
    return { ok: false, error: auth.error };
  }
  const body = auth.envelope.body as Record<string, unknown>;
  const a2aUrl =
    typeof body.a2a_url === "string" && /^https?:\/\//.test(body.a2a_url) ? body.a2a_url : null;
  const boxPubkey =
    typeof body.box_pubkey === "string" && body.box_pubkey.length <= 64 ? body.box_pubkey : null;
  const mailboxUrl =
    typeof body.mailbox_url === "string" && /^https?:\/\//.test(body.mailbox_url)
      ? body.mailbox_url
      : null;
  const status = typeof body.status === "string" ? body.status.slice(0, 40) : null;
  // §5.6: a member's self-asserted name, carried in presence so a rename
  // reaches existing rosters. Peer-controlled — capped like the join path; the
  // petname layer defends against a hostile rename. Empty/whitespace is treated
  // as absent (null) so a nameless or blank beat can't COALESCE away a real
  // stored name.
  const rawName = typeof body.display_name === "string" ? body.display_name.trim() : "";
  const displayName = rawName ? rawName.slice(0, 80) : null;
  db.prepare(
    `INSERT INTO circle_peer_presence
       (peer_pubkey, a2a_url, box_pubkey, mailbox_url, last_seen_at, last_status)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(peer_pubkey) DO UPDATE SET
       a2a_url = COALESCE(excluded.a2a_url, circle_peer_presence.a2a_url),
       box_pubkey = COALESCE(excluded.box_pubkey, circle_peer_presence.box_pubkey),
       mailbox_url = COALESCE(excluded.mailbox_url, circle_peer_presence.mailbox_url),
       last_seen_at = excluded.last_seen_at,
       last_status = excluded.last_status`,
  ).run(auth.envelope.author_pubkey, a2aUrl, boxPubkey, mailboxUrl, now, status);
  // Presence rides a SIGNED member envelope, so it also refreshes the
  // sender's transport endpoints in this circle (mailbox fallback needs
  // box_pubkey + mailbox_url on the member row).
  auth.store.updateMemberEndpoints(
    auth.envelope.circle_id,
    auth.envelope.author_pubkey,
    { a2aUrl, boxPubkey, mailboxUrl, displayName },
    now,
  );
  return { ok: true, result: { seenAt: now } };
}

// ---------------------------------------------------------------------------
// circle/message, circle/ask, circle/answer — the conversation surface.
// Content is scanned + wrapped ON RECEIPT and stored in circle_messages; it
// never reaches an agent as bare text (PLAN-31 §3.5). NOTE: the "digest-
// batching" consumer does not exist yet — inbound bodies sit unread until a
// human opens the circle card. PLAN-36 Phase 0 emits a circles.message
// broadcast here; Phase 3 renders it and adds digest-batched notifications.
// ---------------------------------------------------------------------------

const MAX_MESSAGE_CHARS = 8_000;

function storeInboundMessage(
  db: DatabaseSync,
  env: CircleEnvelope,
  kind: "message" | "ask" | "answer",
  now: number,
): CircleOutcome<{ messageId: string; severity: string }> {
  const body = env.body as Record<string, unknown>;
  const rawText = typeof body.text === "string" ? body.text : "";
  if (!rawText || rawText.length > MAX_MESSAGE_CHARS) {
    return err(A2aErrorCodes.INVALID_PARAMS, `text required (max ${MAX_MESSAGE_CHARS} chars)`);
  }
  const threadId = typeof body.thread_id === "string" ? body.thread_id.slice(0, 64) : null;
  // A3: the parent's envelope id, if this is a reply. Just an id reference — no
  // content — so nothing to injection-scan; the parent (if held) renders locally.
  const replyTo = typeof body.reply_to === "string" ? body.reply_to.slice(0, 64) : null;
  const { content, severity } = sanitizeInboundCircleText(rawText, env.author_pubkey);
  // Phase B: a peer summoning @agent queues a LOCAL draft for OUR human. The
  // raw text is examined only for the summon token; generation is deferred to
  // the scheduler sweep (quarantined path), rate-bucketed at queue time, and
  // refused for messages that failed the security scan. The summoner gets no
  // signal either way.
  if (kind === "message" && severity !== "critical" && detectAgentSummon(rawText)) {
    queueAgentDraft(db, {
      circleId: env.circle_id,
      summonEnvelopeId: env.id,
      summonAuthorPubkey: env.author_pubkey,
      now,
    });
  }
  const messageId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO circle_messages
       (message_id, circle_id, author_pubkey, direction, kind, thread_id, content,
        scan_severity, envelope_id, created_at, reply_to)
     VALUES (?, ?, ?, 'in', ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    messageId,
    env.circle_id,
    env.author_pubkey,
    kind,
    threadId,
    content,
    severity,
    env.id,
    now,
    replyTo,
  );
  // Receiving a signed message proves the sender is alive right now, so refresh
  // their presence — an actively-chatting peer must not read as offline just
  // because their last presence beat aged out (PLAN-36 Phase 0). Bumps
  // last_seen_at only; endpoints/status from the last presence beat are kept.
  db.prepare(
    `INSERT INTO circle_peer_presence (peer_pubkey, last_seen_at) VALUES (?, ?)
     ON CONFLICT(peer_pubkey) DO UPDATE SET last_seen_at = excluded.last_seen_at`,
  ).run(env.author_pubkey, now);
  if (severity === "critical") {
    log.warn(
      `circle/${kind}: neutralized critical injection from ${env.author_pubkey.slice(0, 24)}… in ${env.circle_id}`,
    );
  }
  return { ok: true, result: { messageId, severity } };
}

export function handleCircleMessage(
  params: { envelope?: unknown },
  db: DatabaseSync,
  now: number = Date.now(),
): CircleOutcome<{ messageId: string; severity: string }> {
  const auth = authorizeCircleEnvelope(db, params.envelope, KNOWN_SCOPES.messageSend, {
    now,
    rateClass: "message",
    // Messages may arrive via mailbox replay after offline windows.
    maxSkewSeconds: MAILBOX_MAX_AGE_SECONDS,
  });
  if (!auth.ok) {
    return { ok: false, error: auth.error };
  }
  if (dedupeEnvelope(db, auth.envelope)) {
    return err(A2aErrorCodes.INVALID_REQUEST, "duplicate envelope");
  }
  return storeInboundMessage(db, auth.envelope, "message", now);
}

export function handleCircleAsk(
  params: { envelope?: unknown },
  db: DatabaseSync,
  now: number = Date.now(),
): CircleOutcome<{ messageId: string; severity: string }> {
  const auth = authorizeCircleEnvelope(db, params.envelope, KNOWN_SCOPES.askSend, {
    now,
    rateClass: "message",
    maxSkewSeconds: MAILBOX_MAX_AGE_SECONDS,
  });
  if (!auth.ok) {
    return { ok: false, error: auth.error };
  }
  if (dedupeEnvelope(db, auth.envelope)) {
    return err(A2aErrorCodes.INVALID_REQUEST, "duplicate envelope");
  }
  return storeInboundMessage(db, auth.envelope, "ask", now);
}

export function handleCircleAnswer(
  params: { envelope?: unknown },
  db: DatabaseSync,
  now: number = Date.now(),
): CircleOutcome<{ messageId: string; severity: string }> {
  const auth = authorizeCircleEnvelope(db, params.envelope, KNOWN_SCOPES.answerSend, {
    now,
    rateClass: "message",
    maxSkewSeconds: MAILBOX_MAX_AGE_SECONDS,
  });
  if (!auth.ok) {
    return { ok: false, error: auth.error };
  }
  if (dedupeEnvelope(db, auth.envelope)) {
    return err(A2aErrorCodes.INVALID_REQUEST, "duplicate envelope");
  }
  return storeInboundMessage(db, auth.envelope, "answer", now);
}

/** Envelope-id replay guard for mailbox-replayable verbs. */
function dedupeEnvelope(db: DatabaseSync, env: CircleEnvelope): boolean {
  const hit = db
    .prepare(`SELECT 1 FROM circle_messages WHERE envelope_id = ? LIMIT 1`)
    .get(env.id) as unknown;
  return hit !== undefined && hit !== null;
}

// ---------------------------------------------------------------------------
// circle/event.append + circle/events.since — the typed shared-state ledger
// (C2, the tab). Per-author Ed25519 hash chains (the Forage observation-chain
// pattern): append-only, seq strictly increasing, prev_hash links, fork at
// the same seq freezes the circle. NO settlement logic here — Phase 2.
// ---------------------------------------------------------------------------

export function computeEventHash(args: {
  circleId: string;
  authorPubkey: string;
  seq: number;
  prevHash: string | null;
  eventType: string;
  body: Record<string, JsonValue>;
  claimedAt: number;
}): string {
  return crypto
    .createHash("sha256")
    .update(
      canonicalJson({
        circle_id: args.circleId,
        author: args.authorPubkey,
        seq: args.seq,
        prev: args.prevHash,
        type: args.eventType,
        body: args.body,
        claimed_at: args.claimedAt,
      } as unknown as JsonValue),
      "utf8",
    )
    .digest("hex");
}

export type CircleEventRecord = {
  eventId: string;
  circleId: string;
  authorPubkey: string;
  seq: number;
  prevHash: string | null;
  eventType: string;
  body: Record<string, JsonValue>;
  /** The original signed envelope (replayable through the append path). */
  envelope: Record<string, JsonValue>;
  eventHash: string;
  claimedAt: number;
  receivedAt: number;
};

export function handleCircleEventAppend(
  params: { envelope?: unknown },
  db: DatabaseSync,
  now: number = Date.now(),
): CircleOutcome<{ eventId: string; seq: number; duplicate?: boolean }> {
  const auth = authorizeCircleEnvelope(db, params.envelope, KNOWN_SCOPES.ledgerAppend, {
    now,
    rateClass: "event",
    maxSkewSeconds: MAILBOX_MAX_AGE_SECONDS,
  });
  if (!auth.ok) {
    return { ok: false, error: auth.error };
  }
  const env = auth.envelope;
  if (!auth.store.isWritable(env.circle_id)) {
    return err(A2aErrorCodes.INVALID_REQUEST, "circle is frozen or archived; writes refused");
  }
  const body = env.body as Record<string, unknown>;
  const seq = typeof body.seq === "number" && Number.isInteger(body.seq) ? body.seq : -1;
  const prevHash = typeof body.prev_hash === "string" ? body.prev_hash : null;
  const eventType = typeof body.event_type === "string" ? body.event_type.slice(0, 64) : "";
  const eventBody =
    body.event && typeof body.event === "object" && !Array.isArray(body.event)
      ? (body.event as Record<string, JsonValue>)
      : null;
  const claimedAt = typeof body.claimed_at === "number" ? body.claimed_at : now;
  const heads =
    body.heads && typeof body.heads === "object" && !Array.isArray(body.heads)
      ? (body.heads as Record<string, JsonValue>)
      : {};
  if (seq < 0 || !eventType || !eventBody) {
    return err(A2aErrorCodes.INVALID_PARAMS, "seq, event_type, event required");
  }

  // Injection hygiene on every string field of the event body: the tab is
  // rendered into briefings, so a poisoned memo is a poisoned briefing.
  for (const v of Object.values(eventBody)) {
    if (typeof v === "string" && scanSkillForInjection(v).severity === "critical") {
      return err(A2aErrorCodes.INVALID_REQUEST, "event content failed security scan");
    }
  }

  const expectedHash = computeEventHash({
    circleId: env.circle_id,
    authorPubkey: env.author_pubkey,
    seq,
    prevHash,
    eventType,
    body: eventBody,
    claimedAt,
  });

  // Chain integrity for this author.
  const head = db
    .prepare(
      `SELECT seq, event_hash FROM circle_events
        WHERE circle_id = ? AND author_pubkey = ?
        ORDER BY seq DESC LIMIT 1`,
    )
    .get(env.circle_id, env.author_pubkey) as { seq: number; event_hash: string } | undefined;

  if (head) {
    if (seq === head.seq) {
      // Same seq: replay of the identical event is idempotent; a DIFFERENT
      // event at the same seq is a fork — cryptographic proof of tampering.
      const existing = db
        .prepare(
          `SELECT event_id, event_hash FROM circle_events
            WHERE circle_id = ? AND author_pubkey = ? AND seq = ?`,
        )
        .get(env.circle_id, env.author_pubkey, seq) as
        | { event_id: string; event_hash: string }
        | undefined;
      if (existing && existing.event_hash === expectedHash) {
        return { ok: true, result: { eventId: existing.event_id, seq, duplicate: true } };
      }
      // Already reviewed: the human unfroze after examining a fork from this
      // author, so REPLAYS of it don't re-freeze (a member restored from
      // backup would otherwise re-brick the circle on every sync). The event
      // is still rejected — a fork is never accepted, only forgiven.
      if (auth.store.isForkForgiven(env.circle_id, env.author_pubkey)) {
        return err(
          A2aErrorCodes.INVALID_REQUEST,
          "ledger fork rejected (previously reviewed by the human)",
        );
      }
      // Record the evidence WITH the freeze so the recovery UI can show the
      // human what happened, not just that it happened (Phase D unfreeze).
      auth.store.freezeCircle(
        env.circle_id,
        now,
        JSON.stringify({
          author_pubkey: env.author_pubkey,
          seq,
          held_hash: existing?.event_hash ?? null,
          offered_hash: expectedHash,
          detected_at: now,
        }),
      );
      log.error(
        `circle/event.append: FORK detected for ${env.author_pubkey.slice(0, 24)}… at seq ${seq} in ${env.circle_id} — circle frozen`,
      );
      return err(
        A2aErrorCodes.INVALID_REQUEST,
        "ledger fork detected: circle frozen pending human review",
      );
    }
    if (seq !== head.seq + 1 || prevHash !== head.event_hash) {
      return err(
        A2aErrorCodes.INVALID_REQUEST,
        `chain break: expected seq ${head.seq + 1} with prev_hash of head`,
      );
    }
  } else if (seq !== 0 || prevHash !== null) {
    return err(A2aErrorCodes.INVALID_REQUEST, "first event must be seq 0 with null prev_hash");
  }

  const eventId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO circle_events
       (event_id, circle_id, author_pubkey, seq, prev_hash, event_type, body_json,
        heads_json, envelope_json, event_hash, claimed_at, received_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    eventId,
    env.circle_id,
    env.author_pubkey,
    seq,
    prevHash,
    eventType,
    JSON.stringify(eventBody),
    JSON.stringify(heads),
    JSON.stringify(env),
    expectedHash,
    claimedAt,
    now,
  );
  return { ok: true, result: { eventId, seq } };
}

export function handleCircleEventsSince(
  params: { envelope?: unknown },
  db: DatabaseSync,
  now: number = Date.now(),
): CircleOutcome<{ events: CircleEventRecord[] }> {
  const auth = authorizeCircleEnvelope(db, params.envelope, KNOWN_SCOPES.ledgerRead, { now });
  if (!auth.ok) {
    return { ok: false, error: auth.error };
  }
  const body = auth.envelope.body as Record<string, unknown>;
  const sinceReceivedAt = typeof body.since === "number" ? body.since : 0;
  const limit = Math.min(typeof body.limit === "number" ? body.limit : 200, 500);
  const rows = db
    .prepare(
      `SELECT event_id, circle_id, author_pubkey, seq, prev_hash, event_type, body_json,
              envelope_json, event_hash, claimed_at, received_at
         FROM circle_events
        WHERE circle_id = ? AND received_at > ?
        ORDER BY received_at ASC LIMIT ?`,
    )
    .all(auth.envelope.circle_id, sinceReceivedAt, limit) as unknown as Array<{
    event_id: string;
    circle_id: string;
    author_pubkey: string;
    seq: number;
    prev_hash: string | null;
    event_type: string;
    body_json: string;
    envelope_json: string;
    event_hash: string;
    claimed_at: number;
    received_at: number;
  }>;
  return {
    ok: true,
    result: {
      events: rows.map((r) => ({
        eventId: r.event_id,
        circleId: r.circle_id,
        authorPubkey: r.author_pubkey,
        seq: r.seq,
        prevHash: r.prev_hash,
        eventType: r.event_type,
        body: safeJsonRecord(r.body_json),
        // The original signed envelope so a syncing peer can replay it
        // through its own validated append path (chain + fork checks).
        envelope: safeJsonRecord(r.envelope_json),
        eventHash: r.event_hash,
        claimedAt: r.claimed_at,
        receivedAt: r.received_at,
      })),
    },
  };
}

function safeJsonRecord(json: string): Record<string, JsonValue> {
  try {
    const parsed = JSON.parse(json) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, JsonValue>)
      : {};
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Dispatcher (the forage handleForageMethod pattern).
// ---------------------------------------------------------------------------

export function handleCircleMethod(
  method: string,
  params: unknown,
  db: DatabaseSync,
  now: number = Date.now(),
): CircleOutcome<unknown> {
  const p = (params ?? {}) as Record<string, unknown>;
  switch (method) {
    case "circle/join":
      return handleCircleJoin(p as CircleJoinParams, db, now);
    case "circle/roster":
      return handleCircleRoster(p, db, now);
    case "circle/presence":
      return handleCirclePresence(p, db, now);
    case "circle/message":
      return handleCircleMessage(p, db, now);
    case "circle/ask":
      return handleCircleAsk(p, db, now);
    case "circle/answer":
      return handleCircleAnswer(p, db, now);
    case "circle/event.append":
      return handleCircleEventAppend(p, db, now);
    case "circle/events.since":
      return handleCircleEventsSince(p, db, now);
    default:
      return err(A2aErrorCodes.METHOD_NOT_FOUND, `Unknown circle method: ${method}`);
  }
}
