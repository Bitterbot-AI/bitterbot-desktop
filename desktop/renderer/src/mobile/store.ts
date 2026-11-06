import { create } from "zustand";
import { clearDeviceIdentity, loadOrCreateDeviceIdentity } from "../lib/device-identity";
import { GatewayClient, type GatewayEventFrame, type GatewayHelloOk } from "../lib/gateway-client";
import {
  extractMessageText,
  normalizeMessages,
  parseAgentEvent,
  parseChatEvent,
} from "../lib/message-utils";
import type { ChatMessage } from "../stores/chat-store";
import { claimSetupCode, guessDeviceName, readClaimStatus } from "./pairing-client";
import { clearPersistedPairing, readPersisted, writePersisted } from "./persist";

/** Must match src/gateway/mobile/scopes.ts MOBILE_DEVICE_SCOPES (sorted). */
export const MOBILE_SCOPES = ["operator.approvals", "operator.chat", "operator.notifications"];
export const MOBILE_CLIENT_ID = "bitterbot-mobile";
export const IDENTITY_NAME = "mobile";
const DEFAULT_SESSION = "default";

export type Phase = "boot" | "welcome" | "pairing" | "ready";
export type ConnState = "connecting" | "online" | "offline";

export type PairingState = {
  step: "claiming" | "waiting" | "approved" | "failed";
  confirmCode?: string;
  error?: string;
};

export type ReviewAction = {
  id: string;
  status: string;
  cls: string;
  tool: string;
  preview: string;
  params?: unknown;
  sessionKey: string | null;
  createdAt: number;
  expiresAt: number;
};

export type SessionRow = {
  key: string;
  label?: string;
  displayName?: string;
  derivedTitle?: string;
  lastMessagePreview?: string;
  updatedAt: number | null;
  channel?: string;
};

export type OwnerNotice = { kind: string; text: string; ts: number };

export type StatusData = {
  agentName?: string;
  mood?: string;
  hormones?: { dopamine: number; cortisol: number; oxytocin: number } | null;
  briefing?: string;
  lastDreamAt?: number | null;
  nextDreamAt?: number | null;
  dreamEntry?: string;
  loadedAt?: number;
};

export type DeviceSelf = {
  deviceId: string;
  name: string;
  label?: string;
  displayName?: string;
  createdAtMs: number;
  lastUsedAtMs?: number;
};

export type PushCategories = {
  approvals: boolean;
  replies: boolean;
  notices: boolean;
  previews: boolean;
};

type Run = { runId: string; text: string; seq: number; startedAt: number; activity?: string };

type MobileState = {
  phase: Phase;
  conn: ConnState;
  connError: string | null;
  /** Set when the gateway said this phone is no longer paired. */
  unpairedReason: string | null;
  pairing: PairingState | null;
  insecure: boolean;
  hello: GatewayHelloOk | null;

  sessionKey: string;
  sessions: SessionRow[];
  unread: Record<string, boolean>;
  messages: ChatMessage[];
  historyLoading: boolean;
  run: Run | null;
  /** Run ids this phone started, so their events are recognised in any session spelling. */
  myRuns: Set<string>;

  approvals: ReviewAction[];
  busyApprovals: Set<string>;
  notices: OwnerNotice[];
  status: StatusData;
  self: DeviceSelf | null;
  push: { subscribed: boolean; categories: PushCategories };

  boot: () => Promise<void>;
  startPairing: (code: string) => Promise<void>;
  connect: () => Promise<void>;
  request: <T = unknown>(method: string, params?: unknown, timeoutMs?: number) => Promise<T>;
  setSession: (key: string) => void;
  loadHistory: () => Promise<void>;
  loadSessions: () => Promise<void>;
  send: (
    text: string,
    images?: Array<{ mimeType: string; data: string; name: string }>,
  ) => Promise<void>;
  abort: () => Promise<void>;
  loadApprovals: () => Promise<void>;
  resolveApproval: (id: string, decision: "approve" | "deny") => Promise<string | null>;
  loadStatus: () => Promise<void>;
  loadSelf: () => Promise<void>;
  rename: (name: string) => Promise<void>;
  unpair: () => Promise<void>;
  setVisible: (visible: boolean) => void;
  forgetPairing: (reason: string) => Promise<void>;
};

