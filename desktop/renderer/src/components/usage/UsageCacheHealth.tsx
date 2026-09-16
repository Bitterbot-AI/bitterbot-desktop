import type { UsageCacheHealth as CacheHealth } from "../../stores/usage-store";
import { formatRelativeTime } from "../../lib/format";
import { cn } from "../../lib/utils";
import { formatPct, formatUsdSmart } from "./usage-format";

/**
 * The Claude Code style prompt-cache line: hit rate, busts with their likely cause, warm/cold and
 * TTL, and what the busts cost. Only rendered when cache-capable providers were used.
 */
export function UsageCacheHealthLine({ health }: { health: CacheHealth }) {
  if (health.requests === 0) return null;
  const tone =
    health.hitRate >= 0.5
      ? "text-success"
      : health.hitRate < 0.3
        ? "text-warning"
        : "text-foreground";
  // Cold starts and prefix growth are expected; show the actionable causes first.
  const topReasons = health.reasons
    .filter((r) => !r.reason.startsWith("cold start") && !r.reason.startsWith("context grew"))
    .slice(0, 3);
  return (
    <div className="rounded-xl border border-border/20 bg-card/60 backdrop-blur-sm p-4 space-y-2">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h3 className="text-sm font-medium text-foreground">Prompt cache</h3>
        <span className="inline-flex items-center gap-1.5 text-2xs text-muted-foreground">
          <span
            className={cn(
              "inline-block w-1.5 h-1.5 rounded-full",
              health.warm ? "bg-success" : "bg-muted-foreground/40",
            )}
          />
          {health.warm ? "warm" : "cold"}
          {health.ttl && health.ttl !== "none" ? ` · ${health.ttl} TTL` : ""}
          {health.lastChatTs ? ` · last turn ${formatRelativeTime(health.lastChatTs)}` : ""}
        </span>
      </div>
      <p className="text-xs text-muted-foreground">
        {health.requests} requests ·{" "}
        <span className={tone}>{formatPct(health.hitRate)} of prompt tokens from cache</span>
        {" · "}
        {health.busts} bust{health.busts === 1 ? "" : "s"}
        {health.wastedUsd > 0 ? (
          <>
            {" costing "}
            <span className="text-warning">{formatUsdSmart(health.wastedUsd)}</span>
            {" in re-written cache"}
          </>
        ) : null}
      </p>
      {topReasons.length > 0 && (
        <ul className="text-2xs text-muted-foreground/80 space-y-0.5">
          {topReasons.map((r) => (
            <li key={r.reason}>
              {r.count}× {r.reason}
            </li>
          ))}
        </ul>
      )}
      {health.byModel.length > 1 && (
        <div className="text-2xs text-muted-foreground/60 flex flex-wrap gap-x-4">
          {health.byModel.map((m) => (
            <span key={`${m.provider}/${m.model}`}>
              {m.model}: {formatPct(m.hitRate)} · {m.busts} busts
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
