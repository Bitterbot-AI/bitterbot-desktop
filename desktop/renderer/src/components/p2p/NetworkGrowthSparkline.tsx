/**
 * Inline SVG sparkline showing lifetime_unique_peers over time.
 *
 * Reads from skills.networkHistory rows (persisted gossipsub-received
 * snapshots in the network_census_history SQLite table). Survives gateway
 * restarts because the data is on disk; the chart fills in once enough
 * snapshots have been received.
 */

import type { P2pCensusHistoryRow } from "../../stores/p2p-store";

type SparklineProps = {
  rows: P2pCensusHistoryRow[];
  width?: number;
  height?: number;
};

const PADDING = 6;

export function NetworkGrowthSparkline({ rows, width = 360, height = 80 }: SparklineProps) {
  if (rows.length === 0) {
    return (
      <div className="rounded-xl border border-border/20 bg-card/60 backdrop-blur-sm p-4 text-sm">
        <h3 className="text-sm font-medium text-foreground mb-1">Network Growth</h3>
        <p className="text-xs text-muted-foreground/80">
          Snapshot history will populate as bootnodes broadcast over
          <span className="font-mono text-[11px] mx-1">bitterbot/census/v1</span>
          (every 60s when a bootnode is in{" "}
          <code className="px-1 rounded bg-muted/50 text-[11px]">--bootnode-mode</code>).
        </p>
      </div>
    );
  }

  // De-dupe by generated_at across sources: keep the freshest count per
  // bucket so multi-bootnode networks render one unified line.
  const buckets = new Map<number, number>();
  for (const row of rows) {
    const existing = buckets.get(row.generatedAt) ?? 0;
    buckets.set(row.generatedAt, Math.max(existing, row.lifetimeUniquePeers));
  }
  const points = [...buckets.entries()].toSorted((a, b) => a[0] - b[0]).map(([t, v]) => ({ t, v }));

  const minT = points[0]?.t ?? 0;
  const maxT = points[points.length - 1]?.t ?? 0;
  const tSpan = Math.max(1, maxT - minT);
  const minV = Math.min(...points.map((p) => p.v));
  const maxV = Math.max(...points.map((p) => p.v));
  const vSpan = Math.max(1, maxV - minV);

  const innerW = width - PADDING * 2;
  const innerH = height - PADDING * 2;

  const path = points
    .map((p, i) => {
      const x = PADDING + ((p.t - minT) / tSpan) * innerW;
      // Invert Y so larger values render higher.
      const y = PADDING + innerH - ((p.v - minV) / vSpan) * innerH;
      return `${i === 0 ? "M" : "L"} ${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(" ");

  const lastPoint = points[points.length - 1];
  const lastX = PADDING + ((lastPoint.t - minT) / tSpan) * innerW;
  const lastY = PADDING + innerH - ((lastPoint.v - minV) / vSpan) * innerH;

  const firstSnapshot = new Date(points[0].generatedAt * 1000);
  const lastSnapshot = new Date(lastPoint.t * 1000);

  return (
    <div className="rounded-xl border border-border/20 bg-card/60 backdrop-blur-sm p-4">
      <div className="flex items-baseline justify-between mb-2">
        <h3 className="text-sm font-medium text-foreground">Network Growth</h3>
        <span className="text-xs text-muted-foreground/60">
          {points.length} snapshot{points.length === 1 ? "" : "s"}
        </span>
      </div>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="w-full h-auto text-purple-400"
        preserveAspectRatio="none"
      >
        <path d={path} fill="none" stroke="currentColor" strokeWidth="1.5" />
        <circle cx={lastX} cy={lastY} r="2.5" fill="currentColor" />
      </svg>
      <div className="mt-2 flex items-baseline justify-between text-xs">
        <span className="text-muted-foreground/60">
          {minV.toLocaleString()} → {maxV.toLocaleString()} peers
        </span>
        <span className="text-purple-300 font-medium">{lastPoint.v.toLocaleString()}</span>
      </div>
      <div className="mt-1 flex items-baseline justify-between text-[10px] text-muted-foreground/60">
        <span>{firstSnapshot.toLocaleString()}</span>
        <span>{lastSnapshot.toLocaleString()}</span>
      </div>
    </div>
  );
}
