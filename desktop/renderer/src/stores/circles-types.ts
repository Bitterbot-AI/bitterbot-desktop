// PLAN-36: shared Circles data shapes + pure helpers, split from the store
// (file-size cap). Everything here is renderer-side typing for the circles.*
// RPC payloads plus logic with no store dependency; the store re-exports it
// all, so `import ... from "../../stores/circles-store"` keeps working.

export interface CircleMember {
  memberPubkey: string;
  displayName: string | null;
  /** §5.6: the viewer's private label for this person (overrides displayName). */
  petname?: string | null;
  /** No petname set yet — the human hasn't vouched for who this key is. */
  unverified?: boolean;
  /** Another different key you know shows the same name — impersonation cue. */
  nameCollision?: boolean;
  role: string;
  isSelf: boolean;
  lastSeenAt: number | null;
  lastStatus: string | null;
  /** Their agent's posture ("summon-only" | "off"); null until their node reports it. */
  agentPosture?: string | null;
}

/** The name to show for a member: your private label wins, else their own. */
export function memberName(m: Pick<CircleMember, "petname" | "displayName">): string {
  return (m.petname ?? m.displayName ?? "friend").trim() || "friend";
}

export interface Circle {
  circleId: string;
  name: string;
  kind: string;
  status: string;
  /** JSON fork evidence when status === "frozen" (author, seq, hashes). */
  freezeReason?: string | null;
  unread?: number;
  /** Server read marker (ms epoch); frozen at circle-open for the "New" divider. */
  lastReadAt?: number;
  /** §5.3 agent writes awaiting THIS human's approval (Phase C badges). */
  pendingApprovals?: number;
  members: CircleMember[];
}

/** What the rail tiles and the app sidebar surface without the tab open. */
export interface CircleAttention {
  unread: number;
  approvals: number;
}

/**
 * Aggregate attention across circles for the app-sidebar badge (Phase C).
 * Archived circles are excluded — their tiles are hidden, so their counts
 * would nag about something the rail doesn't show.
 */
export function circlesAttention(circles: Circle[]): CircleAttention {
  let unread = 0;
  let approvals = 0;
  for (const c of circles) {
    if (c.status === "archived") continue;
    unread += c.unread ?? 0;
    approvals += c.pendingApprovals ?? 0;
  }
  return { unread, approvals };
}

export interface CircleMessage {
  messageId: string;
  envelopeId?: string | null;
  authorPubkey: string;
  direction: string;
  kind: string;
  content: string;
  createdAt: number;
  deliveryStatus?: "pending" | "delivered" | "partial" | "failed" | null;
  replyTo?: string | null;
  /** Mockup pin 2: the text was written by the author's AGENT (they approved it). */
  agentAuthored?: boolean;
  /** Tombstoned: own-message retraction (propagated) or local hide. */
  deleted?: boolean;
  /** The tombstone was a local hide by you (vs the author retracting). */
  deletedByMe?: boolean;
}

export interface MessageReaction {
  authorPubkey: string;
  emojis: string[];
}

export interface PinnedMessage {
  envelopeId: string;
  authorPubkey: string;
  direction: string;
  content: string;
  createdAt: number;
  agentAuthored?: boolean;
}

export interface MessageAnnotations {
  /** envelopeId -> per-member reaction sets. */
  reactions: Record<string, MessageReaction[]>;
  /** Pinned envelopeIds, oldest pin first. */
  pins: string[];
  /** The pinned messages resolved server-side (no message-window limit). */
  pinnedMessages?: PinnedMessage[];
}

/**
 * §5.3: an agent tool write awaiting THIS human's approval. The server holds
 * the exact params it will execute; the card shows the preview. Approval is
 * the only path to execution.
 */
export interface PendingOutbound {
  id: string;
  circleId: string;
  action: string;
  preview: Record<string, unknown>;
  createdAt: number;
  expiresAt: number;
}

/** The shared expense tab (circles.tab.balances), folded from the ledger. */
export interface TabBalances {
  /** Net position per member in cents: positive = the circle owes them. */
  net: Record<string, number>;
  /** Pairwise debts for display: debtor -> creditor -> cents. */
  pairwise: Record<string, Record<string, number>>;
  expenses: number;
  reversed: number;
  totalCents: number;
}

