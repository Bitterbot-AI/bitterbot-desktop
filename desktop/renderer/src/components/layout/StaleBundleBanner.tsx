import { useState } from "react";
import { useGatewayStore } from "../../stores/gateway-store";

/** The version this page was built with (root package.json, see vite.config). */
const BUNDLE_VERSION: string = import.meta.env.VITE_APP_VERSION ?? "dev";

const SEMVER = /^\d+\.\d+\.\d+$/;

/**
 * True when the gateway runs a different release than this page was built
 * from. Only real semver on both sides counts: a dev build, or a gateway run
 * outside pnpm (which reports "dev"/"unknown"), never triggers the banner.
 */
export function bundleIsStale(bundleVersion: string, serverVersion: unknown): boolean {
  return (
    typeof serverVersion === "string" &&
    SEMVER.test(bundleVersion) &&
    SEMVER.test(serverVersion) &&
    bundleVersion !== serverVersion
  );
}

/**
 * A tab left open across a gateway update reconnects to the new gateway but
 * keeps running the old page, so the sidebar kept showing v1.2.0 against a
 * v1.4.0 gateway. The gateway reports its version on every connect; when it
 * differs from this page's, offer a reload.
 */
export function StaleBundleBanner() {
  const serverVersion = useGatewayStore(
    (s) => (s.hello?.server as { version?: unknown } | undefined)?.version,
  );
  const [dismissedFor, setDismissedFor] = useState<string | null>(null);
  if (!bundleIsStale(BUNDLE_VERSION, serverVersion) || dismissedFor === serverVersion) {
    return null;
  }
  return (
    <div className="flex items-center gap-3 px-4 py-2 bg-warning/10 border-b border-warning/25 text-sm">
      <span className="text-warning flex-1 min-w-0 truncate">
        Bitterbot was updated to v{String(serverVersion)}. This page is still v{BUNDLE_VERSION}.
      </span>
      <button
        type="button"
        onClick={() => window.location.reload()}
        className="px-2.5 py-1 rounded-lg text-xs bg-warning/15 text-warning border border-warning/30 hover:bg-warning/35 transition-colors whitespace-nowrap"
      >
        Reload
      </button>
      <button
        type="button"
        onClick={() => setDismissedFor(String(serverVersion))}
        className="px-2 py-1 rounded-lg text-xs text-muted-foreground hover:text-foreground transition-colors"
        aria-label="Dismiss reload prompt"
      >
        Dismiss
      </button>
    </div>
  );
}
