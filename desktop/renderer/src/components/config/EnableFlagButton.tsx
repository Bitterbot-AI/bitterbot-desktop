/**
 * PLAN-41 p0-15: one-click enable for a config flag, replacing the
 * "set <dotted.key> = true in your config" copy that views used to show.
 * Reads the current baseHash, merge-patches the flag, and lets the caller
 * refetch. Both current users (circles.enabled, tools.wallet.enabled) are
 * hot-config paths — no restart needed.
 */
import { useState } from "react";
import { cn } from "../../lib/utils";
import { useGatewayStore } from "../../stores/gateway-store";

export function EnableFlagButton({
  patch,
  label,
  onDone,
}: {
  patch: Record<string, unknown>;
  label: string;
  onDone?: () => void;
}) {
  const request = useGatewayStore((s) => s.request);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const click = async () => {
    setBusy(true);
    setError(null);
    try {
      const snap = (await request("config.get", {})) as { baseHash?: string };
      await request("config.patch", {
        raw: JSON.stringify(patch),
        baseHash: snap.baseHash ?? "",
      });
      onDone?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update config");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2">
      <button
        onClick={click}
        disabled={busy}
        className={cn(
          "px-3 py-1.5 text-sm rounded-lg font-medium transition-colors",
          "bg-brand text-white hover:bg-brand/90 disabled:opacity-50",
        )}
      >
        {busy ? "Enabling…" : label}
      </button>
      {error && <p className="text-xs text-danger">{error}</p>}
    </div>
  );
}
