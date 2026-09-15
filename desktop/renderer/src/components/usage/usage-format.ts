import type { PricingSource, UsageKind } from "../../stores/usage-store";

export function formatPct(ratio: number, digits = 0): string {
  if (!Number.isFinite(ratio)) return "0%";
  return `${(ratio * 100).toFixed(digits)}%`;
}

/** Costs under a cent get four decimals so embeddings do not all read "$0.00". */
export function formatUsdSmart(cost: number): string {
  if (!Number.isFinite(cost) || cost === 0) return "$0.00";
  if (cost < 0.0001) return "<$0.0001";
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  if (cost < 1) return `$${cost.toFixed(3)}`;
  return `$${cost.toFixed(2)}`;
}

export function pricingSourceLabel(source: PricingSource): string {
  switch (source) {
    case "provider":
      return "reported";
    case "override":
      return "your price";
    case "catalog":
      return "catalog";
    case "embedding-catalog":
      return "catalog";
    case "local":
      return "local (free)";
    case "estimated":
      return "≈ estimated";
    case "unpriced":
      return "unpriced";
    default:
      return source;
  }
}

/** Tone classes use only the sanctioned status hues (PLAN-41 D-G). */
export function pricingSourceTone(source: PricingSource): string {
  switch (source) {
    case "unpriced":
      return "bg-danger/10 text-danger border-danger/20";
    case "estimated":
      return "bg-warning/10 text-warning border-warning/20";
    case "local":
      return "bg-muted/40 text-muted-foreground border-border/20";
    default:
      return "bg-success/10 text-success border-success/20";
  }
}

export function kindLabel(kind: UsageKind): string {
  switch (kind) {
    case "chat":
      return "chat";
    case "embedding":
      return "embeddings";
    case "vision":
      return "vision";
    case "audio":
      return "audio";
    case "tts":
      return "tts";
    case "search":
      return "search";
    default:
      return kind;
  }
}

/** Series colours for stacked charts: the five `--chart-*` tokens, then a muted fallback. */
export const CHART_FILL_CLASSES = [
  "fill-chart-1",
  "fill-chart-2",
  "fill-chart-3",
  "fill-chart-4",
  "fill-chart-5",
  "fill-muted-foreground/40",
] as const;

export const CHART_BG_CLASSES = [
  "bg-chart-1",
  "bg-chart-2",
  "bg-chart-3",
  "bg-chart-4",
  "bg-chart-5",
  "bg-muted-foreground/40",
] as const;

export function budgetTone(level: number, exceeded: boolean): string {
  if (exceeded) return "bg-danger";
  if (level >= 80) return "bg-warning";
  return "bg-success";
}

export function formatResetIn(resetsAtMs: number, now = Date.now()): string {
  const diff = Math.max(0, resetsAtMs - now);
  const hours = Math.floor(diff / 3_600_000);
  if (hours >= 48) return `resets in ${Math.round(hours / 24)}d`;
  if (hours >= 1) return `resets in ${hours}h`;
  return `resets in ${Math.max(1, Math.round(diff / 60_000))}m`;
}
