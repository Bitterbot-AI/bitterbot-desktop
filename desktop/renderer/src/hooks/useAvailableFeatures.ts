import { useMemo } from "react";
import { useIsManagementNode } from "./useIsManagementNode";

/** Features the connected gateway offers, for `requireFeature` nav gating. */
export function useAvailableFeatures(): readonly string[] {
  const isManagementNode = useIsManagementNode();
  return useMemo(() => (isManagementNode ? ["management"] : []), [isManagementNode]);
}
