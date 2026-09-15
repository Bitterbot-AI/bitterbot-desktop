/**
 * PLAN-50: plain-text rendering of a usage-ledger summary for the CLI and chat commands.
 */

import type {
  UsageGroupSummary,
  UsageLedgerSummary,
  UsageModelSummary,
  UsageTotalsRow,
} from "./usage-ledger.types.js";
import {
  formatTokenCount as formatTokenCountRaw,
  formatUsd as formatUsdRaw,
} from "../utils/usage-format.js";

const formatTokenCount = (n: number): string => formatTokenCountRaw(n) ?? String(n);
const formatUsd = (n: number): string => formatUsdRaw(n) ?? `$${n.toFixed(2)}`;

export type UsageRenderDimension = "model" | "feature" | "provider" | "kind" | "agent" | "day";

function pct(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

function pad(value: string, width: number, align: "left" | "right" = "left"): string {
  if (value.length >= width) {
    return value;
  }
  return align === "left" ? value.padEnd(width) : value.padStart(width);
}

function totalsCells(t: UsageTotalsRow): string[] {
  return [
    String(t.calls),
    formatTokenCount(t.usage.input),
    formatTokenCount(t.usage.cacheRead),
    formatTokenCount(t.usage.cacheWrite),
    formatTokenCount(t.usage.output),
    formatTokenCount(t.usage.total),
    formatUsd(t.cost.total),
    pct(t.cacheHitRate),
  ];
}

const HEADERS = ["calls", "input", "cache r", "cache w", "output", "tokens", "cost", "cache%"];

function renderTable(label: string, rows: Array<[string, string[]]>): string[] {
  if (rows.length === 0) {
    return [`${label}: (none)`];
  }
  const nameWidth = Math.max(label.length, ...rows.map(([name]) => name.length));
  const widths = HEADERS.map((h, i) =>
    Math.max(h.length, ...rows.map(([, cells]) => cells[i]?.length ?? 0)),
  );
  const header = [
    pad(label, nameWidth),
    ...HEADERS.map((h, i) => pad(h, widths[i]!, "right")),
  ].join("  ");
  const lines = [header, "-".repeat(header.length)];
  for (const [name, cells] of rows) {
    lines.push(
      [pad(name, nameWidth), ...cells.map((c, i) => pad(c, widths[i]!, "right"))].join("  "),
    );
  }
  return lines;
}

export function renderUsageLedgerSummary(
  summary: UsageLedgerSummary,
  by: UsageRenderDimension = "model",
): string[] {
  const lines: string[] = [];
  lines.push(`Usage ledger — ${summary.startDate} → ${summary.endDate} (${summary.days}d)`);
  const t = summary.totals;
  lines.push(
    `Total ${formatUsd(t.cost.total)} · ${formatTokenCount(t.usage.total)} tokens · ${t.calls} calls · cache hit ${pct(t.cacheHitRate)}` +
      (t.unpricedCalls > 0 ? ` · ${t.unpricedCalls} unpriced` : "") +
      (t.estimatedCalls > 0 ? ` · ${t.estimatedCalls} estimated` : ""),
  );
  lines.push("");

  const groupRows = (groups: UsageGroupSummary[]): Array<[string, string[]]> =>
    groups.map((g) => [g.label, totalsCells(g)]);
  const modelRows = (models: UsageModelSummary[]): Array<[string, string[]]> =>
    models.map((m) => [
      `${m.provider ?? "?"}/${m.model ?? "?"}${m.pricingSources.includes("unpriced") ? " (unpriced)" : ""}`,
      totalsCells(m),
    ]);

  switch (by) {
    case "feature":
      lines.push(...renderTable("feature", groupRows(summary.byFeature)));
      break;
    case "provider":
      lines.push(...renderTable("provider", groupRows(summary.byProvider)));
      break;
    case "kind":
      lines.push(...renderTable("kind", groupRows(summary.byKind)));
      break;
    case "agent":
      lines.push(...renderTable("agent", groupRows(summary.byAgent)));
      break;
    case "day":
      lines.push(
        ...renderTable(
          "day",
          summary.daily.map((d) => [
            d.date,
            [
              String(d.calls),
              formatTokenCount(d.usage.input),
              formatTokenCount(d.usage.cacheRead),
              formatTokenCount(d.usage.cacheWrite),
              formatTokenCount(d.usage.output),
              formatTokenCount(d.tokens),
              formatUsd(d.cost),
              pct(
                d.usage.input + d.usage.cacheRead + d.usage.cacheWrite > 0
                  ? d.usage.cacheRead / (d.usage.input + d.usage.cacheRead + d.usage.cacheWrite)
                  : 0,
              ),
            ],
          ]),
        ),
      );
      break;
    default:
      lines.push(...renderTable("model", modelRows(summary.byModel)));
  }

  if (summary.budgets.budgets.length > 0) {
    lines.push("");
    lines.push(`Budgets (${summary.budgets.mode})`);
    for (const b of summary.budgets.budgets) {
      lines.push(
        `  ${b.id}: ${formatUsd(b.spentUsd)} / ${formatUsd(b.limitUsd)} (${pct(b.ratio)}) resets ${new Date(b.resetsAtMs).toISOString().slice(0, 10)}${b.exceeded ? " EXCEEDED" : ""}`,
      );
    }
  }
  if (summary.flags.length > 0) {
    lines.push("");
    for (const f of summary.flags) {
      lines.push(`${f.level === "warn" ? "!" : "i"} ${f.message}${f.tip ? ` — ${f.tip}` : ""}`);
    }
  }
  return lines;
}
