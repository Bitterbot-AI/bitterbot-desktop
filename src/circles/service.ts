/**
 * PLAN-31 C1: the node-local circles service — our side of the connection.
 *
 * The A2A handlers (src/gateway/a2a/circles.ts) SERVE friends; this module
 * ACTS for our own human: mints invites, redeems codes by dialing the
 * inviter, mirrors rosters, sends signed conversation/presence/event
 * envelopes to members, and reads the local buffers the UI renders.
 *
 * Identity: the node's Ed25519 device identity (device.json) adapted to the
 * commerce KeyPair — the same key signs circle/v1 envelopes everywhere, so a
 * connection survives gateway restarts and IP changes.
 *
 * Transport v1 is direct dial to each member's a2a_url with best-effort,
 * bounded-parallel fan-out (a per-dial timeout keeps one unreachable peer
 * from stalling the fast maintenance sweep); the store-and-forward mailbox
 * (§3.2) layers under this so offline peers receive on wake. If a member has
 * neither a reachable a2a_url nor a mailbox, the send is reported in
 * SendReport.failed — it is NOT silently retried (an earlier docstring
 * wrongly claimed the mailbox always queues it). PLAN-36 Phase 0 surfaces
 * that failed state to the UI instead of discarding it.
 */

import type { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
import type { JsonValue } from "../commerce/sku.js";
import type { BitterbotConfig } from "../config/types.bitterbot.js";
import type { CircleJoinResult } from "../gateway/a2a/circles.js";
import { keyPairFromPrivateKeyPem, pubkeyId, type KeyPair } from "../commerce/envelope.js";
import { blobDigest, buildMailboxProof } from "../gateway/a2a/mailbox.js";
import { loadOrCreateDeviceIdentity } from "../infra/device-identity.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  CirclesStore,
  DEFAULT_MEMBER_SCOPES,
  type Circle,
  type CircleMember,
} from "../memory/circles-store.js";
import {
  loadOrCreateBoxKeys,
  openBox,
  sealToBox,
  type BoxKeyPair,
  type SealedBlob,
} from "./box-crypto.js";
import { compileBriefingIfDue, latestBriefing, type CompiledBriefing } from "./briefing.js";
import { getCircleTopicBus } from "./circle-topic-transport.js";
import { circleTopicId, publishCircleFrame, type CircleTopicBus } from "./circle-topic.js";
import { DEFAULT_ANSWER_POSTURE, isDisclosureAllowed, pendingAsks } from "./disclosure.js";
import {
  MAILBOX_MAX_AGE_SECONDS,
  makeCircleEnvelope,
  validateCircleEnvelope,
  type CircleEnvelope,
} from "./envelope.js";
import { createInvite, parseInviteCode, type CreatedInvite } from "./invites.js";
import {
  bumpPendingJoinAttempt,
  deletePendingJoin,
  listDuePendingJoins,
  matchPendingJoin,
  upsertPendingJoin,
  type PendingJoin,
} from "./pending-join.js";
import {
  PRACTICE_KIND,
  loadOrCreatePracticeKeys,
  practiceReply,
  realConnectionCount,
} from "./practice.js";
import { markCircleRead, unreadCounts } from "./read-state.js";
import {
  buildChainedEventBody,
  computeTabBalances,
  type TabBalances,
  type TabEventInput,
} from "./tab.js";

const log = createSubsystemLogger("circles/service");

export type FetchLike = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

/**
 * Per-dial ceiling. Kept well under the PLAN-36 Phase-0 fast sweep cadence
 * (~15s) so a blackholed a2a_url (SYN with no RST) cannot make the sweep
 * overrun its own interval.
 */
const DIAL_TIMEOUT_MS = 5000;

/**
 * Parallel dials per circle. Circles cap at ~15 members; bounding this keeps a
 * large circle from opening one socket per member at once while still removing
 * the head-of-line blocking of the old serial fan-out.
 */
const FANOUT_CONCURRENCY = 8;

/** Run `fn` over `items` with at most `limit` in flight at once. */
async function runBounded<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
      await fn(next);
    }
  });
  await Promise.all(workers);
}

export type CirclesServiceDeps = {
  db: DatabaseSync;
  config: BitterbotConfig;
  fetchImpl?: FetchLike;
  /** Injectable for tests; defaults to the device identity KeyPair. */
  keyPair?: KeyPair;
  /** Injectable for tests; defaults to the persisted X25519 box keypair. */
  boxKeys?: BoxKeyPair;
  /** Injectable for tests; defaults to the persisted practice-partner key. */
  practiceKeys?: KeyPair;
  /**
   * Mesh topic bus (PLAN-36 Phase 4). Defaults to the process singleton set by
   * startCircleTopicTransport; injectable for tests. When present, sends also
   * publish to the circle's blinded topic so subscribed+online members receive
   * over the mesh with no a2aUrl. Null/absent → direct-dial + mailbox only.
   */
  topicBus?: CircleTopicBus | null;
};

export type SendReport = {
  delivered: string[];
  failed: string[];
};

/** Per-message delivery aggregate for an outbound send (PLAN-36 B5). */
export type DeliveryStatus = "pending" | "delivered" | "partial" | "failed";

function deliveryStatusFromReport(report: SendReport): DeliveryStatus {
  if (report.failed.length === 0) return "delivered"; // all peers ok (or none to reach)
  if (report.delivered.length === 0) return "failed"; // nothing got through
  return "partial";
}

