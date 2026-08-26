import { useEffect, useRef } from "react";
import { resolveGatewayHttpOrigin } from "../../lib/gateway-origin";
import { useGatewayStore } from "../../stores/gateway-store";

/**
 * ManagementView: embeds the server-rendered management dashboard in an iframe.
 * The dashboard is served at GET /management on the gateway and communicates
 * via its own WebSocket connection for real-time updates.
 */
export function ManagementView() {
  const hello = useGatewayStore((s) => s.hello);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  // No token in the query string: /management is served by the gateway itself and
  // waives auth for loopback callers, so a same-origin iframe already carries the
  // trust the page was loaded with. The old `?token=` was ignored server-side
  // anyway, making it a pure leak into history and referrers.
  // `__BITTERBOT_GATEWAY_URL__` was read here and set by nothing; the shared
  // helper replaces both it and the hardcoded fallback.
  const dashboardUrl = `${resolveGatewayHttpOrigin()}/management`;

  useEffect(() => {
    // Refresh iframe when gateway reconnects
    if (hello && iframeRef.current) {
      iframeRef.current.src = dashboardUrl;
    }
  }, [hello, dashboardUrl]);

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-6 py-4 border-b border-border">
        <div>
          <h1 className="text-xl font-bold">Management Dashboard</h1>
          <p className="text-sm text-muted-foreground">
            Network oversight, anomaly detection, and economic monitoring
          </p>
        </div>
        <a
          href={dashboardUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-muted-foreground hover:text-foreground transition-colors underline"
        >
          Open in new tab
        </a>
      </div>
      <iframe
        ref={iframeRef}
        src={dashboardUrl}
        className="flex-1 w-full border-0"
        title="Management Dashboard"
      />
    </div>
  );
}
