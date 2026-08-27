import { Play, Power, RotateCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { readStoredGatewayToken } from "../../lib/gateway-origin";
import { cn } from "../../lib/utils";
import { useGatewayStore } from "../../stores/gateway-store";
import { useConfirm } from "../ui/confirm-dialog";

// Lifecycle controls for the local node. Restart self-heals (SIGUSR1
// in-process restart); Shut down is a deliberate SIGTERM.
// Start is DEV-ONLY (PLAN-41 ui-start-dead): it posts to the Vite dev
// server's /__gateway/start middleware — the only process still alive when
// the gateway is down. On the production path the gateway serves this page
// itself, so whenever the button could render, the endpoint behind it is
// gone; production shows terminal guidance instead.
// Restart/shutdown go through operator.admin RPCs the local Control UI holds.

type Phase = "idle" | "restarting" | "stopped" | "starting";

export function GatewayControls() {
  const request = useGatewayStore((s) => s.request);
  const status = useGatewayStore((s) => s.status);
  const hello = useGatewayStore((s) => s.hello);
  const [phase, setPhase] = useState<Phase>("idle");
  const [confirmDialog, confirmElement] = useConfirm();
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

  // "Starting…"/"stopped" end the moment the socket is back — the reconnect
  // loop (≤15s backoff) picks the gateway up on its own once it's listening.
  useEffect(() => {
    if (status === "connected" && (phase === "starting" || phase === "stopped")) {
      setPhase("idle");
    }
  }, [phase, status]);

  // Version skew: an older gateway won't have these methods. Advertised in the
  // hello frame, so hide the controls rather than showing buttons that 404.
  const methods = hello?.features?.methods;
  const supported = methods ? methods.includes("system.restart") : true;
  if (!supported) return null;

  // A dropped socket is the EXPECTED outcome of restart/shutdown (the gateway
  // goes away right after acking), so never surface disconnect/timeout errors.
  const isExpectedDrop = (message: string) => /disconnect|closed|timeout/i.test(message);

  const doStart = async () => {
    setError(null);
    setPhase("starting");
    try {
      // Same-origin call to the dev server's own middleware. It used to send the
      // baked VITE_GATEWAY_TOKEN, which no longer exists; a stored token is sent
      // when we have one, and the middleware accepts a loopback caller regardless.
      const storedToken = readStoredGatewayToken();
      const res = await fetch("/__gateway/start", {
        method: "POST",
        headers: storedToken ? { "x-bitterbot-token": storedToken } : {},
      });
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) {
        throw new Error(body?.error ?? `start endpoint returned ${res.status}`);
      }
      // Success: stay in "starting" until the reconnect loop lands ("connected"
      // resets the phase above). Boot can take a while — the banner says so.
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(
        `Could not start the gateway from here (${message}). ` +
          "Run `pnpm start gateway` in a terminal instead.",
      );
      setPhase("idle");
    }
  };

  const doRestart = async () => {
    if (
      !(await confirmDialog({
        title: "Restart the gateway?",
        description: "It briefly disconnects and comes back on its own.",
        actionLabel: "Restart",
      }))
    )
      return;
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
      !(await confirmDialog({
        title: "Shut down the gateway?",
        description: "This stops the node. Bring it back from a terminal (pnpm start gateway).",
        actionLabel: "Shut down",
        destructive: true,
      }))
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

  const connected = status === "connected";
  // Vite dev server origin only — see header comment.
  const canStartFromHere = import.meta.env.DEV;
  const startDisabled = connected || phase === "starting" || phase === "restarting";
  const adminDisabled = phase !== "idle" || !connected;

  return (
    <div className="mt-4 pt-3 border-t border-border/20">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="text-xs text-muted-foreground">
          {phase === "restarting"
            ? "Restarting… the connection will drop and reconnect."
            : phase === "starting"
              ? "Starting… waiting for the gateway to come up. First boot can take a while."
              : phase === "stopped"
                ? canStartFromHere
                  ? "Node stopped. Use Start gateway to relaunch it."
                  : "Node stopped. Relaunch from a terminal: pnpm start gateway — this page reconnects on its own."
                : connected
                  ? "Restart bounces the node; shut down stops it."
                  : canStartFromHere
                    ? "Gateway is not connected. Start it from here."
                    : "Gateway is not connected. Start it from a terminal: pnpm start gateway — this page reconnects on its own."}
        </div>
        <div className="flex items-center gap-2">
          {canStartFromHere && (
            <button
              type="button"
              onClick={() => void doStart()}
              disabled={startDisabled}
              className={cn(
                "flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs",
                "bg-green-500/10 hover:bg-green-500/20 text-green-300 border border-green-500/25 transition-colors",
                startDisabled && "opacity-50",
              )}
            >
              <Play className={cn("w-3.5 h-3.5", phase === "starting" && "animate-pulse")} />
              Start gateway
            </button>
          )}
          <button
            type="button"
            onClick={() => void doRestart()}
            disabled={adminDisabled}
            className={cn(
              "flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs",
              "bg-muted/40 hover:bg-muted/60 text-foreground border border-border/30 transition-colors",
              adminDisabled && "opacity-50",
            )}
          >
            <RotateCw className={cn("w-3.5 h-3.5", phase === "restarting" && "animate-spin")} />
            Restart gateway
          </button>
          <button
            type="button"
            onClick={() => void doShutdown()}
            disabled={adminDisabled}
            className={cn(
              "flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs",
              "bg-red-500/10 hover:bg-red-500/20 text-red-300 border border-red-500/25 transition-colors",
              adminDisabled && "opacity-50",
            )}
          >
            <Power className="w-3.5 h-3.5" />
            Shut down
          </button>
        </div>
      </div>
      {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
      {confirmElement}
    </div>
  );
}
