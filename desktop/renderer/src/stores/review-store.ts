import { create } from "zustand";
import type { GatewayEventFrame } from "../lib/gateway-client";
import { useGatewayStore } from "./gateway-store";

/**
 * Actions the agent wanted to take and had to wait for (PLAN-53 Track B):
 * money leaving the wallet, public posts. The gateway holds them; this store
 * mirrors the list, applies the owner's decisions, and keeps the history the
 * Activity view shows.
 */

export type ReviewStatus = "pending" | "approved" | "denied" | "expired" | "executed" | "failed";

export interface ReviewAction {
  id: string;
  status: ReviewStatus;
  cls: "spend" | "publish";
  tool: string;
  preview: string;
  params: unknown;
  sessionKey: string | null;
  agentId: string | null;
  createdAt: number;
  expiresAt: number;
  decidedAt: number | null;
  decidedBy: string | null;
  decidedVia: string | null;
  note: string | null;
  resultSummary: string | null;
  executedAt: number | null;
}

interface ReviewStore {
  pending: ReviewAction[];
  history: ReviewAction[];
  loaded: boolean;
  unsupported: boolean;
  busy: Set<string>;
  load: () => Promise<void>;
  resolve: (id: string, decision: "approve" | "deny") => Promise<ReviewAction | null>;
  /** Mirror gateway events. Returns the unsubscribe. */
  listen: () => () => void;
}

const isAction = (value: unknown): value is ReviewAction =>
  typeof value === "object" && value !== null && typeof (value as ReviewAction).id === "string";

function upsert(list: ReviewAction[], action: ReviewAction): ReviewAction[] {
  const rest = list.filter((a) => a.id !== action.id);
  return [action, ...rest].toSorted((a, b) => b.createdAt - a.createdAt);
}

export const useReviewStore = create<ReviewStore>((set, get) => ({
  pending: [],
  history: [],
  loaded: false,
  unsupported: false,
  busy: new Set(),

  load: async () => {
    const gateway = useGatewayStore.getState();
    if (gateway.status !== "connected") {
      return;
    }
    try {
      const [pendingRes, allRes] = await Promise.all([
        gateway.request<{ actions: unknown[] }>("review.list", { status: "pending" }),
        gateway.request<{ actions: unknown[] }>("review.list", { status: "all", limit: 100 }),
      ]);
      set({
        pending: pendingRes.actions.filter(isAction),
        history: allRes.actions.filter(isAction),
        loaded: true,
        unsupported: false,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("unknown method")) {
        set({ unsupported: true, loaded: true });
      }
    }
  },

  resolve: async (id, decision) => {
    const gateway = useGatewayStore.getState();
    set((s) => ({ busy: new Set([...s.busy, id]) }));
    try {
      const action = await gateway.request<unknown>("review.resolve", { id, decision });
      if (isAction(action)) {
        set((s) => ({
          pending: s.pending.filter((a) => a.id !== id),
          history: upsert(s.history, action),
        }));
        return action;
      }
      return null;
    } catch {
      // The gateway store has already raised the error toast.
      return null;
    } finally {
      set((s) => {
        const busy = new Set(s.busy);
        busy.delete(id);
        return { busy };
      });
    }
  },

  listen: () => {
    const onEvent = (evt: GatewayEventFrame) => {
      if (evt.event !== "review.requested" && evt.event !== "review.resolved") {
        return;
      }
      const action = evt.payload;
      if (!isAction(action)) {
        return;
      }
      set((s) => ({
        pending:
          action.status === "pending"
            ? upsert(s.pending, action)
            : s.pending.filter((a) => a.id !== action.id),
        history: upsert(s.history, action),
      }));
    };
    const unsubscribeEvents = useGatewayStore.getState().subscribe(onEvent);
    // A reconnect may have missed events; reload.
    const unsubscribeConnection = useGatewayStore.subscribe((next, prev) => {
      if (next.status === "connected" && prev.status !== "connected") {
        void get().load();
      }
    });
    void get().load();
    return () => {
      unsubscribeEvents();
      unsubscribeConnection();
    };
  },
}));