export interface CirclesStatus {
  enabled: boolean;
  pubkey?: string;
  connectionCount?: number;
  reciprocity?: { reciprocatedPeers: number; activePeers: number };
  a2aPublicUrl?: string | null;
  /** §5.6: the name friends see you by (editable in-app). */
  displayName?: string;
}

export interface CanvasSlice {
  slot: string;
  value: string;
  note: string;
  authorPubkey: string;
  updatedAt: number;
}

export interface CanvasCard {
  cardId: string;
  cardType: string;
  title: string;
  text: string;
  authorPubkey: string;
  updatedAt: number;
  slices: CanvasSlice[];
}

/** A tombstoned card (§3.2.9) — enough to narrate the removal and offer Undo. */
export interface RemovedCanvasCard {
  cardId: string;
  cardType: string;
  title: string;
  text: string;
  removedBy: string;
  removedAt: number;
}

/**
 * PLAN-36 Phase B: a node-local draft the member's own agent wrote after an
 * @agent summon. Visible only to this node's human; publishing it (optionally
 * edited) is the consent tap that actually sends it to the circle.
 */
export interface AgentDraft {
  draftId: string;
  circleId: string;
  summonEnvelopeId: string | null;
  summonAuthorPubkey: string | null;
  /** "reply" (chat) or "slice" (a canvas card slot pre-fill, B2). */
  kind?: string;
  targetCardId?: string | null;
  targetSlot?: string | null;
  content: string;
  createdAt: number;
}

/** PLAN-38 P1(b): one honored move in a sandbox session's fold. */
export interface SandboxMove {
  round: number;
  kind: "constraint" | "option.add" | "vote" | "pass";
  text: string;
  optionId: string;
  label: string;
  authorPubkey: string;
  agentAuthored: boolean;
  /** R2/M1: transitive author provenance, recomputed by OUR node. */
  authors: string[];
  eventHash: string;
  claimedAt: number;
}

/** The node-local half of participation, per CIRCLE (never leaves this node). */
export interface SandboxParticipation {
  mode: "off" | "propose";
  turnBudget: number;
  turnsUsed: number;
  tokenBudget: number;
  tokensUsed: number;
  guidance: string;
  pausedAt: number | null;
  pauseReason: string | null;
}

/** A sandbox session folded from the ledger, plus our node-local view state. */
export interface SandboxSession {
  cardId: string;
  taskType: string;
  goal: string;
  roundCap: number;
  framedBy: string;
  enrollments: Array<{ authorPubkey: string; mode: string; updatedAt: number }>;
  speakers: string[];
  moves: SandboxMove[];
  options: Array<{ optionId: string; label: string; text: string; proposedBy: string }>;
  votes: Record<string, string[]>;
  closed: { reason: string; byPubkey: string; at: number } | null;
  currentRound: number;
  status: "gathering" | "live" | "closed";
  myTurn: boolean;
  waitingOn: string[];
  // §3.1 containment, derived by the fold so every node agrees.
  /** Speakers whose turn deadline passed: a visible pass, not a spinner. */
  lapsed: string[];
  /** When the current round's stragglers lapse (ms epoch). */
  passesAt: number | null;
  /** Authors whose last two contributions said the same thing. */
  noProgressAuthors: string[];
  /** Everyone voting agrees on this option — surfaced, never auto-closed. */
  agreedOptionId: string | null;
}

export interface SandboxState {
  /** Agent generation on this node (humans always work regardless). */
  generationEnabled: boolean;
  practicePubkey: string | null;
  /** One standing choice for the whole circle: does my agent work here. */
  participation: SandboxParticipation | null;
  /** Cards whose proposal is still generating — "thinking", not dead air. */
  thinkingCardIds: string[];
  sessions: SandboxSession[];
}

/**
 * PLAN-36 Phase 4b: this member's OWN mastery state for one study-guide
 * section (Leitner box + spaced-repetition due date). Node-local, derived
 * only from the human's own quiz taps; never fans out.
 */
export interface StudySectionState {
  slot: string;
  box: number;
  correctCount: number;
  missCount: number;
  dueAt: number;
}

/** One history page — the store's fetch size AND the component's "a full
 * window is loaded, offer paging" gate derive from this single constant. */
export const HISTORY_PAGE = 100;

