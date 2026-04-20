import { useCallback, useEffect, useState } from "react";
import { FirstRun } from "./components/first-run/FirstRun";
import { AppShell } from "./components/layout/AppShell";
import { Toaster } from "./components/ui/sonner";
import {
  readStoredGatewayToken,
  readStoredGatewayUrl,
  useGatewayStore,
} from "./stores/gateway-store";

export function App() {
  const connect = useGatewayStore((s) => s.connect);

  // Decide at boot whether we already have a token (either persisted
  // to localStorage from a prior FirstRun or baked in via
  // VITE_GATEWAY_TOKEN at build time). If not, render <FirstRun>
  // instead of the main shell so we don't flash a "Disconnected"
  // badge and confuse a new user.
  const [hasCredentials, setHasCredentials] = useState<boolean>(
    () => readStoredGatewayToken() !== null,
  );

  useEffect(() => {
    if (!hasCredentials) return;
    const url = readStoredGatewayUrl();
    connect(url);
  }, [connect, hasCredentials]);

  const handleFirstRunComplete = useCallback(() => {
    setHasCredentials(true);
  }, []);

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
