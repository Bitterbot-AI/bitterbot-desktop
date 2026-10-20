import type { PluginRuntime } from "bitterbot/plugin-sdk";

let runtime: PluginRuntime | null = null;

export function setEmailRuntime(next: PluginRuntime) {
  runtime = next;
}

export function getEmailRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("Email runtime not initialized");
  }
  return runtime;
}
