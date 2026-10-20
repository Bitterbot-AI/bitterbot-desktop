import { useCallback, useEffect, useState } from "react";
import { FirstRun } from "./components/first-run/FirstRun";
import { AppShell } from "./components/layout/AppShell";
import { SetupWizard } from "./components/setup/SetupWizard";
import { Toaster } from "./components/ui/sonner";
import { initDeepLinkJoin } from "./lib/deep-link";
import { fetchSessionToken, persistGatewayCredentials } from "./lib/gateway-origin";
import { isSetupPath } from "./lib/setup-route";
import {
  readStoredGatewayToken,
  readStoredGatewayUrl,
  useGatewayStore,
} from "./stores/gateway-store";

export function App() {
  // PLAN-56 Phase 4: `<basePath>/setup` is browser-first onboarding, with its
  // own connection (a one-time setup token, wizard scope only).
  if (typeof window !== "undefined" && isSetupPath(window.location.pathname)) {
    return (
      <>
        <SetupWizard />
        <Toaster richColors position="top-right" />
      </>
    );
  }
  return <ControlApp />;
}

function ControlApp() {
  const connect = useGatewayStore((s) => s.connect);

  // Decide at boot whether we already have a token. A stored one (from a prior
  // FirstRun) wins; otherwise ask the gateway that served this page via the
  // same-origin handoff endpoint, which replaces the old build-time
  // VITE_GATEWAY_TOKEN define. Only when both come up empty do we render
  // <FirstRun>, so we never flash a "Disconnected" badge at a new user.
  // `undefined` means "still deciding" and renders nothing.
  const [hasCredentials, setHasCredentials] = useState<boolean | undefined>(() =>
    readStoredGatewayToken() !== null ? true : undefined,
  );

  useEffect(() => {
    if (hasCredentials !== undefined) return;
    let cancelled = false;
    void (async () => {
      const token = await fetchSessionToken();
      if (cancelled) return;
      if (token) {
        persistGatewayCredentials({ url: readStoredGatewayUrl(), token });
        setHasCredentials(true);
      } else {
        setHasCredentials(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [hasCredentials]);

  useEffect(() => {
    if (hasCredentials !== true) return;
    const url = readStoredGatewayUrl();
    connect(url);
  }, [connect, hasCredentials]);

  // bitterbot:// deep links (Tauri shell only; no-op in the browser).
  // Registered at app boot so a cold-start link (the app was LAUNCHED by
  // the guest page's "Open in Bitterbot") is picked up too.
  useEffect(() => {
    void initDeepLinkJoin();
  }, []);

  const handleFirstRunComplete = useCallback(() => {
    setHasCredentials(true);
  }, []);

  // Still asking the gateway for a token: render nothing rather than flashing
  // FirstRun at a user who is about to be connected automatically.
  if (hasCredentials === undefined) {
    return null;
  }

  if (!hasCredentials) {
    return (
      <>
        <FirstRun onComplete={handleFirstRunComplete} />
        <Toaster richColors position="top-right" />
      </>
    );
  }

  return (
    <>
      <AppShell />
      <Toaster richColors position="top-right" />
    </>
  );
}
