/**
 * Where is this renderer running? The same bundle serves the Tauri desktop
 * shell and the browser Control UI the gateway hosts on :19001. The Tauri 2
 * runtime exposes `__TAURI_INTERNALS__` on window; the browser does not.
 */
export function isTauriRuntime(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ !== "undefined"
  );
}

/** Product name for chrome such as the sidebar footer. */
export function productName(): string {
  return isTauriRuntime() ? "Bitterbot Desktop" : "Bitterbot";
}
