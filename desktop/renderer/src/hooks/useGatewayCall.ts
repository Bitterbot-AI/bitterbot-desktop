import { useCallback, useState } from "react";
import { useGatewayStore } from "../stores/gateway-store";

/**
 * Hook for making one-shot RPC calls to the gateway.
 * Returns { call, data, loading, error }.
 */
export function useGatewayCall<T = unknown>(method: string) {
  const request = useGatewayStore((s) => s.request);
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const call = useCallback(
    async (params?: unknown): Promise<T | null> => {
      setLoading(true);
      setError(null);
      try {
        const result = await request<T>(method, params);
        setData(result);
        return result;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
        return null;
      } finally {
        setLoading(false);
      }
    },
    [method, request],
  );

  return { call, data, loading, error };
}
