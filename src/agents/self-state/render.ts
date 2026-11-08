import type { BitterbotConfig } from "../../config/config.js";
import { CAPABILITIES } from "./registry.js";
import type {
  Capability,
  CapabilityObservations,
  CapabilityState,
  ResolvedCapability,
} from "./types.js";

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
  /** The agent taking the turn (per-agent overrides). Defaults to the default agent. */
  agentId?: string;
  /** What the gateway observed now; the prompt block passes none. */
  observed?: CapabilityObservations;
};

export function resolveCapability(
  capability: Capability,
  config: BitterbotConfig,
  options: ResolveOptions = {},
): ResolvedCapability {
  const { read, ...rest } = capability;
  const { source: readSource, ...reading } = read({
    config,
    env: options.env ?? process.env,
    agentId: options.agentId,
    observed: options.observed,
  });
  const written = options.fileConfig ?? config;
  // A parent or the environment decided it: its own keys say nothing about who set that.
  const deciding = reading.because?.keys?.length ? reading.because.keys : capability.keys;
  const ownerSet =
    readSource === "config" ||
    (reading.because?.kind !== "environment" && deciding.some((key) => hasPath(written, key)));
  return { ...rest, ...reading, source: ownerSet ? "config" : "default" };
}

export function resolveCapabilities(
  config: BitterbotConfig,
  options: ResolveOptions = {},
  capabilities: readonly Capability[] = CAPABILITIES,
): ResolvedCapability[] {
  return capabilities.map((capability) => resolveCapability(capability, config, options));
}

const LINE_ORDER: Array<{ state: CapabilityState; title: string }> = [
  { state: "on", title: "Switched on" },
  { state: "recording", title: "Recording only (keeps a record, changes no behaviour yet)" },
  { state: "paused", title: "Paused by the owner" },
  { state: "blocked", title: "Switched on but blocked" },
  { state: "off", title: "Off" },
];

function labelWithMode(c: ResolvedCapability): string {
  if (c.state === "blocked" && c.missing) {
    return `${c.label} (needs ${c.missing})`;
  }
  return c.mode ? `${c.label} (${c.mode})` : c.label;
}

/**
 * The `## Your Current State` block: names only, grouped by state, from the
 * settings alone. It moves only when the config does, so it sits in the
 * cached half of the prompt; what is observed live (pauses, backends,
 * peers) is left to `self_state`.
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
    "This is what your settings switch on, read every turn. It cannot see whether a switched-on part is working at this moment (paused by the owner, no backend or model, no peers). Before saying a part is running, call `self_state`: it checks that, and says what each part does, why it is in its state and the setting that changes it.",
  );
  return lines.join("\n");
}

export function resolveSelfStateBlock(
  config: BitterbotConfig | undefined,
  options: { agentId?: string } = {},
): string | undefined {
  if (!config) {
    return undefined;
  }
  return renderSelfStateBlock(resolveCapabilities(config, { agentId: options.agentId }));
}
