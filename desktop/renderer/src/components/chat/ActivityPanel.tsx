import { Activity, Check, Clock, ShieldAlert, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { cn } from "../../lib/utils";
import { useGatewayStore } from "../../stores/gateway-store";
import { type ReviewAction, type ReviewStatus, useReviewStore } from "../../stores/review-store";

const CLASS_LABEL: Record<string, string> = {
  spend: "spend",
  publish: "post",
  contact: "message",
  handoff: "handoff",
  command: "command",
};

/**
 * What the agent asked to do on the owner's behalf and what came of it
 * (PLAN-53 B5). One list, newest first, from the review store.
 */
export function ActivityPanel() {
  const history = useReviewStore((s) => s.history);
  const loaded = useReviewStore((s) => s.loaded);
  const unsupported = useReviewStore((s) => s.unsupported);
  const listen = useReviewStore((s) => s.listen);

  useEffect(() => listen(), [listen]);

  if (unsupported) {
    return (
      <Empty text="This gateway build does not record reviewed actions yet. Update the gateway." />
    );
  }
  return (
    <div className="flex-1 overflow-auto">
      <Payments />
      {loaded && history.length === 0 ? (
        <Empty text="Nothing has needed your approval yet." />
      ) : (
        <ul className="divide-y divide-border/30">
          {history.map((action) => (
            <ActivityRow key={action.id} action={action} />
          ))}
        </ul>
      )}
    </div>
  );
}

export type SpendDecision = {
  id: string;
  ts: number;
  origin: "wallet-tool" | "a2a" | "rpc" | "payout";
  payee: string;
  amountUsd: number;
  verdict: "allow" | "deny";
  reason: string;
  outcome: "sent" | "failed" | "refused";
  txHash?: string;
  error?: string;
};

const ORIGIN: Record<SpendDecision["origin"], string> = {
  "wallet-tool": "the agent",
  a2a: "a task for another agent",
  rpc: "you, directly",
  payout: "an automatic payout",
};

/** One line for a payment: what happened, how much, to whom, and on what authority. */
export function describeSpend(d: SpendDecision): { tone: string; text: string } {
  const amount = `$${d.amountUsd.toFixed(2)}`;
  if (d.outcome === "sent") {
    return { tone: "text-success", text: `Sent ${amount} to ${d.payee} (${d.reason})` };
  }
  if (d.outcome === "refused") {
    return { tone: "text-warning", text: `Refused ${amount} to ${d.payee}: ${d.reason}` };
  }
  return {
    tone: "text-danger",
    text: `Failed to send ${amount} to ${d.payee}${d.error ? `: ${d.error}` : ""}`,
  };
}

/** Money out, from the spend gate's record. Shown only when there is any. */
function Payments() {
  const status = useGatewayStore((s) => s.status);
  const request = useGatewayStore((s) => s.request);
  const [decisions, setDecisions] = useState<SpendDecision[]>([]);

  const load = useCallback(async () => {
    if (status !== "connected") return;
    try {
      const res = (await request("review.spends", { limit: 20 })) as {
        decisions?: SpendDecision[];
      };
      setDecisions(res?.decisions ?? []);
    } catch {
      // An older gateway: no payment record to show.
    }
  }, [status, request]);

  useEffect(() => {
    void load();
  }, [load]);

  if (decisions.length === 0) return null;
  return (
    <details className="border-b border-border/30" open data-testid="activity-payments">
      <summary className="px-3 py-2 text-2xs font-semibold uppercase tracking-wide text-muted-foreground cursor-pointer">
        Payments ({decisions.length})
      </summary>
      <ul className="divide-y divide-border/20">
        {decisions.map((d) => {
          const line = describeSpend(d);
          return (
            <li key={d.id} className="px-3 py-1.5">
              <p className={cn("text-xs break-words", line.tone)}>{line.text}</p>
              <p className="text-2xs text-muted-foreground">
                {new Date(d.ts).toLocaleString()} · from {ORIGIN[d.origin] ?? d.origin}
                {d.txHash ? ` · ${d.txHash.slice(0, 14)}…` : ""}
              </p>
            </li>
          );
        })}
      </ul>
    </details>
  );
}

const STATUS: Record<ReviewStatus, { label: string; tone: string; icon: typeof Check }> = {
  pending: { label: "Waiting", tone: "text-warning", icon: ShieldAlert },
  approved: { label: "Approved", tone: "text-success", icon: Check },
  executed: { label: "Done", tone: "text-success", icon: Check },
  failed: { label: "Failed", tone: "text-danger", icon: X },
  denied: { label: "Denied", tone: "text-danger", icon: X },
  expired: { label: "Expired", tone: "text-muted-foreground", icon: Clock },
};

function ActivityRow({ action }: { action: ReviewAction }) {
  const meta = STATUS[action.status];
  const Icon = meta.icon;
  const when = new Date(action.decidedAt ?? action.createdAt).toLocaleString();
  return (
    <li className="px-3 py-2" data-testid="activity-row">
      <div className="flex items-start gap-2">
        <Icon className={cn("w-3.5 h-3.5 mt-0.5 flex-shrink-0", meta.tone)} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className={cn("text-badge font-medium uppercase tracking-wide", meta.tone)}>
              {meta.label}
            </span>
            <span className="text-2xs text-muted-foreground">
              {CLASS_LABEL[action.cls] ?? action.cls} · {action.id}
            </span>
          </div>
          <p className="text-xs text-foreground break-words">{action.preview}</p>
          <p className="text-2xs text-muted-foreground">
            {when}
            {action.decidedBy ? ` · by ${action.decidedBy}` : ""}
          </p>
          {action.resultSummary && (
            <p className="text-2xs text-muted-foreground font-mono break-words mt-0.5 line-clamp-3">
              {action.resultSummary}
            </p>
          )}
        </div>
      </div>
    </li>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <div className="flex-1 flex items-center justify-center">
      <div className="text-center space-y-2 text-muted-foreground px-6">
        <Activity className="w-8 h-8 mx-auto opacity-50" />
        <p className="text-sm">{text}</p>
      </div>
    </div>
  );
}
