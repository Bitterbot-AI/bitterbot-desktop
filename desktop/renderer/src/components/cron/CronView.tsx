import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { useGatewayEvent } from "../../hooks/useGatewayEvent";
import { describeError } from "../../lib/describe-error";
import { formatRelativeTime, formatDateTime } from "../../lib/format";
import { cn } from "../../lib/utils";
import {
  cronJobHealth,
  useCronStore,
  type CronJob,
  type CronRunEntry,
} from "../../stores/cron-store";
import { useGatewayStore } from "../../stores/gateway-store";
import { useConfirm } from "../ui/confirm-dialog";
import { MonitorsSection } from "./MonitorsSection";
import { TasksSection } from "./TasksSection";

const HEALTH_TONE = {
  ok: "text-success",
  warn: "text-warning",
  bad: "text-danger",
  idle: "text-muted-foreground/60",
} as const;

function describeDelivery(job: CronJob): string {
  const delivery = job.delivery;
  if (delivery?.mode === "none") return "Result stays in the session";
  if (delivery?.channel && delivery.to) return `Sends to ${delivery.channel} ${delivery.to}`;
  return "Sends to your most recent chat";
}

function CronJobCard({
  job,
  onToggle,
  onRun,
  onRemove,
  onLoadRuns,
  runs,
}: {
  job: CronJob;
  onToggle: (id: string, enabled: boolean) => void;
  onRun: (id: string) => void;
  onRemove: (id: string, label: string) => void;
  onLoadRuns: (id: string) => void;
  runs: CronRunEntry[] | undefined;
}) {
  const [showRuns, setShowRuns] = useState(false);
  const health = cronJobHealth(job);
  const toggleRuns = () => {
    if (!showRuns) onLoadRuns(job.id);
    setShowRuns(!showRuns);
  };
  return (
    <div className="rounded-xl border border-border/20 bg-card/60 backdrop-blur-sm p-4">
      <div className="flex items-start gap-3">
        <button
          onClick={() => onToggle(job.id, !job.enabled)}
          className={cn(
            "mt-0.5 w-9 h-5 rounded-full transition-colors relative flex-shrink-0",
            job.enabled ? "bg-brand" : "bg-muted",
          )}
        >
          <span
            className={cn(
              "absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform",
              job.enabled ? "left-[18px]" : "left-0.5",
            )}
          />
        </button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-sm font-medium text-foreground">
              {job.label ?? "Untitled Job"}
            </span>
            <span className="text-xs font-mono text-muted-foreground/60">{job.schedule}</span>
          </div>
          <p className="text-xs text-muted-foreground line-clamp-2">{job.text}</p>
          <div className="flex items-center gap-4 mt-2 text-xs text-muted-foreground/60">
            {job.lastRunAt && <span>Last: {formatRelativeTime(job.lastRunAt)}</span>}
            {job.nextRunAt && <span>Next: {formatDateTime(job.nextRunAt)}</span>}
            {job.sessionKey && <span className="font-mono">{job.sessionKey}</span>}
          </div>
          <div className="flex items-center gap-4 mt-1 text-xs">
            <span className={HEALTH_TONE[health.tone]} data-testid="cron-health">
              {health.text}
            </span>
            <span className="text-muted-foreground/60">{describeDelivery(job)}</span>
            <button
              onClick={toggleRuns}
              className="text-muted-foreground/60 hover:text-foreground underline-offset-2 hover:underline"
            >
              {showRuns ? "Hide history" : "History"}
            </button>
          </div>
          {showRuns && (
            <ul className="mt-2 space-y-1 text-xs" data-testid="cron-runs">
              {runs === undefined && <li className="text-muted-foreground/60">Loading…</li>}
              {runs?.length === 0 && <li className="text-muted-foreground/60">No runs yet</li>}
              {runs?.map((run) => (
                <li key={`${run.ts}:${run.status}`} className="flex gap-2">
                  <span className="text-muted-foreground/60 flex-shrink-0">
                    {formatDateTime(run.ts)}
                  </span>
                  <span
                    className={cn(
                      "flex-shrink-0",
                      run.status === "ok"
                        ? "text-success"
                        : run.status === "error"
                          ? "text-danger"
                          : "text-muted-foreground",
                    )}
                  >
                    {run.status}
                  </span>
                  {run.error && (
                    <span className="text-muted-foreground break-words">{run.error}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => onRun(job.id)}
            className="px-2 py-1 text-xs rounded bg-brand/10 text-brand hover:bg-brand/30 border border-brand/20"
          >
            Run
          </button>
          <button
            onClick={() => onRemove(job.id, job.label ?? job.id)}
            className="px-2 py-1 text-xs rounded bg-danger/10 text-danger hover:bg-danger/30 border border-danger/20"
          >
            Remove
          </button>
        </div>
      </div>
    </div>
  );
}

function AddCronForm({ onAdd }: { onAdd: (params: Record<string, unknown>) => void }) {
  const [label, setLabel] = useState("");
  const [schedule, setSchedule] = useState("0 9 * * *");
  const [text, setText] = useState("");
  const [deliverTo, setDeliverTo] = useState<"last" | "chat" | "none">("last");
  const [channel, setChannel] = useState("");
  const [recipient, setRecipient] = useState("");
  const chatIncomplete = deliverTo === "chat" && (!channel.trim() || !recipient.trim());

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!text.trim() || chatIncomplete) return;
    onAdd({
      label: label.trim() || undefined,
      schedule,
      text: text.trim(),
      // "last" sends no delivery block: the gateway uses the most recent chat.
      ...(deliverTo === "chat"
        ? { delivery: { mode: "announce", channel: channel.trim(), to: recipient.trim() } }
        : deliverTo === "none"
          ? { delivery: { mode: "none" } }
          : {}),
    });
    setLabel("");
    setText("");
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="rounded-xl border border-border/20 bg-card/60 backdrop-blur-sm p-4 space-y-3"
    >
      <h3 className="text-sm font-medium text-foreground">Add a scheduled job</h3>
      <div className="grid grid-cols-2 gap-3">
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Label (optional)"
          className={cn(
            "h-8 px-3 text-sm rounded-lg border bg-transparent",
            "border-border/30 focus:border-brand focus:outline-none",
          )}
        />
        <input
          value={schedule}
          onChange={(e) => setSchedule(e.target.value)}
          placeholder="Cron schedule"
          className={cn(
            "h-8 px-3 text-sm font-mono rounded-lg border bg-transparent",
            "border-border/30 focus:border-brand focus:outline-none",
          )}
        />
      </div>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Message text…"
        rows={2}
        className={cn(
          "w-full px-3 py-2 text-sm rounded-lg border bg-transparent resize-none",
          "border-border/30 focus:border-brand focus:outline-none",
        )}
      />
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <label htmlFor="cron-deliver" className="text-muted-foreground">
          Send the result to
        </label>
        <select
          id="cron-deliver"
          value={deliverTo}
          onChange={(e) => setDeliverTo(e.target.value as "last" | "chat" | "none")}
          className="h-8 px-2 rounded-lg border border-border/30 bg-transparent"
        >
          <option value="last">my most recent chat</option>
          <option value="chat">a specific chat</option>
          <option value="none">nowhere (keep it in the session)</option>
        </select>
        {deliverTo === "chat" && (
          <>
            <input
              value={channel}
              onChange={(e) => setChannel(e.target.value)}
              placeholder="Channel, e.g. telegram"
              aria-label="Channel"
              className="h-8 px-3 rounded-lg border border-border/30 bg-transparent focus:border-brand focus:outline-none"
            />
            <input
              value={recipient}
              onChange={(e) => setRecipient(e.target.value)}
              placeholder="Recipient id or number"
              aria-label="Recipient"
              className="h-8 px-3 rounded-lg border border-border/30 bg-transparent focus:border-brand focus:outline-none"
            />
          </>
        )}
      </div>
      <button
        type="submit"
        disabled={!text.trim() || chatIncomplete}
        className={cn(
          "px-4 py-1.5 text-xs rounded-lg font-medium",
          "bg-brand text-white hover:bg-brand/90",
          "disabled:opacity-50 disabled:cursor-not-allowed",
          "transition-colors",
        )}
      >
        Add Job
      </button>
    </form>
  );
}

export function CronView() {
  const [confirmDialog, confirmElement] = useConfirm();
  const gwStatus = useGatewayStore((s) => s.status);
  const request = useGatewayStore((s) => s.request);
  const jobs = useCronStore((s) => s.jobs);
  const loading = useCronStore((s) => s.loading);
  const setJobs = useCronStore((s) => s.setJobs);
  const setLoading = useCronStore((s) => s.setLoading);
  const setError = useCronStore((s) => s.setError);
  const removeJob = useCronStore((s) => s.removeJob);
  const updateJob = useCronStore((s) => s.updateJob);
  const addJob = useCronStore((s) => s.addJob);
  const runLogs = useCronStore((s) => s.runLogs);
  const setRunLogs = useCronStore((s) => s.setRunLogs);

  const refresh = useCallback(async () => {
    if (gwStatus !== "connected") return;
    setLoading(true);
    try {
      const res = (await request("cron.list", { includeDisabled: true })) as {
        jobs?: CronJob[];
      };
      if (res?.jobs) setJobs(res.jobs);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load cron jobs");
    } finally {
      setLoading(false);
    }
  }, [gwStatus, request, setJobs, setLoading, setError]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const loadRuns = useCallback(
    async (id: string) => {
      try {
        const res = (await request("cron.runs", { id, limit: 10 })) as { runs?: CronRunEntry[] };
        setRunLogs(
          id,
          (res?.runs ?? []).toSorted((a, b) => b.ts - a.ts),
        );
      } catch {
        setRunLogs(id, []);
      }
    },
    [request, setRunLogs],
  );

  // The gateway reports every finished run: keep the cards current without a
  // manual refresh, including a job that was just turned off for failing.
  const onCronEvent = useCallback(
    (payload: unknown) => {
      const event = payload as { job?: CronJob | null; run?: CronRunEntry } | null;
      if (event?.job?.id) {
        updateJob(event.job.id, event.job);
        if (useCronStore.getState().runLogs[event.job.id]) void loadRuns(event.job.id);
      } else if (event?.run?.jobId) {
        // The run removed its job (a one-shot that succeeded).
        removeJob(event.run.jobId);
      }
    },
    [updateJob, removeJob, loadRuns],
  );
  useGatewayEvent("cron", onCronEvent);

  const handleToggle = useCallback(
    async (id: string, enabled: boolean) => {
      try {
        await request("cron.update", { id, patch: { enabled } });
        updateJob(id, { enabled });
      } catch (err) {
        toast.error("Toggle failed", {
          description: describeError(err),
        });
      }
    },
    [request, updateJob],
  );

  const handleRun = useCallback(
    async (id: string) => {
      try {
        await request("cron.run", { id, mode: "force" });
        refresh();
      } catch (err) {
        toast.error("Run failed", {
          description: describeError(err),
        });
      }
    },
    [request, refresh],
  );

  const handleRemove = useCallback(
    async (id: string, label: string) => {
      if (
        !(await confirmDialog({
          title: `Remove cron job "${label}"?`,
          actionLabel: "Remove",
          destructive: true,
        }))
      )
        return;
      try {
        await request("cron.remove", { id });
        removeJob(id);
      } catch (err) {
        toast.error("Remove failed", {
          description: describeError(err),
        });
      }
    },
    [request, removeJob, confirmDialog],
  );

  const handleAdd = useCallback(
    async (params: Record<string, unknown>) => {
      try {
        const res = (await request("cron.add", params)) as CronJob;
        addJob(res);
      } catch (err) {
        toast.error("Add failed", {
          description: describeError(err),
        });
      }
    },
    [request, addJob],
  );

  return (
    <div className="h-full overflow-y-auto p-6 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Automations</h1>
          <p className="text-sm text-muted-foreground mt-1">
            What your agent does without being asked: scheduled jobs, monitors and longer tasks.
          </p>
        </div>
        <button
          onClick={refresh}
          disabled={loading}
          className={cn(
            "px-3 py-1.5 text-xs rounded-lg",
            "bg-brand/10 text-brand hover:bg-brand/30",
            "border border-brand/20 transition-colors",
            loading && "opacity-50",
          )}
        >
          {loading ? "Loading…" : "Refresh"}
        </button>
      </div>

      <div>
        <h2 className="text-lg font-semibold text-foreground">Scheduled jobs</h2>
        <p className="text-xs text-muted-foreground mt-0.5">
          {jobs.length} job{jobs.length !== 1 ? "s" : ""}. Things that happen at a set time.
        </p>
      </div>
      <AddCronForm onAdd={handleAdd} />

      <div className="space-y-3">
        {jobs.length === 0 && !loading ? (
          <div className="p-8 text-center text-muted-foreground text-sm rounded-xl border border-border/20 bg-card/60 backdrop-blur-sm">
            No scheduled jobs yet
          </div>
        ) : (
          jobs.map((job) => (
            <CronJobCard
              key={job.id}
              job={job}
              onToggle={handleToggle}
              onRun={handleRun}
              onRemove={handleRemove}
              onLoadRuns={loadRuns}
              runs={runLogs[job.id]}
            />
          ))
        )}
      </div>
      <MonitorsSection />
      <TasksSection />
      {confirmElement}
    </div>
  );
}
