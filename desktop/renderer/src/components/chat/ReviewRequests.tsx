import { Check, ShieldAlert, X } from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "../../lib/utils";
import { type ReviewAction, useReviewStore } from "../../stores/review-store";

/**
 * Actions waiting for the owner (PLAN-53 Track B), shown above the chat so a
 * held spend or post is never missed. Approving a spend asks twice.
 */
export function ReviewRequests() {
  const pending = useReviewStore((s) => s.pending);
  const listen = useReviewStore((s) => s.listen);

  useEffect(() => listen(), [listen]);

  if (pending.length === 0) {
    return null;
  }
  return (
    <div className="flex-shrink-0 px-2 pt-2 space-y-2" data-testid="review-requests">
      {pending.map((action) => (
        <ReviewCard key={action.id} action={action} />
      ))}
    </div>
  );
}

function ReviewCard({ action }: { action: ReviewAction }) {
  const resolve = useReviewStore((s) => s.resolve);
  const busy = useReviewStore((s) => s.busy.has(action.id));
  const [confirming, setConfirming] = useState(false);
  const isSpend = action.cls === "spend";

  const approve = () => {
    if (isSpend && !confirming) {
      setConfirming(true);
      return;
    }
    void resolve(action.id, "approve");
  };

  return (
    <div className="rounded-lg border border-warning/30 bg-warning/5 p-3">
      <div className="flex items-start gap-2">
        <ShieldAlert className="w-4 h-4 text-warning flex-shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <p className="text-xs font-medium text-warning">
            {isSpend ? "Spending needs your approval" : "A public post needs your approval"}
            <span className="ml-2 font-mono text-2xs text-muted-foreground">{action.id}</span>
          </p>
          <p className="text-sm text-foreground mt-0.5 break-words">{action.preview}</p>
          <div className="flex items-center gap-2 mt-2">
            <button
              onClick={approve}
              disabled={busy}
              className={cn(
                "flex items-center gap-1 px-3 py-1 rounded-md text-xs font-medium border transition-colors disabled:opacity-50",
                confirming
                  ? "bg-success text-white border-success"
                  : "bg-success/15 text-success border-success/30 hover:bg-success/25",
              )}
            >
              <Check className="w-3.5 h-3.5" />
              {confirming ? "Yes, send it" : "Approve"}
            </button>
            {confirming && (
              <button
                onClick={() => setConfirming(false)}
                className="px-2 py-1 rounded-md text-xs text-muted-foreground hover:text-foreground"
              >
                Not yet
              </button>
            )}
            <button
              onClick={() => void resolve(action.id, "deny")}
              disabled={busy}
              className="flex items-center gap-1 px-3 py-1 rounded-md text-xs font-medium border border-danger/30 bg-danger/10 text-danger hover:bg-danger/20 transition-colors disabled:opacity-50"
            >
              <X className="w-3.5 h-3.5" />
              Deny
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
