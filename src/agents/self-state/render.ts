import type { BitterbotConfig } from "../../config/config.js";
import { CAPABILITIES } from "./registry.js";
import type { Capability, CapabilityState, ResolvedCapability } from "./types.js";

function hasPath(config: unknown, dotted: string): boolean {
  let node: unknown = config;
  for (const part of dotted.split(".")) {
    if (!node || typeof node !== "object" || !(part in node)) {
      return false;
    }
    node = (node as Record<string, unknown>)[part];
  }
  return node !== undefined;
}

export type ResolveOptions = {
  env?: NodeJS.ProcessEnv;
  /**
   * The config file as written, before load-time defaults. When given,
   * `source` says whether the owner set one of the part's keys; without it,
   * `source` is "default" only if no key is present in `config`.
   */
  fileConfig?: unknown;
};

export function resolveCapability(
  capability: Capability,
  config: BitterbotConfig,
  options: ResolveOptions = {},
): ResolvedCapability {
  const { read, ...rest } = capability;
  const reading = read({ config, env: options.env ?? process.env });
  const written = options.fileConfig ?? config;
  return {
    ...rest,
    ...reading,
    source: capability.keys.some((key) => hasPath(written, key)) ? "config" : "default",
  };
}

export function resolveCapabilities(
  config: BitterbotConfig,
  options: ResolveOptions = {},
  capabilities: readonly Capability[] = CAPABILITIES,
): ResolvedCapability[] {
  return capabilities.map((capability) => resolveCapability(capability, config, options));
}

const LINE_ORDER: Array<{ state: CapabilityState; title: string }> = [
  { state: "on", title: "On" },
  { state: "recording", title: "Recording only (changes nothing yet)" },
  { state: "blocked", title: "On but blocked" },
  { state: "off", title: "Off" },
];

function labelWithMode(c: ResolvedCapability): string {
  if (c.state === "blocked" && c.missing) {
    return `${c.label} (needs ${c.missing})`;
  }
  return c.mode ? `${c.label} (${c.mode})` : c.label;
}

/**
 * The `## Your Current State` block: names only, grouped by state. It moves
 * only when the config does, so it sits in the cached half of the prompt.
 */
export function renderSelfStateBlock(resolved: readonly ResolvedCapability[]): string {
  const lines = ["## Your Current State"];
  for (const { state, title } of LINE_ORDER) {
    const names = resolved.filter((c) => c.state === state).map(labelWithMode);
    if (names.length > 0) {
      lines.push(`${title}: ${names.join(", ")}.`);
    }
  }
  lines.push(
    "Read from the live config on every turn. Before saying a part of you is running, check here; `self_state` has what each part does, why it is in its state and the setting that changes it.",
  );
  return lines.join("\n");
}

export function resolveSelfStateBlock(config: BitterbotConfig | undefined): string | undefined {
  if (!config) {
    return undefined;
  }
  return renderSelfStateBlock(resolveCapabilities(config));
}
