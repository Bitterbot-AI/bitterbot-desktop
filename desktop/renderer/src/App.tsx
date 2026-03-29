import { useEffect } from "react";
import { useGatewayStore } from "./stores/gateway-store";
import { AppShell } from "./components/layout/AppShell";

export function App() {
  const connect = useGatewayStore((s) => s.connect);

  useEffect(() => {
    // Start gateway connection when the app mounts.
    // In Electron, the preload script provides the URL via IPC (async).
    // In plain browser dev, fall back to localhost.
    const init = async () => {
      const url =
        typeof window.bitterbot?.getGatewayUrl === "function"
          ? await window.bitterbot.getGatewayUrl()
          : (import.meta.env.VITE_GATEWAY_URL ?? "ws://localhost:19001");

      connect(url);
    };
    init();
  }, [connect]);

  return <AppShell />;
}
