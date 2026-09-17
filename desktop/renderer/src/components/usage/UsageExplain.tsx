import { useCallback, useState } from "react";
import { cn } from "../../lib/utils";
import { useGatewayStore } from "../../stores/gateway-store";
import { useUsageStore, type UsageExplanation } from "../../stores/usage-store";

/** "Why does usage look like this?" Plain-language drivers vs the window before. */
export function UsageExplain() {
  const request = useGatewayStore((s) => s.request);
  const days = useUsageStore((s) => s.days);
  const [result, setResult] = useState<UsageExplanation | null>(null);
  const [loading, setLoading] = useState(false);
  const run = useCallback(async () => {
    setLoading(true);
    try {
      setResult((await request("usage.ledger.explain", { days })) as UsageExplanation);
    } catch {
      setResult(null);
    } finally {
      setLoading(false);
    }
  }, [request, days]);
  return (
    <div className="rounded-xl border border-border/20 bg-card/60 backdrop-blur-sm p-4 space-y-2">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <h3 className="text-sm font-medium text-foreground">Why does usage look like this?</h3>
        <button
          type="button"
          onClick={() => void run()}
          disabled={loading}
          className={cn(
            "px-3 py-1 text-xs rounded-lg bg-brand/10 text-brand hover:bg-brand/30 border border-brand/20 transition-colors",
            loading && "opacity-50",
          )}
        >
          {loading ? "Explaining…" : result ? "Refresh" : "Explain"}
        </button>
      </div>
      {result ? (
        <ul className="text-xs text-foreground space-y-1 list-disc pl-4">
          {result.lines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted-foreground">
          Compares this window with the one before it and names the features, models and sessions
          that moved the bill. Also available in chat as{" "}
          <code className="text-2xs">/usage why</code>.
        </p>
      )}
    </div>
  );
}
