import { useMemo } from "react";
import { useGatewayStore } from "../../stores/gateway-store";

function resolveGatewayHttpUrl(): string {
  const gwUrl = useGatewayStore.getState().client?.url;
  if (gwUrl) {
    try {
      const parsed = new URL(gwUrl.replace("ws://", "http://").replace("wss://", "https://"));
      return `${parsed.protocol}//${parsed.hostname}:${parsed.port}`;
    } catch {
      // fallback
    }
  }
  const envUrl = import.meta.env.VITE_GATEWAY_URL;
  if (envUrl) {
    try {
      const parsed = new URL(envUrl.replace("ws://", "http://").replace("wss://", "https://"));
      return `${parsed.protocol}//${parsed.hostname}:${parsed.port}`;
    } catch {
      // fallback
    }
  }
  return "http://localhost:19001";
}

export function DreamsView() {
  const src = useMemo(() => `${resolveGatewayHttpUrl()}/dreams`, []);

  return (
    <div className="flex flex-col h-full w-full">
      <iframe
        src={src}
        className="flex-1 w-full border-0"
        title="Dream Engine Dashboard"
        allow="autoplay"
      />
    </div>
  );
}
