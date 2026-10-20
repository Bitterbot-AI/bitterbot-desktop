import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { useGatewayEvent } from "../../hooks/useGatewayEvent";
import { describeError } from "../../lib/describe-error";
import { formatRelativeTime } from "../../lib/format";
import { cn } from "../../lib/utils";
import { useGatewayStore } from "../../stores/gateway-store";

export type MonitorRow = {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  intervalMs: number;
  note?: string;
  condition: { kind: string; text?: string; value?: number };
  health: {
    lastCheckAt?: number;
    lastChangeAt?: number;
    lastFiredAt?: number;
    lastError?: string;
    consecutiveErrors: number;
    lastValue?: string;
  };
};

/** One line on how a monitor is doing. */
export function monitorHealth(m: MonitorRow): {
  tone: "ok" | "warn" | "bad" | "idle";
  text: string;
} {
  if (!m.enabled) return { tone: "idle", text: "Off" };
  if (m.health.consecutiveErrors >= 3) {
    return { tone: "bad", text: `Cannot be checked: ${m.health.lastError ?? "unknown error"}` };
  }
  if (m.health.lastError) return { tone: "warn", text: `Last check failed: ${m.health.lastError}` };
  if (m.health.lastCheckAt === undefined) return { tone: "idle", text: "Not checked yet" };
  return { tone: "ok", text: `Checked ${formatRelativeTime(m.health.lastCheckAt)}` };
}

export function describeCondition(c: MonitorRow["condition"]): string {
  switch (c.kind) {
    case "contains":
      return `when it contains "${c.text}"`;
    case "not-contains":
      return `when it no longer contains "${c.text}"`;
    case "above":
      return `when it goes above ${c.value}`;
    case "below":
      return `when it goes below ${c.value}`;
    default:
      return "when it changes";
  }
}

const TONE = {
  ok: "text-success",
  warn: "text-warning",
  bad: "text-danger",
  idle: "text-muted-foreground/60",
} as const;

/**
 * Monitors (PLAN-53 E5, E8): watches on a page or an API that wake the agent
 * only when something changes.
 */
export function MonitorsSection() {
  const status = useGatewayStore((s) => s.status);
  const request = useGatewayStore((s) => s.request);
  const [monitors, setMonitors] = useState<MonitorRow[]>([]);
  const [unavailable, setUnavailable] = useState(false);
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [contains, setContains] = useState("");

  const refresh = useCallback(async () => {
    if (status !== "connected") return;
    try {
      const res = (await request("monitors.list", {})) as { monitors?: MonitorRow[] };
      setMonitors(res?.monitors ?? []);
      setUnavailable(false);
    } catch {
      setUnavailable(true);
    }
  }, [status, request]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onEvent = useCallback((payload: unknown) => {
    const next = (payload as { monitor?: MonitorRow } | null)?.monitor;
    if (next?.id) setMonitors((list) => list.map((m) => (m.id === next.id ? next : m)));
  }, []);
  useGatewayEvent("monitor", onEvent);

  const run = async (label: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
      await refresh();
    } catch (err) {
      toast.error(label, { description: describeError(err) });
    }
  };

  const add = (e: React.FormEvent) => {
    e.preventDefault();
    if (!url.trim()) return;
    void run("Could not add the monitor", async () => {
      await request("monitors.add", {
        url: url.trim(),
        name: name.trim() || undefined,
        condition: contains.trim()
          ? { kind: "contains", text: contains.trim() }
          : { kind: "changed" },
      });
      setUrl("");
      setName("");
      setContains("");
    });
  };

  if (unavailable) return null;

  return (
    <section className="space-y-3" data-testid="monitors-section">
      <div>
        <h2 className="text-lg font-semibold text-foreground">Monitors</h2>
        <p className="text-xs text-muted-foreground mt-0.5">
          Watch a page or an API. Your agent is woken only when something changes; checking costs
          nothing until then.
        </p>
      </div>
      <form
        onSubmit={add}
        className="rounded-xl border border-border/20 bg-card/60 backdrop-blur-sm p-4 grid grid-cols-1 md:grid-cols-4 gap-3"
      >
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://… page or API to watch"
          aria-label="Address to watch"
          className="md:col-span-2 h-8 px-3 text-sm rounded-lg border border-border/30 bg-transparent focus:border-brand focus:outline-none"
        />
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Name (optional)"
          aria-label="Monitor name"
          className="h-8 px-3 text-sm rounded-lg border border-border/30 bg-transparent focus:border-brand focus:outline-none"
        />
        <input
          value={contains}
          onChange={(e) => setContains(e.target.value)}
          placeholder="Tell me when it says… (blank: any change)"
          aria-label="Text to wait for"
          className="h-8 px-3 text-sm rounded-lg border border-border/30 bg-transparent focus:border-brand focus:outline-none"
        />
        <button
          type="submit"
          disabled={!url.trim()}
          className="md:col-span-4 justify-self-start px-4 py-1.5 text-xs rounded-lg font-medium bg-brand text-white hover:bg-brand/90 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Add monitor
        </button>
      </form>
      {monitors.length === 0 ? (
        <div className="p-6 text-center text-muted-foreground text-sm rounded-xl border border-border/20 bg-card/60">
          No monitors yet. Add one above, or ask your agent to "tell me when this page changes".
        </div>
      ) : (
        monitors.map((m) => {
          const health = monitorHealth(m);
          return (
            <div
              key={m.id}
              className="rounded-xl border border-border/20 bg-card/60 backdrop-blur-sm p-4"
            >
              <div className="flex items-start gap-3">
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-foreground">{m.name}</div>
                  <div
                    className="text-xs font-mono text-muted-foreground/70 truncate"
                    title={m.url}
                  >
                    {m.url}
                  </div>
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-1 text-xs">
                    <span className={cn(TONE[health.tone], "break-words")}>{health.text}</span>
                    <span className="text-muted-foreground/60">
                      Tells you {describeCondition(m.condition)}, every{" "}
                      {Math.round(m.intervalMs / 60_000)} min
                    </span>
                    {m.health.lastChangeAt && (
                      <span className="text-muted-foreground/60">
                        Last change {formatRelativeTime(m.health.lastChangeAt)}
                      </span>
                    )}
                  </div>
                  {m.health.lastValue && (
                    <p className="text-xs text-muted-foreground mt-1 line-clamp-2 break-words">
                      Now: {m.health.lastValue}
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-1 flex-shrink-0">
                  <button
                    onClick={() =>
                      void run("Check failed", () => request("monitors.check", { id: m.id }))
                    }
                    className="px-2 py-1 text-xs rounded bg-brand/10 text-brand hover:bg-brand/30 border border-brand/20"
                  >
                    Check now
                  </button>
                  <button
                    onClick={() =>
                      void run("Update failed", () =>
                        request("monitors.update", { id: m.id, patch: { enabled: !m.enabled } }),
                      )
                    }
                    className="px-2 py-1 text-xs rounded border border-border/30 text-muted-foreground hover:text-foreground"
                  >
                    {m.enabled ? "Pause" : "Resume"}
                  </button>
                  <button
                    onClick={() =>
                      void run("Remove failed", () => request("monitors.remove", { id: m.id }))
                    }
                    className="px-2 py-1 text-xs rounded bg-danger/10 text-danger hover:bg-danger/30 border border-danger/20"
                  >
                    Remove
                  </button>
                </div>
              </div>
            </div>
          );
        })
      )}
    </section>
  );
}
