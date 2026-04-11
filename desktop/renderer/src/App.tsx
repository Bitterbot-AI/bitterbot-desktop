import { useEffect } from "react";
import { useGatewayStore } from "./stores/gateway-store";
import { AppShell } from "./components/layout/AppShell";

export function App() {
  const connect = useGatewayStore((s) => s.connect);

  useEffect(() => {
    const url = import.meta.env.VITE_GATEWAY_URL ?? "ws://localhost:19001";
    connect(url);
  }, [connect]);

  return <AppShell />;
}
