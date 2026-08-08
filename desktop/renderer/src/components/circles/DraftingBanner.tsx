import { Sparkles, X } from "lucide-react";
import { memo, useEffect, useState } from "react";
import { formatDuration } from "../../lib/format";

// The summon-wait indicator, extracted so its 1s elapsed ticker re-renders
// THIS banner only — not the whole chat subtree (d638276 review cleanup).
// Elapsed renders via the shared formatDuration ("1m 15s", never "(75s)").

export const DraftingBanner = memo(function DraftingBanner({
  since,
  count,
  onDismiss,
}: {
  since: number;
  count: number;
  onDismiss: () => void;
}) {
  const [elapsedMs, setElapsedMs] = useState(0);
  useEffect(() => {
    const tick = () => setElapsedMs(Math.max(1000, Date.now() - since));
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [since]);

  return (
    <div className="mx-3 -mb-1 motion-enter-conversation flex items-center gap-2 text-xs text-circle-agent border border-circle-agent/30 rounded-t-lg bg-circle-agent-soft/40 px-3 py-1.5">
      <Sparkles className="w-3.5 h-3.5 shrink-0 animate-pulse" />
      <span className="min-w-0">
        Your agent is drafting{count > 1 ? ` ×${count}` : ""}{" "}
        <span className="tabular-nums">({formatDuration(elapsedMs)})</span> — it lands above the
        composer, private to you, and nothing posts until you approve it.
      </span>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Stop waiting for the draft"
        title="Stop waiting — if the draft still lands, it goes to the quiet tray."
        className="ml-auto shrink-0 hover:text-foreground"
      >
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  );
});
