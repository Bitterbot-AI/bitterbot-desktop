import { useCallback, useEffect, useRef } from "react";
import { useGatewayEvent } from "../../hooks/useGatewayEvent";
import { useGatewayStore } from "../../stores/gateway-store";
import { useUIStore } from "../../stores/ui-store";
import {
  parseCheckResponse,
  parseUpdateEvent,
  shouldShowUpdateBanner,
  useUpdateStore,
  type UpdateCheckResponse,
} from "../../stores/update-store";

/**
 * Fleet drift control: the gateway broadcasts an `update` event at boot and
 * every 6 hours; once a node falls `update.promptBehindCommits` commits
 * behind upstream this banner nags (dismissible per local sha — it comes
 * back only after the node actually updates or the page reloads).
 *
 * Always mounted in AppShell, so this component owns the update store's
 * lifecycle: the event subscription, plus a one-shot bootstrap check per
 * connection (the boot broadcast usually fires before this UI reconnects,
 * so without the bootstrap a freshly opened UI would wait up to 6h).
 */
export function UpdateBanner() {
  const setActiveTab = useUIStore((s) => s.setActiveTab);
  const connectionStatus = useGatewayStore((s) => s.status);
  const hello = useGatewayStore((s) => s.hello);
  const request = useGatewayStore((s) => s.request);
  const info = useUpdateStore((s) => s.info);
  const updating = useUpdateStore((s) => s.updating);
  const dismissedSha = useUpdateStore((s) => s.dismissedSha);
  const setInfo = useUpdateStore((s) => s.setInfo);
  const dismissBanner = useUpdateStore((s) => s.dismissBanner);
  const resetForReconnect = useUpdateStore((s) => s.resetForReconnect);
  const reloadAfterReconnect = useUpdateStore((s) => s.reloadAfterReconnect);

  // After a successful in-UI update, the gateway rebuilds (renderer included)
  // and restarts. Once it drops and comes back, reload so the browser isn't
  // stranded on the pre-update bundle. Gated on an actual drop so we never
  // reload while still on the old connection.
  const sawDropForReloadRef = useRef(false);
  useEffect(() => {
    if (!reloadAfterReconnect) {
      sawDropForReloadRef.current = false;
      return;
    }
    if (connectionStatus !== "connected") {
      sawDropForReloadRef.current = true;
    } else if (sawDropForReloadRef.current) {
      window.location.reload();
    }
  }, [reloadAfterReconnect, connectionStatus]);

  const onEvent = useCallback(
    (payload: unknown) => {
      const parsed = parseUpdateEvent(payload);
      if (parsed) {
        setInfo(parsed);
      }
    },
    [setInfo],
  );
  useGatewayEvent("update", onEvent);

  // One bootstrap check per connection epoch. A ref (not state) guards it so
  // a failing check can never re-arm itself — no retry storms (the periodic
  // gateway broadcast is the retry path).
  const bootstrappedRef = useRef(false);
  const wasConnectedRef = useRef(false);
  useEffect(() => {
    if (connectionStatus !== "connected") {
      if (wasConnectedRef.current) {
        // Disconnected (possibly a restart mid-update): stale data must not
        // survive into the next connection.
        bootstrappedRef.current = false;
        resetForReconnect();
      }
      wasConnectedRef.current = false;
      return;
    }
    wasConnectedRef.current = true;
    if (bootstrappedRef.current) {
      return;
    }
    bootstrappedRef.current = true;
    // Version skew: only probe gateways that advertise the method.
    const methods = hello?.features?.methods;
    if (methods && !methods.includes("update.check")) {
      return;
    }
    void (async () => {
      try {
        // fetch:false = local refs only; instant, no network from the gateway.
        const resp = await request<UpdateCheckResponse>(
          "update.check",
          { fetch: false },
          { timeoutMs: 30_000 },
        );
        setInfo(parseCheckResponse(resp));
      } catch {
        // Silent: an old gateway or a transient failure just means no banner
        // until the next broadcast.
      }
    })();
  }, [connectionStatus, hello, request, setInfo, resetForReconnect]);

  if (!shouldShowUpdateBanner({ info, updating, dismissedSha })) {
    return null;
  }

  const behind = info?.staleness.behind;
  const label =
    info?.staleness.reason === "package-version"
      ? `A newer release is available (v${info.registryLatest ?? "?"}).`
      : `This node is ${behind ?? "many"} commits behind the latest code.`;

  return (
    <div className="flex items-center gap-3 px-4 py-2 bg-amber-500/10 border-b border-amber-500/25 text-sm">
      <span className="text-amber-300 flex-1 min-w-0 truncate">
        {label} Out-of-date nodes drift from the fleet.
      </span>
      <button
        type="button"
        onClick={() => setActiveTab("overview")}
        className="px-2.5 py-1 rounded-lg text-xs bg-amber-500/15 text-amber-200 border border-amber-500/30 hover:bg-amber-500/25 transition-colors whitespace-nowrap"
      >
        Update from Overview
      </button>
      <button
        type="button"
        onClick={dismissBanner}
        className="px-2 py-1 rounded-lg text-xs text-muted-foreground hover:text-foreground transition-colors"
        aria-label="Dismiss update prompt"
      >
        Dismiss
      </button>
    </div>
  );
}
