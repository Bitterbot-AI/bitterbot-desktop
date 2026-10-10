/**
 * PLAN-56 Phase 1: the `p2p.enabled` switch on the P2P page. Reads the flag
 * from `config.get` (the gateway's load-time default is ON), writes it with
 * `config.patch` under the base-hash guard, and says plainly that the change
 * needs a gateway restart (p2p is a restart-required path: the orchestrator
 * sidecar is spawned at startup, src/gateway/server-startup.ts).
 */
import { useCallback, useEffect, useState } from "react";
import { useGatewayStore } from "../../stores/gateway-store";
import { Switch } from "../ui/switch";

type State = { enabled: boolean; baseHash: string } | null;

export function P2pEnabledSwitch() {
  const request = useGatewayStore((s) => s.request);
  const [state, setState] = useState<State>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [restartNeeded, setRestartNeeded] = useState(false);

  const load = useCallback(async () => {
    try {
      const snap = (await request("config.get", {})) as
        | { baseHash?: string; config?: { p2p?: { enabled?: boolean } } }
        | undefined;
      if (!snap || typeof snap !== "object") {
        return;
      }
      setState({
        // Unset means ON (src/config/defaults.ts applyP2pDefaults).
        enabled: snap.config?.p2p?.enabled !== false,
        baseHash: snap.baseHash ?? "",
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not read config");
    }
  }, [request]);

  useEffect(() => {
    void load();
  }, [load]);

  const toggle = async (checked: boolean) => {
    if (!state) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await request("config.patch", {
        raw: JSON.stringify({ p2p: { enabled: checked } }),
        baseHash: state.baseHash,
      });
      setRestartNeeded(true);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update config");
    } finally {
      setBusy(false);
    }
  };

  if (!state) {
    return null;
  }
  return (
    <div className="flex items-center gap-2 ml-auto text-xs text-muted-foreground">
      <label className="flex items-center gap-2 cursor-pointer">
        <Switch
          checked={state.enabled}
          disabled={busy}
          onCheckedChange={(checked) => void toggle(checked)}
          aria-label="P2P Mesh Enabled"
        />
        <span>P2P mesh</span>
        <code className="text-2xs text-muted-foreground/60">p2p.enabled</code>
      </label>
      {restartNeeded && (
        <span className="px-1.5 py-0.5 rounded text-2xs uppercase tracking-wide bg-warning/10 text-warning border border-warning/20">
          restart the gateway to apply
        </span>
      )}
      {error && <span className="text-danger">{error}</span>}
    </div>
  );
}
