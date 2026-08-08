import { useCallback, useEffect } from "react";
import { useGatewayEvent } from "../../hooks/useGatewayEvent";
import { useCirclesStore } from "../../stores/circles-store";
import { useGatewayStore } from "../../stores/gateway-store";

// Phase C: circles attention is APP-WIDE. The Circles tab unmounts when you
// leave it, so this headless component (mounted in AppShell for the app's
// lifetime) keeps the store's circle list — unread counts, pending-approval
// counts — fresh for the sidebar badge and whatever else needs it. It only
// refreshes the cheap list; per-circle loads stay with the view. It never
// marks anything read: nothing here is on screen.
export function CirclesGlobalSync() {
  // refreshList, NOT refresh: the cheap status+list pair only. The full
  // refresh fires 5 per-circle pane RPCs for a circle nobody is viewing and
  // writes user-facing error notices — both wrong for a headless loop
  // (d638276 review #7). The view owns pane loads and error surfacing.
  const refreshList = useCirclesStore((s) => s.refreshList);
  const status = useGatewayStore((s) => s.status);

  useEffect(() => {
    if (status !== "connected") return;
    void refreshList();
    const timer = setInterval(() => void refreshList(), 45_000);
    return () => clearInterval(timer);
  }, [status, refreshList]);

  // Inbound (direct dial or mailbox drain) pushes a "circles" event.
  useGatewayEvent(
    "circles",
    useCallback(() => void refreshList(), [refreshList]),
  );

  return null;
}
