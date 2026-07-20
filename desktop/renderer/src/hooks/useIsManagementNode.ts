import { useEffect, useState } from "react";
import { useGatewayStore } from "../stores/gateway-store";

/**
 * Probe whether this node is a management node: management.health only
 * succeeds when the ManagementNodeService is running (management tier).
 * Probes once per gateway connect; resets on disconnect.
 */
export function useIsManagementNode(): boolean {
  const gwStatus = useGatewayStore((s) => s.status);
  const request = useGatewayStore((s) => s.request);
  const [isManagementNode, setIsManagementNode] = useState(false);

  useEffect(() => {
    if (gwStatus !== "connected") {
      setIsManagementNode(false);
      return;
    }
    let cancelled = false;
    request("management.health")
      .then((res) => {
        if (!cancelled && res && typeof res === "object") {
          setIsManagementNode(true);
        }
      })
      .catch(() => {
        if (!cancelled) setIsManagementNode(false);
      });
    return () => {
      cancelled = true;
    };
  }, [gwStatus, request]);

  return isManagementNode;
}