async function circleRpc(
  fetchImpl: FetchLike,
  a2aUrl: string,
  method: string,
  params: Record<string, unknown>,
): Promise<{ ok: boolean; result?: Record<string, unknown>; error?: string }> {
  try {
    const res = await fetchImpl(a2aUrl.replace(/\/$/, "") + "/a2a", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: crypto.randomUUID(), method, params }),
      signal: AbortSignal.timeout(DIAL_TIMEOUT_MS),
    });
    if (!res.ok) return { ok: false, error: `http ${res.status}` };
    const body = JSON.parse(await res.text()) as {
      result?: Record<string, unknown>;
      error?: { message?: string };
    };
    if (body.error) return { ok: false, error: body.error.message ?? "rpc error" };
    return { ok: true, result: body.result };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

/** The decrypted inner payload of a mailbox blob (generic verb, or a §4 join). */
type MailboxInner = {
  method?: string;
  envelope?: unknown;
  inviteId?: string;
  secret?: string;
  join?: unknown;
};

export class CirclesService {
  private readonly db: DatabaseSync;
  private readonly config: BitterbotConfig;
  private readonly fetchImpl: FetchLike;
  private readonly key: KeyPair;
  private readonly boxKeys: BoxKeyPair;
  private practiceKeysLazy: KeyPair | undefined;
  private readonly topicBusDep: CircleTopicBus | null | undefined;
  readonly store: CirclesStore;

  constructor(deps: CirclesServiceDeps) {
    this.db = deps.db;
    this.config = deps.config;
    this.fetchImpl = deps.fetchImpl ?? (fetch as unknown as FetchLike);
    this.key = deps.keyPair ?? keyPairFromPrivateKeyPem(loadOrCreateDeviceIdentity().privateKeyPem);
    this.boxKeys = deps.boxKeys ?? loadOrCreateBoxKeys();
    this.practiceKeysLazy = deps.practiceKeys;
    this.topicBusDep = deps.topicBus;
    this.store = new CirclesStore(this.db);
  }

  /** The mesh topic bus: injected value wins (incl. explicit null), else the
   *  process singleton set by startCircleTopicTransport. */
  private topicBus(): CircleTopicBus | null {
    return this.topicBusDep !== undefined ? this.topicBusDep : getCircleTopicBus();
  }

  get pubkey(): string {
    return pubkeyId(this.key);
  }

  get boxPubkeyB64(): string {
    return this.boxKeys.publicKeyB64;
  }

  /** The underlying store handle (disclosure grants live beside the circles). */
  get dbHandle(): DatabaseSync {
    return this.db;
  }

  private get displayName(): string {
    return this.config.circles?.displayName ?? this.config.ui?.assistant?.name ?? "Bitterbot agent";
  }

  private get a2aPublicUrl(): string | undefined {
    return this.config.circles?.a2aPublicUrl;
  }

  /** The mailbox host URL where OTHERS deposit mail for US. */
  private get myMailboxUrl(): string | undefined {
    const mailbox = this.config.circles?.mailbox;
    return mailbox?.enabled === false ? undefined : mailbox?.url;
  }

  // -------------------------------------------------------------------------
  // Create + invite (the inviter's half of the ceremony)
  // -------------------------------------------------------------------------

  /**
   * Create a circle. A pairwise CONNECTION is a 2-member circle of kind
   * "connection" — one membership machinery for the edge and the group.
   */
  createCircle(args: { name: string; kind?: string }): string {
    return this.store.createCircle({
      name: args.name,
      kind: args.kind ?? "connection",
      creatorPubkey: this.pubkey,
      creatorA2aUrl: this.a2aPublicUrl,
    });
  }

  /**
   * Mint an invite code for a circle (creating a fresh connection circle
   * when none is given). The code is returned ONCE; only its hash persists.
   */
  createInviteCode(args: { circleId?: string; name?: string; ttlMs?: number }): CreatedInvite & {
    circleId: string;
  } {
    // §4: a reachable a2a URL is no longer mandatory — a mailbox rendezvous is an
    // equally valid dial-back address. Require at least one, or peers truly have
    // no way to reach us.
    const hasMailboxRendezvous = Boolean(this.myMailboxUrl && this.boxKeys.publicKeyB64);
    if (!this.a2aPublicUrl && !hasMailboxRendezvous) {
      throw new Error(
        "circles: neither a2aPublicUrl nor a mailbox is configured — peers would have no way to reach back",
      );
    }
    const circleId =
      args.circleId ??
      this.createCircle({ name: args.name ?? `${this.displayName} & friend`, kind: "connection" });
    const circle = this.store.getCircle(circleId);
    if (!circle) {
      throw new Error(`unknown circle ${circleId}`);
    }
    if (circle.status !== "active") {
      throw new Error(`circle ${circleId} is ${circle.status}; invites refused`);
    }
    const invite = createInvite(this.db, {
      circleId,
      circleName: circle.name,
      circleKind: circle.kind,
      inviterKey: this.key,
      inviterName: this.displayName,
      inviterA2aUrl: this.a2aPublicUrl,
      inviterMailboxUrl: hasMailboxRendezvous ? this.myMailboxUrl : undefined,
      inviterBoxPubkey: hasMailboxRendezvous ? this.boxKeys.publicKeyB64 : undefined,
      scopes: DEFAULT_MEMBER_SCOPES,
      ttlMs: args.ttlMs,
    });
    return { ...invite, circleId };
  }

  // -------------------------------------------------------------------------
  // Redeem (the invitee's half)
  // -------------------------------------------------------------------------

