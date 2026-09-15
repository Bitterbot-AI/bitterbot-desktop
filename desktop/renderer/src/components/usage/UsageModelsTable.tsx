import { ArrowDown, ArrowUp } from "lucide-react";
import { useMemo, useState } from "react";
import type { UsageModelSummary } from "../../stores/usage-store";
import { formatRelativeTime, formatTokens } from "../../lib/format";
import { cn } from "../../lib/utils";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";
import {
  formatPct,
  formatUsdSmart,
  kindLabel,
  pricingSourceLabel,
  pricingSourceTone,
} from "./usage-format";

type SortKey =
  | "cost"
  | "tokens"
  | "calls"
  | "input"
  | "cacheRead"
  | "cacheWrite"
  | "output"
  | "cacheHitRate";

const COLUMNS: Array<{ key: SortKey; label: string; title: string }> = [
  { key: "calls", label: "Calls", title: "Model calls in the window" },
  { key: "input", label: "Input", title: "Uncached input tokens" },
  { key: "cacheRead", label: "Cache read", title: "Prompt tokens served from the provider cache" },
  { key: "cacheWrite", label: "Cache write", title: "Prompt tokens written to the provider cache" },
  { key: "output", label: "Output", title: "Output tokens (reasoning included)" },
  { key: "tokens", label: "Total", title: "All tokens" },
  {
    key: "cacheHitRate",
    label: "Cache %",
    title: "cache read ÷ (input + cache read + cache write)",
  },
  { key: "cost", label: "Cost", title: "USD, priced per bucket" },
];

function valueOf(m: UsageModelSummary, key: SortKey): number {
  switch (key) {
    case "cost":
      return m.cost.total;
    case "tokens":
      return m.usage.total;
    case "calls":
      return m.calls;
    case "input":
      return m.usage.input;
    case "cacheRead":
      return m.usage.cacheRead;
    case "cacheWrite":
      return m.usage.cacheWrite;
    case "output":
      return m.usage.output;
    case "cacheHitRate":
      return m.cacheHitRate;
  }
}

export function UsageModelsTable({ models }: { models: UsageModelSummary[] }) {
  const [sortKey, setSortKey] = useState<SortKey>("cost");
  const [desc, setDesc] = useState(true);
  const hasReasoning = models.some((m) => m.usage.reasoning > 0);

  const sorted = useMemo(
    () =>
      [...models].toSorted((a, b) =>
        desc
          ? valueOf(b, sortKey) - valueOf(a, sortKey)
          : valueOf(a, sortKey) - valueOf(b, sortKey),
      ),
    [models, sortKey, desc],
  );

  const toggle = (key: SortKey) => {
    if (key === sortKey) {
      setDesc((d) => !d);
    } else {
      setSortKey(key);
      setDesc(true);
    }
  };

  if (models.length === 0) {
    return <p className="text-xs text-muted-foreground">No model calls in this window.</p>;
  }

  return (
    <div className="rounded-xl border border-border/20 bg-card/60 backdrop-blur-sm overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="text-2xs">Model</TableHead>
            <TableHead className="text-2xs">Type</TableHead>
            {COLUMNS.map((c) => (
              <TableHead key={c.key} className="text-2xs text-right">
                <button
                  type="button"
                  title={c.title}
                  onClick={() => toggle(c.key)}
                  className={cn(
                    "inline-flex items-center gap-1 hover:text-foreground",
                    sortKey === c.key && "text-foreground",
                  )}
                >
                  {c.label}
                  {sortKey === c.key &&
                    (desc ? <ArrowDown className="w-3 h-3" /> : <ArrowUp className="w-3 h-3" />)}
                </button>
              </TableHead>
            ))}
            {hasReasoning && (
              <TableHead
                className="text-2xs text-right"
                title="Reasoning tokens (subset of output)"
              >
                Reasoning
              </TableHead>
            )}
            <TableHead className="text-2xs">Pricing</TableHead>
            <TableHead className="text-2xs">Last</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {sorted.map((m) => {
            const key = `${m.provider ?? "?"}/${m.model ?? "?"}`;
            const worstSource = m.pricingSources.includes("unpriced")
              ? "unpriced"
              : m.pricingSources.includes("estimated")
                ? "estimated"
                : m.pricingSources.includes("local")
                  ? "local"
                  : (m.pricingSources[0] ?? "catalog");
            return (
              <TableRow key={key} className="text-xs">
                <TableCell>
                  <div className="text-foreground truncate max-w-[260px]" title={key}>
                    {m.model ?? "unknown"}
                  </div>
                  <div className="text-2xs text-muted-foreground/60">{m.provider ?? ""}</div>
                </TableCell>
                <TableCell>
                  <div className="flex flex-wrap gap-1">
                    {m.kinds.map((k) => (
                      <span
                        key={k}
                        className="rounded border border-border/20 bg-muted/30 px-1.5 text-2xs text-muted-foreground"
                      >
                        {kindLabel(k)}
                      </span>
                    ))}
                  </div>
                </TableCell>
                <TableCell className="text-right tabular-nums">{m.calls}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatTokens(m.usage.input)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatTokens(m.usage.cacheRead)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatTokens(m.usage.cacheWrite)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatTokens(m.usage.output)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatTokens(m.usage.total)}
                </TableCell>
                <TableCell
                  className={cn(
                    "text-right tabular-nums",
                    m.cacheHitRate >= 0.5 ? "text-success" : undefined,
                  )}
                >
                  {m.kinds.includes("chat") ? formatPct(m.cacheHitRate) : "—"}
                </TableCell>
                <TableCell className="text-right tabular-nums text-brand font-medium">
                  {formatUsdSmart(m.cost.total)}
                </TableCell>
                {hasReasoning && (
                  <TableCell className="text-right tabular-nums">
                    {formatTokens(m.usage.reasoning)}
                  </TableCell>
                )}
                <TableCell>
                  <span
                    className={cn("rounded border px-1.5 text-2xs", pricingSourceTone(worstSource))}
                  >
                    {pricingSourceLabel(worstSource)}
                  </span>
                </TableCell>
                <TableCell className="text-2xs text-muted-foreground whitespace-nowrap">
                  {m.lastTs ? formatRelativeTime(m.lastTs) : ""}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
