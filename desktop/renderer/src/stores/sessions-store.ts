import { create } from "zustand";
import { useGatewayStore } from "./gateway-store";

export type SessionEntry = {
  key: string;
  sessionId?: string;
  /** A title the person gave the conversation. Wins over the derived one. */
  label?: string;
  /** A title the gateway derived from the first message. */
  derivedTitle?: string;
  updatedAt?: number | null;
  thinkingLevel?: string;
  verboseLevel?: string;
  reasoningLevel?: string;
  model?: string;
  modelProvider?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  channel?: string;
  origin?: Record<string, unknown>;
  [key: string]: unknown;
};

/** What to call a conversation: the person's own title, else the derived one. */
export function sessionTitle(
  session: Pick<SessionEntry, "key" | "label" | "derivedTitle">,
): string {
  return session.label?.trim() || session.derivedTitle?.trim() || session.key;
}

export type RecencyGroup = {
  id: "today" | "week" | "older";
  label: string;
  sessions: SessionEntry[];
};

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Split conversations into disjoint Today / Previous 7 days / Older groups,
 * newest first inside each. Empty groups are dropped. "Today" is the local
 * calendar day, not the last 24 hours.
 */
export function groupByRecency(
  sessions: readonly SessionEntry[],
  now = Date.now(),
): RecencyGroup[] {
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const todayStart = startOfToday.getTime();
  const weekStart = todayStart - 7 * DAY_MS;

  const groups: RecencyGroup[] = [
    { id: "today", label: "Today", sessions: [] },
    { id: "week", label: "Previous 7 days", sessions: [] },
    { id: "older", label: "Older", sessions: [] },
  ];
  const sorted = [...sessions].toSorted((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  for (const session of sorted) {
    const at = session.updatedAt ?? 0;
    const index = at >= todayStart ? 0 : at >= weekStart ? 1 : 2;
    groups[index].sessions.push(session);
  }
  return groups.filter((g) => g.sessions.length > 0);
}

type SessionsState = {
  sessions: SessionEntry[];
  loading: boolean;
  error: string | null;
  filter: string;
  setSessions: (sessions: SessionEntry[]) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  setFilter: (filter: string) => void;
  removeSession: (key: string) => void;
  updateSession: (key: string, patch: Partial<SessionEntry>) => void;
  /** Fetch the conversation list. Best effort: a failure keeps the old list. */
  refresh: () => Promise<void>;
  /** Give a conversation a title. An empty title restores the derived one. */
  rename: (key: string, title: string) => Promise<void>;
  /** Delete a conversation on the gateway and drop it from the list. */
  remove: (key: string) => Promise<void>;
};

/** How many conversations the list asks for. */
export const SESSIONS_LIST_LIMIT = 100;

export const useSessionsStore = create<SessionsState>((set, get) => ({
  sessions: [],
  loading: false,
  error: null,
  filter: "",
  setSessions: (sessions) => set({ sessions }),
  setLoading: (loading) => set({ loading }),
  setError: (error) => set({ error }),
  setFilter: (filter) => set({ filter }),
  removeSession: (key) =>
    set((s) => ({ sessions: s.sessions.filter((session) => session.key !== key) })),
  updateSession: (key, patch) =>
    set((s) => ({
      sessions: s.sessions.map((session) =>
        session.key === key ? { ...session, ...patch } : session,
      ),
    })),
  refresh: async () => {
    const gateway = useGatewayStore.getState();
    if (gateway.status !== "connected") return;
    try {
      const res = await gateway.request<{ sessions?: SessionEntry[] }>("sessions.list", {
        includeDerivedTitles: true,
        limit: SESSIONS_LIST_LIMIT,
      });
      if (res?.sessions) set({ sessions: res.sessions, error: null });
    } catch {
      // The list is best effort; the last good one stays on screen.
    }
  },
  rename: async (key, title) => {
    const label = title.trim();
    await useGatewayStore
      .getState()
      .request("sessions.patch", { key, label: label.length > 0 ? label : null });
    get().updateSession(key, { label: label.length > 0 ? label : undefined });
  },
  remove: async (key) => {
    await useGatewayStore.getState().request("sessions.delete", { key });
    get().removeSession(key);
  },
}));