  /**
   * Redeem a pasted invite code: verify the inviter's signature FIRST, then
   * complete the pairing. Direct dial to the inviter's circle/join is the fast
   * path; when the inviter has no reachable a2a URL or is offline, fall back to
   * the §4 MAILBOX RENDEZVOUS — seal the join request into the inviter's mailbox
   * and return `pending`, so the roster arrives via our own mailbox drain once
   * they next poll. Either way the human saw the parsed invite (who is asking)
   * before this is called — calling it IS the invitee-side consent.
   */
  async redeemInviteCode(code: string): Promise<{
    circleId: string;
    circleName: string;
    inviterName: string | null;
    members: number;
    status: "connected" | "pending";
  }> {
    const parsed = parseInviteCode(code);
    if (!parsed.ok) {
      throw new Error(parsed.error);
    }
    const invite = parsed.invite;
    // Circle-id collision guard (review #1): a hostile inviter can name ANY
    // circle_id in its invite, including one we already belong to. Refuse if we
    // already know this circle under a DIFFERENT creator, so a redeem/welcome
    // can never overwrite an existing circle's roster/endpoints.
    const known = this.store.getCircle(invite.circleId);
    if (known && known.creatorPubkey !== invite.inviterPubkey) {
      throw new Error(
        "join refused: this invite names a circle you already know under another owner",
      );
    }
    const joinEnvelope = this.buildJoinEnvelope(invite.circleId);

    // Fast path: a direct dial when the inviter published a reachable URL.
    if (invite.inviterA2aUrl) {
      const rpc = await circleRpc(this.fetchImpl, invite.inviterA2aUrl, "circle/join", {
        inviteId: invite.inviteId,
        secret: invite.secret,
        join: joinEnvelope,
      });
      if (rpc.ok && rpc.result) {
        const members = this.importJoinResult(invite, rpc.result);
        log.info(`joined circle ${invite.circleId} (${members} members, direct)`);
        return {
          circleId: invite.circleId,
          circleName: invite.circleName,
          inviterName: invite.inviterName,
          members,
          status: "connected",
        };
      }
      log.debug(`direct join for ${invite.circleId} failed (${rpc.error}); trying mailbox`);
    }

    // Fallback: mailbox rendezvous. Needs the inviter's mailbox coords AND our
    // own mailbox (that is where their signed `welcome` roster comes back).
    if (!invite.inviterMailboxUrl || !invite.inviterBoxPubkey) {
      throw new Error("join failed: inviter is unreachable and left no mailbox rendezvous");
    }
    if (!this.myMailboxUrl) {
      throw new Error(
        "join failed: inviter is offline/unreachable and this node has no mailbox to receive the reply — set circles.mailbox.url",
      );
    }
    const pending: PendingJoin = {
      inviteId: invite.inviteId,
      circleId: invite.circleId,
      inviterPubkey: invite.inviterPubkey,
      inviterMailboxUrl: invite.inviterMailboxUrl,
      inviterBoxPubkey: invite.inviterBoxPubkey,
      secret: invite.secret,
      joinEnvelope,
      attempts: 1,
      nextAttemptAt: 0,
      expiresAt: invite.expiresAt,
      createdAt: Date.now(),
    };
    upsertPendingJoin(this.db, pending);
    await this.postJoinToInviterMailbox(pending);
    log.info(`join for circle ${invite.circleId} posted to inviter mailbox (pending welcome)`);
    return {
      circleId: invite.circleId,
      circleName: invite.circleName,
      inviterName: invite.inviterName,
      members: 0,
      status: "pending",
    };
  }

  /** The invitee's signed `join` envelope (its dial-back coordinates). */
  private buildJoinEnvelope(circleId: string): CircleEnvelope {
    return makeCircleEnvelope(
      "join",
      circleId,
      {
        display_name: this.displayName,
        a2a_url: this.a2aPublicUrl ?? null,
        box_pubkey: this.boxKeys.publicKeyB64,
        mailbox_url: this.myMailboxUrl ?? null,
      },
      this.key,
    );
  }

  /**
   * Mirror a join/welcome roster into our local store. Shared by the direct
   * (sync) path and the mailbox `welcome` path. Returns the member count, or
   * throws if the returned circle does not match the invite/pending circle.
   */
  private importJoinResult(
    invite: { circleId: string; circleName: string; circleKind: string },
    raw: Record<string, unknown>,
  ): number {
    const result = raw as {
      circle?: {
        circleId?: string;
        name?: string;
        kind?: string;
        creatorPubkey?: string;
        keyEpoch?: number;
        createdAt?: number;
      };
      members?: Array<{
        memberPubkey?: string;
        displayName?: string | null;
        a2aUrl?: string | null;
        boxPubkey?: string | null;
        mailboxUrl?: string | null;
        role?: string;
        scopes?: string[];
        joinedAt?: number;
      }>;
    };
    const circle = result.circle;
    if (
      !circle ||
      circle.circleId !== invite.circleId ||
      typeof circle.creatorPubkey !== "string"
    ) {
      throw new Error("join failed: inviter returned a mismatched circle");
    }
    // Central collision guard (review #1, defence in depth): never let an
    // imported roster overwrite a circle we already know under a different owner.
    const known = this.store.getCircle(circle.circleId);
    if (known && known.creatorPubkey !== circle.creatorPubkey) {
      throw new Error("join failed: circle id collides with a known circle under another owner");
    }
    const members = (result.members ?? []).filter(
      (m): m is { memberPubkey: string } & typeof m => typeof m.memberPubkey === "string",
    );
    this.store.importCircle(
      {
        circleId: circle.circleId,
        name: typeof circle.name === "string" ? circle.name : invite.circleName,
        kind: typeof circle.kind === "string" ? circle.kind : invite.circleKind,
        creatorPubkey: circle.creatorPubkey,
        keyEpoch: typeof circle.keyEpoch === "number" ? circle.keyEpoch : 0,
        createdAt: typeof circle.createdAt === "number" ? circle.createdAt : Date.now(),
      },
      members.map((m) => ({
        memberPubkey: m.memberPubkey,
        displayName: m.displayName ?? null,
        a2aUrl: m.a2aUrl ?? null,
        boxPubkey: m.boxPubkey ?? null,
        mailboxUrl: m.mailboxUrl ?? null,
        role: m.role === "creator" ? "creator" : "member",
        scopes: m.scopes,
        joinedAt: m.joinedAt,
      })),
    );
    return members.length;
  }

