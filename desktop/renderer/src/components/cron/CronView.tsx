import { useCallback, useEffect, useState } from "react";
import { useGatewayStore } from "../../stores/gateway-store";
import { useCronStore, type CronJob } from "../../stores/cron-store";
import { formatRelativeTime, formatDateTime } from "../../lib/format";
import { cn } from "../../lib/utils";

function CronJobCard({
  job,
  onToggle,
  onRun,
  onRemove,
}: {
  job: CronJob;
  onToggle: (id: string, enabled: boolean) => void;
  onRun: (id: string) => void;
  onRemove: (id: string) => void;
}) {
  return (
    <div className="rounded-xl border border-border/20 bg-card/60 backdrop-blur-sm p-4">
      <div className="flex items-start gap-3">
        <button
          onClick={() => onToggle(job.id, !job.enabled)}
          className={cn(
            "mt-0.5 w-9 h-5 rounded-full transition-colors relative flex-shrink-0",
            job.enabled ? "bg-purple-500" : "bg-muted",
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
            <span className="text-xs font-mono text-muted-foreground/60">
              {job.schedule}
            </span>
          </div>
          <p className="text-xs text-muted-foreground line-clamp-2">
            {job.text}
          </p>
          <div className="flex items-center gap-4 mt-2 text-xs text-muted-foreground/60">
            {job.lastRunAt && (
              <span>Last: {formatRelativeTime(job.lastRunAt)}</span>
            )}
            {job.nextRunAt && (
              <span>Next: {formatDateTime(job.nextRunAt)}</span>
            )}
            {job.sessionKey && (
              <span className="font-mono">{job.sessionKey}</span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => onRun(job.id)}
            className="px-2 py-1 text-xs rounded bg-purple-500/10 text-purple-300 hover:bg-purple-500/20 border border-purple-500/20"
          >
            Run
          </button>
          <button
            onClick={() => {
              if (confirm(`Remove cron job "${job.label ?? job.id}"?`))
                onRemove(job.id);
            }}
            className="px-2 py-1 text-xs rounded bg-red-500/10 text-red-400 hover:bg-red-500/20 border border-red-500/20"
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

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
    onAdd({
      label: label.trim() || undefined,
      schedule,
      text: text.trim(),
    });
    setLabel("");
    setText("");
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="rounded-xl border border-border/20 bg-card/60 backdrop-blur-sm p-4 space-y-3"
    >
      <h3 className="text-sm font-medium text-foreground">Add Cron Job</h3>
      <div className="grid grid-cols-2 gap-3">
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Label (optional)"
          className={cn(
            "h-8 px-3 text-sm rounded-lg border bg-transparent",
            "border-border/30 focus:border-purple-500 focus:outline-none",
          )}
        />
        <input
          value={schedule}
          onChange={(e) => setSchedule(e.target.value)}
          placeholder="Cron schedule"
          className={cn(
            "h-8 px-3 text-sm font-mono rounded-lg border bg-transparent",
            "border-border/30 focus:border-purple-500 focus:outline-none",
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
          "border-border/30 focus:border-purple-500 focus:outline-none",
        )}
      />
      <button
        type="submit"
        disabled={!text.trim()}
        className={cn(
          "px-4 py-1.5 text-xs rounded-lg font-medium",
          "bg-purple-500 text-white hover:bg-purple-600",
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

  const handleToggle = useCallback(
    async (id: string, enabled: boolean) => {
      try {
        await request("cron.update", { id, patch: { enabled } });
        updateJob(id, { enabled });
      } catch (err) {
        alert(`Toggle failed: ${err instanceof Error ? err.message : "Unknown error"}`);
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
        alert(`Run failed: ${err instanceof Error ? err.message : "Unknown error"}`);
      }
    },
    [request, refresh],
  );

  const handleRemove = useCallback(
    async (id: string) => {
      try {
        await request("cron.remove", { id });
        removeJob(id);
      } catch (err) {
        alert(`Remove failed: ${err instanceof Error ? err.message : "Unknown error"}`);
      }
    },
    [request, removeJob],
  );

  const handleAdd = useCallback(
    async (params: Record<string, unknown>) => {
      try {
        const res = (await request("cron.add", params)) as CronJob;
        addJob(res);
      } catch (err) {
        alert(`Add failed: ${err instanceof Error ? err.message : "Unknown error"}`);
      }
    },
    [request, addJob],
  );

  return (
    <div className="h-full overflow-y-auto p-6 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Cron</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {jobs.length} scheduled job{jobs.length !== 1 ? "s" : ""}
          </p>
        </div>
        <button
          onClick={refresh}
          disabled={loading}
          className={cn(
            "px-3 py-1.5 text-xs rounded-lg",
            "bg-purple-500/10 text-purple-300 hover:bg-purple-500/20",
            "border border-purple-500/20 transition-colors",
            loading && "opacity-50",
          )}
        >
          {loading ? "Loading…" : "Refresh"}
        </button>
      </div>

      <AddCronForm onAdd={handleAdd} />

      <div className="space-y-3">
        {jobs.length === 0 && !loading ? (
          <div className="p-8 text-center text-muted-foreground text-sm rounded-xl border border-border/20 bg-card/60 backdrop-blur-sm">
            No cron jobs configured
          </div>
        ) : (
          jobs.map((job) => (
            <CronJobCard
              key={job.id}
              job={job}
              onToggle={handleToggle}
              onRun={handleRun}
              onRemove={handleRemove}
            />
          ))
        )}
      </div>
    </div>
  );
}
