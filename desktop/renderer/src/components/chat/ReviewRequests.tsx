import { Check, MousePointerClick, ShieldAlert, X } from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "../../lib/utils";
import { useArtifactStore } from "../../stores/artifact-store";
import { useBrowserLiveStore } from "../../stores/browser-live-store";
import { type ReviewAction, useReviewStore } from "../../stores/review-store";
import { useUIStore } from "../../stores/ui-store";

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
      {pending.map((action) =>
        action.cls === "handoff" ? (
          <HandoffCard key={action.id} action={action} />
        ) : (
          <ReviewCard key={action.id} action={action} />
        ),
      )}
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
            {isSpend
              ? "Spending needs your approval"
              : action.cls === "contact"
                ? "A message to someone new needs your approval"
                : "A public post needs your approval"}
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

/** What the agent said it needs, from the stored request. */
function handoffReason(action: ReviewAction): string {
  const params = action.params as { reason?: unknown } | null;
  return typeof params?.reason === "string" && params.reason ? params.reason : action.preview;
}

/** The site the agent wants the person on, so they can judge the request. */
function handoffSite(action: ReviewAction): string | null {
  const params = action.params as { url?: unknown } | null;
  if (typeof params?.url !== "string") {
    return null;
  }
  try {
    return new URL(params.url).host || null;
  } catch {
    return null;
  }
}

/**
 * The agent is stuck on something only a person should do (a login, a
 * CAPTCHA) and is waiting. "Take over" opens the live browser and takes the
 * controls in one step; taking control is what accepts the request.
 */
function HandoffCard({ action }: { action: ReviewAction }) {
  const resolve = useReviewStore((s) => s.resolve);
  const busy = useReviewStore((s) => s.busy.has(action.id));
  const site = handoffSite(action);

  const takeOver = () => {
    useUIStore.getState().setToolPanelOpen(true);
    useArtifactStore.getState().setPanelMode("browser");
    useBrowserLiveStore.getState().requestTakeover();
  };

  return (
    <div className="rounded-lg border border-brand/30 bg-brand/5 p-3" data-testid="handoff-card">
      <div className="flex items-start gap-2">
        <MousePointerClick className="w-4 h-4 text-brand flex-shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <p className="text-xs font-medium text-brand">
            Your agent needs you in the browser
            <span className="ml-2 font-mono text-2xs text-muted-foreground">{action.id}</span>
          </p>
          <p className="text-sm text-foreground mt-0.5 break-words">{handoffReason(action)}</p>
          {site && (
            <p className="text-xs text-muted-foreground mt-0.5">
              Page: <span className="font-mono text-foreground">{site}</span>. Check it is the site
              you expect before you type anything.
            </p>
          )}
          <p className="text-xs text-muted-foreground mt-0.5">
            It is waiting. Hand the browser back when you are done and it will carry on.
          </p>
          <div className="flex items-center gap-2 mt-2">
            <button
              onClick={takeOver}
              disabled={busy}
              className="flex items-center gap-1 px-3 py-1 rounded-md text-xs font-medium border bg-brand/15 text-brand border-brand/30 hover:bg-brand/25 transition-colors disabled:opacity-50"
            >
              <MousePointerClick className="w-3.5 h-3.5" />
              Take over
            </button>
            <button
              onClick={() => void resolve(action.id, "deny")}
              disabled={busy}
              className="px-3 py-1 rounded-md text-xs font-medium border border-border/40 text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
            >
              Not now
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
