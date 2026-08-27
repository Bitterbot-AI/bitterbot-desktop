import { useCallback, useState } from "react";
import { formatRelativeTime } from "../../lib/format";
import { cn } from "../../lib/utils";
import { useGatewayStore } from "../../stores/gateway-store";
import {
  parseCheckResponse,
  useUpdateStore,
  type UpdateCheckResponse,
} from "../../stores/update-store";

// update.run on the dev channel preflights (install + build + lint in a
// worktree) before it rebases, so a run can legitimately take a long while.
const UPDATE_RUN_TIMEOUT_MS = 45 * 60 * 1000;
const CHECK_TIMEOUT_MS = 60 * 1000;

type RunResponse = {
  ok: boolean;
  result: { status: string; reason?: string | null };
  restart?: unknown;
};

function describeSkipReason(reason: string | null): string {
  switch (reason) {
    case "dirty":
      return "the working tree has uncommitted changes; commit or stash them first";
    case "no-upstream":
      return "the checkout has no upstream branch configured";
    case "fetch-failed":
      return "git fetch failed; check the node's network access";
    case "checkout-failed":
      return "the git checkout step failed";
    case "rebase-failed":
      return "the rebase failed and was aborted; the checkout is unchanged";
    case "no-release-tag":
      return "no release tag found for this channel";
    case "preflight-worktree-failed":
      return "could not create the preflight worktree";
    case "preflight-no-good-commit":
      return "no upstream commit passed the install/build/lint preflight";
    case "not-bitterbot-root":
      return "the resolved directory is not a Bitterbot checkout";
    default:
      return reason ?? "unknown";
  }
}

