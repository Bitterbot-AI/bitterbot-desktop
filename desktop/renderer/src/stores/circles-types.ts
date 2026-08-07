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
  members: CircleMember[];
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

/**
 * Union two chronological message runs by messageId, `incoming` winning on
 * collisions (tombstones, delivery-status flips), sorted oldest-first with
 * messageId as the stable tiebreak. Used both for the 20s poll window (which
 * must not clobber older pages) and for history-page prepends.
 */
export function mergeMessages(
  existing: CircleMessage[],
  incoming: CircleMessage[],
): CircleMessage[] {
  const byId = new Map<string, CircleMessage>();
  for (const m of existing) byId.set(m.messageId, m);
  for (const m of incoming) byId.set(m.messageId, m);
  return [...byId.values()].sort(
    (a, b) => a.createdAt - b.createdAt || (a.messageId < b.messageId ? -1 : 1),
  );
}