let client: GatewayClient | null = null;
let idCounter = 0;
const nextId = () => `m-${Date.now().toString(36)}-${++idCounter}`;

const UNPAIRED_REASONS = [
  "device removed",
  "device token revoked",
  "device token mismatch",
  "pairing required",
];

function wsUrl(): string {
  const loc = window.location;
  return `${loc.protocol === "https:" ? "wss:" : "ws:"}//${loc.host}`;
}

function sameSession(a: string | undefined, b: string): boolean {
  if (!a) return false;
  if (a === b) return true;
  // The gateway may answer with the canonical spelling (agent:main:default).
  return a.endsWith(`:${b}`) || b.endsWith(`:${a}`);
}

export const useMobile = create<MobileState>((set, get) => ({
  phase: "boot",
  conn: "offline",
  connError: null,
  unpairedReason: null,
  pairing: null,
  insecure: typeof isSecureContext !== "undefined" ? !isSecureContext : false,
  hello: null,

  sessionKey: readPersisted().sessionKey ?? DEFAULT_SESSION,
  sessions: [],
  unread: {},
  messages: [],
  historyLoading: false,
  run: null,
  myRuns: new Set(),

  approvals: [],
  busyApprovals: new Set(),
  notices: [],
  status: {},
  self: null,
  push: {
    subscribed: false,
    categories: { approvals: true, replies: true, notices: true, previews: true },
  },

  boot: async () => {
    const persisted = readPersisted();
    if (persisted.deviceToken) {
      set({ phase: "ready" });
      await get().connect();
    } else {
      set({ phase: "welcome" });
    }
  },

  startPairing: async (code: string) => {
    client?.stop();
    client = null;
    set({ phase: "pairing", pairing: { step: "claiming" }, unpairedReason: null });
    try {
      const identity = await loadOrCreateDeviceIdentity(IDENTITY_NAME, {
        allowInsecureFallback: true,
      });
      if (!identity) {
        throw new Error("This browser cannot store a device key (is private browsing on?).");
      }
      const claim = await claimSetupCode(code, identity, guessDeviceName());
      set({ pairing: { step: "waiting", confirmCode: claim.localConfirmCode } });
      const deadline = Date.now() + 6 * 60_000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 1500));
        if (get().phase !== "pairing") return;
        let status;
        try {
          status = await readClaimStatus(claim.claimId, identity.deviceId);
        } catch {
          continue; // a blip; keep waiting
        }
        if (status.status === "approved") {
          writePersisted({ deviceToken: status.deviceToken, deviceId: status.deviceId });
          set({ pairing: { step: "approved", confirmCode: claim.localConfirmCode } });
          await new Promise((r) => setTimeout(r, 900));
          set({ phase: "ready", pairing: null });
          await get().connect();
          return;
        }
        if (status.status === "rejected") {
          throw new Error("The pairing was declined on the computer.");
        }
        if (status.status === "expired") {
          throw new Error("The pairing code expired. Make a new one on the computer.");
        }
      }
      throw new Error("Nobody approved the pairing in time. Make a new code and try again.");
    } catch (err) {
      set({
        pairing: {
          step: "failed",
          confirmCode: get().pairing?.confirmCode,
          error: err instanceof Error ? err.message : String(err),
        },
      });
    }
  },

  connect: async () => {
    client?.stop();
    set({ conn: "connecting", connError: null });
    const c = new GatewayClient({
      url: wsUrl(),
      clientName: MOBILE_CLIENT_ID,
      clientMode: "ui",
      displayName: guessDeviceName(),
      scopes: MOBILE_SCOPES,
      deviceIdentity: () =>
        loadOrCreateDeviceIdentity(IDENTITY_NAME, { allowInsecureFallback: true }),
      deviceToken: () => readPersisted().deviceToken ?? null,
      defaultRequestTimeoutMs: 30_000,
      onHello: (hello) => {
        if (hello.auth?.deviceToken && hello.auth.deviceToken !== readPersisted().deviceToken) {
          writePersisted({ deviceToken: hello.auth.deviceToken });
        }
        set({ conn: "online", connError: null, hello });
        get().setVisible(document.visibilityState === "visible");
        void get().loadHistory();
        void get().loadSessions();
        void get().loadApprovals();
        void get().loadSelf();
        void get().loadStatus();
      },
      onEvent: (evt) => handleEvent(evt, get, set),
      onClose: ({ code, reason }) => {
        const lower = reason.toLowerCase();
        if (code === 4001 || UNPAIRED_REASONS.some((r) => lower.includes(r))) {
          void get().forgetPairing(
            code === 4001 || lower.includes("removed") || lower.includes("revoked")
              ? "This phone was unpaired from the computer."
              : "This phone is no longer paired with the gateway.",
          );
          return;
        }
        set({ conn: navigator.onLine ? "connecting" : "offline", connError: reason || null });
      },
    });
    client = c;
    c.start();
  },

  request: async <T>(method: string, params?: unknown, timeoutMs?: number) => {
    if (!client) throw new Error("not connected");
    return await client.request<T>(method, params, timeoutMs ? { timeoutMs } : undefined);
  },

  setSession: (key: string) => {
    if (key === get().sessionKey) return;
    writePersisted({ sessionKey: key });
    set((s) => ({
      sessionKey: key,
      messages: [],
      run: null,
      unread: { ...s.unread, [key]: false },
    }));
    void get().loadHistory();
  },

  loadHistory: async () => {
    if (get().conn !== "online") return;
    const sessionKey = get().sessionKey;
    set({ historyLoading: true });
    try {
      const res = await get().request<{ messages?: unknown[] }>("chat.history", {
        sessionKey,
        limit: 120,
      });
      if (get().sessionKey !== sessionKey) return;
      set({ messages: normalizeMessages(res.messages ?? []) });
    } catch {
      // keep what we had; the banner shows the connection state
    } finally {
      set({ historyLoading: false });
    }
  },

  loadSessions: async () => {
    try {
      const res = await get().request<{ sessions?: SessionRow[] }>("sessions.list", {
        limit: 30,
        includeDerivedTitles: true,
        includeLastMessage: true,
      });
      set({ sessions: res.sessions ?? [] });
    } catch {
      // the switcher just shows the current session
    }
  },

  send: async (text, images) => {
    const trimmed = text.trim();
    if ((!trimmed && !images?.length) || get().conn !== "online") return;
    const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const myRuns = new Set(get().myRuns);
    myRuns.add(runId);
    set((s) => ({
      messages: [
        ...s.messages,
        {
          id: nextId(),
          role: "user",
          content: trimmed,
          timestamp: Date.now(),
          images: images?.map((img) => ({
            type: "base64" as const,
            mimeType: img.mimeType,
            data: img.data,
          })),
        },
      ],
      run: { runId, text: "", seq: 0, startedAt: Date.now() },
      myRuns,
    }));
    try {
      await get().request("chat.send", {
        sessionKey: get().sessionKey,
        message: trimmed,
        idempotencyKey: runId,
        ...(images?.length
          ? {
              attachments: images.map((img) => ({
                type: "image",
                mimeType: img.mimeType,
                fileName: img.name,
                content: img.data,
              })),
            }
          : {}),
      });
    } catch (err) {
      set((s) => ({
        run: null,
        messages: [
          ...s.messages,
          {
            id: nextId(),
            role: "system",
            content: `Could not send: ${err instanceof Error ? err.message : String(err)}`,
            timestamp: Date.now(),
          },
        ],
      }));
    }
  },

  abort: async () => {
    const run = get().run;
    if (!run) return;
    try {
      await get().request("chat.abort", { sessionKey: get().sessionKey, runId: run.runId });
    } catch {
      // the final event still arrives
    }
  },

  loadApprovals: async () => {
    try {
      const res = await get().request<{ actions?: ReviewAction[] }>("review.list", {
        status: "pending",
      });
      set({ approvals: (res.actions ?? []).filter((a) => a.status === "pending") });
    } catch {
      // older gateway or no approvals scope: the tab stays empty
    }
  },

  resolveApproval: async (id, decision) => {
    const busy = new Set(get().busyApprovals);
    busy.add(id);
    set({ busyApprovals: busy });
    try {
      await get().request("review.resolve", { id, decision, via: "phone" });
      set((s) => ({ approvals: s.approvals.filter((a) => a.id !== id) }));
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    } finally {
      const after = new Set(get().busyApprovals);
      after.delete(id);
      set({ busyApprovals: after });
    }
  },

  loadStatus: async () => {
    const next: StatusData = { ...get().status, loadedAt: Date.now() };
    const [identity, dream, emotional, journal] = await Promise.allSettled([
      get().request<{ name?: string }>("agent.identity.get", {}),
      get().request<{
        lastCycle?: { completedAt?: number };
        nextDreamEta?: number | null;
        hormones?: StatusData["hormones"];
        enabled?: boolean;
      }>("dream.status", {}),
      get().request<{
        mood?: string;
        emotionalBriefing?: string;
        dopamine?: number;
        cortisol?: number;
        oxytocin?: number;
        hormones?: null;
      }>("dream.emotional", {}),
      get().request<{ entries?: Array<{ content: string }> }>("dream.journal", { limit: 1 }),
    ]);
    if (identity.status === "fulfilled") next.agentName = identity.value.name;
    if (dream.status === "fulfilled") {
      next.lastDreamAt = dream.value.lastCycle?.completedAt ?? null;
      next.nextDreamAt = dream.value.nextDreamEta ?? null;
      next.hormones = dream.value.hormones ?? null;
    }
    if (emotional.status === "fulfilled") {
      next.mood = emotional.value.mood;
      next.briefing = emotional.value.emotionalBriefing;
      if (typeof emotional.value.dopamine === "number") {
        next.hormones = {
          dopamine: emotional.value.dopamine,
          cortisol: emotional.value.cortisol ?? 0,
          oxytocin: emotional.value.oxytocin ?? 0,
        };
      }
    }
    if (journal.status === "fulfilled") next.dreamEntry = journal.value.entries?.[0]?.content;
    set({ status: next });
  },

  loadSelf: async () => {
    try {
      const res = await get().request<{
        device: DeviceSelf;
        push: { subscribed: boolean; categories: PushCategories };
      }>("mobile.self.get", {});
      set({ self: res.device, push: res.push });
    } catch {
      // shown as unknown in Settings
    }
  },

  rename: async (name) => {
    const res = await get().request<DeviceSelf>("mobile.self.rename", { name });
    set({ self: res });
  },

  unpair: async () => {
    try {
      await get().request("mobile.self.unpair", {});
    } catch {
      // unpair locally regardless: the owner asked for it
    }
    await get().forgetPairing("This phone is unpaired. Pair again from your computer any time.");
  },

  setVisible: (visible) => {
    if (get().conn !== "online") return;
    void get()
      .request("mobile.presence", { visible })
      .catch(() => {});
  },

  forgetPairing: async (reason) => {
    client?.halt();
    client?.stop();
    client = null;
    clearPersistedPairing();
    try {
      const reg = await navigator.serviceWorker?.getRegistration();
      const sub = await reg?.pushManager?.getSubscription();
      await sub?.unsubscribe();
    } catch {
      // nothing subscribed
    }
    await clearDeviceIdentity(IDENTITY_NAME);
    set({
      phase: "welcome",
      conn: "offline",
      unpairedReason: reason,
      messages: [],
      approvals: [],
      sessions: [],
      self: null,
      hello: null,
      run: null,
    });
  },
}));

