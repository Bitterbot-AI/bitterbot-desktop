import { useGatewayStore } from "../stores/gateway-store";

/**
 * Main gateway hook — provides connection status and request method.
 */
export function useGateway() {
  const status = useGatewayStore((s) => s.status);
  const hello = useGatewayStore((s) => s.hello);
  const error = useGatewayStore((s) => s.error);
  const request = useGatewayStore((s) => s.request);

  return { status, hello, error, request };
}
