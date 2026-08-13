// bitterbot:// deep-link handling for the Tauri desktop shell.
//
// The guest-JOIN page (deploy/guest-page/index.html) offers
// `bitterbot://join#<invite-code>` as its primary CTA. The Tauri shell
// registers the scheme (src-tauri: tauri-plugin-deep-link + single-instance);
// this module receives the URLs on the renderer side and routes them into the
// SAME verified join flow as paste-to-join: switch to the People tab, open
// the invite panel with the code prefilled, and run the `circles.inviteInfo`
// trust preview. A deep link PREFILLS, it never auto-joins — only the
// human's explicit Join tap redeems (PLAN-36 §4).
//
// Like updater.ts, everything Tauri-specific is dynamically imported behind a
// runtime check so the plain-browser Control UI never loads it. We call the
// plugin's invoke/event surface directly through @tauri-apps/api (already a
// dependency) rather than adding @tauri-apps/plugin-deep-link's JS wrapper —
// the wrapper is a one-line shim over exactly these two calls.

import { useCirclesStore } from "../stores/circles-store";
import { useUIStore } from "../stores/ui-store";

/**
 * Parse a bitterbot:// join URL into the invite code it carries, or null.
 * Accepted shape: `bitterbot://join#<code>` (optionally `join/#`), where
 * `<code>` is a percent-encoded `bbc1.` invite code — the same fragment
 * convention as the guest page's own URL.
 */
export function parseBitterbotJoinUrl(url: string): string | null {
  if (typeof url !== "string") return null;
  const m = /^bitterbot:\/\/join\/?#(.+)$/i.exec(url.trim());
  if (!m) return null;
  let code: string;
  try {
    code = decodeURIComponent(m[1] as string).trim();
  } catch {
    return null;
  }
  return code.startsWith("bbc1.") ? code : null;
}

function isTauriRuntime(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ !== "undefined"
  );
}

function routeJoinCode(code: string): void {
  // Prefill-only: the circles store stashes the code; CirclesView opens the
  // invite panel, which runs the inviteInfo trust preview. No redeem here.
  useCirclesStore.getState().setPendingJoinCode(code);
  useUIStore.getState().setActiveTab("people");
}

let started = false;

/**
 * Start listening for deep links (no-op outside the Tauri shell). Handles
 * both the cold-start URL (the app was launched BY the link) and links
 * arriving while the app runs (forwarded by the single-instance plugin).
 * Returns true when the listener was installed.
 */
export async function initDeepLinkJoin(): Promise<boolean> {
  if (started || !isTauriRuntime()) return false;
  started = true;
  try {
    const [{ invoke }, { listen }] = await Promise.all([
      import("@tauri-apps/api/core"),
      import("@tauri-apps/api/event"),
    ]);
    const handle = (urls: unknown) => {
      if (!Array.isArray(urls)) return;
      for (const u of urls) {
        const code = parseBitterbotJoinUrl(String(u));
        if (code) {
          routeJoinCode(code);
          return; // one join flow at a time
        }
      }
    };
    // Cold start: the URL that launched this instance.
    handle(await invoke<string[] | null>("plugin:deep-link|get_current"));
    // Running instance: URLs forwarded by single-instance / the OS.
    await listen<string[]>("deep-link://new-url", (event) => handle(event.payload));
    return true;
  } catch {
    // Plugin not present (older shell) — never fatal for the UI.
    return false;
  }
}
