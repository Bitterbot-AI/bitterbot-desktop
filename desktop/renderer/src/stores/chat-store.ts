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
  usage?: { input: number; output: number; total: number };
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
  activeRun: StreamRun | null;
  sessionKey: string;
  loading: boolean;
  error: string | null;
  toolCalls: ActiveToolCall[];

  setMessages: (msgs: ChatMessage[]) => void;
  addMessage: (msg: ChatMessage) => void;
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
  activeRun: null,
  sessionKey: "default",
  loading: false,
  error: null,
  toolCalls: [],

  setMessages: (msgs) => set({ messages: msgs, error: null }),

  addMessage: (msg) => set((s) => ({ messages: [...s.messages, msg] })),

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
      const newMessages = message ? [...s.messages, message] : s.messages;
      return { activeRun: null, messages: newMessages };
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