export function UpdateCard() {
  const request = useGatewayStore((s) => s.request);
  const connectionStatus = useGatewayStore((s) => s.status);
  const hello = useGatewayStore((s) => s.hello);
  const {
    info,
    checking,
    updating,
    outcome,
    setInfo,
    setChecking,
    setUpdating,
    setOutcome,
    setReloadAfterReconnect,
  } = useUpdateStore();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Version skew: gateways advertise their methods in the hello frame. An
  // older gateway without update.check gets a quiet hint, never an error.
  const methods = hello?.features?.methods;
  const supported = methods ? methods.includes("update.check") : true;

  const runCheck = useCallback(
    async (fetch: boolean) => {
      setChecking(true);
      setError(null);
      try {
        const resp = await request<UpdateCheckResponse>(
          "update.check",
          { fetch },
          { timeoutMs: CHECK_TIMEOUT_MS },
        );
        setInfo(parseCheckResponse(resp));
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setChecking(false);
      }
    },
    [request, setChecking, setInfo],
  );

  const runUpdate = useCallback(async () => {
    setConfirming(false);
    setUpdating(true);
    setOutcome(null);
    setError(null);
    try {
      const resp = await request<RunResponse>(
        "update.run",
        {},
        { timeoutMs: UPDATE_RUN_TIMEOUT_MS },
      );
      const status = resp.result?.status ?? "unknown";
      setOutcome({
        status,
        reason: resp.result?.reason ?? null,
        // The gateway only schedules its SIGUSR1 restart on a successful run.
        restarting: status === "ok",
      });
      // A successful update rebuilds the renderer too; reload once the gateway
      // is back so the browser isn't left on the old bundle.
      if (status === "ok") setReloadAfterReconnect(true);
    } catch (err) {
      // The socket dropping here MAY be the restart, or a network blip, or a
      // hung run. Don't claim success: report the interruption and let the
      // reconnect bootstrap re-learn the node's real state.
      const message = err instanceof Error ? err.message : String(err);
      if (/disconnect|closed|timeout/i.test(message)) {
        setOutcome({ status: "interrupted", reason: null, restarting: false });
      } else {
        setError(message);
      }
    } finally {
      setUpdating(false);
    }
  }, [request, setUpdating, setOutcome]);

  const behind = info?.staleness.behind;
  const upToDate = info != null && !info.staleness.stale && behind === 0;

  if (!supported) {
    return (
      <div className="rounded-xl border border-border/20 bg-card/60 backdrop-blur-sm p-4">
        <h2 className="text-sm font-medium text-foreground mb-1">Node Version</h2>
        <p className="text-xs text-muted-foreground">
          This gateway predates in-UI updates. Update it once from the terminal (
          <span className="font-mono">bitterbot update</span>) to enable them.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-border/20 bg-card/60 backdrop-blur-sm p-4">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-medium text-foreground">Node Version</h2>
        {info && (
          <span className="text-xs text-muted-foreground">
            checked {formatRelativeTime(info.checkedAt)}
            {info.fetchOk === false && " (offline, counts may be stale)"}
          </span>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm mb-3">
        <span className="text-foreground font-mono">v{info?.version ?? "…"}</span>
        {info?.branch && info.sha && (
          <span className="text-muted-foreground font-mono text-xs">
            {info.branch}@{info.sha.slice(0, 8)}
          </span>
        )}
        {info?.installKind === "git" &&
          (behind != null ? (
            <span
              className={cn(
                "text-xs px-2 py-0.5 rounded-full",
                behind === 0
                  ? "bg-success/10 text-success"
                  : info.staleness.stale
                    ? "bg-warning/15 text-warning"
                    : "bg-muted/40 text-muted-foreground",
              )}
            >
              {behind === 0 ? "up to date" : `${behind} commit${behind === 1 ? "" : "s"} behind`}
            </span>
          ) : (
            <span className="text-xs px-2 py-0.5 rounded-full bg-muted/40 text-muted-foreground">
              drift unknown (no upstream tracking)
            </span>
          ))}
        {info?.installKind === "package" && info.registryLatest && (
          <span className="text-xs text-muted-foreground">
            channel latest: v{info.registryLatest}
          </span>
        )}
        {info?.dirty && (
          <span className="text-xs px-2 py-0.5 rounded-full bg-warning/15 text-warning">
            uncommitted changes
          </span>
        )}
      </div>

      {/* What an update brings, BEFORE install (sota-bar rec 2) */}
      {!updating &&
        info?.installKind === "git" &&
        (behind ?? 0) > 0 &&
        (info.pendingCommits?.length ?? 0) > 0 && (
          <div className="mb-3 rounded-lg bg-muted/20 border border-border/10 p-3">
            <p className="text-xs font-medium text-foreground mb-1.5">What&apos;s new upstream</p>
            <ul className="space-y-0.5">
              {info.pendingCommits!.slice(0, 8).map((subject, i) => (
                <li key={i} className="text-xs text-muted-foreground truncate">
                  • {subject}
                </li>
              ))}
              {(behind ?? 0) > 8 && (
                <li className="text-xs text-muted-foreground/60">…and {(behind ?? 0) - 8} more</li>
              )}
            </ul>
          </div>
        )}

      {updating ? (
        <p className="text-sm text-brand">
          Updating… the node fetches the latest code, verifies it builds (the dev channel preflights
          in a throwaway worktree), then applies it and restarts. This can take a while; the
          connection will drop when it restarts.
        </p>
      ) : outcome?.restarting ? (
        <p className="text-sm text-success">
          Update applied. The node is rebuilding and restarting; this page will reconnect on its
          own.
        </p>
      ) : outcome?.status === "interrupted" ? (
        <p className="text-sm text-warning">
          The connection dropped while updating. If the node is restarting, this page will reconnect
          and show its new version; otherwise re-check for updates.
        </p>
      ) : outcome && outcome.status !== "ok" ? (
        <p className="text-sm text-warning">
          Update {outcome.status}: {describeSkipReason(outcome.reason)}.
        </p>
      ) : null}

      {error && <p className="text-sm text-danger mb-2">{error}</p>}

      {!updating && (
        <div className="flex items-center gap-2 mt-1">
          <button
            type="button"
            onClick={() => void runCheck(true)}
            disabled={checking || connectionStatus !== "connected"}
            className={cn(
              "px-3 py-1.5 rounded-lg text-xs",
              "bg-muted/40 hover:bg-muted/70 text-foreground",
              "border border-border/30 transition-colors",
              (checking || connectionStatus !== "connected") && "opacity-50",
            )}
          >
            {checking ? "Checking…" : "Check for updates"}
          </button>
          {!confirming ? (
            <button
              type="button"
              onClick={() => setConfirming(true)}
              disabled={connectionStatus !== "connected" || upToDate}
              className={cn(
                "px-3 py-1.5 rounded-lg text-xs",
                "bg-brand/10 hover:bg-brand/30 text-brand",
                "border border-brand/20 transition-colors",
                (connectionStatus !== "connected" || upToDate) && "opacity-50",
              )}
            >
              Update now
            </button>
          ) : (
            <span className="flex items-center gap-2 text-xs text-muted-foreground">
              Rebuilds and restarts the node (can take 20+ minutes).
              <button
                type="button"
                onClick={() => void runUpdate()}
                className="px-2 py-1 rounded bg-warning/15 text-warning border border-warning/30 hover:bg-warning/35"
              >
                Confirm update
              </button>
              <button
                type="button"
                onClick={() => setConfirming(false)}
                className="px-2 py-1 rounded bg-muted/40 text-foreground border border-border/30 hover:bg-muted/70"
              >
                Cancel
              </button>
            </span>
          )}
        </div>
      )}
    </div>
  );
}
