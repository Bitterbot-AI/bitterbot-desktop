import { useChatStore } from "../stores/chat-store";
import { useUIStore } from "../stores/ui-store";

/** Open an existing conversation in the chat view. */
export function openSession(key: string): void {
  const chat = useChatStore.getState();
  if (chat.sessionKey !== key) {
    chat.clearMessages();
    chat.setSessionKey(key);
  }
  useUIStore.getState().setActiveTab("chat");
}

/** Start a fresh conversation and show it. */
export function startNewChat(): string {
  const key = `chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const chat = useChatStore.getState();
  chat.clearMessages();
  chat.setSessionKey(key);
  useUIStore.getState().setActiveTab("chat");
  return key;
}
