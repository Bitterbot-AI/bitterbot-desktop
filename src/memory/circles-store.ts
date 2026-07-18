/**
 * PLAN-31 C1: the circles store — the pairing/membership foundation of the
 * collective-agency substrate.
 *
 * A circle is a closed, mutually-paired member set (4-15 humans) whose agents
 * coordinate shared life. This store owns membership only; the shared event
 * ledger (C2) and the encrypted channel/mailbox (C1 transport) build on top.
 *
 * Substrate discipline (PLAN-31 sections 11-12): the tables are
 * domain-agnostic. `kind` distinguishes expense / care / team / household
 * circles so the same membership machinery serves every domain, and member
 * `scopes` are an extensible default-deny set keyed by action class (not
 * hardcoded to money) so a care-rotation skill grants different scopes than a
 * settlement skill without a schema change.
 *
 * Two invariants this store enforces, both from the mechanics red team:
 *  - The payout wallet is PINNED at pair time. A settlement to any address
 *    other than a member's pinned wallet must be refused downstream; changing
 *    a pinned wallet requires an explicit re-pair (a new call here), never a
 *    silent update from agent logic.
 *  - Every membership change bumps `key_epoch`. NOTE: this counter is bumped
 *    but not yet CONSUMED — transport is currently unsealed HTTP with no
 *    channel key to rotate, so the "a departed member cannot read future
 *    traffic" property does NOT hold today. Consuming key_epoch (channel-key
 *    rotation) is PLAN-36 §5.6.
 */

