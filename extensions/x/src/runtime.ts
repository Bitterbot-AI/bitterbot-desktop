import type { PluginRuntime } from "bitterbot/plugin-sdk";

let runtime: PluginRuntime | null = null;

export function setXRuntime(next: PluginRuntime) {
  runtime = next;
}

export function getXRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("X runtime not initialized");
  }
  return runtime;
}
