import { create } from "zustand";

/**
 * A normalized chat message for rendering.
 * Supports both simple text and structured content blocks.
 */
export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  timestamp: number;
  thinking?: string;
  toolCalls?: ToolCallItem[];
  images?: ImageItem[];
  usage?: {
    input: number;
    output: number;
    total: number;
    cost?: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
  stopReason?: string;
  toolCallId?: string; // For tool-role messages: which tool_use this is a response to
}

export interface ToolCallItem {
  id?: string;
  name: string;
  args?: unknown;
  result?: string;
  isSuccess?: boolean;
}

export interface ImageItem {
  type: "base64" | "url";
  mimeType?: string;
  data: string;
}

/** Active streaming run state */
interface StreamRun {
  runId: string;
  text: string;
  seq: number;
  startedAt: number;
}

/** Active tool call for the side panel */
export interface ActiveToolCall {
  id: string;
  name: string;
  args: unknown;
  result?: string;
  partialResult?: string;
  status: "running" | "completed" | "error";
  timestamp: number;
}

interface ChatState {
  messages: ChatMessage[];
  /** PLAN-50 Phase 6: ledger costs buffered per run until the reply is finalized. */
  pendingRunCosts: Record<
    string,
    { cost: number; input: number; output: number; cacheRead: number; cacheWrite: number }
  >;
  /** Run id -> message id for replies already finalized (bounded), so late rows still attach. */
  runMessages: Record<string, string>;
  activeRun: StreamRun | null;
  sessionKey: string;
  loading: boolean;
  error: string | null;
  toolCalls: ActiveToolCall[];

  setMessages: (msgs: ChatMessage[]) => void;
  addMessage: (msg: ChatMessage) => void;
  /** PLAN-50 Phase 6: attach the ledger's cost for the latest assistant reply of this session. */
  applyUsageEvent: (evt: {
    kind?: string;
    feature?: string;
    runId?: string | null;
    sessionKey?: string | null;
    ts?: number;
    cost?: { total?: number };
    usage?: { input?: number; cacheRead?: number; cacheWrite?: number; output?: number };
  }) => void;
  setSessionKey: (key: string) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;

  // Streaming
  startRun: (runId: string) => void;
  appendDelta: (runId: string, text: string, seq: number) => void;
  finalizeRun: (runId: string, message?: ChatMessage) => void;
  abortRun: (runId: string) => void;
  clearMessages: () => void;

  // Tool calls
  addToolCall: (tc: ActiveToolCall) => void;
  updateToolCallPartial: (id: string, partialResult: string) => void;
  updateToolCallResult: (id: string, result: string, status?: "completed" | "error") => void;
  clearToolCalls: () => void;
}

let msgCounter = 0;
export function nextMsgId(): string {
  return `msg-${++msgCounter}-${Date.now()}`;
}

