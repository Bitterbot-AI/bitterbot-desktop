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

interface CirclesState {
  status: CirclesStatus | null;
  circles: Circle[];
  activeCircleId: string | null;
  messagesByCircle: Record<string, CircleMessage[]>;
  loading: boolean;
  notice: string | null;

  refresh: () => Promise<void>;
  selectCircle: (circleId: string) => void;
  loadMessages: (circleId: string) => Promise<void>;
  send: (circleId: string, text: string, replyTo?: string) => Promise<boolean>;
  markRead: (circleId: string) => void;
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
        get().markRead(activeCircleId); // the circle on screen is, by definition, read
      }
    } catch (err) {
      set({ notice: String(err), loading: false });
    }
  },

  selectCircle: (circleId) => {
    set({ activeCircleId: circleId });
    void get().loadMessages(circleId);
    get().markRead(circleId);
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