  /**
   * Seal the join request into the inviter's mailbox, addressed to the inviter's
   * signing pubkey. Only the inviter's box key can open it, so the mailbox host
   * stores ciphertext it cannot read.
   */
  private async postJoinToInviterMailbox(pending: PendingJoin): Promise<boolean> {
    let blob: string;
    try {
      blob = JSON.stringify(
        sealToBox(
          pending.inviterBoxPubkey,
          JSON.stringify({
            method: "circle/join",
            inviteId: pending.inviteId,
            secret: pending.secret,
            join: pending.joinEnvelope,
          }),
        ),
      );
    } catch (err) {
      log.debug(`join seal for ${pending.circleId} failed: ${String(err)}`);
      return false;
    }
    const proof = buildMailboxProof({
      verb: "post",
      pubkey: this.pubkey,
      privateKey: this.key.privateKey,
      extra: blobDigest(pending.inviterPubkey, blob),
    });
    const rpc = await circleRpc(this.fetchImpl, pending.inviterMailboxUrl, "mailbox/post", {
      to: pending.inviterPubkey,
      blob,
      proof,
    });
    return rpc.ok;
  }

  /**
   * Re-post every un-expired pending mailbox join. The fast scheduler calls this
   * each drain cycle so a join placed while the inviter was offline is retried
   * until their signed welcome lands (or the invite expires). Idempotent: a
   * re-post is a rejoin on the inviter side, which just re-sends the welcome.
   */
  async repostPendingJoins(): Promise<number> {
    const now = Date.now();
    const due = listDuePendingJoins(this.db, now);
    let reposted = 0;
    for (const p of due) {
      // Advance the backoff on every attempt (success or not) so an offline
      // inviter cannot make us hammer their mailbox — review #2.
      bumpPendingJoinAttempt(this.db, p.inviteId, now);
      if (await this.postJoinToInviterMailbox(p)) {
        reposted += 1;
      }
    }
    return reposted;
  }

  // -------------------------------------------------------------------------
  // Conversation + presence fan-out: direct dial first, mailbox fallback
  // (§3.2 — every circle interaction must survive asymmetric online windows)
  // -------------------------------------------------------------------------

  /** Members of a circle other than ourselves. */
  private peerMembers(circleId: string): CircleMember[] {
    return this.store.getMembers(circleId).filter((m) => m.memberPubkey !== this.pubkey);
  }

  /**
   * Deposit a sealed copy of the verb call in the member's mailbox. The
   * plaintext is {method, envelope}; it is sealed to the member's box key,
   * so the mailbox host stores ciphertext it cannot read.
   */
  private async postToMailbox(
    member: CircleMember,
    method: string,
    envelope: CircleEnvelope,
  ): Promise<boolean> {
    if (!member.mailboxUrl || !member.boxPubkey) {
      return false;
    }
    let blob: string;
    try {
      blob = JSON.stringify(sealToBox(member.boxPubkey, JSON.stringify({ method, envelope })));
    } catch (err) {
      log.debug(`mailbox seal for ${member.memberPubkey.slice(0, 24)}… failed: ${String(err)}`);
      return false;
    }
    const proof = buildMailboxProof({
      verb: "post",
      pubkey: this.pubkey,
      privateKey: this.key.privateKey,
      extra: blobDigest(member.memberPubkey, blob),
    });
    const rpc = await circleRpc(this.fetchImpl, member.mailboxUrl, "mailbox/post", {
      to: member.memberPubkey,
      blob,
      proof,
    });
    return rpc.ok;
  }

  /** Deliver one envelope to one member: direct dial first, mailbox fallback. */
  private async deliverToMember(
    member: CircleMember,
    method: string,
    envelope: CircleEnvelope,
  ): Promise<boolean> {
    if (member.a2aUrl) {
      const rpc = await circleRpc(this.fetchImpl, member.a2aUrl, method, { envelope });
      if (rpc.ok) return true;
      log.debug(`direct ${method} to ${member.memberPubkey.slice(0, 24)}… failed: ${rpc.error}`);
    }
    // Offline or unreachable: store-and-forward. Presence beats are
    // point-in-time and skip the mailbox (stale presence is noise).
    if (method !== "circle/presence" && (await this.postToMailbox(member, method, envelope))) {
      return true;
    }
    return false;
  }