import type { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";

/**
 * An action-class scope a member may hold. A free string so third-party and
 * future-domain skills can define their own scopes (sections 11-12) without a
 * type change; the known first-party scopes are documented in KNOWN_SCOPES.
 * Authorization is always default-deny.
 */
export type CircleScope = string;

/** The first-party action-class scopes (documentation + reuse). */
export const KNOWN_SCOPES = {
  ledgerRead: "ledger.read",
  ledgerAppend: "ledger.append",
  settlePropose: "settle.propose",
  scheduleRead: "schedule.read",
  schedulePropose: "schedule.propose",
  briefingRead: "briefing.read",
  decideVote: "decide.vote",
  // PLAN-31 C1/C2 connection-first verbs (v3): the social surface.
  rosterRead: "roster.read",
  messageSend: "message.send",
  presenceShare: "presence.share",
  askSend: "ask.send",
  answerSend: "answer.send",
} as const;

/** A circle's coordination domain. Free string; expense is the v1 beachhead. */
export type CircleKind = string;

export type CircleMember = {
  circleId: string;
  memberPubkey: string;
  displayName: string | null;
  /** Payout wallet pinned at pair time; settlements refuse any other payTo. */
  pinnedWallet: string | null;
  a2aUrl: string | null;
  /** X25519 box pubkey (base64) for mailbox sealing; published in signed envelopes. */
  boxPubkey: string | null;
  /** The member's mailbox host URL (where WE deposit mail for THEM). */
  mailboxUrl: string | null;
  role: "creator" | "member";
  scopes: CircleScope[];
  status: "active" | "left" | "suspended";
  joinedAt: number;
};

export type Circle = {
  circleId: string;
  name: string;
  kind: CircleKind;
  creatorPubkey: string;
  keyEpoch: number;
  /** `frozen` = event-ledger fork detected; writes refused until a human clears it. */
  status: "active" | "archived" | "frozen";
  /** JSON fork evidence recorded at freeze time (author, seq, hashes); NULL otherwise. */
  freezeReason: string | null;
  createdAt: number;
};

/** Default scopes granted to an ordinary member of an expense circle. */
export const DEFAULT_MEMBER_SCOPES: CircleScope[] = Object.values(KNOWN_SCOPES);

type CircleRow = {
  circle_id: string;
  name: string;
  kind: string;
  creator_pubkey: string;
  key_epoch: number;
  status: string;
  freeze_reason: string | null;
  created_at: number;
};

type MemberRow = {
  circle_id: string;
  member_pubkey: string;
  display_name: string | null;
  pinned_wallet: string | null;
  a2a_url: string | null;
  box_pubkey: string | null;
  mailbox_url: string | null;
  role: string;
  scopes_json: string;
  status: string;
  joined_at: number;
};

function rowToCircle(r: CircleRow): Circle {
  return {
    circleId: r.circle_id,
    name: r.name,
    kind: r.kind,
    creatorPubkey: r.creator_pubkey,
    keyEpoch: r.key_epoch,
    status: r.status as Circle["status"],
    freezeReason: r.freeze_reason ?? null,
    createdAt: r.created_at,
  };
}

function rowToMember(r: MemberRow): CircleMember {
  let scopes: CircleScope[] = [];
  try {
    const parsed = JSON.parse(r.scopes_json) as unknown;
    if (Array.isArray(parsed)) scopes = parsed.filter((s): s is string => typeof s === "string");
  } catch {
    // corrupt scope blob → default-deny (empty), never a crash
  }
  return {
    circleId: r.circle_id,
    memberPubkey: r.member_pubkey,
    displayName: r.display_name,
    pinnedWallet: r.pinned_wallet,
    a2aUrl: r.a2a_url,
    boxPubkey: r.box_pubkey ?? null,
    mailboxUrl: r.mailbox_url ?? null,
    role: r.role as CircleMember["role"],
    scopes,
    status: r.status as CircleMember["status"],
    joinedAt: r.joined_at,
  };
}

export class CirclesStore {
  constructor(private readonly db: DatabaseSync) {}

  /** Create a circle with its creator as the first member. Returns the id. */
  createCircle(args: {
    name: string;
    kind?: CircleKind;
    creatorPubkey: string;
    creatorWallet?: string;
    creatorA2aUrl?: string;
    now?: number;
  }): string {
    const now = args.now ?? Date.now();
    const circleId = crypto.randomUUID();
    this.db
      .prepare(
        `INSERT INTO circles
           (circle_id, name, kind, creator_pubkey, key_epoch, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, 0, 'active', ?, ?)`,
      )
      .run(circleId, args.name, args.kind ?? "expense", args.creatorPubkey, now, now);
    this.db
      .prepare(
        `INSERT INTO circle_members
           (circle_id, member_pubkey, display_name, pinned_wallet, a2a_url, role,
            scopes_json, status, joined_at, updated_at)
         VALUES (?, ?, NULL, ?, ?, 'creator', ?, 'active', ?, ?)`,
      )
      .run(
        circleId,
        args.creatorPubkey,
        args.creatorWallet ?? null,
        args.creatorA2aUrl ?? null,
        JSON.stringify(DEFAULT_MEMBER_SCOPES),
        now,
        now,
      );
    return circleId;
  }

  /**
   * Add (or re-pair) a member. Pins their payout wallet; bumps the circle's
   * key epoch so the transport layer rotates the channel key. Idempotent on
   * (circle, pubkey): a second call re-pairs (this is the explicit,
   * human-approved path a pinned-wallet change must take).
   */
  addMember(args: {
    circleId: string;
    memberPubkey: string;
    displayName?: string;
    pinnedWallet?: string;
    a2aUrl?: string;
    boxPubkey?: string;
    mailboxUrl?: string;
    scopes?: CircleScope[];
    now?: number;
  }): void {
    const now = args.now ?? Date.now();
    this.db
      .prepare(
        `INSERT INTO circle_members
           (circle_id, member_pubkey, display_name, pinned_wallet, a2a_url, box_pubkey,
            mailbox_url, role, scopes_json, status, joined_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'member', ?, 'active', ?, ?)
         ON CONFLICT(circle_id, member_pubkey) DO UPDATE SET
           display_name = excluded.display_name,
           pinned_wallet = excluded.pinned_wallet,
           a2a_url = excluded.a2a_url,
           box_pubkey = COALESCE(excluded.box_pubkey, circle_members.box_pubkey),
           mailbox_url = COALESCE(excluded.mailbox_url, circle_members.mailbox_url),
           scopes_json = excluded.scopes_json,
           status = 'active',
           updated_at = excluded.updated_at`,
      )
      .run(
        args.circleId,
        args.memberPubkey,
        args.displayName ?? null,
        args.pinnedWallet ?? null,
        args.a2aUrl ?? null,
        args.boxPubkey ?? null,
        args.mailboxUrl ?? null,
        JSON.stringify(args.scopes ?? DEFAULT_MEMBER_SCOPES),
        now,
        now,
      );
    this.bumpKeyEpoch(args.circleId, now);
  }

  /**
   * A member leaves / is evicted (node-local). Balances are NOT erased (they
   * live in the ledger). Does NOT bump the key epoch: the epoch only blinds
   * the gossip topic NAME, which an evictee already knows (they know the
   * circleId), so a bump grants no read-exclusion — and bumping on only one
   * node desyncs the remaining members' topic home (§5.5 review F2/F3). Write
   * refusal is total regardless (memberHasScope default-denies non-active).
   */
  removeMember(circleId: string, memberPubkey: string, now: number = Date.now()): void {
    this.db
      .prepare(
        `UPDATE circle_members SET status = 'left', updated_at = ?
          WHERE circle_id = ? AND member_pubkey = ? AND status != 'left'`,
      )
      .run(now, circleId, memberPubkey);
  }

  /** Suspend a member's writes (compromise circuit breaker, red-team §5). */
  suspendMember(circleId: string, memberPubkey: string, now: number = Date.now()): void {
    this.db
      .prepare(
        `UPDATE circle_members SET status = 'suspended', updated_at = ?
          WHERE circle_id = ? AND member_pubkey = ? AND status = 'active'`,
      )
      .run(now, circleId, memberPubkey);
  }

  getCircle(circleId: string): Circle | null {
    const row = this.db.prepare(`SELECT * FROM circles WHERE circle_id = ?`).get(circleId) as
      | CircleRow
      | undefined;
    return row ? rowToCircle(row) : null;
  }

  /** Active members of a circle. */
  getMembers(circleId: string): CircleMember[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM circle_members WHERE circle_id = ? AND status = 'active' ORDER BY joined_at`,
      )
      .all(circleId) as unknown as MemberRow[];
    return rows.map(rowToMember);
  }

  getMember(circleId: string, memberPubkey: string): CircleMember | null {
    const row = this.db
      .prepare(`SELECT * FROM circle_members WHERE circle_id = ? AND member_pubkey = ?`)
      .get(circleId, memberPubkey) as MemberRow | undefined;
    return row ? rowToMember(row) : null;
  }

  /** Circles this member actively belongs to. */
  getCirclesForMember(memberPubkey: string): Circle[] {
    const rows = this.db
      .prepare(
        `SELECT c.* FROM circles c
           JOIN circle_members m ON m.circle_id = c.circle_id
          WHERE m.member_pubkey = ? AND m.status = 'active' AND c.status = 'active'
          ORDER BY c.created_at`,
      )
      .all(memberPubkey) as unknown as CircleRow[];
    return rows.map(rowToCircle);
  }

  /**
   * Authorization primitive the A2A friend-auth branch calls: does this
   * member hold this scope in this circle right now? Default-deny — an
   * unknown/left/suspended member or a missing scope returns false.
   */
  memberHasScope(circleId: string, memberPubkey: string, scope: CircleScope): boolean {
    const m = this.getMember(circleId, memberPubkey);
    return m?.status === "active" && m.scopes.includes(scope);
  }

  /** The pinned payout wallet for a member; settlements must match this. */
  pinnedWalletFor(circleId: string, memberPubkey: string): string | null {
    return this.getMember(circleId, memberPubkey)?.pinnedWallet ?? null;
  }

  /**
   * Update a member's transport endpoints (a2a URL, box pubkey, mailbox URL)
   * from a SIGNED envelope body (join/presence). Never touches the pinned
   * wallet — that requires the explicit re-pair ceremony.
   */
  updateMemberEndpoints(
    circleId: string,
    memberPubkey: string,
    endpoints: { a2aUrl?: string | null; boxPubkey?: string | null; mailboxUrl?: string | null },
    now: number = Date.now(),
  ): void {
    this.db
      .prepare(
        `UPDATE circle_members SET
           a2a_url = COALESCE(?, a2a_url),
           box_pubkey = COALESCE(?, box_pubkey),
           mailbox_url = COALESCE(?, mailbox_url),
           updated_at = ?
         WHERE circle_id = ? AND member_pubkey = ?`,
      )
      .run(
        endpoints.a2aUrl ?? null,
        endpoints.boxPubkey ?? null,
        endpoints.mailboxUrl ?? null,
        now,
        circleId,
        memberPubkey,
      );
  }

  /**
   * Mirror a circle we were invited into (PLAN-31 C1: after a successful
   * circle/join redemption, the invitee stores the inviter's roster so both
   * nodes hold the same membership view). Upserts the circle row with the
   * REMOTE circle_id (identity across the mesh) and every roster member.
   * Idempotent: re-mirroring refreshes names/urls without duplicating rows.
   */
  importCircle(
    circle: {
      circleId: string;
      name: string;
      kind: CircleKind;
      creatorPubkey: string;
      keyEpoch: number;
      createdAt: number;
    },
    members: Array<{
      memberPubkey: string;
      displayName?: string | null;
      pinnedWallet?: string | null;
      a2aUrl?: string | null;
      boxPubkey?: string | null;
      mailboxUrl?: string | null;
      role?: "creator" | "member";
      scopes?: CircleScope[];
      joinedAt?: number;
    }>,
    now: number = Date.now(),
  ): void {
    this.db
      .prepare(
        `INSERT INTO circles
           (circle_id, name, kind, creator_pubkey, key_epoch, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'active', ?, ?)
         ON CONFLICT(circle_id) DO UPDATE SET
           name = excluded.name,
           kind = excluded.kind,
           key_epoch = MAX(circles.key_epoch, excluded.key_epoch),
           updated_at = excluded.updated_at`,
      )
      .run(
        circle.circleId,
        circle.name,
        circle.kind,
        circle.creatorPubkey,
        circle.keyEpoch,
        circle.createdAt,
        now,
      );
    for (const m of members) {
      this.db
        .prepare(
          `INSERT INTO circle_members
             (circle_id, member_pubkey, display_name, pinned_wallet, a2a_url, box_pubkey,
              mailbox_url, role, scopes_json, status, joined_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
           ON CONFLICT(circle_id, member_pubkey) DO UPDATE SET
             display_name = excluded.display_name,
             pinned_wallet = excluded.pinned_wallet,
             a2a_url = excluded.a2a_url,
             box_pubkey = COALESCE(excluded.box_pubkey, circle_members.box_pubkey),
             mailbox_url = COALESCE(excluded.mailbox_url, circle_members.mailbox_url),
             role = excluded.role,
             scopes_json = excluded.scopes_json,
             status = 'active',
             updated_at = excluded.updated_at`,
        )
        .run(
          circle.circleId,
          m.memberPubkey,
          m.displayName ?? null,
          m.pinnedWallet ?? null,
          m.a2aUrl ?? null,
          m.boxPubkey ?? null,
          m.mailboxUrl ?? null,
          m.role ?? "member",
          JSON.stringify(m.scopes ?? DEFAULT_MEMBER_SCOPES),
          m.joinedAt ?? now,
          now,
        );
    }
  }

  /**
   * Freeze a circle (fork detected in the event ledger, PLAN-31 §3.3: a
   * same-seq divergence is cryptographic proof of tampering — writes stop
   * and humans are surfaced). `reason` is the JSON fork evidence the UI
   * shows the human. Unfreezing is a deliberate human act.
   */
  freezeCircle(circleId: string, now: number = Date.now(), reason: string | null = null): void {
    this.db
      .prepare(
        `UPDATE circles SET status = 'frozen', freeze_reason = ?, updated_at = ?
          WHERE circle_id = ?`,
      )
      .run(reason, now, circleId);
  }

  /**
   * The deliberate human act that ends a freeze: resume writes, and MOVE the
   * fork evidence into the `forgiven_forks` audit trail (never destroyed).
   * Only a frozen circle can be unfrozen (returns false otherwise).
   * Node-local: each member's node froze independently and each member's
   * human decides independently. The forked author's CHAIN stays divergent —
   * their future tab/canvas events may still chain-break until they recover —
   * but conversation and everyone else's events resume. Because the author is
   * now forgiven, replays of their fork are rejected WITHOUT re-freezing
   * (isForkForgiven) — reviewed once is reviewed; a fork from a different
   * member still freezes.
   */
  unfreezeCircle(circleId: string, now: number = Date.now()): boolean {
    const circle = this.getCircle(circleId);
    if (!circle || circle.status !== "frozen") return false;
    let forgiven: unknown[] = [];
    const row = this.db
      .prepare(`SELECT forgiven_forks FROM circles WHERE circle_id = ?`)
      .get(circleId) as { forgiven_forks: string | null } | undefined;
    try {
      const parsed = JSON.parse(row?.forgiven_forks ?? "[]") as unknown;
      if (Array.isArray(parsed)) forgiven = parsed;
    } catch {
      /* corrupt audit trail: start fresh rather than fail the recovery */
    }
    if (circle.freezeReason) {
      let evidence: Record<string, unknown> = {};
      try {
        evidence = JSON.parse(circle.freezeReason) as Record<string, unknown>;
      } catch {
        evidence = { raw: circle.freezeReason };
      }
      forgiven.push({ ...evidence, forgiven_at: now });
      forgiven = forgiven.slice(-20); // bounded audit trail
    }
    const res = this.db
      .prepare(
        `UPDATE circles SET status = 'active', freeze_reason = NULL, forgiven_forks = ?,
                updated_at = ?
          WHERE circle_id = ? AND status = 'frozen'`,
      )
      .run(JSON.stringify(forgiven), now, circleId);
    return Number(res.changes) === 1;
  }

  /**
   * Has the human already reviewed (and forgiven) a fork from this author in
   * this circle? Used by the fork branch to reject replays without
   * re-freezing — otherwise one replayed envelope (a member restored from
   * backup, or a griefer) puts the circle straight back in the freezer after
   * every unfreeze. A determined attacker inside the circle can still fork at
   * a DIFFERENT seq only by rewriting more of their own history — the audit
   * trail names them each time; eviction is the §5.5 primitive.
   */
  isForkForgiven(circleId: string, authorPubkey: string): boolean {
    const row = this.db
      .prepare(`SELECT forgiven_forks FROM circles WHERE circle_id = ?`)
      .get(circleId) as { forgiven_forks: string | null } | undefined;
    if (!row?.forgiven_forks) return false;
    try {
      const parsed = JSON.parse(row.forgiven_forks) as Array<{ author_pubkey?: string }>;
      return Array.isArray(parsed) && parsed.some((f) => f.author_pubkey === authorPubkey);
    } catch {
      return false;
    }
  }

  /** True when the circle exists and accepts writes (active, not frozen). */
  isWritable(circleId: string): boolean {
    return this.getCircle(circleId)?.status === "active";
  }

  private bumpKeyEpoch(circleId: string, now: number): void {
    this.db
      .prepare(`UPDATE circles SET key_epoch = key_epoch + 1, updated_at = ? WHERE circle_id = ?`)
      .run(now, circleId);
  }
}
