// Auto-updater hook for the Tauri desktop shell.
//
// Usage from the UI layer:
//   import { checkForUpdate, startUpdateLoop } from "./updater";
//   startUpdateLoop(); // polls once per 4 hours, plus once on launch
//
// The updater plugin is optional at runtime: if the app is running in a
// plain browser (dev) or the Tauri plugin isn't wired, all functions
// become no-ops. Never throw out of here; update failures are never
// critical to app functionality.
//
// See research/TAURI-PRODUCTION-PLAN.md §4.

// NOTE: these imports require @tauri-apps/plugin-updater and
// @tauri-apps/plugin-process in desktop/package.json. Add them before
// the first build:
//   cd desktop && pnpm add @tauri-apps/plugin-updater @tauri-apps/plugin-process @tauri-apps/api
// Until those are installed, this file won't typecheck. That's expected
// until Phase 1 lands.

type UpdateEvent =
  | { event: "Started"; data: { contentLength?: number } }
  | { event: "Progress"; data: { chunkLength: number } }
  | { event: "Finished" };

export type UpdateStatus =
  | { state: "idle" }
  | { state: "checking" }
  | { state: "available"; version: string; notes?: string }
  | { state: "downloading"; downloadedBytes: number; totalBytes?: number }
  | { state: "ready"; version: string }
  | { state: "error"; message: string };

type StatusListener = (status: UpdateStatus) => void;

const listeners = new Set<StatusListener>();
let current: UpdateStatus = { state: "idle" };

function emit(next: UpdateStatus) {
  current = next;
  for (const fn of listeners) {
    try {
      fn(next);
    } catch {
      // listener errors are never fatal for the updater itself
    }
  }
}

export function subscribe(listener: StatusListener): () => void {
  listeners.add(listener);
  listener(current);
  return () => {
    listeners.delete(listener);
  };
}

export function getStatus(): UpdateStatus {
  return current;
}

function isTauriRuntime(): boolean {
  // The Tauri 2 runtime exposes __TAURI_INTERNALS__ on window.
  return (
    typeof window !== "undefined" &&
    typeof (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ !== "undefined"
  );
}

export async function checkForUpdate(
  options: { install?: boolean; relaunch?: boolean } = {},
): Promise<UpdateStatus> {
  if (!isTauriRuntime()) {
    return { state: "idle" };
  }

  try {
    emit({ state: "checking" });
    // Dynamic import so the browser-dev path never tries to load the
    // plugin (it would fail at module-init time).
    const { check } = await import("@tauri-apps/plugin-updater");
    const update = await check();
    if (!update?.available) {
      emit({ state: "idle" });
      return { state: "idle" };
    }

    const available: UpdateStatus = {
      state: "available",
      version: update.version,
      notes: update.body ?? undefined,
    };
    emit(available);

    if (!options.install) {
      return available;
    }

    let totalBytes: number | undefined;
    let downloadedBytes = 0;
    await update.downloadAndInstall((ev: UpdateEvent) => {
      if (ev.event === "Started") {
        totalBytes = ev.data.contentLength;
        emit({ state: "downloading", downloadedBytes: 0, totalBytes });
      } else if (ev.event === "Progress") {
        downloadedBytes += ev.data.chunkLength;
        emit({ state: "downloading", downloadedBytes, totalBytes });
      } else if (ev.event === "Finished") {
        emit({ state: "ready", version: update.version });
      }
    });

    if (options.relaunch ?? true) {
      const { relaunch } = await import("@tauri-apps/plugin-process");
      await relaunch();
    }

    return { state: "ready", version: update.version };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    emit({ state: "error", message });
    return { state: "error", message };
  }
}

let loopStarted = false;
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

export function startUpdateLoop(): void {
  if (loopStarted || !isTauriRuntime()) return;
  loopStarted = true;
  // First check shortly after launch so we don't block startup.
  setTimeout(() => void checkForUpdate(), 30_000);
  setInterval(() => void checkForUpdate(), CHECK_INTERVAL_MS);
}
