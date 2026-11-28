import { useEffect, useRef } from "react";
import { useGatewayStore } from "../../stores/gateway-store";

/**
 * Says so, in the conversation column, when the gateway connection drops
 * after it was up. The draft stays editable; Send waits for the connection.
 */
export function ConnectionBanner() {
  const status = useGatewayStore((s) => s.status);
  const wasConnected = useRef(false);
  useEffect(() => {
    if (status === "connected") wasConnected.current = true;
  }, [status]);

  if (status === "connected" || !wasConnected.current) return null;
  return (
    <div className="shrink-0 px-3 pb-2 md:px-5">
      <div
        role="status"
        className="mx-auto flex w-full max-w-[800px] items-center gap-2 rounded-md bg-warning-soft px-3 py-2 text-sm text-ink"
      >
        <span className="size-2 shrink-0 rounded-full bg-warning" />
        {status === "connecting"
          ? "Connection lost. Reconnecting…"
          : "Disconnected from the gateway."}
      </div>
    </div>
  );
}
