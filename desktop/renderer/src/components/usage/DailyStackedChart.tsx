import { useMemo, useState } from "react";
import type { UsageDailyPoint } from "../../stores/usage-store";
import { formatCost, formatTokens } from "../../lib/format";
import { cn } from "../../lib/utils";
import { CHART_BG_CLASSES, CHART_FILL_CLASSES } from "./usage-format";

const MAX_SERIES = 5;
const WIDTH = 720;
const HEIGHT = 160;
const PAD_BOTTOM = 18;

type Metric = "cost" | "tokens";

/**
 * Daily spend/tokens as stacked bars per model (top five by cost, rest grouped as "other").
 * Inline SVG in house style: no chart library, series colours from the `--chart-*` tokens.
 */
export function DailyStackedChart({ daily }: { daily: UsageDailyPoint[] }) {
  const [metric, setMetric] = useState<Metric>("cost");

  const { series, stacks, maxValue } = useMemo(() => {
    const totals = new Map<string, number>();
    for (const day of daily) {
      for (const m of day.byModel) {
        const key = `${m.provider ?? "?"}/${m.model ?? "?"}`;
        totals.set(key, (totals.get(key) ?? 0) + (metric === "cost" ? m.cost : m.tokens));
      }
    }
    const ranked = Array.from(totals.entries()).toSorted((a, b) => b[1] - a[1]);
    const top = ranked.slice(0, MAX_SERIES).map(([key]) => key);
    const hasOther = ranked.length > MAX_SERIES;
    const series = hasOther ? [...top, "other"] : top;
    const stacks = daily.map((day) => {
      const values = new Map<string, number>();
      for (const m of day.byModel) {
        const key = `${m.provider ?? "?"}/${m.model ?? "?"}`;
        const bucket = top.includes(key) ? key : "other";
        values.set(bucket, (values.get(bucket) ?? 0) + (metric === "cost" ? m.cost : m.tokens));
      }
      const total = Array.from(values.values()).reduce((s, v) => s + v, 0);
      return { date: day.date, values, total, calls: day.calls };
    });
    const maxValue = Math.max(1e-9, ...stacks.map((s) => s.total));
    return { series, stacks, maxValue };
  }, [daily, metric]);

  if (daily.length === 0) {
    return null;
  }

  const slot = WIDTH / Math.max(1, stacks.length);
  const barWidth = Math.max(2, slot * 0.7);
  const plotHeight = HEIGHT - PAD_BOTTOM;
  const labelEvery = stacks.length > 31 ? 7 : stacks.length > 14 ? 3 : 1;
  const format = metric === "cost" ? formatCost : formatTokens;

  return (
    <div className="rounded-xl border border-border/20 bg-card/60 backdrop-blur-sm p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-medium text-foreground">
          Daily {metric === "cost" ? "spend" : "tokens"} by model
        </h3>
        <div className="flex rounded-lg overflow-hidden border border-border/20">
          {(["cost", "tokens"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMetric(m)}
              className={cn(
                "px-2 py-0.5 text-2xs transition-colors",
                metric === m ? "bg-brand/20 text-brand" : "text-muted-foreground hover:bg-muted/40",
              )}
            >
              {m}
            </button>
          ))}
        </div>
      </div>
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="w-full h-auto"
        role="img"
        aria-label={`Daily ${metric} by model`}
      >
        {stacks.map((stack, i) => {
          const x = i * slot + (slot - barWidth) / 2;
          let cursor = plotHeight;
          return (
            <g key={stack.date}>
              <title>
                {`${stack.date}: ${format(stack.total)} · ${stack.calls} calls\n` +
                  series
                    .filter((s) => (stack.values.get(s) ?? 0) > 0)
                    .map((s) => `${s}: ${format(stack.values.get(s) ?? 0)}`)
                    .join("\n")}
              </title>
              {series.map((s, si) => {
                const value = stack.values.get(s) ?? 0;
                if (value <= 0) return null;
                const h = (value / maxValue) * plotHeight;
                cursor -= h;
                return (
                  <rect
                    key={s}
                    x={x}
                    y={cursor}
                    width={barWidth}
                    height={h}
                    className={cn(
                      CHART_FILL_CLASSES[si] ?? CHART_FILL_CLASSES[5],
                      "opacity-80 hover:opacity-100 transition-opacity",
                    )}
                  />
                );
              })}
              {stack.total <= 0 && (
                <rect
                  x={x}
                  y={plotHeight - 1}
                  width={barWidth}
                  height={1}
                  className="fill-muted-foreground/20"
                />
              )}
              {i % labelEvery === 0 && (
                <text
                  x={x + barWidth / 2}
                  y={HEIGHT - 4}
                  textAnchor="middle"
                  className="fill-muted-foreground/60"
                  style={{ fontSize: 10 }}
                >
                  {stack.date.slice(5)}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2">
        {series.map((s, si) => (
          <span key={s} className="inline-flex items-center gap-1.5 text-2xs text-muted-foreground">
            <span
              className={cn(
                "inline-block w-2.5 h-2.5 rounded-sm",
                CHART_BG_CLASSES[si] ?? CHART_BG_CLASSES[5],
              )}
            />
            {s}
          </span>
        ))}
      </div>
    </div>
  );
}