  private async fanOut(
    circleId: string,
    method: string,
    envelope: CircleEnvelope,
  ): Promise<SendReport> {
    // PLAN-36 Phase 4: one publish to the circle's blinded topic reaches any
    // subscribed+online member over the mesh, no a2aUrl required. Best-effort
    // and additive — the direct-dial + mailbox paths below still run, and the
    // receiver's envelope-id dedupe collapses any overlap. (Delivery status
    // still reflects direct/mailbox; the topic reach is a bonus.)
    const bus = this.topicBus();
    if (bus) {
      try {
        const epoch = this.store.getCircle(circleId)?.keyEpoch ?? 0;
        await publishCircleFrame(bus, circleId, epoch, method, envelope);
      } catch (err) {
        log.debug(`topic publish for ${circleId} failed: ${String(err)}`);
      }
    }
    // Bounded-parallel so one unreachable member (dial times out after
    // DIAL_TIMEOUT_MS) cannot serialize the whole fan-out. push() between
    // awaits is safe on the single JS thread; callers that assert on order
    // sort the arrays (delivered/failed are sets, not sequences).
    const report: SendReport = { delivered: [], failed: [] };
    await runBounded(this.peerMembers(circleId), FANOUT_CONCURRENCY, async (member) => {
      const ok = await this.deliverToMember(member, method, envelope);
      (ok ? report.delivered : report.failed).push(member.memberPubkey);
    });
    return report;
  }

  /**
   * Subscribe to every active non-practice circle's blinded topic so this node
   * RECEIVES mesh messages for them. Idempotent; the fast scheduler calls it
   * each cycle so newly-joined circles get subscribed and epoch bumps re-home
   * the subscription. No-op when no topic bus is active.
   */
  async ensureCircleSubscriptions(): Promise<void> {
    const bus = this.topicBus();
    if (!bus) return;
    for (const c of this.listCircles()) {
      if (c.kind === PRACTICE_KIND) continue;
      try {
        await bus.subscribe(circleTopicId(c.circleId, c.keyEpoch));
      } catch (err) {
        log.debug(`topic subscribe for ${c.circleId} failed: ${String(err)}`);
      }
    }
  }

  /**
   * Send an agent message (or ask/answer) into a circle. Outbound copy is
   * recorded locally for the conversation view + reciprocity metrics.
   */
  async sendMessage(args: {
    circleId: string;
    text: string;
    kind?: "message" | "ask" | "answer";
    threadId?: string;
  }): Promise<SendReport & { envelopeId: string }> {
    const kind = args.kind ?? "message";
    const circle = this.store.getCircle(args.circleId);
    if (!circle || circle.status !== "active") {
      throw new Error(`circle ${args.circleId} is not active`);
    }
    const body: Record<string, JsonValue> = { text: args.text };
    if (args.threadId) {
      body.thread_id = args.threadId;
    }
    const envelope = makeCircleEnvelope(
      kind === "message" ? "message" : kind === "ask" ? "ask" : "answer",
      args.circleId,
      body,
      this.key,
    );
    const messageId = crypto.randomUUID();
    this.db
      .prepare(
        `INSERT INTO circle_messages
           (message_id, circle_id, author_pubkey, direction, kind, thread_id, content,
            scan_severity, envelope_id, created_at, delivery_status)
         VALUES (?, ?, ?, 'out', ?, ?, ?, NULL, ?, ?, 'pending')`,
      )
      .run(
        messageId,
        args.circleId,
        this.pubkey,
        kind,
        args.threadId ?? null,
        args.text,
        envelope.id,
        Date.now(),
      );
    const method =
      kind === "message" ? "circle/message" : kind === "ask" ? "circle/ask" : "circle/answer";
    // The practice circle is local-only: no network fan-out; the labeled bot
    // replies immediately through the same inbound path a friend would use.
    if (circle.kind === PRACTICE_KIND) {
      this.setDeliveryStatus(messageId, "delivered");
      await this.practiceSweep();
      return { delivered: [], failed: [], envelopeId: envelope.id };
    }
    const report = await this.fanOut(args.circleId, method, envelope);
    this.setDeliveryStatus(messageId, deliveryStatusFromReport(report));
    return { ...report, envelopeId: envelope.id };
  }

  /** Update the per-message delivery aggregate after fan-out (PLAN-36 B5). */
  private setDeliveryStatus(messageId: string, status: DeliveryStatus): void {
    this.db
      .prepare(`UPDATE circle_messages SET delivery_status = ? WHERE message_id = ?`)
      .run(status, messageId);
  }

  /**
   * Practice-partner upkeep (§4.3): keep the labeled bot circle alive while
   * the user has no real connections, reply to their practice messages, and
   * retire the circle the moment a real connection exists.
   */
  async practiceSweep(): Promise<boolean> {
    if (this.config.circles?.practicePartner?.enabled === false) {
      return false;
    }
    const partnerKey =
      this.practiceKeysLazy ?? (this.practiceKeysLazy = loadOrCreatePracticeKeys());
    return await practiceReply(this.db, { selfPubkey: this.pubkey, partnerKey });
  }

  /** Weekly briefing upkeep: compile when due (maintenance tick). */
  briefingSweep(): CompiledBriefing | null {
    if (this.config.circles?.briefing?.enabled === false) {
      return null;
    }
    return compileBriefingIfDue(this.db, { selfPubkey: this.pubkey });
  }

  /** The latest compiled briefing for the UI. */
  briefing(): CompiledBriefing | null {
    return latestBriefing(this.db);
  }

  /** Presence heartbeat to every connected circle (cheap, batched by caller). */
  async heartbeat(): Promise<void> {
    const circles = this.store.getCirclesForMember(this.pubkey);
    for (const circle of circles) {
      const envelope = makeCircleEnvelope(
        "presence",
        circle.circleId,
        {
          a2a_url: this.a2aPublicUrl ?? null,
          box_pubkey: this.boxKeys.publicKeyB64,
          mailbox_url: this.myMailboxUrl ?? null,
          status: "online",
        },
        this.key,
      );
      await this.fanOut(circle.circleId, "circle/presence", envelope);
    }
  }

