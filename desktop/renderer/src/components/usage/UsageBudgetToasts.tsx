import { useCallback } from "react";
import { toast } from "sonner";
import { useGatewayEvent } from "../../hooks/useGatewayEvent";
import { formatCost } from "../../lib/format";

type BudgetAlert = {
  type: "usage.budget";
  ts: number;
  previousLevel: number;
  status: {
    id: string;
    limitUsd: number;
    spentUsd: number;
    ratio: number;
    level: number;
    exceeded: boolean;
    resetsAtMs: number;
  };
};

/** Surfaces `usage.budget` threshold crossings as toasts anywhere in the app. Renders nothing. */
export function UsageBudgetToasts() {
  const onAlert = useCallback((payload: unknown) => {
    const alert = payload as BudgetAlert;
    if (!alert || alert.type !== "usage.budget" || !alert.status) return;
    const s = alert.status;
    const resets = new Date(s.resetsAtMs).toLocaleString();
    const title = s.exceeded
      ? `Budget ${s.id} exceeded`
      : `Budget ${s.id} at ${Math.round(s.ratio * 100)}%`;
    const description = `${formatCost(s.spentUsd)} of ${formatCost(s.limitUsd)} · resets ${resets}`;
    if (s.exceeded) {
      toast.error(title, { description, id: `budget:${s.id}` });
    } else if (s.level >= 80) {
      toast.warning(title, { description, id: `budget:${s.id}` });
    } else {
      toast.info(title, { description, id: `budget:${s.id}` });
    }
  }, []);
  useGatewayEvent("usage.budget", onAlert);
  return null;
}
