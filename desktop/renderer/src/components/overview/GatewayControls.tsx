import { Power, RotateCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { cn } from "../../lib/utils";
import { useGatewayStore } from "../../stores/gateway-store";

// Lifecycle controls for the local node. Restart self-heals (SIGUSR1
// in-process restart); Shut down is a deliberate one-way SIGTERM — the UI
// cannot bring the gateway back, so it is confirmed with that warning.
// Both go through operator.admin RPCs the local Control UI already holds.

type Phase = "idle" | "restarting" | "stopped";

export function GatewayControls() {
  const request = useGatewayStore((s) => s.request);
  const status = useGatewayStore((s) => s.status);
  const hello = useGatewayStore((s) => s.hello);
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);

  // Clear the "Restarting…" banner only after a real disconnect→reconnect
  // cycle — the socket stays connected for a beat after the ack, so clearing
  // on "connected" alone would reset instantly and never show progress.
  const sawDropRef = useRef(false);
  useEffect(() => {
    if (phase !== "restarting") {
      sawDropRef.current = false;
      return;
    }
    if (status !== "connected") {
      sawDropRef.current = true;
    } else if (sawDropRef.current) {
      setPhase("idle");
    }
  }, [phase, status]);

  // Version skew: an older gateway won't have these methods. Advertised in the
  // hello frame, so hide the controls rather than showing buttons that 404.
  const methods = hello?.features?.methods;
  const supported = methods ? methods.includes("system.restart") : true;
  if (!supported) return null;

  // A dropped socket is the EXPECTED outcome of both ops (the gateway goes
  // away right after acking), so never surface disconnect/timeout as an error.
  const isExpectedDrop = (message: string) => /disconnect|closed|timeout/i.test(message);

  const doRestart = async () => {
    if (!confirm("Restart the gateway? It briefly disconnects and comes back on its own.")) return;
    setError(null);
    setPhase("restarting");
    try {
      await request("system.restart", {});
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!isExpectedDrop(message)) {
        setError(message);
        setPhase("idle");
      }
    }
  };

  const doShutdown = async () => {
    if (
      !confirm(
        "Shut down the gateway?\n\nThis stops the node. The Control UI cannot restart it — " +
          "you'll relaunch it from a terminal (pnpm start gateway) or by reopening the app.",
      )
    )
      return;
    setError(null);
    setPhase("stopped");
    try {
      await request("system.shutdown", {});
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!isExpectedDrop(message)) {
        setError(message);
        setPhase("idle");
      }
    }
  };

  return (
    <div className="mt-4 pt-3 border-t border-border/20">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="text-xs text-muted-foreground">
          {phase === "restarting"
            ? "Restarting… the connection will drop and reconnect."
            : phase === "stopped"
              ? "Node stopped. Relaunch from a terminal or by reopening the app."
              : "Restart bounces the node; shut down stops it (one-way from here)."}
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void doRestart()}
            disabled={phase !== "idle" || status !== "connected"}
            className={cn(
              "flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs",
              "bg-muted/40 hover:bg-muted/60 text-foreground border border-border/30 transition-colors",
              (phase !== "idle" || status !== "connected") && "opacity-50",
            )}
          >
            <RotateCw className={cn("w-3.5 h-3.5", phase === "restarting" && "animate-spin")} />
            Restart gateway
          </button>
          <button
            type="button"
            onClick={() => void doShutdown()}
            disabled={phase !== "idle" || status !== "connected"}
            className={cn(
              "flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs",
              "bg-red-500/10 hover:bg-red-500/20 text-red-300 border border-red-500/25 transition-colors",
              (phase !== "idle" || status !== "connected") && "opacity-50",
            )}
          >
            <Power className="w-3.5 h-3.5" />
            Shut down
          </button>
        </div>
      </div>
      {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
    </div>
  );
}
