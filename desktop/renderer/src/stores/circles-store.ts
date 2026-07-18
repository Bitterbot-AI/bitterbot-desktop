import { create } from "zustand";
import { useGatewayStore } from "./gateway-store";

// PLAN-36 Phase A (redesign): the per-circle keyed store the Discord-style
// CirclesView is built on. Replaces PeopleView's ad-hoc local useState. Keeps
// one message cache per circle so switching circles is instant and A2 (unread
// badges) has a home. All state rides the existing circles.* gateway RPCs — no
// new protocol.

export interface CircleMember {
  memberPubkey: string;
  displayName: string | null;
  role: string;
  isSelf: boolean;
  lastSeenAt: number | null;
  lastStatus: string | null;
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
}

export interface CirclesStatus {
  enabled: boolean;
  pubkey?: string;
  connectionCount?: number;
  reciprocity?: { reciprocatedPeers: number; activePeers: number };
  a2aPublicUrl?: string | null;
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

interface CirclesState {
  status: CirclesStatus | null;
  circles: Circle[];
  activeCircleId: string | null;
  messagesByCircle: Record<string, CircleMessage[]>;
  cardsByCircle: Record<string, CanvasCard[]>;
  draftsByCircle: Record<string, AgentDraft[]>;
  loading: boolean;
  notice: string | null;

  refresh: () => Promise<void>;
  selectCircle: (circleId: string) => void;
  loadMessages: (circleId: string) => Promise<void>;
  loadCards: (circleId: string) => Promise<void>;
  loadDrafts: (circleId: string) => Promise<void>;
  requestSliceDraft: (circleId: string, cardId: string, slot: string) => Promise<boolean>;
  publishDraft: (circleId: string, draftId: string, text: string) => Promise<boolean>;
  discardDraft: (circleId: string, draftId: string) => Promise<boolean>;
  send: (circleId: string, text: string, replyTo?: string) => Promise<boolean>;
  putCard: (circleId: string, title: string, text: string, cardId?: string) => Promise<boolean>;
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
  cardsByCircle: {},
  draftsByCircle: {},
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
        void get().loadDrafts(activeCircleId);
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
    void get().loadDrafts(circleId);
    get().markRead(circleId);
  },

  loadDrafts: async (circleId) => {
    try {
      const res = await request<{ drafts: AgentDraft[] }>("circles.drafts.list", { circleId });
      set((s) => ({ draftsByCircle: { ...s.draftsByCircle, [circleId]: res.drafts ?? [] } }));
    } catch (err) {
      set({ notice: String(err) });
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

  putCard: async (circleId, title, text, cardId) => {
    if (!title.trim() && !text.trim()) return false;
    try {
      await request("circles.canvas.put", { circleId, title: title.trim(), text, cardId });
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

  markRead: (circleId) => {
    // Optimistically clear the badge, then persist server-side (fire-and-forget).
    set((s) => ({
      circles: s.circles.map((c) => (c.circleId === circleId ? { ...c, unread: 0 } : c)),
    }));
    void request("circles.markRead", { circleId }).catch(() => {});
  },

  loadMessages: async (circleId) => {
    try {
      const res = await request<{ messages: CircleMessage[] }>("circles.messages", { circleId });
      set((s) => ({ messagesByCircle: { ...s.messagesByCircle, [circleId]: res.messages ?? [] } }));
    } catch (err) {
      set({ notice: String(err) });
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
