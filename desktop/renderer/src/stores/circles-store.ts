import { create } from "zustand";
import { useGatewayStore } from "./gateway-store";

// PLAN-36 Phase A (redesign): the per-circle keyed store the Discord-style
// CirclesView is built on. Replaces PeopleView's ad-hoc local useState. Keeps
// one message cache per circle so switching circles is instant and A2 (unread
// badges) has a home. All state rides the existing circles.* gateway RPCs — no
// new protocol.

// Version-skew degradation: a gateway older than this UI doesn't know the
// newer circles.* RPCs. Remember per-method, stop calling, and never surface
// the failure as a notice — the feature simply stays absent until the
// gateway is rebuilt. (The gateway-store already suppresses the toast.)
const unsupportedMethods = new Set<string>();
/** Test seam: module state must not leak between renderer tests. */
export function resetUnsupportedMethodsForTests(): void {
  unsupportedMethods.clear();
}
function methodUnavailable(method: string, err: unknown): boolean {
  if (unsupportedMethods.has(method)) return true;
  if (String(err).includes("unknown method")) {
    unsupportedMethods.add(method);
    return true;
  }
  return false;
}

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

interface CirclesState {
  status: CirclesStatus | null;
  circles: Circle[];
  activeCircleId: string | null;
  messagesByCircle: Record<string, CircleMessage[]>;
  annotationsByCircle: Record<string, MessageAnnotations>;
  cardsByCircle: Record<string, CanvasCard[]>;
  sandboxByCircle: Record<string, SandboxState>;
  draftsByCircle: Record<string, AgentDraft[]>;
  /** Phase 4b study state, keyed `${circleId}:${cardId}`. */
  studyByCard: Record<string, StudySectionState[]>;
  outboundByCircle: Record<string, PendingOutbound[]>;
  loading: boolean;
  notice: string | null;

  refresh: () => Promise<void>;
  selectCircle: (circleId: string) => void;
  loadMessages: (circleId: string) => Promise<void>;
  loadCards: (circleId: string) => Promise<void>;
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
  archiveCircle: (circleId: string) => Promise<boolean>;
  unarchiveCircle: (circleId: string) => Promise<boolean>;
  deleteCircle: (circleId: string) => Promise<boolean>;
  setPetname: (memberPubkey: string, petname: string) => Promise<boolean>;
  setSelfName: (name: string) => Promise<boolean>;
  setNotice: (notice: string | null) => void;
}

function request<T = unknown>(method: string, params?: unknown): Promise<T> {
  return useGatewayStore.getState().request<T>(method, params);
}