  /**
   * Drain our mailbox: poll the configured host, open each sealed blob with
   * our box key, and dispatch the inner {method, envelope} through the SAME
   * local A2A handlers a direct dial would hit — one auth/scan/dedupe path,
   * whether a message arrived live or slept 3 days on a relay. Ack only what
   * dispatched (or was garbage); a handler error leaves the blob for retry.
   */
  async pollMailbox(): Promise<{ received: number; dispatched: number }> {
    const url = this.myMailboxUrl;
    if (!url) {
      return { received: 0, dispatched: 0 };
    }
    const proof = buildMailboxProof({
      verb: "poll",
      pubkey: this.pubkey,
      privateKey: this.key.privateKey,
      extra: "0",
    });
    const rpc = await circleRpc(this.fetchImpl, url, "mailbox/poll", { proof, since: 0 });
    if (!rpc.ok || !rpc.result) {
      return { received: 0, dispatched: 0 };
    }
    const blobs = (rpc.result as { blobs?: Array<{ blobId: string; blob: string }> }).blobs ?? [];
    const { handleCircleMethod } = await import("../gateway/a2a/circles.js");
    const ackIds: string[] = [];
    let dispatched = 0;
    for (const item of blobs) {
      let inner: MailboxInner | null = null;
      try {
        const sealed = JSON.parse(item.blob) as SealedBlob;
        const opened = openBox(this.boxKeys, sealed);
        inner = opened ? (JSON.parse(opened) as MailboxInner) : null;
      } catch {
        inner = null;
      }
      const method = inner?.method;

      // §4 INVITER side: a sealed mailbox join request. Run it through the SAME
      // circle/join handler a direct dial hits, then mail the signed `welcome`
      // roster back to the invitee. Always ack — a re-post arrives as a fresh
      // blob (rejoin), and a permanently-bad secret never becomes valid.
      if (method === "circle/join" && inner?.inviteId && inner.secret && inner.join) {
        const outcome = handleCircleMethod(
          "circle/join",
          { inviteId: inner.inviteId, secret: inner.secret, join: inner.join },
          this.db,
        );
        if (outcome.ok) {
          dispatched += 1;
          await this.sendWelcome(inner.join as CircleEnvelope, outcome.result as CircleJoinResult);
        } else {
          log.debug(`mailbox join rejected: ${outcome.error.message}`);
        }
        ackIds.push(item.blobId);
        continue;
      }

      // §4 INVITEE side: a signed `welcome` roster answering our pending join.
      // importWelcome authenticates it (pending-join match + signer). Always ack
      // — an unsolicited/forged welcome is dropped, and a genuine retry re-arrives.
      if (method === "circle/welcome" && inner?.envelope) {
        if (this.importWelcome(inner.envelope as CircleEnvelope)) {
          dispatched += 1;
        }
        ackIds.push(item.blobId);
        continue;
      }

      if (!method || !method.startsWith("circle/") || !inner?.envelope) {
        // Garbage or not-for-us: ack so it never clogs the box.
        ackIds.push(item.blobId);
        continue;
      }
      const outcome = handleCircleMethod(method, { envelope: inner.envelope }, this.db);
      if (outcome.ok) {
        dispatched += 1;
        ackIds.push(item.blobId);
      } else if (!/rate limit/i.test(outcome.error.message)) {
        // A handler error on an IMMUTABLE envelope is deterministic — an
        // unauthorized/duplicate/malformed blob will fail identically forever,
        // so ack it (drop) rather than reprocess it every cycle until its 30-day
        // TTL, which a hostile co-member could exploit to clog the box (review
        // #4). ONLY a rate-limit is transient, so that alone is left for retry.
        ackIds.push(item.blobId);
      }
    }
    if (ackIds.length > 0) {
      const ackProof = buildMailboxProof({
        verb: "ack",
        pubkey: this.pubkey,
        privateKey: this.key.privateKey,
        extra: ackIds.join(","),
      });
      await circleRpc(this.fetchImpl, url, "mailbox/ack", { proof: ackProof, blobIds: ackIds });
    }
    return { received: blobs.length, dispatched };
  }

  /**
   * INVITER side of the §4 rendezvous: mail a signed `welcome` roster back to a
   * member who joined via our mailbox. Sealed to their box key and addressed to
   * their signing pubkey, both taken from the join envelope they signed — so
   * only they can open it, and the signature lets them authenticate us.
   */
  private async sendWelcome(joinEnv: CircleEnvelope, result: CircleJoinResult): Promise<void> {
    const body = joinEnv.body as Record<string, unknown>;
    const toPubkey = joinEnv.author_pubkey;
    const boxPubkey = typeof body.box_pubkey === "string" ? body.box_pubkey : "";
    const mailboxUrl =
      typeof body.mailbox_url === "string" && /^https?:\/\//.test(body.mailbox_url)
        ? body.mailbox_url
        : "";
    if (!boxPubkey || !mailboxUrl) {
      log.debug(`welcome skipped for ${joinEnv.circle_id}: invitee left no mailbox rendezvous`);
      return;
    }
    const welcomeEnv = makeCircleEnvelope(
      "welcome",
      joinEnv.circle_id,
      {
        circle: result.circle as unknown as JsonValue,
        members: result.members as unknown as JsonValue,
      },
      this.key,
    );
    let blob: string;
    try {
      blob = JSON.stringify(
        sealToBox(boxPubkey, JSON.stringify({ method: "circle/welcome", envelope: welcomeEnv })),
      );
    } catch (err) {
      log.debug(`welcome seal for ${joinEnv.circle_id} failed: ${String(err)}`);
      return;
    }
    const proof = buildMailboxProof({
      verb: "post",
      pubkey: this.pubkey,
      privateKey: this.key.privateKey,
      extra: blobDigest(toPubkey, blob),
    });
    await circleRpc(this.fetchImpl, mailboxUrl, "mailbox/post", { to: toPubkey, blob, proof });
  }