/** The fields the server can legitimately change on a known message. */
function sameMessage(a: CircleMessage, b: CircleMessage): boolean {
  return (
    a.content === b.content &&
    a.createdAt === b.createdAt &&
    a.envelopeId === b.envelopeId &&
    a.deliveryStatus === b.deliveryStatus &&
    a.replyTo === b.replyTo &&
    a.agentAuthored === b.agentAuthored &&
    a.deleted === b.deleted &&
    a.deletedByMe === b.deletedByMe
  );
}

/**
 * Union two chronological message runs by messageId, `incoming` winning on
 * collisions (tombstones, delivery-status flips), sorted oldest-first with
 * messageId as the stable tiebreak. Used both for the 20s poll window (which
 * must not clobber older pages) and for history-page prepends.
 *
 * Reference-stable: an unchanged message keeps its existing object, and a
 * no-op merge returns `existing` itself — idle 20s polls must not force a
 * re-render of every row (the poll always parses fresh objects).
 */
export function mergeMessages(
  existing: CircleMessage[],
  incoming: CircleMessage[],
): CircleMessage[] {
  const byId = new Map<string, CircleMessage>();
  for (const m of existing) byId.set(m.messageId, m);
  for (const m of incoming) {
    const prev = byId.get(m.messageId);
    byId.set(m.messageId, prev && sameMessage(prev, m) ? prev : m);
  }
  const merged = [...byId.values()].sort(
    (a, b) => a.createdAt - b.createdAt || (a.messageId < b.messageId ? -1 : 1),
  );
  if (merged.length === existing.length && merged.every((m, i) => m === existing[i])) {
    return existing;
  }
  return merged;
}

/** The circles store's full state + action surface (lives here for the
 * file-size split; the store implements it). */
export interface CirclesState {
  status: CirclesStatus | null;
  circles: Circle[];
  activeCircleId: string | null;
  messagesByCircle: Record<string, CircleMessage[]>;
  annotationsByCircle: Record<string, MessageAnnotations>;
  /**
   * The circle's read marker AS IT STOOD WHEN THE HUMAN OPENED IT — the "New"
   * divider anchors here and must not slide while they read (markRead bumps
   * the live marker the moment the circle is opened).
   */
  readFrontierByCircle: Record<string, number>;
  /** History paging: true once a short page proved there is nothing older. */
  historyExhaustedByCircle: Record<string, boolean>;
  /** When each circle was last locally marked read (session-only): the ack
   * guard against a racing circles.list resurrecting a cleared badge. */
  readSyncByCircle: Record<string, number>;
  cardsByCircle: Record<string, CanvasCard[]>;
  removedByCircle: Record<string, RemovedCanvasCard[]>;
  sandboxByCircle: Record<string, SandboxState>;
  draftsByCircle: Record<string, AgentDraft[]>;
  /** Phase 4b study state, keyed `${circleId}:${cardId}`. */
  studyByCard: Record<string, StudySectionState[]>;
  outboundByCircle: Record<string, PendingOutbound[]>;
  /** Shared expense tab per circle — the surface behind log_expense approvals. */
  tabByCircle: Record<string, TabBalances>;
  loading: boolean;
  notice: string | null;
  /** Phase D: errors must LOOK like errors — a failed send is not a tip. */
  noticeLevel: "info" | "error";
  /** §3.2.8: a chat item's card chip focuses its card on the canvas. */
  focusCardId: string | null;

