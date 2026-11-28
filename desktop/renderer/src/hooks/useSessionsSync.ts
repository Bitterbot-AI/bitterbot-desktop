import { useEffect } from "react";
import { useChatStore } from "../stores/chat-store";
import { useGatewayStore } from "../stores/gateway-store";
import { useSessionsStore } from "../stores/sessions-store";

const POLL_MS = 30_000;
/** A new conversation only exists on the gateway after its first send. */
const AFTER_SWITCH_MS = 1_000;

/**
 * Keeps the conversation list in the sessions store fresh for the whole app.
 * Mounted once by the shell; the sidebar, palette and usage strip all read
 * the same list.
 */
export function useSessionsSync(): void {
  const status = useGatewayStore((s) => s.status);
  const sessionKey = useChatStore((s) => s.sessionKey);

  useEffect(() => {
    if (status !== "connected") return;
    void useSessionsStore.getState().refresh();
    const timer = setInterval(() => void useSessionsStore.getState().refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [status]);

  useEffect(() => {
    if (status !== "connected") return;
    const timer = setTimeout(() => void useSessionsStore.getState().refresh(), AFTER_SWITCH_MS);
    return () => clearTimeout(timer);
  }, [status, sessionKey]);
}
