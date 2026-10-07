import { nextMsgId, useChatStore } from "../stores/chat-store";
import { useGatewayStore } from "../stores/gateway-store";
import { useProjectsStore } from "../stores/projects-store";

/**
 * Send one user message on the current session: show it, open the run, and
 * hand it to the gateway. Shared by the composer and voice mode.
 */
export async function sendChatText(text: string): Promise<string | null> {
  const trimmed = text.trim();
  const gateway = useGatewayStore.getState();
  if (!trimmed || gateway.status !== "connected") return null;
  const chat = useChatStore.getState();
  chat.addMessage({ id: nextMsgId(), role: "user", content: trimmed, timestamp: Date.now() });
  const idempotencyKey = `run-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  chat.startRun(idempotencyKey);
  const projectId = useProjectsStore.getState().activeProjectId;
  await gateway.request("chat.send", {
    sessionKey: chat.sessionKey,
    message: trimmed,
    idempotencyKey,
    ...(projectId ? { projectId } : {}),
  });
  return idempotencyKey;
}
