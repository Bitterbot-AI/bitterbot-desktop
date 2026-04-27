/**
 * Two side-by-side breakdown panels for the P2P dashboard:
 *   - by_tier: edge / management / unknown / etc
 *   - by_address_type: ipv4_public / ipv4_private / dns / relay / ipv6
 *
 * Data source priority: networkCensus.snapshot (gossipsub-pushed, fresh)
 * → bootstrapCensus (HTTP-polled, only when this node is itself a bootnode)
 * → null (renders an empty hint).
 */

type Distribution = Record<string, number>;

type CensusBreakdownProps = {
  byTier: Distribution | null;
  byAddressType: Distribution | null;
  source: string | null;
  generatedAt: number | null;
};

export function CensusBreakdown({
  byTier,
  byAddressType,
  source,
  generatedAt,
}: CensusBreakdownProps) {
  const hasTier = byTier && Object.keys(byTier).length > 0;
  const hasAddr = byAddressType && Object.keys(byAddressType).length > 0;

  if (!hasTier && !hasAddr) {
    return (
      <div className="rounded-xl border border-border/20 bg-card/60 backdrop-blur-sm p-4 text-sm text-muted-foreground">
        <h3 className="text-sm font-medium text-foreground mb-1">Network Census</h3>
        <p className="text-xs text-muted-foreground/80">
          No bootnode census received yet. Subscribe a bootnode running with
          <code className="mx-1 px-1 rounded bg-muted/50 text-[11px]">--bootnode-mode</code>
          and snapshots will arrive over{" "}
          <span className="font-mono text-[11px]">bitterbot/census/v1</span>.
        </p>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      {hasTier && byTier ? (
        <DistributionPanel
          title="By node tier"
          rows={byTier}
          color="text-purple-400"
          source={source}
          generatedAt={generatedAt}
        />
      ) : null}
      {hasAddr && byAddressType ? (
        <DistributionPanel
          title="By address type"
          rows={byAddressType}
          color="text-cyan-400"
          source={source}
          generatedAt={generatedAt}
        />
      ) : null}
    </div>
  );
}

function DistributionPanel({
  title,
  rows,
  color,
  source,
  generatedAt,
}: {
  title: string;
  rows: Distribution;
  color: string;
  source: string | null;
  generatedAt: number | null;
}) {
  const entries = Object.entries(rows).toSorted((a, b) => b[1] - a[1]);
  const total = entries.reduce((sum, [, v]) => sum + v, 0);
  return (
    <div className="rounded-xl border border-border/20 bg-card/60 backdrop-blur-sm p-4">
      <div className="flex items-baseline justify-between mb-3">
        <h3 className="text-sm font-medium text-foreground">{title}</h3>
        <span className="text-xs text-muted-foreground/60">{total} total</span>
      </div>
      <ul className="space-y-2">
        {entries.map(([label, count]) => {
          const pct = total > 0 ? (count / total) * 100 : 0;
          return (
            <li key={label}>
              <div className="flex items-baseline justify-between text-xs">
                <span className="text-muted-foreground capitalize">{label.replace(/_/g, " ")}</span>
                <span className={color}>
                  {count} <span className="text-muted-foreground/60">({pct.toFixed(0)}%)</span>
                </span>
              </div>
              <div className="mt-1 h-1.5 rounded-full bg-muted/40 overflow-hidden">
                <div
                  className={`h-full rounded-full bg-current ${color}`}
                  style={{ width: `${pct.toFixed(2)}%` }}
                />
              </div>
            </li>
          );
        })}
      </ul>
      {(source || generatedAt) && (
        <div className="mt-3 pt-2 border-t border-border/20 flex items-center justify-between text-[10px] text-muted-foreground/60">
          {source ? (
            <span className="font-mono truncate max-w-[180px]" title={source}>
              {abbreviate(source)}
            </span>
          ) : (
            <span />
          )}
          {generatedAt ? <span>{relativeTime(generatedAt)}</span> : null}
        </div>
      )}
    </div>
  );
}

function abbreviate(peerId: string): string {
  if (peerId.length <= 16) {
    return peerId;
  }
  return `${peerId.slice(0, 8)}…${peerId.slice(-6)}`;
}

function relativeTime(epochSecs: number): string {
  const ms = epochSecs > 1e12 ? epochSecs : epochSecs * 1000;
  const delta = Math.max(0, Date.now() - ms);
  if (delta < 60_000) {
    return `${Math.floor(delta / 1000)}s ago`;
  }
  if (delta < 3600_000) {
    return `${Math.floor(delta / 60_000)}m ago`;
  }
  if (delta < 24 * 3600_000) {
    return `${Math.floor(delta / 3600_000)}h ago`;
  }
  return `${Math.floor(delta / (24 * 3600_000))}d ago`;
}