export const useChatStore = create<ChatState>((set, get) => ({
  messages: [],
  pendingRunCosts: {},
  runMessages: {},
  activeRun: null,
  sessionKey: "default",
  loading: false,
  error: null,
  toolCalls: [],

  setMessages: (msgs) => set({ messages: msgs, error: null }),

  addMessage: (msg) => set((s) => ({ messages: [...s.messages, msg] })),

  applyUsageEvent: (evt) =>
    set((s) => {
      if (evt.kind !== "chat" || !evt.sessionKey || evt.sessionKey !== s.sessionKey) return s;
      if (evt.feature && evt.feature !== "agent/turn") return s;
      const cost = evt.cost?.total;
      if (typeof cost !== "number" || !evt.runId) return s;
      const cacheRead = evt.usage?.cacheRead ?? 0;
      const cacheWrite = evt.usage?.cacheWrite ?? 0;
      const input = (evt.usage?.input ?? 0) + cacheRead + cacheWrite;
      const output = evt.usage?.output ?? 0;
      // The ledger row streams at message_end, before the reply is appended in finalizeRun.
      // Buffer per run; finalizeRun attaches the sum. Late rows for an already-finalized run
      // land on the message recorded for that run.
      const finalizedId = s.runMessages[evt.runId];
      if (finalizedId) {
        const next = s.messages.map((m) =>
          m.id === finalizedId
            ? {
                ...m,
                usage: {
                  input: (m.usage?.input ?? 0) + input,
                  output: (m.usage?.output ?? 0) + output,
                  total: (m.usage?.total ?? 0) + input + output,
                  cost: (m.usage?.cost ?? 0) + cost,
                  cacheRead: (m.usage?.cacheRead ?? 0) + cacheRead,
                  cacheWrite: (m.usage?.cacheWrite ?? 0) + cacheWrite,
                },
              }
            : m,
        );
        return { messages: next };
      }
      const prev = s.pendingRunCosts[evt.runId] ?? {
        cost: 0,
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
      };
      return {
        pendingRunCosts: {
          ...s.pendingRunCosts,
          [evt.runId]: {
            cost: prev.cost + cost,
            input: prev.input + input,
            output: prev.output + output,
            cacheRead: prev.cacheRead + cacheRead,
            cacheWrite: prev.cacheWrite + cacheWrite,
          },
        },
      };
    }),

  setSessionKey: (key) => set({ sessionKey: key }),

  setLoading: (loading) => set({ loading }),

  setError: (error) => set({ error }),

  startRun: (runId) =>
    set({
      activeRun: { runId, text: "", seq: 0, startedAt: Date.now() },
      toolCalls: [], // Clear stale tool calls from previous run
    }),

  appendDelta: (runId, text, seq) =>
    set((s) => {
      if (!s.activeRun || s.activeRun.runId !== runId) return s;
      // Only apply if seq is newer (protocol guarantees ordering)
      if (seq <= s.activeRun.seq && seq !== 0) return s;
      return {
        activeRun: { ...s.activeRun, text, seq },
      };
    }),

  finalizeRun: (runId, message) =>
    set((s) => {
      if (s.activeRun?.runId !== runId) return s;
      const pending = s.pendingRunCosts[runId];
      const finalMessage =
        message && pending
          ? {
              ...message,
              usage: {
                input: message.usage?.input ?? pending.input,
                output: message.usage?.output ?? pending.output,
                total: message.usage?.total ?? pending.input + pending.output,
                cost: pending.cost,
                cacheRead: pending.cacheRead,
                cacheWrite: pending.cacheWrite,
              },
            }
          : message;
      const newMessages = finalMessage ? [...s.messages, finalMessage] : s.messages;
      const { [runId]: _consumed, ...restPending } = s.pendingRunCosts;
      const runEntries = Object.entries(s.runMessages).slice(-49);
      const runMessages = finalMessage
        ? Object.fromEntries([...runEntries, [runId, finalMessage.id]])
        : s.runMessages;
      return { activeRun: null, messages: newMessages, pendingRunCosts: restPending, runMessages };
    }),

  abortRun: (runId) =>
    set((s) => {
      if (s.activeRun?.runId !== runId) return s;
      // Keep partial text as a message
      const partial = s.activeRun.text;
      if (partial) {
        const msg: ChatMessage = {
          id: nextMsgId(),
          role: "assistant",
          content: partial + "\n\n_(aborted)_",
          timestamp: Date.now(),
        };
        return { activeRun: null, messages: [...s.messages, msg] };
      }
      return { activeRun: null };
    }),

  clearMessages: () => set({ messages: [], activeRun: null, error: null, toolCalls: [] }),

  addToolCall: (tc) => set((s) => ({ toolCalls: [...s.toolCalls, tc] })),

  updateToolCallPartial: (id, partialResult) =>
    set((s) => ({
      toolCalls: s.toolCalls.map((tc) => (tc.id === id ? { ...tc, partialResult } : tc)),
    })),

  updateToolCallResult: (id, result, status = "completed") =>
    set((s) => ({
      toolCalls: s.toolCalls.map((tc) => (tc.id === id ? { ...tc, result, status } : tc)),
    })),

  clearToolCalls: () => set({ toolCalls: [] }),
}));
