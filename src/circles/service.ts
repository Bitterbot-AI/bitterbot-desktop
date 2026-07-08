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
 * Transport v1 is direct dial to each member's a2a_url with best-effort
 * fan-out; the store-and-forward mailbox (§3.2) layers under this so offline
 * peers receive on wake. A failed dial is queued for retry by the mailbox
 * layer, never dropped silently.
 */

import type { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
import type { JsonValue } from "../commerce/sku.js";
import type { BitterbotConfig } from "../config/types.bitterbot.js";
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
import { DEFAULT_ANSWER_POSTURE, isDisclosureAllowed, pendingAsks } from "./disclosure.js";
import { makeCircleEnvelope, type CircleEnvelope } from "./envelope.js";
import { createInvite, parseInviteCode, type CreatedInvite } from "./invites.js";
import {
  buildChainedEventBody,
  computeTabBalances,
  type TabBalances,
  type TabEventInput,
} from "./tab.js";

const log = createSubsystemLogger("circles/service");

export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export type CirclesServiceDeps = {
  db: DatabaseSync;
  config: BitterbotConfig;
  fetchImpl?: FetchLike;
  /** Injectable for tests; defaults to the device identity KeyPair. */
  keyPair?: KeyPair;
  /** Injectable for tests; defaults to the persisted X25519 box keypair. */
  boxKeys?: BoxKeyPair;
};

export type SendReport = {
  delivered: string[];
  failed: string[];
};

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

export class CirclesService {
  private readonly db: DatabaseSync;
  private readonly config: BitterbotConfig;
  private readonly fetchImpl: FetchLike;
  private readonly key: KeyPair;
  private readonly boxKeys: BoxKeyPair;
  readonly store: CirclesStore;

  constructor(deps: CirclesServiceDeps) {
    this.db = deps.db;
    this.config = deps.config;
    this.fetchImpl = deps.fetchImpl ?? (fetch as unknown as FetchLike);
    this.key = deps.keyPair ?? keyPairFromPrivateKeyPem(loadOrCreateDeviceIdentity().privateKeyPem);
    this.boxKeys = deps.boxKeys ?? loadOrCreateBoxKeys();
    this.store = new CirclesStore(this.db);
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
    if (!this.a2aPublicUrl) {
      throw new Error(
        "circles.a2aPublicUrl is not configured — peers would have no way to dial back",
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
      scopes: DEFAULT_MEMBER_SCOPES,
      ttlMs: args.ttlMs,
    });
    return { ...invite, circleId };
  }

  // -------------------------------------------------------------------------
  // Redeem (the invitee's half)
  // -------------------------------------------------------------------------

  /**
   * Redeem a pasted invite code: verify the inviter's signature FIRST, dial
   * their node's circle/join, then mirror the returned roster locally. The
   * human saw the parsed invite (who is asking) before this is called —
   * calling it IS the invitee-side consent.
   */
  async redeemInviteCode(code: string): Promise<{
    circleId: string;
    circleName: string;
    inviterName: string | null;
    members: number;
  }> {
    const parsed = parseInviteCode(code);
    if (!parsed.ok) {
      throw new Error(parsed.error);
    }
    const invite = parsed.invite;
    const joinEnvelope = makeCircleEnvelope(
      "join",
      invite.circleId,
      {
        display_name: this.displayName,
        a2a_url: this.a2aPublicUrl ?? null,
        box_pubkey: this.boxKeys.publicKeyB64,
        mailbox_url: this.myMailboxUrl ?? null,
      },
      this.key,
    );
    const rpc = await circleRpc(this.fetchImpl, invite.inviterA2aUrl, "circle/join", {
      inviteId: invite.inviteId,
      secret: invite.secret,
      join: joinEnvelope,
    });
    if (!rpc.ok || !rpc.result) {
      throw new Error(`join failed: ${rpc.error ?? "no result"}`);
    }
    const result = rpc.result as {
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
    log.info(`joined circle ${circle.circleId} (${members.length} members)`);
    return {
      circleId: circle.circleId,
      circleName: typeof circle.name === "string" ? circle.name : invite.circleName,
      inviterName: invite.inviterName,
      members: members.length,
    };
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

  private async fanOut(
    circleId: string,
    method: string,
    envelope: CircleEnvelope,
  ): Promise<SendReport> {
    const report: SendReport = { delivered: [], failed: [] };
    for (const member of this.peerMembers(circleId)) {
      if (member.a2aUrl) {
        const rpc = await circleRpc(this.fetchImpl, member.a2aUrl, method, { envelope });
        if (rpc.ok) {
          report.delivered.push(member.memberPubkey);
          continue;
        }
        log.debug(`direct ${method} to ${member.memberPubkey.slice(0, 24)}… failed: ${rpc.error}`);
      }
      // Offline or unreachable: store-and-forward. Presence beats are
      // point-in-time and skip the mailbox (stale presence is noise).
      if (method !== "circle/presence" && (await this.postToMailbox(member, method, envelope))) {
        report.delivered.push(member.memberPubkey);
        continue;
      }
      report.failed.push(member.memberPubkey);
    }
    return report;
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
    this.db
      .prepare(
        `INSERT INTO circle_messages
           (message_id, circle_id, author_pubkey, direction, kind, thread_id, content,
            scan_severity, envelope_id, created_at)
         VALUES (?, ?, ?, 'out', ?, ?, ?, NULL, ?, ?)`,
      )
      .run(
        crypto.randomUUID(),
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
    const report = await this.fanOut(args.circleId, method, envelope);
    return { ...report, envelopeId: envelope.id };
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
      let inner: { method?: string; envelope?: unknown } | null = null;
      try {
        const sealed = JSON.parse(item.blob) as SealedBlob;
        const opened = openBox(this.boxKeys, sealed);
        inner = opened ? (JSON.parse(opened) as { method?: string; envelope?: unknown }) : null;
      } catch {
        inner = null;
      }
      if (!inner?.method || !inner.method.startsWith("circle/") || !inner.envelope) {
        // Garbage or not-for-us: ack so it never clogs the box.
        ackIds.push(item.blobId);
        continue;
      }
      const outcome = handleCircleMethod(inner.method, { envelope: inner.envelope }, this.db);
      // Duplicate-envelope errors are SUCCESS for ack purposes (already
      // delivered via a live dial); real handler errors leave it for retry.
      if (outcome.ok || /duplicate/i.test(outcome.ok ? "" : outcome.error.message)) {
        if (outcome.ok) {
          dispatched += 1;
        }
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
  // Local reads (the People pane + conversation views)
  // -------------------------------------------------------------------------

  listCircles(): Circle[] {
    return this.store.getCirclesForMember(this.pubkey);
  }

  /** Distinct connected humans across all circles (the friend-node count). */
  connectionCount(): number {
    const rows = this.db
      .prepare(
        `SELECT COUNT(DISTINCT m.member_pubkey) AS n
           FROM circle_members m
           JOIN circle_members me
             ON me.circle_id = m.circle_id AND me.member_pubkey = ? AND me.status = 'active'
          WHERE m.status = 'active' AND m.member_pubkey != ?`,
      )
      .get(this.pubkey, this.pubkey) as { n: number } | undefined;
    return rows?.n ?? 0;
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
  }> {
    const rows = this.db
      .prepare(
        `SELECT message_id, author_pubkey, direction, kind, thread_id, content, created_at
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
    }>;
    return rows.map((r) => ({
      messageId: r.message_id,
      authorPubkey: r.author_pubkey,
      direction: r.direction,
      kind: r.kind,
      threadId: r.thread_id,
      content: r.content,
      createdAt: r.created_at,
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
