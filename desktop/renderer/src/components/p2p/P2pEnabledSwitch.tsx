/**
 * PLAN-56 Phase 1: the `p2p.enabled` switch on the P2P page. Reads the flag
 * from `config.get` (the gateway's load-time default is ON) and writes it with
 * `config.patch` under the base-hash guard. `p2p` has no hot-reload rule, so
 * the gateway schedules its own restart (~2 s, src/gateway/server-methods/
 * config.ts) and reports it in the patch response; the switch shows that and
 * does not re-read the config while the gateway is going down.
 */
import { RotateCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useGatewayStore } from "../../stores/gateway-store";
import { Switch } from "../ui/switch";

type State = { enabled: boolean; baseHash: string } | null;

type PatchResponse = {
  restart?: unknown;
  restartReasons?: string[];
};

export function P2pEnabledSwitch() {
  const request = useGatewayStore((s) => s.request);
  const [state, setState] = useState<State>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [restarting, setRestarting] = useState<string[] | null>(null);

  const load = useCallback(async () => {
    try {
      const snap = (await request("config.get", {})) as
        | { baseHash?: string; config?: { p2p?: { enabled?: boolean } } }
        | undefined;
      if (!snap || typeof snap !== "object") {
        setError("config.get returned nothing");
        return;
      }
      setError(null);
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
      const res = (await request("config.patch", {
        raw: JSON.stringify({ p2p: { enabled: checked } }),
        baseHash: state.baseHash,
      })) as PatchResponse | undefined;
      setState({ enabled: checked, baseHash: state.baseHash });
      if (res?.restart) {
        // The gateway is about to restart itself; the socket will drop and the
        // UI reconnects on its own. Re-reading now would race the restart.
        setRestarting(res.restartReasons ?? []);
      } else {
        await load();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update config");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center gap-2 ml-auto text-xs text-muted-foreground">
      {state && (
        <label className="flex items-center gap-2 cursor-pointer">
          <Switch
            checked={state.enabled}
            disabled={busy || restarting !== null}
            onCheckedChange={(checked) => void toggle(checked)}
            aria-label="P2P Mesh Enabled"
          />
          <span>P2P mesh</span>
          <code className="text-2xs text-muted-foreground/60">p2p.enabled</code>
        </label>
      )}
      {restarting !== null && (
        <span
          className="flex items-center gap-1 px-1.5 py-0.5 rounded text-2xs uppercase tracking-wide bg-warning/10 text-warning border border-warning/20"
          title={restarting.length > 0 ? restarting.join(", ") : undefined}
        >
          <RotateCw className="w-3 h-3 animate-spin" />
          gateway restarting…
        </span>
      )}
      {error && (
        <span className="text-danger" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}