/** Reconnect immediately when the app returns to the foreground. */
export function nudgeReconnect() {
  client?.reconnectNow();
}

type Get = () => MobileState;
type SetFn = (partial: Partial<MobileState> | ((s: MobileState) => Partial<MobileState>)) => void;

function handleEvent(evt: GatewayEventFrame, get: Get, set: SetFn) {
  switch (evt.event) {
    case "chat": {
      const chat = parseChatEvent(evt.payload);
      if (!chat) return;
      const state = get();
      const mine = state.myRuns.has(chat.runId);
      const current = mine || sameSession(chat.sessionKey, state.sessionKey);
      if (!current) {
        if (chat.state === "final" && chat.sessionKey) {
          const row = state.sessions.find((s) => sameSession(chat.sessionKey, s.key));
          if (row) set((s) => ({ unread: { ...s.unread, [row.key]: true } }));
        }
        return;
      }
      if (chat.state === "delta") {
        const text = extractMessageText(chat.message);
        set((s) => {
          const run = s.run && s.run.runId === chat.runId ? s.run : null;
          if (run && chat.seq !== 0 && chat.seq <= run.seq) return {};
          return {
            run: {
              runId: chat.runId,
              text,
              seq: chat.seq,
              startedAt: run?.startedAt ?? Date.now(),
              activity: run?.activity,
            },
          };
        });
        return;
      }
      if (chat.state === "final" || chat.state === "error" || chat.state === "aborted") {
        const text =
          chat.state === "error"
            ? chat.errorMessage || "Something went wrong."
            : extractMessageText(chat.message) ||
              (chat.state === "aborted" ? (get().run?.text ?? "") : "");
        set((s) => {
          const messages = [...s.messages];
          if (text) {
            messages.push({
              id: nextId(),
              role: chat.state === "error" ? "system" : "assistant",
              content: chat.state === "aborted" ? `${text}\n\n_(stopped)_` : text,
              timestamp: Date.now(),
            });
          }
          return { messages, run: s.run?.runId === chat.runId || !text ? null : s.run };
        });
        if (!mine && !text) {
          // A run started elsewhere finished without a body here; reload to be exact.
          void get().loadHistory();
        }
      }
      return;
    }
    case "agent": {
      const agent = parseAgentEvent(evt.payload);
      if (!agent || agent.stream !== "tool") return;
      const run = get().run;
      if (!run || run.runId !== agent.runId) return;
      const phase = typeof agent.data.phase === "string" ? agent.data.phase : "";
      const name = typeof agent.data.name === "string" ? agent.data.name : "";
      if (phase === "start" && name) {
        set({ run: { ...run, activity: name } });
      } else if (phase === "result") {
        set({ run: { ...run, activity: undefined } });
      }
      return;
    }
    case "review.requested": {
      const action = evt.payload as ReviewAction;
      if (action && typeof action.id === "string" && action.status === "pending") {
        set((s) => ({ approvals: [action, ...s.approvals.filter((a) => a.id !== action.id)] }));
      }
      return;
    }
    case "review.resolved": {
      const action = evt.payload as { id?: string };
      if (action?.id) {
        set((s) => ({ approvals: s.approvals.filter((a) => a.id !== action.id) }));
      }
      return;
    }
    case "owner.notice": {
      const notice = evt.payload as OwnerNotice;
      if (notice && typeof notice.text === "string") {
        set((s) => ({ notices: [notice, ...s.notices].slice(0, 20) }));
      }
      return;
    }
    default:
      return;
  }
}