  /** Cheap list-only sync (status + list + selection) — safe for the
   * app-wide background loop: no pane loads, no markRead, no notices. */
  refreshList: () => Promise<{ ok: boolean; error?: string }>;
  refresh: () => Promise<void>;
  selectCircle: (circleId: string) => void;
  loadMessages: (circleId: string) => Promise<void>;
  /** Prepend the next (older) history page; resolves to how many were added. */
  loadOlderMessages: (circleId: string) => Promise<number>;
  loadCards: (circleId: string) => Promise<void>;
  setFocusCard: (cardId: string | null) => void;
  removeCard: (circleId: string, cardId: string) => Promise<boolean>;
  clearCard: (circleId: string, cardId: string, keepText: boolean) => Promise<boolean>;
  undoRemoveCard: (circleId: string, removed: RemovedCanvasCard) => Promise<boolean>;
  loadSandbox: (circleId: string) => Promise<void>;
  /** The one consent act: does my agent work this circle's canvas. */
  setCanvasParticipation: (
    circleId: string,
    mode: "off" | "propose",
    opts?: { guidance?: string; turnBudget?: number },
  ) => Promise<boolean>;
  /** The human composer: post a move by hand. */
  sandboxMove: (
    circleId: string,
    cardId: string,
    kind: "constraint" | "option.add" | "vote" | "pass",
    opts?: { text?: string; optionId?: string; label?: string },
  ) => Promise<boolean>;
  /** Steer: your words to your own agent (private, never posted anywhere). */
  steerAgent: (circleId: string, guidance: string) => Promise<boolean>;
  pauseSandbox: (circleId: string) => Promise<boolean>;
  resumeSandbox: (circleId: string) => Promise<boolean>;
  closeSandbox: (circleId: string, cardId: string, reason: "done" | "human") => Promise<boolean>;
  loadDrafts: (circleId: string) => Promise<void>;
  loadOutbound: (circleId: string) => Promise<void>;
  /** Load the shared expense tab (a user must be able to SEE what they approve). */
  loadTab: (circleId: string) => Promise<void>;
  /** Fire-and-forget ALL of a circle's pane loads — the one fan-out site. */
  loadCirclePanes: (circleId: string) => void;
  approveOutbound: (circleId: string, id: string) => Promise<boolean>;
  rejectOutbound: (circleId: string, id: string) => Promise<boolean>;
  requestSliceDraft: (circleId: string, cardId: string, slot: string) => Promise<boolean>;
  /** Phase 4b: ask my agent for a personal study aid from this card (private; never publishable). */
  requestStudyDraft: (circleId: string, cardId: string) => Promise<boolean>;
  loadStudyState: (circleId: string, cardId: string) => Promise<void>;
  /** Phase 4b: record one quiz tap; refreshes the card's study state. */
  recordStudy: (
    circleId: string,
    cardId: string,
    slot: string,
    correct: boolean,
  ) => Promise<boolean>;
  /** Chat-scoped "Ask my agent": a private reply draft, no summon message posted. */
  requestChatDraft: (circleId: string) => Promise<boolean>;
  publishDraft: (circleId: string, draftId: string, text: string) => Promise<boolean>;
  discardDraft: (circleId: string, draftId: string) => Promise<boolean>;
  send: (circleId: string, text: string, replyTo?: string) => Promise<boolean>;
  react: (circleId: string, envelopeId: string, emojis: string[]) => Promise<boolean>;
  setPinned: (circleId: string, envelopeId: string, pinned: boolean) => Promise<boolean>;
  deleteMessage: (
    circleId: string,
    envelopeId: string,
    expectPropagation?: boolean,
  ) => Promise<boolean>;
  putCard: (
    circleId: string,
    title: string,
    text: string,
    cardId?: string,
    cardType?: string,
  ) => Promise<boolean>;
  putDecision: (circleId: string, question: string, options: string[]) => Promise<boolean>;
  putStudyGuide: (circleId: string, title: string, sections: string[]) => Promise<boolean>;
  putSlice: (
    circleId: string,
    cardId: string,
    slot: string,
    value: string,
    note: string,
  ) => Promise<boolean>;
  vote: (circleId: string, cardId: string, option: string, note: string) => Promise<boolean>;
  markRead: (circleId: string) => void;
  unfreeze: (circleId: string) => Promise<boolean>;
  removeMember: (circleId: string, memberPubkey: string) => Promise<boolean>;
  renameCircle: (circleId: string, name: string) => Promise<boolean>;
  /** Verified preview of an invite code (who is REALLY asking) before joining. */
  inviteInfo: (code: string) => Promise<{
    circleName: string;
    inviterName: string | null;
    inviterPubkey: string;
    /** Your label for the verified signer when you already know them. */
    knownAs?: string | null;
  } | null>;
  /** One-tap join for an invite code detected in a message. */
  joinInvite: (code: string) => Promise<boolean>;
  /** Phase C posture control: flip the agent-drafts switch (persisted + live). */
  setAgentDrafts: (enabled: boolean) => Promise<boolean>;
  archiveCircle: (circleId: string) => Promise<boolean>;
  unarchiveCircle: (circleId: string) => Promise<boolean>;
  deleteCircle: (circleId: string) => Promise<boolean>;
  setPetname: (memberPubkey: string, petname: string) => Promise<boolean>;
  setSelfName: (name: string) => Promise<boolean>;
  setNotice: (notice: string | null) => void;
}