  /**
   * INVITEE side of the §4 rendezvous: import a signed `welcome` roster. Accepted
   * ONLY when it is a valid `welcome` envelope AND matches a pending join for the
   * same circle signed by the SAME pubkey that signed the invite — so a random
   * party cannot seal us a bogus circle (they would need the inviter's key).
   */
  private importWelcome(env: CircleEnvelope): boolean {
    const validation = validateCircleEnvelope(env, {
      now: Math.floor(Date.now() / 1000),
      expectedType: "welcome",
      maxSkewSeconds: MAILBOX_MAX_AGE_SECONDS,
    });
    if (!validation.ok) {
      log.debug(`welcome rejected: ${validation.error}`);
      return false;
    }
    const pending = matchPendingJoin(this.db, env.circle_id, env.author_pubkey, Date.now());
    if (!pending) {
      log.debug(`welcome for ${env.circle_id} has no matching pending join; dropped`);
      return false;
    }
    const body = env.body as Record<string, unknown>;
    try {
      this.importJoinResult(
        { circleId: pending.circleId, circleName: "circle", circleKind: "connection" },
        { circle: body.circle, members: body.members },
      );
    } catch (err) {
      log.debug(`welcome import for ${env.circle_id} failed: ${String(err)}`);
      return false;
    }
    deletePendingJoin(this.db, pending.inviteId);
    log.info(`joined circle ${env.circle_id} via mailbox welcome`);
    return true;
  }

  // -------------------------------------------------------------------------
  // Graph answers (C2, §3.5): background capability, never a marquee hook
  // -------------------------------------------------------------------------

  /**
   * Put a question to the trusted graph. The category rides in the thread id
   * ("<category>:<uuid>") so answering nodes can match it against their
   * humans' disclosure grants.
   */
  async askPeople(args: {
    circleId: string;
    question: string;
    category: string;
  }): Promise<SendReport & { threadId: string }> {
    const category = args.category.trim().toLowerCase().replaceAll(":", ".").slice(0, 24);
    if (!category) {
      throw new Error("category required");
    }
    const threadId = `${category}:${crypto.randomUUID()}`;
    const report = await this.sendMessage({
      circleId: args.circleId,
      text: args.question,
      kind: "ask",
      threadId,
    });
    return { ...report, threadId };
  }

  /**
   * The §3.5 default posture, automated: every pending inbound ask whose
   * category the human has NOT granted gets one polite refusal ("my human
   * can see this question; I'll reply if they've allowed this topic").
   * Granted asks are LEFT PENDING for the human/agent surface — autonomy
   * ends where the grant begins; nothing from private memory is ever
   * auto-disclosed by this sweep.
   */
  async answerPendingAsks(): Promise<{ declined: number; awaitingHuman: number }> {
    let declined = 0;
    let awaitingHuman = 0;
    for (const ask of pendingAsks(this.db)) {
      const allowed =
        ask.category !== null && isDisclosureAllowed(this.db, ask.category, ask.circleId);
      if (allowed) {
        awaitingHuman += 1;
        continue;
      }
      try {
        await this.sendMessage({
          circleId: ask.circleId,
          text: DEFAULT_ANSWER_POSTURE,
          kind: "answer",
          threadId: ask.threadId ?? undefined,
        });
        declined += 1;
      } catch (err) {
        log.debug(`default-posture answer failed: ${String(err)}`);
      }
    }
    return { declined, awaitingHuman };
  }

  // -------------------------------------------------------------------------
  // The shared tab (C2, v3): typed chained events, NO settlement
  // -------------------------------------------------------------------------

  /**
   * Append a tab event (expense/reversal/note) to OUR chain and fan it out.
   * The local write goes through the SAME validated append path a peer's
   * would (membership + scope + chain + fork checks) — one ledger law for
   * everyone, ourselves included.
   */
  async appendTabEvent(args: {
    circleId: string;
    input: TabEventInput;
  }): Promise<SendReport & { eventId: string; seq: number }> {
    const circle = this.store.getCircle(args.circleId);
    if (!circle || circle.status !== "active") {
      throw new Error(`circle ${args.circleId} is not active`);
    }
    const body = buildChainedEventBody(this.db, {
      circleId: args.circleId,
      authorPubkey: this.pubkey,
      input: args.input,
    });
    const envelope = makeCircleEnvelope(
      "event",
      args.circleId,
      body as unknown as Record<string, JsonValue>,
      this.key,
    );
    const { handleCircleMethod } = await import("../gateway/a2a/circles.js");
    const local = handleCircleMethod("circle/event.append", { envelope }, this.db);
    if (!local.ok) {
      throw new Error(`tab append refused: ${local.error.message}`);
    }
    const report = await this.fanOut(args.circleId, "circle/event.append", envelope);
    return { ...(local.result as { eventId: string; seq: number }), ...report };
  }

  /** The tab's current fold: net + pairwise balances, display only. */
  tabBalances(circleId: string): TabBalances {
    return computeTabBalances(this.db, circleId);
  }

