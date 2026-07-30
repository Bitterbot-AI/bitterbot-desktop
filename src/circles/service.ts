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
  claimAgentDraft,
  detectAgentSummon,
  generateQueuedAgentDrafts,
  getAgentDraft,
  listReadyAgentDrafts,
  queueAgentDraft,
  queueAgentSliceDraft,
  queueAgentStudyDraft,
  setAgentDraftStatus,
  sweepAgentDraftHousekeeping,
  type AgentDraft,
  type DraftLlmCall,
} from "./agent-drafts.js";
import { computeMessageAnnotations, type MessageAnnotations } from "./annotations.js";
import {
  loadOrCreateBoxKeys,
  openBox,
  sealToBox,
  type BoxKeyPair,
  type SealedBlob,
} from "./box-crypto.js";
import { compileBriefingIfDue, latestBriefing, type CompiledBriefing } from "./briefing.js";
import {
  computeCanvasCards,
  computeCanvasState,
  maxCardStamp,
  type CanvasCard,
  type CanvasState,
} from "./canvas.js";
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
  claimPendingOutbound,
  listPendingOutbound,
  revertPendingOutbound,
  type PendingOutbound,
} from "./pending-outbound.js";
import {
  PRACTICE_KIND,
  PRACTICE_PARTNER_NAME,
  loadOrCreatePracticeKeys,
  practiceReply,
  realConnectionCount,
} from "./practice.js";
import { markCircleRead, unreadCounts } from "./read-state.js";
import {
  parseProposalSlot,
  practiceSandboxSweep,
  SANDBOX_DRAFT_KIND,
  sweepSandboxTurns,
  validateSandboxMoveText,
} from "./sandbox-agent.js";
import {
  computeSandboxSessions,
  getSandboxParticipation,
  isMyTurn,
  pauseSandboxParticipation,
  resumeSandboxParticipation,
  setSandboxParticipation,
  steerSandboxParticipation,
  type SandboxCloseReason,
  type SandboxMoveKind,
  type SandboxParticipation,
  type SandboxSession,
} from "./sandbox.js";
import { listStudyState, recordStudyResult, type StudySectionState } from "./study.js";
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
  /**
   * Phase B: the quarantined tool-less completion used to generate agent
   * drafts (one prompt in, plain text out — the judge-provider pattern).
   * Only the scheduler-owned service instance carries it; RPC-owned instances
   * (list/publish/discard) never generate and leave it unset.
   */
  draftLlm?: DraftLlmCall;
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
): Promise<{ ok: boolean; result?: Record<string, unknown>; error?: string; refused?: boolean }> {
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
    // The peer ANSWERED with a refusal — that is a definitive application
    // outcome (bad secret, bound invite, revoked…), not a reachability
    // problem. Callers must not retry it through the mailbox.
    if (body.error) return { ok: false, refused: true, error: body.error.message ?? "rpc error" };
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
  private readonly draftLlm: DraftLlmCall | undefined;
  readonly store: CirclesStore;

  constructor(deps: CirclesServiceDeps) {
    this.db = deps.db;
    this.config = deps.config;
    this.fetchImpl = deps.fetchImpl ?? (fetch as unknown as FetchLike);
    this.key = deps.keyPair ?? keyPairFromPrivateKeyPem(loadOrCreateDeviceIdentity().privateKeyPem);
    this.boxKeys = deps.boxKeys ?? loadOrCreateBoxKeys();
    this.practiceKeysLazy = deps.practiceKeys;
    this.topicBusDep = deps.topicBus;
    this.draftLlm = deps.draftLlm;
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
    // §5.6: the in-app self-name (node-local setting) wins; then config, then
    // the assistant name, then the generic default.
    const set = this.store.getSetting("display_name")?.trim();
    if (set) return set;
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
      creatorDisplayName: this.displayName,
    });
  }

  /**
   * Mint an invite code for a circle (creating a fresh connection circle
   * when none is given). The code is returned ONCE; only its hash persists.
   */
  createInviteCode(args: {
    circleId?: string;
    name?: string;
    ttlMs?: number;
    /** Bind redemption to one pubkey (send-to-connection path). */
    targetPubkey?: string;
  }): CreatedInvite & {
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
      targetPubkey: args.targetPubkey,
    });
    return { ...invite, circleId };
  }

  /**
   * Deliver an invite code to an ALREADY-CONNECTED peer through a circle you
   * both share (the "add someone I know" path — no copy/paste ceremony).
   * The code rides the normal signed message path in the smallest shared
   * active circle (a 1:1 connection when one exists); the receiver's UI
   * detects it and offers a one-tap Join. Sending is not consent — the
   * receiving human still reviews the parsed invite and taps Join themselves.
   */
  async sendInviteToConnection(args: {
    code: string;
    targetPubkey: string;
    circleName: string;
  }): Promise<SendReport & { viaCircleId: string }> {
    // STRICTLY a 1:1 circle (exactly us + them). Fan-out delivers to every
    // member of the delivery circle, and even a target-bound code should not
    // be broadcast to bystanders (adversarial review #2). No 1:1 → refuse and
    // let the human share the invite link instead.
    const via = this.listCircles().find((c) => {
      if (c.status !== "active") return false;
      const members = this.store.getMembers(c.circleId);
      return members.length === 2 && members.some((m) => m.memberPubkey === args.targetPubkey);
    });
    if (!via) {
      throw new Error(
        "no direct 1:1 circle with that person — share the invite link with them instead",
      );
    }
    const report = await this.sendMessage({
      circleId: via.circleId,
      text:
        `I'd like to add you to my circle "${args.circleName}". ` +
        `Paste this invite code in your Circles pane to join (or tap Join if your app offers it):\n${args.code}`,
    });
    return { ...report, viaCircleId: via.circleId };
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
      if (rpc.refused) {
        // The inviter's node answered and said no — surface the real reason
        // instead of masking it as "unreachable" and queuing mailbox retries.
        throw new Error(`join refused: ${rpc.error}`);
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
    replyTo?: string;
    /**
     * Phase B internal: set when the message IS a published agent draft, so
     * agent output can never re-summon the agent (a draft containing "@agent"
     * must not loop back into generation).
     */
    suppressAgentSummon?: boolean;
    /**
     * Mockup pin 2: the text was WRITTEN BY the author's agent (published
     * draft / approved agent-tool send). Presentation provenance — carried in
     * the body so every member's stream renders "<name>'s agent", never the
     * human. Human consent still gated the send; this only labels authorship.
     */
    agentAuthored?: boolean;
  }): Promise<SendReport & { envelopeId: string }> {
    const kind = args.kind ?? "message";
    const circle = this.store.getCircle(args.circleId);
    if (!circle || circle.status !== "active") {
      throw new Error(`circle ${args.circleId} is not active`);
    }
    const body: Record<string, JsonValue> = { text: args.text };
    if (args.agentAuthored) {
      body.agent_authored = true;
    }
    if (args.threadId) {
      body.thread_id = args.threadId;
    }
    // A3: reference the parent by its envelope id (stable across every node).
    const replyTo = args.replyTo ? args.replyTo.slice(0, 64) : null;
    if (replyTo) {
      body.reply_to = replyTo;
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
            scan_severity, envelope_id, created_at, delivery_status, reply_to, agent_authored)
         VALUES (?, ?, ?, 'out', ?, ?, ?, NULL, ?, ?, 'pending', ?, ?)`,
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
        replyTo,
        args.agentAuthored ? 1 : 0,
      );
    // Phase B self-summon: our human typing @agent in their OWN message queues
    // a draft on this node too (a peer's @agent queues on receipt instead).
    // Quiet-by-default: no token, nothing happens.
    if (
      kind === "message" &&
      !args.suppressAgentSummon &&
      this.agentDraftsEnabled() &&
      detectAgentSummon(args.text)
    ) {
      queueAgentDraft(this.db, {
        circleId: args.circleId,
        summonEnvelopeId: envelope.id,
        summonAuthorPubkey: this.pubkey,
      });
    }
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
          // §5.6: carry our current self-name so a rename reaches existing
          // friends' rosters on the next beat.
          display_name: this.displayName,
          // Roster posture (mockup pin 3): what our agent can do in this
          // circle, so friends' rosters answer "who and what can hear this".
          agent_posture: this.selfAgentPosture(),
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
    /** Review #4: set when the QUESTION was agent-written (approved tool ask). */
    agentAuthored?: boolean;
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
      agentAuthored: args.agentAuthored,
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
          // Review #4b: this is automated agent text (no human in the loop) —
          // it must never render as the human speaking.
          agentAuthored: true,
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

  // -------------------------------------------------------------------------
  // Group canvas (PLAN-36 Phase C): typed cards folded from the event log.
  // -------------------------------------------------------------------------

  /** The group canvas's current cards. */
  canvasCards(circleId: string): CanvasCard[] {
    return computeCanvasCards(this.db, circleId);
  }

  /** Live cards plus legible tombstones (§3.2.9: narration + Undo). */
  canvasState(circleId: string): CanvasState {
    return computeCanvasState(this.db, circleId);
  }

  /**
   * Clear a card: tombstone it and immediately re-put a fresh card with the
   * same title (§3.2.9 — a UI gesture, not a wire concept). The new card id
   * means a fresh sandbox session by construction: round 1, no moves, no
   * votes, zero fold changes. Spend is NOT refunded (R10).
   */
  async clearCanvasCard(args: {
    circleId: string;
    cardId: string;
    keepText: boolean;
  }): Promise<SendReport & { eventId: string; seq: number; newCardId: string }> {
    const card = computeCanvasCards(this.db, args.circleId).find((c) => c.cardId === args.cardId);
    if (!card) throw new Error("that card is not on the canvas");
    const newCardId = crypto.randomUUID();
    // A card must never clear to fully empty (no title AND no text) — that is
    // an un-editable, un-restorable blank. If it has no title, keep the text
    // regardless so the fresh card still carries content.
    const keepText = args.keepText || !card.title.trim();
    // The tombstone is marked superseded_by the replacement so the fold hides
    // it from the removal strip (a clear is not a deletion; no Undo). It is
    // stamped to WIN the old card's slot (§3.2.9 clamp) so a future-dated peer
    // put can't leave the original alive beside the replacement.
    await this.removeCanvasCard({
      circleId: args.circleId,
      cardId: args.cardId,
      supersededBy: newCardId,
    });
    const report = await this.putCanvasCard({
      circleId: args.circleId,
      cardId: newCardId,
      cardType: card.cardType,
      title: card.title,
      text: keepText ? card.text : "",
    });
    return { ...report, newCardId };
  }

  /**
   * Create or update a canvas card (LWW by cardId) + fan it out. The stamp
   * clamps to beat any existing event for this card (§3.2.9): a fresh create
   * gets `now`; an edit or an undo re-put out-orders the prior winner even if
   * that winner (or a peer's forgery) carried a future timestamp.
   */
  async putCanvasCard(args: {
    circleId: string;
    cardId: string;
    cardType: string;
    title: string;
    text: string;
  }): Promise<SendReport & { eventId: string; seq: number }> {
    return this.appendTabEvent({
      circleId: args.circleId,
      input: {
        type: "canvas.card.put",
        cardId: args.cardId,
        cardType: args.cardType,
        title: args.title,
        text: args.text,
        updatedAt: this.nextCardStamp(args.circleId, args.cardId),
      },
    });
  }

  /** Tombstone a canvas card + fan it out. Stamped to win the slot (§3.2.9). */
  async removeCanvasCard(args: {
    circleId: string;
    cardId: string;
    supersededBy?: string;
  }): Promise<SendReport & { eventId: string; seq: number }> {
    return this.appendTabEvent({
      circleId: args.circleId,
      input: {
        type: "canvas.card.remove",
        cardId: args.cardId,
        updatedAt: this.nextCardStamp(args.circleId, args.cardId),
        supersededBy: args.supersededBy,
      },
    });
  }

  /**
   * The stamp a slot-winning write must carry: strictly above every existing
   * put/remove for this card, and never below local now. Lets an honest actor
   * always out-order a forged or clock-skewed future timestamp so delete /
   * clear / undo cannot be permanently defeated (§3.2.9 write-side clamp).
   */
  private nextCardStamp(circleId: string, cardId: string): number {
    return Math.max(Date.now(), maxCardStamp(this.db, circleId, cardId) + 1);
  }

  /**
   * Contribute OUR slice to a card's slot (C2) — e.g. our vote on a Decision
   * Card. One slice per (card, slot, us), last-writer-wins; publishing it is the
   * consent act (in Phase B an agent pre-fills the value; the human still calls
   * this to publish it).
   */
  async putCanvasSlice(args: {
    circleId: string;
    cardId: string;
    slot: string;
    value: string;
    note: string;
  }): Promise<SendReport & { eventId: string; seq: number }> {
    return this.appendTabEvent({
      circleId: args.circleId,
      input: {
        type: "canvas.slice.put",
        cardId: args.cardId,
        slot: args.slot,
        value: args.value,
        note: args.note,
        updatedAt: Date.now(),
      },
    });
  }

  // -------------------------------------------------------------------------
  // Self identity (§5.6): the name friends are introduced to you by.
  // -------------------------------------------------------------------------

  /** The name YOU are shown to friends by (your self-asserted display name). */
  myDisplayName(): string {
    return this.displayName;
  }

  /**
   * Set your own display name (in-app), then push it to every circle via a
   * presence beat so EXISTING friends' rosters refresh — not just new joins.
   * The name is your own input, capped like any name; the peer's petname layer
   * still lets each friend override it for their eyes.
   */
  async setDisplayName(name: string): Promise<void> {
    const clean = name.trim().slice(0, 80);
    if (!clean) throw new Error("name cannot be empty");
    this.store.setSetting("display_name", clean);
    // Best-effort live propagation; the name is stored regardless of reach.
    try {
      await this.heartbeat();
    } catch (err) {
      log.debug(`display-name presence push failed (stored anyway): ${String(err)}`);
    }
  }

  // -------------------------------------------------------------------------
  // Petnames (§5.6): node-local per-person labels + name resolution.
  // -------------------------------------------------------------------------

  /** Our private labels, pubkey -> petname (never leaves this node). */
  petnames(): Record<string, string> {
    return Object.fromEntries(this.store.getPetnames());
  }

  /** Assign / edit our private label for a person (empty clears it). */
  setPetname(memberPubkey: string, petname: string): void {
    if (!/^ed25519:[0-9a-f]{64}$/.test(memberPubkey)) {
      throw new Error("invalid member pubkey");
    }
    if (memberPubkey === this.pubkey) {
      throw new Error("you cannot petname yourself");
    }
    this.store.setPetname(memberPubkey, petname);
  }

  clearPetname(memberPubkey: string): void {
    this.store.clearPetname(memberPubkey);
  }

  /**
   * Rename a circle — NODE-LOCAL, any status. Your label for the group; it
   * never reaches a peer (their copy keeps whatever they call it).
   */
  renameCircle(args: { circleId: string; name: string }): void {
    const clean = args.name.trim().slice(0, 80);
    if (!clean) throw new Error("name cannot be empty");
    if (!this.store.getCircle(args.circleId)) {
      throw new Error(`circle ${args.circleId} not found`);
    }
    this.store.renameCircle(args.circleId, clean);
  }

  /**
   * §5.5: remove a member from a circle (the moderation primitive — evict a
   * bad actor). NODE-LOCAL self-protection: ANY member may prune another from
   * THEIR OWN node's roster (never themselves). Creator-gating was dropped in
   * review — removal only affects this node, so gating it to the creator left
   * every other member unable to protect themselves while the UI told them to
   * "ask the others to remove them too" (§5.5 review F1). The removed member is
   * marked 'left' so `memberHasScope` default-denies all their future writes on
   * this node (the A2A boundary enforces it), and this node stops fanning out
   * to them; their ledger history is untouched. There is no central authority
   * in a P2P circle — each member decides for their own node.
   */
  async removeMember(args: { circleId: string; memberPubkey: string }): Promise<void> {
    const circle = this.store.getCircle(args.circleId);
    if (!circle) throw new Error(`circle ${args.circleId} not found`);
    if (args.memberPubkey === this.pubkey) {
      throw new Error("you cannot remove yourself (leave the circle instead)");
    }
    const member = this.store.getMember(args.circleId, args.memberPubkey);
    if (!member || member.status === "left") {
      throw new Error("no such active member in this circle");
    }
    this.store.removeMember(args.circleId, args.memberPubkey);
    log.warn(
      `member ${args.memberPubkey.slice(0, 24)}… removed from circle ${args.circleId} (node-local)`,
    );
    // §5.5 follow-through: removal is node-local BY DESIGN (each member guards
    // their own roster; there is no central authority in a P2P circle), which
    // used to leave the rest of the circle finding out only out-of-band — the
    // UI said "ask the others to remove them too" with no mechanism. Fan a
    // SIGNED removal notice to the remaining members (the evictee is already
    // excluded: peerMembers is active-only). Receivers store it as a
    // `system`-kind chat message attributed to us — an informed-consent nudge
    // their human acts on, never something their node obeys (any member could
    // make the same claim as free text; this changes visibility, not trust).
    // Best-effort: the local removal above stands even if every dial fails.
    if (circle.kind !== PRACTICE_KIND) {
      try {
        await this.announceMemberRemoval(args.circleId, args.memberPubkey);
      } catch (err) {
        log.debug(`removal notice fan-out for ${args.circleId} failed: ${String(err)}`);
      }
    }
  }

  /**
   * The §5.5 removal notice: a `circle/message` envelope carrying a
   * structured `system: "member_removed"` marker plus a plain-text fallback.
   * Patched receivers store it with kind `system` (rendered as a labeled
   * system line, @agent summon suppressed); unpatched receivers just show a
   * readable chat message — graceful both ways. The text carries only the
   * PUBKEY prefix: a roster displayName is peer-controlled (could smuggle an
   * @agent summon into receivers' scan path) and a petname must never leave
   * this node (§5.6). Receiving UIs resolve the pubkey to their own name for
   * the person.
   */
  private async announceMemberRemoval(circleId: string, removedPubkey: string): Promise<void> {
    const text =
      `Removed member ${removedPubkey.slice(0, 24)}… from my copy of this circle. ` +
      `My node no longer accepts their writes or delivers to them. Each member ` +
      `controls their own roster — review their membership on your node too.`;
    const envelope = makeCircleEnvelope(
      "message",
      circleId,
      { text, system: "member_removed", removed_pubkey: removedPubkey },
      this.key,
    );
    const messageId = crypto.randomUUID();
    this.db
      .prepare(
        `INSERT INTO circle_messages
           (message_id, circle_id, author_pubkey, direction, kind, thread_id, content,
            scan_severity, envelope_id, created_at, delivery_status, reply_to, agent_authored)
         VALUES (?, ?, ?, 'out', 'system', NULL, ?, NULL, ?, ?, 'pending', NULL, 0)`,
      )
      .run(messageId, circleId, this.pubkey, text, envelope.id, Date.now());
    const report = await this.fanOut(circleId, "circle/message", envelope);
    this.setDeliveryStatus(messageId, deliveryStatusFromReport(report));
  }

  // -------------------------------------------------------------------------
  // Pending outbound (§5.3): the human approval queue for agent writes.
  // -------------------------------------------------------------------------

  /** Agent writes awaiting this human's approval (per circle). */
  pendingOutbound(circleId: string): PendingOutbound[] {
    return listPendingOutbound(this.db, circleId);
  }

  /**
   * The human approved: atomically claim the pending row and execute its
   * STORED params through the normal paths. The agent supplied the params at
   * queue time and never touches execution — the approval card is the only
   * trigger, and racing approvals execute exactly once.
   */
  async approvePendingOutbound(id: string): Promise<SendReport> {
    const pending = claimPendingOutbound(this.db, id, "approved");
    if (!pending) {
      throw new Error(`pending outbound ${id} is not awaiting approval`);
    }
    try {
      return await this.executePendingOutbound(pending);
    } catch (err) {
      // Nothing left the node — hand the card back so the human can retry
      // or reject (review F3: a claimed-then-failed write must not vanish).
      revertPendingOutbound(this.db, id);
      throw err;
    }
  }

  private async executePendingOutbound(pending: PendingOutbound): Promise<SendReport> {
    const p = pending.params;
    const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);
    switch (pending.action) {
      case "send":
        return this.sendMessage({
          circleId: pending.circleId,
          text: str(p.text),
          // Agent-authored text must not re-enter the @agent summon loop.
          suppressAgentSummon: true,
          agentAuthored: true,
        });
      case "ask":
        return this.askPeople({
          circleId: pending.circleId,
          question: str(p.question),
          category: str(p.category, "general"),
          agentAuthored: true,
        });
      case "log_expense": {
        const participants = Array.isArray(p.participants)
          ? (p.participants as unknown[]).filter((x): x is string => typeof x === "string")
          : [];
        return this.appendTabEvent({
          circleId: pending.circleId,
          input: {
            type: "expense.add",
            memo: str(p.memo),
            amountCents: typeof p.amountCents === "number" ? p.amountCents : 0,
            participants,
          },
        });
      }
      default:
        throw new Error(`unknown pending action ${str(pending.action, "?")}`);
    }
  }

  /** The human said no. Nothing ever leaves the node. */
  rejectPendingOutbound(id: string): void {
    if (!claimPendingOutbound(this.db, id, "rejected")) {
      throw new Error(`pending outbound ${id} is not awaiting approval`);
    }
  }

  // -------------------------------------------------------------------------
  // Message annotations (Phase D): reactions + pins on the event log.
  // -------------------------------------------------------------------------

  /** Current reactions + pins for a circle (folded from the log). */
  messageAnnotations(circleId: string): MessageAnnotations {
    return computeMessageAnnotations(this.db, circleId);
  }

  /**
   * The pinned messages themselves, resolved by envelope id with NO window
   * limit — a pin's whole point is surfacing a message older than the
   * conversation buffer (review F4: pins silently vanished past the last 100
   * messages). Pin order preserved; unresolvable ids (30-day horizon, late
   * join) are dropped.
   */
  pinnedMessages(circleId: string): Array<{
    envelopeId: string;
    authorPubkey: string;
    direction: string;
    content: string;
    createdAt: number;
    agentAuthored: boolean;
  }> {
    const pins = this.messageAnnotations(circleId).pins;
    if (pins.length === 0) return [];
    const placeholders = pins.map(() => "?").join(",");
    const rows = this.db
      .prepare(
        `SELECT envelope_id, author_pubkey, direction, content, created_at, agent_authored
           FROM circle_messages
          WHERE circle_id = ? AND envelope_id IN (${placeholders}) AND deleted_at IS NULL`,
      )
      .all(circleId, ...pins) as unknown as Array<{
      envelope_id: string;
      author_pubkey: string;
      direction: string;
      content: string;
      created_at: number;
      agent_authored: number | null;
    }>;
    const byEnvelope = new Map(rows.map((r) => [r.envelope_id, r]));
    return pins
      .map((id) => byEnvelope.get(id))
      .filter((r): r is NonNullable<typeof r> => !!r)
      .map((r) => ({
        envelopeId: r.envelope_id,
        authorPubkey: r.author_pubkey,
        direction: r.direction,
        content: r.content,
        createdAt: r.created_at,
        agentAuthored: r.agent_authored === 1,
      }));
  }

  /**
   * Delete a message. Two scopes, decided by authorship:
   *  - OWN message → a `message.delete` event on our signed chain, fanned out
   *    like any ledger write (gossip/dial/mailbox + events.since sync), so
   *    honest peer nodes tombstone it too. Honor-system by construction: a
   *    modified node can keep its copy — the UI must never promise more.
   *  - Someone else's message → node-local hide only; nothing fans out.
   * Either way the local row is tombstoned (content blanked, row kept so
   * reply threads hold their anchor).
   */
  async deleteMessage(args: {
    circleId: string;
    envelopeId: string;
  }): Promise<SendReport & { scope: "everyone" | "local" }> {
    const row = this.db
      .prepare(
        `SELECT author_pubkey, deleted_at FROM circle_messages
          WHERE circle_id = ? AND envelope_id = ?`,
      )
      .get(args.circleId, args.envelopeId) as
      | { author_pubkey: string; deleted_at: number | null }
      | undefined;
    if (!row) {
      throw new Error("message not found");
    }
    const own = row.author_pubkey === this.pubkey;
    if (row.deleted_at) {
      return { delivered: [], failed: [], scope: "local" };
    }
    const circle = this.store.getCircle(args.circleId);
    const canPropagate =
      own && circle && circle.status === "active" && circle.kind !== PRACTICE_KIND;
    if (canPropagate) {
      // Propagate FIRST: the local append runs through the same ingest hook,
      // which applies our tombstone. If the append is refused (rate limit,
      // chain refusal) nothing has changed locally — the user can retry and
      // the retraction event is never silently lost.
      const report = await this.appendTabEvent({
        circleId: args.circleId,
        input: {
          type: "message.delete",
          targetEnvelopeId: args.envelopeId,
          updatedAt: Date.now(),
        },
      });
      return { delivered: report.delivered, failed: report.failed, scope: "everyone" };
    }
    // Local hide (someone else's message), or an own message in a circle that
    // refuses writes (frozen/archived/practice): tombstone this node only.
    this.db
      .prepare(
        `UPDATE circle_messages
            SET deleted_at = ?, deleted_by = ?, content = ''
          WHERE circle_id = ? AND envelope_id = ?`,
      )
      .run(Date.now(), this.pubkey, args.circleId, args.envelopeId);
    return { delivered: [], failed: [], scope: "local" };
  }

  /** Set OUR full reaction set on a message (empty = clear) + fan out. */
  async reactToMessage(args: {
    circleId: string;
    envelopeId: string;
    emojis: string[];
  }): Promise<SendReport & { eventId: string; seq: number }> {
    return this.appendTabEvent({
      circleId: args.circleId,
      input: {
        type: "message.react",
        targetEnvelopeId: args.envelopeId,
        emojis: args.emojis,
        updatedAt: Date.now(),
      },
    });
  }

  /** Pin or unpin a message for the whole circle (LWW per target) + fan out. */
  async setMessagePinned(args: {
    circleId: string;
    envelopeId: string;
    pinned: boolean;
  }): Promise<SendReport & { eventId: string; seq: number }> {
    return this.appendTabEvent({
      circleId: args.circleId,
      input: {
        type: "message.pin",
        targetEnvelopeId: args.envelopeId,
        pinned: args.pinned,
        updatedAt: Date.now(),
      },
    });
  }

  /**
   * Phase D: the human's deliberate act ending a fork freeze. Node-local —
   * this member reviewed the evidence and chose to resume. The forked
   * author's chain may keep chain-breaking until they recover; conversation
   * and everyone else's events resume immediately.
   */
  unfreezeCircle(circleId: string): void {
    const circle = this.store.getCircle(circleId);
    if (!circle) throw new Error(`circle ${circleId} not found`);
    if (circle.status !== "frozen") {
      throw new Error(`circle ${circleId} is not frozen`);
    }
    if (!this.store.unfreezeCircle(circleId)) {
      throw new Error(`circle ${circleId} is not frozen`);
    }
    log.warn(
      `circle ${circleId} unfrozen by the local human (fork evidence moved to the audit trail)`,
    );
  }

  // -------------------------------------------------------------------------
  // Agent drafts (PLAN-36 Phase B): summon-only, quarantined, consent-gated.
  // -------------------------------------------------------------------------

  /** Kill switch: `circles.agentDrafts.enabled: false` opts out (default ON). */
  agentDraftsEnabled(): boolean {
    return this.config.circles?.agentDrafts?.enabled !== false;
  }

  /**
   * Scheduler sweep: generate queued drafts on the quarantined tool-less
   * path. No-op without the injected draftLlm (RPC-owned instances) or with
   * drafts disabled — queued rows then simply expire.
   */
  async generateAgentDrafts(): Promise<{ generated: number }> {
    // PLAN-38: the sandbox sweeps ride this same scheduler slot. Gated by the
    // R19 kill switch (default OFF); a sweep failure never blocks drafts.
    if (this.sandboxGenerationEnabled()) {
      try {
        sweepSandboxTurns(this.db, { selfPubkey: this.pubkey });
        if (this.config.circles?.practicePartner?.enabled !== false) {
          await practiceSandboxSweep(this.db, { partnerKey: this.practiceKey() });
        }
      } catch (err) {
        log.debug(`sandbox sweep failed: ${String(err)}`);
      }
    }
    if (!this.draftLlm || !this.agentDraftsEnabled()) {
      // Housekeeping still runs: queued rows (the inbound path is config-blind
      // by design — a2a handlers take no config) expire instead of piling up,
      // and terminal rows are pruned. Only SPEND is gated by the switch.
      sweepAgentDraftHousekeeping(this.db);
      return { generated: 0 };
    }
    return generateQueuedAgentDrafts(this.db, this.draftLlm, { selfPubkey: this.pubkey });
  }

  /** Ready drafts for the UI. Node-local; never leaves this node unpublished. */
  agentDrafts(circleId: string): AgentDraft[] {
    return listReadyAgentDrafts(this.db, circleId);
  }

  /**
   * B2: our human asked their agent to pre-fill THEIR contribution to a card
   * slot (a vote, a study-guide section). Human-initiated only; the draft
   * comes back through the same private consent surface.
   */
  /**
   * Chat-scoped "Ask my agent" (summon-UX): our human asks their agent to
   * draft a reply to the recent conversation WITHOUT posting a summon message
   * to the circle. Nothing reaches the wire — the draft comes back through
   * the same private consent surface, and only a publish tap ever sends.
   * Shares the per-circle draft rate bucket with @agent summons.
   */
  requestAgentReplyDraft(args: { circleId: string }): { queued: boolean; reason?: string } {
    if (!this.agentDraftsEnabled()) {
      return { queued: false, reason: "disabled" };
    }
    const circle = this.store.getCircle(args.circleId);
    if (!circle || circle.status !== "active") {
      throw new Error(`circle ${args.circleId} is not active`);
    }
    return queueAgentDraft(this.db, {
      circleId: args.circleId,
      summonEnvelopeId: null,
      summonAuthorPubkey: this.pubkey,
    });
  }

  requestAgentSliceDraft(args: { circleId: string; cardId: string; slot: string }): {
    queued: boolean;
    reason?: string;
  } {
    if (!this.agentDraftsEnabled()) {
      return { queued: false, reason: "disabled" };
    }
    const circle = this.store.getCircle(args.circleId);
    if (!circle || circle.status !== "active") {
      throw new Error(`circle ${args.circleId} is not active`);
    }
    const card = computeCanvasCards(this.db, args.circleId).find((c) => c.cardId === args.cardId);
    if (!card) {
      throw new Error(`card ${args.cardId} not found in circle`);
    }
    // The slot lands in the TRUSTED prompt frame (section task line), so it
    // must never carry newlines or frame-breaking text — even from our own
    // renderer (review hardening; "vote" and "sec-<hex>" both pass).
    const slot = args.slot.slice(0, 32);
    if (!/^[a-z0-9_-]+$/i.test(slot)) {
      throw new Error("slot must be alphanumeric/-/_");
    }
    return queueAgentSliceDraft(this.db, {
      circleId: args.circleId,
      cardId: args.cardId,
      slot,
    });
  }

  /**
   * Phase 4b: our human asked their agent for a personal study aid built from
   * a shared study-guide card, tuned to their own mastery state. The draft
   * renders to our human ONLY — no publish path exists for this kind, so
   * nothing here can ever reach the circle.
   */
  requestAgentStudyDraft(args: { circleId: string; cardId: string }): {
    queued: boolean;
    reason?: string;
  } {
    if (!this.agentDraftsEnabled()) {
      return { queued: false, reason: "disabled" };
    }
    const circle = this.store.getCircle(args.circleId);
    if (!circle || circle.status !== "active") {
      throw new Error(`circle ${args.circleId} is not active`);
    }
    const card = computeCanvasCards(this.db, args.circleId).find((c) => c.cardId === args.cardId);
    if (!card) {
      throw new Error(`card ${args.cardId} not found in circle`);
    }
    return queueAgentStudyDraft(this.db, { circleId: args.circleId, cardId: args.cardId });
  }

  /**
   * Phase 4b: record one quiz result — the human's own tap on a study draft
   * question. Member-own data (§5.2): this is the ONLY thing the study loop
   * persists, and it never fans out.
   */
  recordStudyResult(args: {
    circleId: string;
    cardId: string;
    slot: string;
    correct: boolean;
  }): StudySectionState {
    if (!this.store.getCircle(args.circleId)) {
      throw new Error(`circle ${args.circleId} not found`);
    }
    return recordStudyResult(this.db, args);
  }

  /** Phase 4b: this member's own mastery state (per card, or the whole circle). */
  studyState(circleId: string, cardId?: string): StudySectionState[] {
    return listStudyState(this.db, circleId, cardId);
  }

  // -------------------------------------------------------------------------
  // PLAN-38 P1(b): the canvas sandbox. Human acts (frame, enroll, move, close)
  // are ordinary signed events on the ledger; agent GENERATION is gated by the
  // R19 kill switch and every generated move waits for its human's tap.
  // -------------------------------------------------------------------------

  /**
   * Agent generation (turn sweep + practice moves). ON by default
   * `[R19 amended 2026-07-28 by Victor: the sandbox is core, not opt-in]`.
   *
   * Why this is safe for P1 specifically: the switch was never the gate that
   * mattered here. Generation is already behind three explicit human acts —
   * framing a session on a card, enrolling (mode is never set automatically),
   * and the per-enrollment turn/token budgets only that human can refill —
   * and the sweep reads ONLY this node's own enrollments, so a node with none
   * does zero work and spends nothing. Every generated move still waits for
   * its own human's tap (propose-mode is all of P1), so nothing reaches the
   * wire unseen either way.
   *
   * What R19 was protecting stays protected: P2 auto-append remains a
   * SEPARATE, still-default-off opt-in per enrollment, and `enabled: false`
   * here continues to stop all agent spend on this node.
   */
  sandboxGenerationEnabled(): boolean {
    return this.config.circles?.sandbox?.enabled !== false;
  }

  private practiceKey(): KeyPair {
    return (this.practiceKeysLazy ??= loadOrCreatePracticeKeys());
  }

  /**
   * The canvas for the UI: every card's live state plus our node-local view
   * (whose turn, who a round waits on) and our standing participation. No
   * "sessions" concept crosses this boundary — cards are simply alive.
   */
  sandboxState(circleId: string): {
    generationEnabled: boolean;
    practicePubkey: string | null;
    participation: SandboxParticipation | null;
    thinkingCardIds: string[];
    sessions: Array<SandboxSession & { myTurn: boolean; waitingOn: string[] }>;
  } {
    const partnerPk = pubkeyId(this.practiceKey());
    const practiceMember = this.store
      .getMembers(circleId)
      .some((m) => m.memberPubkey === partnerPk && m.status === "active");
    const sessions = computeSandboxSessions(this.db, circleId).map((s) => {
      const moved = new Set(
        s.moves.filter((m) => m.round === s.currentRound).map((m) => m.authorPubkey),
      );
      return {
        ...s,
        myTurn: isMyTurn(s, this.pubkey),
        waitingOn: s.status === "closed" ? [] : s.speakers.filter((pk) => !moved.has(pk)),
      };
    });
    // Fix for the dead-air problem: cards whose proposal is still being
    // generated say so, instead of nothing happening for a sweep cycle.
    const thinking = this.db
      .prepare(
        `SELECT DISTINCT target_card_id FROM circle_agent_drafts
          WHERE circle_id = ? AND kind = ? AND status IN ('queued', 'drafting')
            AND target_card_id IS NOT NULL`,
      )
      .all(circleId, SANDBOX_DRAFT_KIND) as unknown as Array<{ target_card_id: string }>;
    return {
      generationEnabled: this.sandboxGenerationEnabled(),
      practicePubkey: practiceMember ? partnerPk : null,
      participation: getSandboxParticipation(this.db, circleId),
      thinkingCardIds: thinking.map((t) => t.target_card_id),
      sessions,
    };
  }

  /**
   * The ONE consent act: "my agent works this circle's canvas." Two halves
   * (R4) — the private row (budgets, guidance; never leaves the node) and a
   * circle-wide signed event carrying `mode` only, so peers know whether we
   * speak and every node derives the same speaker order. Setting it again
   * clears a pause.
   *
   * Turning participation ON also seats the practice partner when this is a
   * solo circle, because a canvas with one agent cannot demonstrate anything
   * and asking a person to summon a test fixture is not a feature.
   */
  async setCanvasParticipation(args: {
    circleId: string;
    mode: "off" | "propose";
    turnBudget?: number;
    tokenBudget?: number;
    guidance?: string;
  }): Promise<SandboxParticipation> {
    const participation = setSandboxParticipation(this.db, {
      circleId: args.circleId,
      mode: args.mode,
      turnBudget: args.turnBudget,
      tokenBudget: args.tokenBudget,
      guidance: args.guidance,
    });
    await this.appendTabEvent({
      circleId: args.circleId,
      input: { type: "sandbox.enroll.put", mode: args.mode, updatedAt: Date.now() },
    });
    if (args.mode === "propose") {
      await this.ensurePracticePartnerSeat(args.circleId);
    }
    return participation;
  }

  /**
   * Solo circles get the labeled practice partner automatically (P1.0 — with
   * one human installed it is the only thing that can exercise a card end to
   * end). Silently does nothing when real members are present or the partner
   * is disabled; this is never a user-facing act.
   */
  private async ensurePracticePartnerSeat(circleId: string): Promise<string | null> {
    if (this.config.circles?.practicePartner?.enabled === false) return null;
    const partnerKey = this.practiceKey();
    const partnerPk = pubkeyId(partnerKey);
    const members = this.store.getMembers(circleId);
    const realOthers = members.filter(
      (m) =>
        m.status === "active" && m.memberPubkey !== this.pubkey && m.memberPubkey !== partnerPk,
    );
    if (realOthers.length > 0) return null;
    if (!members.some((m) => m.memberPubkey === partnerPk && m.status === "active")) {
      this.store.addMember({
        circleId,
        memberPubkey: partnerPk,
        displayName: PRACTICE_PARTNER_NAME,
        scopes: DEFAULT_MEMBER_SCOPES,
      });
    }
    // The partner's own circle-wide participation, signed by its own key
    // through the same validated append path a real peer would use.
    const already = computeSandboxSessions(this.db, circleId)[0]?.enrollments.some(
      (e) => e.authorPubkey === partnerPk && e.mode !== "off",
    );
    if (!already) {
      const body = buildChainedEventBody(this.db, {
        circleId,
        authorPubkey: partnerPk,
        input: { type: "sandbox.enroll.put", mode: "propose", updatedAt: Date.now() },
      });
      const envelope = makeCircleEnvelope(
        "event",
        circleId,
        body as unknown as Record<string, JsonValue>,
        partnerKey,
      );
      const { handleCircleMethod } = await import("../gateway/a2a/circles.js");
      const outcome = handleCircleMethod("circle/event.append", { envelope }, this.db);
      if (!outcome.ok) {
        log.debug(`practice participation refused: ${outcome.error.message}`);
        return null;
      }
    }
    return partnerPk;
  }

  /**
   * A move by hand (§2's "join in" half): no participation, no agent, no
   * budget involved. Bound by the same one-move-per-member-per-round rule as
   * everyone else, with a legible refusal.
   */
  async postSandboxMove(args: {
    circleId: string;
    cardId: string;
    kind: SandboxMoveKind;
    text?: string;
    optionId?: string;
    label?: string;
  }): Promise<SendReport & { eventId: string; seq: number }> {
    const session = computeSandboxSessions(this.db, args.circleId).find(
      (s) => s.cardId === args.cardId,
    );
    if (!session) throw new Error(`card ${args.cardId} is not on the canvas`);
    if (session.status === "closed") {
      throw new Error(`this card is finished (${session.closed?.reason ?? "done"})`);
    }
    if (
      session.moves.some((m) => m.round === session.currentRound && m.authorPubkey === this.pubkey)
    ) {
      throw new Error(
        `one move per member per round — you already moved in round ${session.currentRound + 1}`,
      );
    }
    // M5 at send time too: a vote must name an option that exists in OUR fold
    // (the fold re-validates on every node regardless).
    if (args.kind === "vote" && !session.options.some((o) => o.optionId === args.optionId)) {
      throw new Error("vote must pick an option that is on the card");
    }
    const text = args.text?.trim() ? validateSandboxMoveText(args.text) : "";
    return this.appendTabEvent({
      circleId: args.circleId,
      input: {
        type: "sandbox.move",
        cardId: args.cardId,
        round: session.currentRound,
        kind: args.kind,
        text,
        optionId: args.optionId,
        label: args.label,
        agentAuthored: false,
      },
    });
  }

  /**
   * Steer: the human's own words to their own agent (decision 5: private).
   * Reachable from the card AND from chat (/steer) — both are first-party
   * text, so neither touches the §3.3 asymmetry. Never a wire event.
   */
  steerSandbox(args: { circleId: string; guidance: string }): SandboxParticipation {
    return steerSandboxParticipation(this.db, {
      circleId: args.circleId,
      guidance: args.guidance,
    });
  }

  /** One-tap pause (§3.1): nothing generates or publishes until resumed. */
  pauseSandbox(args: { circleId: string; reason?: string }): void {
    pauseSandboxParticipation(this.db, {
      circleId: args.circleId,
      reason: args.reason?.trim() || "paused by you",
    });
  }

  resumeSandbox(args: { circleId: string }): void {
    resumeSandboxParticipation(this.db, { circleId: args.circleId });
  }

  /** Finish a card with a legible, attributed reason (§3.1). */
  async closeSandboxSession(args: {
    circleId: string;
    cardId: string;
    reason: SandboxCloseReason;
  }): Promise<SendReport & { eventId: string; seq: number }> {
    return this.appendTabEvent({
      circleId: args.circleId,
      input: {
        type: "sandbox.close",
        cardId: args.cardId,
        reason: args.reason,
        updatedAt: Date.now(),
      },
    });
  }

  /**
   * The consent tap: publish a draft to the circle AS our human's message.
   * The human may have edited the text; what they approved is what ships.
   * Goes through the normal sendMessage path (signing, fan-out, delivery
   * accounting, reply threading to the summoning message) — there is no
   * separate agent send path to audit.
   */
  async publishAgentDraft(args: {
    draftId: string;
    text?: string;
  }): Promise<SendReport & { envelopeId?: string; eventId?: string }> {
    const draft = getAgentDraft(this.db, args.draftId);
    if (!draft) {
      throw new Error(`draft ${args.draftId} is not awaiting review`);
    }
    // Phase 4b hard rule: a study draft is render-to-own-human ONLY. There is
    // no path from the study lens to the wire — sharing insights with the
    // circle is a normal human-typed message, never a publish of this draft.
    if (draft.kind === "study") {
      throw new Error("study drafts render to your own screen only and cannot be published");
    }
    const text = (args.text ?? draft.content).trim();
    if (!text) throw new Error("draft text is empty");
    const isSandbox = draft.kind === SANDBOX_DRAFT_KIND && draft.targetCardId;
    const isSlice = draft.kind === "slice" && draft.targetCardId && draft.targetSlot;
    // §3.2.9: a draft whose card was deleted (or cleared — clear mints a new
    // card id) dies legibly BEFORE the claim, never posts to a resurrected
    // ghost. Discarded, not handed back: a gone card can't come back the same,
    // so "ready" would just fail forever. Guarded on the 'ready'→'discarded'
    // transition (claimAgentDraft) so a retried publish of an ALREADY-published
    // draft can never overwrite its status to 'discarded' — that would corrupt
    // the R5 audit record for a move already on the wire.
    if (
      (isSlice || isSandbox) &&
      !computeCanvasCards(this.db, draft.circleId).some((c) => c.cardId === draft.targetCardId)
    ) {
      claimAgentDraft(this.db, draft.draftId, "ready", "discarded");
      throw new Error("the card this draft targets is no longer on the canvas");
    }
    // Atomic claim BEFORE the awaited send: a racing second publish (or a
    // publish vs discard) loses here — "approved once, sent once".
    if (!claimAgentDraft(this.db, draft.draftId, "ready", "publishing")) {
      throw new Error(`draft ${args.draftId} is not awaiting review`);
    }
    try {
      // A slice draft publishes as OUR contribution to the target card slot
      // (the normal canvas consent path); a reply draft publishes as a chat
      // message threaded to the summon. Both are the standard signed paths —
      // no separate agent send path to audit. The target card is re-checked
      // at publish (review: it may have been tombstoned since the draft was
      // generated — refuse rather than append an orphaned slice).
      const report = isSandbox
        ? await this.publishSandboxMoveFromDraft(
            draft.circleId,
            draft.targetCardId as string,
            text,
            parseProposalSlot(draft.targetSlot),
          )
        : isSlice
          ? await this.putCanvasSlice({
              circleId: draft.circleId,
              cardId: draft.targetCardId as string,
              slot: draft.targetSlot as string,
              value: text,
              note: "",
            })
          : await this.sendMessage({
              circleId: draft.circleId,
              text,
              replyTo: draft.summonEnvelopeId ?? undefined,
              suppressAgentSummon: true,
              agentAuthored: true,
            });
      setAgentDraftStatus(this.db, draft.draftId, "published");
      return report;
    } catch (err) {
      // Nothing left the node — hand the draft back for another try.
      setAgentDraftStatus(this.db, draft.draftId, "ready");
      throw err;
    }
  }

  /**
   * The approved sandbox proposal becomes a signed move. Publish-time consent
   * re-check (R5, second gate): the enrollment may have been paused or turned
   * off since the turn was claimed, the session may have closed, and the
   * round may already carry our move — every refusal is legible.
   */
  private async publishSandboxMoveFromDraft(
    circleId: string,
    cardId: string,
    text: string,
    proposal: "constraint" | "option" | "vote" = "constraint",
  ): Promise<SendReport & { eventId: string; seq: number }> {
    const part = getSandboxParticipation(this.db, circleId);
    if (!part || part.mode !== "propose") {
      throw new Error("your agent is not working this circle's canvas — turn it on to post");
    }
    if (part.pausedAt) {
      throw new Error(
        `your agent is paused (${part.pauseReason ?? "paused"}) — resume before posting`,
      );
    }
    const session = computeSandboxSessions(this.db, circleId).find((s) => s.cardId === cardId);
    if (!session) throw new Error("that card is no longer on the canvas");
    if (session.status === "closed") {
      throw new Error(`this card is finished (${session.closed?.reason ?? "done"})`);
    }
    if (
      session.moves.some((m) => m.round === session.currentRound && m.authorPubkey === this.pubkey)
    ) {
      throw new Error(
        `one move per member per round — you already moved in round ${session.currentRound + 1}`,
      );
    }
    const clean = validateSandboxMoveText(text);

    // The server chose the proposal kind at queue time (R13); here the human-
    // approved string maps onto exactly that kind's one field, value-checked.
    if (proposal === "vote") {
      if (/^abstain$/i.test(clean)) {
        return this.appendTabEvent({
          circleId,
          input: {
            type: "sandbox.move",
            cardId,
            round: session.currentRound,
            kind: "pass",
            agentAuthored: true,
          },
        });
      }
      // M5: the approved text must reproduce one option label byte-for-byte
      // (after trim) — anything else is refused legibly, never guessed at.
      const match = session.options.find((o) => o.label.trim() === clean);
      if (!match) {
        throw new Error(
          "the approved vote no longer matches an option on the card — ask again or vote by hand",
        );
      }
      return this.appendTabEvent({
        circleId,
        input: {
          type: "sandbox.move",
          cardId,
          round: session.currentRound,
          kind: "vote",
          optionId: match.optionId,
          agentAuthored: true,
        },
      });
    }
    if (proposal === "option") {
      const slug = clean
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 24);
      const optionId = slug ? `opt-${slug}` : `opt-${session.moves.length + 1}`;
      return this.appendTabEvent({
        circleId,
        input: {
          type: "sandbox.move",
          cardId,
          round: session.currentRound,
          kind: "option.add",
          optionId,
          label: clean.slice(0, 200),
          agentAuthored: true,
        },
      });
    }
    return this.appendTabEvent({
      circleId,
      input: {
        type: "sandbox.move",
        cardId,
        round: session.currentRound,
        kind: "constraint",
        text: clean,
        agentAuthored: true,
      },
    });
  }

  /** The other half of consent: throw the draft away. Nothing ever left. */
  discardAgentDraft(draftId: string): void {
    if (!claimAgentDraft(this.db, draftId, "ready", "discarded")) {
      throw new Error(`draft ${draftId} is not awaiting review`);
    }
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

  /** Circles for the UI — includes frozen + archived (active-only hides them). */
  listCirclesForUi(): Circle[] {
    return this.store.getCirclesForMemberUi(this.pubkey);
  }

  /** Hide a circle (reversible). Node-local. */
  archiveCircle(circleId: string): void {
    if (!this.store.getCircle(circleId)) throw new Error(`circle ${circleId} not found`);
    if (!this.store.archiveCircle(circleId)) {
      throw new Error("circle cannot be archived (already archived, or gone)");
    }
  }

  /** Restore an archived circle. Node-local. */
  unarchiveCircle(circleId: string): void {
    if (!this.store.unarchiveCircle(circleId)) {
      throw new Error("circle is not archived");
    }
  }

  /** Permanently delete a circle from this node (all local data). Node-local. */
  deleteCircle(circleId: string): void {
    if (!this.store.getCircle(circleId)) throw new Error(`circle ${circleId} not found`);
    this.store.deleteCircle(circleId);
    log.warn(`circle ${circleId} deleted from this node (node-local; friends keep their copy)`);
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
    agentPosture: string | null;
  }> {
    const rows = this.db
      .prepare(
        `SELECT peer_pubkey, a2a_url, last_seen_at, last_status, agent_posture
           FROM circle_peer_presence ORDER BY last_seen_at DESC`,
      )
      .all() as unknown as Array<{
      peer_pubkey: string;
      a2a_url: string | null;
      last_seen_at: number;
      last_status: string | null;
      agent_posture: string | null;
    }>;
    return rows.map((r) => ({
      peerPubkey: r.peer_pubkey,
      a2aUrl: r.a2a_url,
      lastSeenAt: r.last_seen_at,
      lastStatus: r.last_status,
      agentPosture: r.agent_posture,
    }));
  }

  /**
   * Our own agent's posture in circles (mockup pin 3). v1 has two honest
   * states: "summon-only" (the Phase B @agent draft path is on) and "off"
   * (the kill switch is set). There is no always-listening mode — an agent
   * only ever sees what is @-addressed to it.
   */
  selfAgentPosture(): "summon-only" | "off" {
    // Review #6: only advertise a capability this node actually has — with no
    // draft LLM wired, a summon can never generate, so the posture is "off"
    // even when the config switch is on.
    return this.draftLlm && this.agentDraftsEnabled() ? "summon-only" : "off";
  }

  messages(
    circleId: string,
    limit = 100,
  ): Array<{
    messageId: string;
    envelopeId: string | null;
    authorPubkey: string;
    direction: string;
    kind: string;
    threadId: string | null;
    content: string;
    createdAt: number;
    deliveryStatus: DeliveryStatus | null;
    replyTo: string | null;
    agentAuthored: boolean;
    deleted: boolean;
    /** The tombstone was a LOCAL hide by this node's human (vs an author retraction). */
    deletedByMe: boolean;
  }> {
    const rows = this.db
      .prepare(
        `SELECT message_id, envelope_id, author_pubkey, direction, kind, thread_id, content,
                created_at, delivery_status, reply_to, agent_authored, deleted_at, deleted_by
           FROM circle_messages WHERE circle_id = ?
          ORDER BY created_at DESC LIMIT ?`,
      )
      .all(circleId, Math.min(limit, 500)) as unknown as Array<{
      message_id: string;
      envelope_id: string | null;
      author_pubkey: string;
      direction: string;
      kind: string;
      thread_id: string | null;
      content: string;
      created_at: number;
      delivery_status: DeliveryStatus | null;
      reply_to: string | null;
      agent_authored: number | null;
      deleted_at: number | null;
      deleted_by: string | null;
    }>;
    return rows.map((r) => ({
      messageId: r.message_id,
      envelopeId: r.envelope_id,
      authorPubkey: r.author_pubkey,
      direction: r.direction,
      kind: r.kind,
      threadId: r.thread_id,
      content: r.content,
      createdAt: r.created_at,
      deliveryStatus: r.delivery_status,
      replyTo: r.reply_to,
      agentAuthored: r.agent_authored === 1,
      deleted: r.deleted_at != null,
      deletedByMe:
        r.deleted_at != null && r.deleted_by === this.pubkey && r.author_pubkey !== this.pubkey,
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
