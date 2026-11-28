import { MousePointerClick, ShieldAlert, Terminal } from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "../../lib/utils";
import { useArtifactStore } from "../../stores/artifact-store";
import { useBrowserLiveStore } from "../../stores/browser-live-store";
import { type ReviewAction, useReviewStore } from "../../stores/review-store";
import { useUIStore } from "../../stores/ui-store";

/**
 * Actions waiting for the owner (PLAN-53 Track B), shown in the conversation
 * column just above the composer so a held spend or post is never missed.
 * Approving a spend asks twice.
 */
export function ReviewRequests() {
  const pending = useReviewStore((s) => s.pending);
  const listen = useReviewStore((s) => s.listen);

  useEffect(() => listen(), [listen]);

  if (pending.length === 0) {
    return null;
  }
  return (
    <div className="shrink-0 px-3 pb-2 md:px-5" data-testid="review-requests">
      <div className="mx-auto w-full max-w-[800px] space-y-2">
        {pending.map((action) =>
          action.cls === "handoff" ? (
            <HandoffCard key={action.id} action={action} />
          ) : action.cls === "command" ? (
            <CommandCard key={action.id} action={action} />
          ) : (
            <ReviewCard key={action.id} action={action} />
          ),
        )}
      </div>
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
    <div className="rounded-xl border border-line bg-raised p-3">
      <div className="flex items-start gap-2">
        <ShieldAlert className="mt-0.5 size-[18px] shrink-0 text-warning" strokeWidth={1.75} />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-ink">
            {isSpend
              ? "Spending needs your approval"
              : action.cls === "contact"
                ? "A message to someone new needs your approval"
                : action.cls === "connector"
                  ? "A change through a connector needs your approval"
                  : "A public post needs your approval"}
            <span className="ml-2 font-mono text-xs font-normal text-ink-muted">{action.id}</span>
          </p>
          <p className="mt-0.5 break-words text-sm text-ink">{action.preview}</p>
          <div className="flex items-center gap-2 mt-2">
            <button
              onClick={approve}
              disabled={busy}
              className={cn(
                "h-8 rounded-md border border-control px-3 text-sm font-medium text-ink transition-colors hover:bg-hover disabled:opacity-50",
                confirming &&
                  "border-button bg-button text-on-button hover:bg-button hover:opacity-85",
              )}
            >
              {confirming ? "Yes, send it" : "Approve"}
            </button>
            {confirming && (
              <button
                onClick={() => setConfirming(false)}
                className="h-8 rounded-md px-2 text-sm text-ink-secondary transition-colors hover:bg-hover hover:text-ink"
              >
                Not yet
              </button>
            )}
            <button
              onClick={() => void resolve(action.id, "deny")}
              disabled={busy}
              className="h-8 rounded-md border border-control px-3 text-sm font-medium text-ink transition-colors hover:bg-hover disabled:opacity-50"
            >
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
    <div className="rounded-xl border border-line bg-raised p-3" data-testid="handoff-card">
      <div className="flex items-start gap-2">
        <MousePointerClick
          className="mt-0.5 size-[18px] shrink-0 text-warning"
          strokeWidth={1.75}
        />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-ink">
            Your agent needs you in the browser
            <span className="ml-2 font-mono text-xs font-normal text-ink-muted">{action.id}</span>
          </p>
          <p className="mt-0.5 break-words text-sm text-ink">{handoffReason(action)}</p>
          {site && (
            <p className="mt-0.5 text-sm text-ink-secondary">
              Page: <span className="font-mono text-ink">{site}</span>. Check it is the site you
              expect before you type anything.
            </p>
          )}
          <p className="mt-0.5 text-sm text-ink-secondary">
            It is waiting. Hand the browser back when you are done and it will carry on.
          </p>
          <div className="flex items-center gap-2 mt-2">
            <button
              onClick={takeOver}
              disabled={busy}
              className="h-8 rounded-md border border-control px-3 text-sm font-medium text-ink transition-colors hover:bg-hover disabled:opacity-50"
            >
              Take over
            </button>
            <button
              onClick={() => void resolve(action.id, "deny")}
              disabled={busy}
              className="h-8 rounded-md border border-control px-3 text-sm font-medium text-ink transition-colors hover:bg-hover disabled:opacity-50"
            >
              Not now
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * A shell command the agent wants to run. The exec tool is waiting on the
 * answer: once runs this one, always also adds it to the allowlist.
 */
function CommandCard({ action }: { action: ReviewAction }) {
  const resolve = useReviewStore((s) => s.resolve);
  const busy = useReviewStore((s) => s.busy.has(action.id));
  const params = action.params as { command?: unknown; cwd?: unknown; host?: unknown } | null;
  const command = typeof params?.command === "string" ? params.command : action.preview;
  const where = [
    typeof params?.host === "string" ? params.host : null,
    typeof params?.cwd === "string" ? params.cwd : null,
  ].filter(Boolean);

  return (
    <div className="rounded-xl border border-line bg-raised p-3" data-testid="command-card">
      <div className="flex items-start gap-2">
        <Terminal className="mt-0.5 size-[18px] shrink-0 text-warning" strokeWidth={1.75} />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-ink">
            A command needs your approval
            <span className="ml-2 font-mono text-xs font-normal text-ink-muted">{action.id}</span>
          </p>
          <pre className="text-xs font-mono text-ink mt-1 whitespace-pre-wrap break-all max-h-32 overflow-auto">
            {command}
          </pre>
          {where.length > 0 && (
            <p className="mt-1 font-mono text-xs text-ink-muted">{where.join(" · ")}</p>
          )}
          <div className="flex items-center gap-2 mt-2">
            <button
              onClick={() => void resolve(action.id, "approve")}
              disabled={busy}
              className="h-8 rounded-md border border-control px-3 text-sm font-medium text-ink transition-colors hover:bg-hover disabled:opacity-50"
            >
              Allow once
            </button>
            <button
              onClick={() => void resolve(action.id, "approve", { always: true })}
              disabled={busy}
              className="h-8 rounded-md border border-control px-3 text-sm font-medium text-ink transition-colors hover:bg-hover disabled:opacity-50"
            >
              Always allow
            </button>
            <button
              onClick={() => void resolve(action.id, "deny")}
              disabled={busy}
              className="h-8 rounded-md border border-control px-3 text-sm font-medium text-ink transition-colors hover:bg-hover disabled:opacity-50"
            >
              Deny
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
