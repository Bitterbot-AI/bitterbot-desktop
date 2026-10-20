import { useEffect } from "react";
import { hasBrowserControl, useBrowserLiveStore } from "../stores/browser-live-store";

/**
 * Watch the agent's browser while `active` is true. Any number of components
 * can call this; the gateway streams once and stops when the last one leaves.
 */
export function useBrowserLive(active: boolean) {
  const acquire = useBrowserLiveStore((s) => s.acquire);
  useEffect(() => (active ? acquire() : undefined), [active, acquire]);

  const state = useBrowserLiveStore((s) => s.state);
  const reason = useBrowserLiveStore((s) => s.reason);
  const url = useBrowserLiveStore((s) => s.url);
  const title = useBrowserLiveStore((s) => s.title);
  const frame = useBrowserLiveStore((s) => s.frame);
  const control = useBrowserLiveStore((s) => s.control);
  const mine = useBrowserLiveStore(hasBrowserControl);
  return { state, reason, url, title, frame, control, mine };
}
