import { Activity, Check, Clock, ShieldAlert, X } from "lucide-react";
import { useEffect } from "react";
import { cn } from "../../lib/utils";
import { type ReviewAction, type ReviewStatus, useReviewStore } from "../../stores/review-store";

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
  if (loaded && history.length === 0) {
    return <Empty text="Nothing has needed your approval yet." />;
  }
  return (
    <div className="flex-1 overflow-auto">
      <ul className="divide-y divide-border/30">
        {history.map((action) => (
          <ActivityRow key={action.id} action={action} />
        ))}
      </ul>
    </div>
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
              {action.cls === "spend" ? "spend" : "post"} · {action.id}
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