  /**
   * Pull missing events from peers and replay each signed envelope through
   * our own validated append path. Best-effort per peer; a peer serving a
   * forked chain freezes the circle here exactly as a live append would.
   * (v1 window: envelopes older than the 30d mailbox ceiling do not sync —
   * fresh circles are whole; deep-history import for late joiners is a
   * Phase-2 concern.)
   */
  async syncEvents(circleId: string): Promise<{ applied: number }> {
    const { handleCircleMethod } = await import("../gateway/a2a/circles.js");
    let applied = 0;
    for (const member of this.peerMembers(circleId)) {
      if (!member.a2aUrl) {
        continue;
      }
      const ask = makeCircleEnvelope("presence", circleId, { since: 0 }, this.key);
      const rpc = await circleRpc(this.fetchImpl, member.a2aUrl, "circle/events.since", {
        envelope: ask,
      });
      if (!rpc.ok || !rpc.result) {
        continue;
      }
      const events = (rpc.result as { events?: Array<{ envelope?: unknown }> }).events ?? [];
      for (const ev of events) {
        if (!ev.envelope) {
          continue;
        }
        const outcome = handleCircleMethod(
          "circle/event.append",
          { envelope: ev.envelope },
          this.db,
        );
        if (outcome.ok && !(outcome.result as { duplicate?: boolean }).duplicate) {
          applied += 1;
        }
      }
    }
    return { applied };
  }

  // -------------------------------------------------------------------------
  // Local reads (the Circles pane + conversation views)
  // -------------------------------------------------------------------------

  listCircles(): Circle[] {
    return this.store.getCirclesForMember(this.pubkey);
  }

  /** Unread inbound count per circle (PLAN-36 A2), for the rail badges. */
  unreadByCircle(): Record<string, number> {
    return unreadCounts(this.db);
  }

  /** Mark a circle read up to now — called when the human opens it (A2). */
  markRead(circleId: string): void {
    markCircleRead(this.db, circleId, Date.now());
  }

  /**
   * True if this node has at least one active, non-practice circle — i.e. real
   * network work a fast sweep should service. The practice circle is local-only
   * (no fan-out), so a node with only a practice partner idles the fast timer
   * (PLAN-36 Phase 0 scheduler idle-backoff).
   */
  hasActiveCircles(): boolean {
    return this.listCircles().some((c) => c.kind !== PRACTICE_KIND);
  }

  /**
   * Distinct connected HUMANS across all circles (the friend-node count).
   * The practice partner never counts — it is a bot and says so (§4.3).
   */
  connectionCount(): number {
    return realConnectionCount(this.db, this.pubkey);
  }

  peerPresence(): Array<{
    peerPubkey: string;
    a2aUrl: string | null;
    lastSeenAt: number;
    lastStatus: string | null;
  }> {
    const rows = this.db
      .prepare(
        `SELECT peer_pubkey, a2a_url, last_seen_at, last_status
           FROM circle_peer_presence ORDER BY last_seen_at DESC`,
      )
      .all() as unknown as Array<{
      peer_pubkey: string;
      a2a_url: string | null;
      last_seen_at: number;
      last_status: string | null;
    }>;
    return rows.map((r) => ({
      peerPubkey: r.peer_pubkey,
      a2aUrl: r.a2a_url,
      lastSeenAt: r.last_seen_at,
      lastStatus: r.last_status,
    }));
  }

  messages(
    circleId: string,
    limit = 100,
  ): Array<{
    messageId: string;
    authorPubkey: string;
    direction: string;
    kind: string;
    threadId: string | null;
    content: string;
    createdAt: number;
    deliveryStatus: DeliveryStatus | null;
  }> {
    const rows = this.db
      .prepare(
        `SELECT message_id, author_pubkey, direction, kind, thread_id, content, created_at,
                delivery_status
           FROM circle_messages WHERE circle_id = ?
          ORDER BY created_at DESC LIMIT ?`,
      )
      .all(circleId, Math.min(limit, 500)) as unknown as Array<{
      message_id: string;
      author_pubkey: string;
      direction: string;
      kind: string;
      thread_id: string | null;
      content: string;
      created_at: number;
      delivery_status: DeliveryStatus | null;
    }>;
    return rows.map((r) => ({
      messageId: r.message_id,
      authorPubkey: r.author_pubkey,
      direction: r.direction,
      kind: r.kind,
      threadId: r.thread_id,
      content: r.content,
      createdAt: r.created_at,
      deliveryStatus: r.delivery_status,
    }));
  }

  /**
   * Reciprocity per peer (PLAN-31 §9 North Star: weekly reciprocated agent
   * conversations across distinct contacts): a peer counts as reciprocated
   * in the window when BOTH an inbound message from them and an outbound
   * message from us exist in the same circle.
   */
  reciprocity(windowMs: number = 7 * 24 * 60 * 60 * 1000): {
    reciprocatedPeers: number;
    activePeers: number;
  } {
    const cutoff = Date.now() - windowMs;
    const row = this.db
      .prepare(
        `WITH inbound AS (
           SELECT DISTINCT circle_id, author_pubkey AS peer FROM circle_messages
            WHERE direction = 'in' AND created_at > ?
         ),
         outbound AS (
           SELECT DISTINCT circle_id FROM circle_messages
            WHERE direction = 'out' AND created_at > ?
         )
         SELECT
           (SELECT COUNT(DISTINCT peer) FROM inbound) AS active,
           (SELECT COUNT(DISTINCT i.peer) FROM inbound i
             JOIN outbound o ON o.circle_id = i.circle_id) AS reciprocated`,
      )
      .get(cutoff, cutoff) as { active: number; reciprocated: number } | undefined;
    return {
      reciprocatedPeers: row?.reciprocated ?? 0,
      activePeers: row?.active ?? 0,
    };
  }
}