export const useCirclesStore = create<CirclesState>((set, get) => ({
  status: null,
  circles: [],
  activeCircleId: null,
  messagesByCircle: {},
  annotationsByCircle: {},
  cardsByCircle: {},
  sandboxByCircle: {},
  draftsByCircle: {},
  studyByCard: {},
  outboundByCircle: {},
  loading: true,
  notice: null,

  setNotice: (notice) => set({ notice }),

  refresh: async () => {
    try {
      const status = await request<CirclesStatus>("circles.status", {});
      if (!status.enabled) {
        set({ status, circles: [], loading: false });
        return;
      }
      const list = await request<{ circles: Circle[] }>("circles.list", {});
      const circles = list.circles ?? [];
      // Keep the current selection if it still exists; else pick the first.
      const prev = get().activeCircleId;
      const activeCircleId =
        prev && circles.some((c) => c.circleId === prev) ? prev : (circles[0]?.circleId ?? null);
      set({ status, circles, activeCircleId, loading: false });
      if (activeCircleId) {
        void get().loadMessages(activeCircleId);
        void get().loadCards(activeCircleId);
        void get().loadSandbox(activeCircleId);
        void get().loadDrafts(activeCircleId);
        void get().loadOutbound(activeCircleId);
        get().markRead(activeCircleId); // the circle on screen is, by definition, read
      }
    } catch (err) {
      set({ notice: String(err), loading: false });
    }
  },

  selectCircle: (circleId) => {
    set({ activeCircleId: circleId });
    void get().loadMessages(circleId);
    void get().loadCards(circleId);
    void get().loadSandbox(circleId);
    void get().loadDrafts(circleId);
    void get().loadOutbound(circleId);
    get().markRead(circleId);
  },

  loadDrafts: async (circleId) => {
    if (unsupportedMethods.has("circles.drafts.list")) return;
    try {
      const res = await request<{ drafts: AgentDraft[] }>("circles.drafts.list", { circleId });
      set((s) => ({ draftsByCircle: { ...s.draftsByCircle, [circleId]: res.drafts ?? [] } }));
    } catch (err) {
      if (methodUnavailable("circles.drafts.list", err)) return;
      set({ notice: String(err) });
    }
  },

  loadOutbound: async (circleId) => {
    if (unsupportedMethods.has("circles.outbound.list")) return;
    try {
      const res = await request<{ pending: PendingOutbound[] }>("circles.outbound.list", {
        circleId,
      });
      set((s) => ({ outboundByCircle: { ...s.outboundByCircle, [circleId]: res.pending ?? [] } }));
    } catch (err) {
      if (methodUnavailable("circles.outbound.list", err)) return;
      set({ notice: String(err) });
    }
  },

  approveOutbound: async (circleId, id) => {
    try {
      await request("circles.outbound.approve", { id });
      await Promise.all([get().loadOutbound(circleId), get().loadMessages(circleId)]);
      return true;
    } catch (err) {
      set({ notice: String(err) });
      return false;
    }
  },

  rejectOutbound: async (circleId, id) => {
    try {
      await request("circles.outbound.reject", { id });
      await get().loadOutbound(circleId);
      return true;
    } catch (err) {
      set({ notice: String(err) });
      return false;
    }
  },

  requestSliceDraft: async (circleId, cardId, slot) => {
    try {
      // B2: ask my agent to pre-fill MY slot on this card. The draft comes
      // back via the "circles" nudge → loadDrafts; publishing a slice draft
      // ships through circles.canvas.slice on the server.
      await request("circles.drafts.request", { circleId, cardId, slot });
      return true;
    } catch (err) {
      set({ notice: String(err) });
      return false;
    }
  },

  requestStudyDraft: async (circleId, cardId) => {
    try {
      // Phase 4b: the agent builds a private study aid (quiz + gap map) from
      // the shared card, tuned to MY mastery state. Renders to me only; the
      // server has no publish path for study drafts.
      await request("circles.drafts.request", { circleId, cardId, kind: "study" });
      return true;
    } catch (err) {
      set({ notice: String(err) });
      return false;
    }
  },

  loadStudyState: async (circleId, cardId) => {
    try {
      const res = await request<{ sections: StudySectionState[] }>("circles.study.state", {
        circleId,
        cardId,
      });
      set((s) => ({
        studyByCard: { ...s.studyByCard, [`${circleId}:${cardId}`]: res.sections ?? [] },
      }));
    } catch {
      // Older gateway without Phase 4b: no badges, everything else works.
    }
  },

  recordStudy: async (circleId, cardId, slot, correct) => {
    try {
      await request("circles.study.record", { circleId, cardId, slot, correct });
      await get().loadStudyState(circleId, cardId);
      return true;
    } catch (err) {
      set({ notice: String(err) });
      return false;
    }
  },

  requestChatDraft: async (circleId) => {
    try {
      // Nothing is posted to the circle — the agent drafts privately and the
      // card lands in the quiet tray for review/publish.
      await request("circles.drafts.request", { circleId });
      return true;
    } catch (err) {
      set({ notice: String(err) });
      return false;
    }
  },

  publishDraft: async (circleId, draftId, text) => {
    if (!text.trim()) return false;
    try {
      await request("circles.drafts.publish", { draftId, text: text.trim() });
      // A reply draft lands in messages; a slice draft lands on the canvas.
      await Promise.all([
        get().loadDrafts(circleId),
        get().loadMessages(circleId),
        get().loadCards(circleId),
      ]);
      return true;
    } catch (err) {
      set({ notice: String(err) });
      return false;
    }
  },

  discardDraft: async (circleId, draftId) => {
    try {
      await request("circles.drafts.discard", { draftId });
      await get().loadDrafts(circleId);
      return true;
    } catch (err) {
      set({ notice: String(err) });
      return false;
    }
  },

  loadCards: async (circleId) => {
    try {
      const res = await request<{ cards: CanvasCard[] }>("circles.canvas.list", { circleId });
      set((s) => ({ cardsByCircle: { ...s.cardsByCircle, [circleId]: res.cards ?? [] } }));
    } catch (err) {
      set({ notice: String(err) });
    }
  },

  // PLAN-38 P1(b): the canvas sandbox. Version-skew safe: an older gateway
  // without the sandbox RPCs leaves the feature absent, never noisy.
  loadSandbox: async (circleId) => {
    if (unsupportedMethods.has("circles.sandbox.state")) return;
    try {
      const res = await request<Partial<SandboxState>>("circles.sandbox.state", { circleId });
      // Normalize defensively: a gateway of a different vintage answering with
      // an unexpected shape must degrade to "no sessions", never crash the
      // canvas render.
      const state: SandboxState = {
        generationEnabled: res?.generationEnabled === true,
        practicePubkey: typeof res?.practicePubkey === "string" ? res.practicePubkey : null,
        participation: res?.participation ?? null,
        thinkingCardIds: Array.isArray(res?.thinkingCardIds) ? res.thinkingCardIds : [],
        sessions: Array.isArray(res?.sessions) ? res.sessions : [],
      };
      set((s) => ({ sandboxByCircle: { ...s.sandboxByCircle, [circleId]: state } }));
    } catch (err) {
      if (!methodUnavailable("circles.sandbox.state", err)) set({ notice: String(err) });
    }
  },

  setCanvasParticipation: async (circleId, mode, opts) => {
    try {
      await request("circles.sandbox.participation", {
        circleId,
        mode,
        guidance: opts?.guidance,
        turnBudget: opts?.turnBudget,
      });
      await get().loadSandbox(circleId);
      await get().refresh(); // a solo circle may have gained the practice bot
      return true;
    } catch (err) {
      set({ notice: String(err) });
      return false;
    }
  },

  sandboxMove: async (circleId, cardId, kind, opts) => {
    try {
      await request("circles.sandbox.move", { circleId, cardId, kind, ...opts });
      await get().loadSandbox(circleId);
      return true;
    } catch (err) {
      set({ notice: String(err) });
      return false;
    }
  },

  steerAgent: async (circleId, guidance) => {
    try {
      await request("circles.sandbox.steer", { circleId, guidance });
      await get().loadSandbox(circleId);
      return true;
    } catch (err) {
      set({ notice: String(err) });
      return false;
    }
  },

  pauseSandbox: async (circleId) => {
    try {
      await request("circles.sandbox.pause", { circleId });
      await get().loadSandbox(circleId);
      return true;
    } catch (err) {
      set({ notice: String(err) });
      return false;
    }
  },

  resumeSandbox: async (circleId) => {
    try {
      await request("circles.sandbox.resume", { circleId });
      await get().loadSandbox(circleId);
      return true;
    } catch (err) {
      set({ notice: String(err) });
      return false;
    }
  },

  closeSandbox: async (circleId, cardId, reason) => {
    try {
      await request("circles.sandbox.close", { circleId, cardId, reason });
      await get().loadSandbox(circleId);
      return true;
    } catch (err) {
      set({ notice: String(err) });
      return false;
    }
  },

  putCard: async (circleId, title, text, cardId, cardType) => {
    if (!title.trim() && !text.trim()) return false;
    try {
      await request("circles.canvas.put", {
        circleId,
        title: title.trim(),
        text,
        cardId,
        cardType,
      });
      await get().loadCards(circleId);
      return true;
    } catch (err) {
      set({ notice: String(err) });
      return false;
    }
  },

  putDecision: async (circleId, question, options) => {
    const opts = options.map((o) => o.trim()).filter(Boolean);
    if (!question.trim() || opts.length < 2) return false;
    try {
      // A Decision Card is a card with cardType "decision"; options ride the
      // text field, one per line (a scanned string). Votes are per-member slices.
      await request("circles.canvas.put", {
        circleId,
        cardType: "decision",
        title: question.trim(),
        text: opts.join("\n"),
      });
      await get().loadCards(circleId);
      return true;
    } catch (err) {
      set({ notice: String(err) });
      return false;
    }
  },

  putStudyGuide: async (circleId, title, sections) => {
    const secs = sections.map((s) => s.trim()).filter(Boolean);
    if (!title.trim() || secs.length === 0) return false;
    try {
      // A study guide (C3) is a card with cardType "study"; sections ride the
      // text field, one per line. Each member's per-section contribution is a
      // separate slice (slot = the section's stable id), so the guide ASSEMBLES
      // from everyone's pieces instead of being one author's document.
      await request("circles.canvas.put", {
        circleId,
        cardType: "study",
        title: title.trim(),
        text: secs.join("\n"),
      });
      await get().loadCards(circleId);
      return true;
    } catch (err) {
      set({ notice: String(err) });
      return false;
    }
  },

  putSlice: async (circleId, cardId, slot, value, note) => {
    if (!slot || !value) return false;
    try {
      await request("circles.canvas.slice", { circleId, cardId, slot, value, note });
      await get().loadCards(circleId);
      return true;
    } catch (err) {
      set({ notice: String(err) });
      return false;
    }
  },

  vote: async (circleId, cardId, option, note) => {
    return get().putSlice(circleId, cardId, "vote", option, note);
  },

  unfreeze: async (circleId) => {
    try {
      await request("circles.unfreeze", { circleId });
      await get().refresh(); // status flips back to active everywhere it shows
      return true;
    } catch (err) {
      set({ notice: String(err) });
      return false;
    }
  },

  removeMember: async (circleId, memberPubkey) => {
    try {
      await request("circles.member.remove", { circleId, memberPubkey });
      await get().refresh(); // roster shrinks everywhere it shows
      return true;
    } catch (err) {
      set({ notice: String(err) });
      return false;
    }
  },

  renameCircle: async (circleId, name) => {
    try {
      // Node-local: your label for the group; the wire never carries it.
      await request("circles.rename", { circleId, name });
      await get().refresh();
      return true;
    } catch (err) {
      set({ notice: String(err) });
      return false;
    }
  },

  inviteInfo: async (code) => {
    try {
      return await request<{
        circleName: string;
        inviterName: string | null;
        inviterPubkey: string;
        knownAs?: string | null;
      }>("circles.inviteInfo", { code });
    } catch (err) {
      set({ notice: String(err) });
      return null;
    }
  },

  joinInvite: async (code) => {
    try {
      await request("circles.join", { code });
      await get().refresh();
      return true;
    } catch (err) {
      set({ notice: String(err) });
      return false;
    }
  },

  archiveCircle: async (circleId) => {
    try {
      await request("circles.archive", { circleId });
      if (get().activeCircleId === circleId) set({ activeCircleId: null });
      await get().refresh();
      return true;
    } catch (err) {
      set({ notice: String(err) });
      return false;
    }
  },

  unarchiveCircle: async (circleId) => {
    try {
      await request("circles.unarchive", { circleId });
      await get().refresh();
      return true;
    } catch (err) {
      set({ notice: String(err) });
      return false;
    }
  },

  deleteCircle: async (circleId) => {
    try {
      await request("circles.delete", { circleId });
      if (get().activeCircleId === circleId) set({ activeCircleId: null });
      await get().refresh();
      return true;
    } catch (err) {
      set({ notice: String(err) });
      return false;
    }
  },

  setPetname: async (memberPubkey, petname) => {
    try {
      // Empty label clears it; the server treats blank as clear too.
      const method = petname.trim() ? "circles.petname.set" : "circles.petname.clear";
      await request(method, { memberPubkey, petname: petname.trim() });
      await get().refresh(); // the new label shows everywhere this person appears
      return true;
    } catch (err) {
      set({ notice: String(err) });
      return false;
    }
  },

  setSelfName: async (name) => {
    if (!name.trim()) return false;
    try {
      await request("circles.self.setName", { name: name.trim() });
      await get().refresh(); // status.displayName + how you appear locally
      return true;
    } catch (err) {
      set({ notice: String(err) });
      return false;
    }
  },

  markRead: (circleId) => {
    // Optimistically clear the badge, then persist server-side (fire-and-forget).
    set((s) => ({
      circles: s.circles.map((c) => (c.circleId === circleId ? { ...c, unread: 0 } : c)),
    }));
    void request("circles.markRead", { circleId }).catch(() => {});
  },

  loadMessages: async (circleId) => {
    try {
      const res = await request<{ messages: CircleMessage[]; annotations?: MessageAnnotations }>(
        "circles.messages",
        { circleId },
      );
      // The server returns the recent window newest-first (DESC LIMIT); the
      // chat renders chronologically, so store it oldest-first — newest lands
      // at the bottom of the thread under the auto-scroll.
      const chronological = [...(res.messages ?? [])].reverse();
      set((s) => ({
        messagesByCircle: { ...s.messagesByCircle, [circleId]: chronological },
        annotationsByCircle: {
          ...s.annotationsByCircle,
          [circleId]: res.annotations ?? { reactions: {}, pins: [] },
        },
      }));
    } catch (err) {
      set({ notice: String(err) });
    }
  },

  react: async (circleId, envelopeId, emojis) => {
    try {
      await request("circles.react", { circleId, envelopeId, emojis });
      await get().loadMessages(circleId);
      return true;
    } catch (err) {
      set({ notice: String(err) });
      return false;
    }
  },

  setPinned: async (circleId, envelopeId, pinned) => {
    try {
      await request("circles.pin", { circleId, envelopeId, pinned });
      await get().loadMessages(circleId);
      return true;
    } catch (err) {
      set({ notice: String(err) });
      return false;
    }
  },

  deleteMessage: async (circleId, envelopeId, expectPropagation) => {
    try {
      const res = await request<{ scope?: string }>("circles.message.delete", {
        circleId,
        envelopeId,
      });
      // The server decides the real scope (a frozen/archived circle refuses
      // ledger writes); if the human was promised "everyone", correct it.
      if (expectPropagation && res?.scope === "local") {
        set({
          notice:
            "Deleted on this device only — the circle is not accepting writes right now, so friends' copies were not retracted.",
        });
      }
      await get().loadMessages(circleId);
      return true;
    } catch (err) {
      set({ notice: String(err) });
      return false;
    }
  },

  send: async (circleId, text, replyTo) => {
    const trimmed = text.trim();
    if (!trimmed) return false;
    try {
      await request("circles.send", { circleId, text: trimmed, replyTo });
      await get().loadMessages(circleId);
      return true;
    } catch (err) {
      set({ notice: String(err) });
      return false;
    }
  },
}));
