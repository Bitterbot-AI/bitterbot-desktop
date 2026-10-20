import { useEffect } from "react";
import { useGatewayStore } from "../stores/gateway-store";

/**
 * Ask the gateway to include tool OUTPUT in this window's tool events
 * (PLAN-53 A4). Without it the terminal view shows commands and no output: the
 * gateway strips results for every WS client below verbose=full, and only a
 * connection holding this lease is exempt.
 *
 * Reference-counted, renewed while anyone holds it, and given back when the
 * last holder leaves. The gateway drops a lease that is not renewed in 30 s.
 */

export const TOOL_OUTPUT_RENEW_MS = 10_000;

let holders = 0;
let renewTimer: ReturnType<typeof setInterval> | null = null;
let unsubscribeConnection: (() => void) | null = null;

function subscribe(): void {
  const gateway = useGatewayStore.getState();
  if (gateway.status !== "connected") {
    return;
  }
  // An older gateway answers "unknown method"; the gateway store notes that
  // once and stays quiet. The pane then shows commands without output, as before.
  void gateway.request("tools.output.subscribe", {}).catch(() => {});
}

export function acquireToolOutput(): () => void {
  holders += 1;
  if (holders === 1) {
    subscribe();
    renewTimer = setInterval(subscribe, TOOL_OUTPUT_RENEW_MS);
    // A reconnect is a new connection on the gateway: the old lease is gone.
    unsubscribeConnection = useGatewayStore.subscribe((next, prev) => {
      if (next.status === "connected" && prev.status !== "connected") {
        subscribe();
      }
    });
  }
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    holders = Math.max(0, holders - 1);
    if (holders > 0) {
      return;
    }
    if (renewTimer) {
      clearInterval(renewTimer);
      renewTimer = null;
    }
    unsubscribeConnection?.();
    unsubscribeConnection = null;
    const gateway = useGatewayStore.getState();
    if (gateway.status === "connected") {
      void gateway.request("tools.output.unsubscribe", {}).catch(() => {});
    }
  };
}

/** Hold the tool output lease while `active` is true. */
export function useToolOutputLease(active: boolean): void {
  useEffect(() => (active ? acquireToolOutput() : undefined), [active]);
}
