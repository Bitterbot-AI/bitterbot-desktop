import type { BitterbotConfig } from "../../config/config.js";

/**
 * What a part of the agent is set to do, and, where the gateway can see it,
 * what it is doing now.
 *
 * - `on`: switched on in the settings. It runs when its schedule or a
 *   request calls for it; `self_state` adds what it could observe (a
 *   missing backend, a disconnected network).
 * - `recording`: runs and keeps a record, but changes no behaviour yet (a
 *   shadow mode).
 * - `paused`: switched on, but the owner paused it.
 * - `off`: does not run.
 * - `blocked`: switched on, but something it needs is missing (an API key,
 *   a model, a backend, a connection), so it cannot do its work.
 */
export type CapabilityState = "on" | "recording" | "paused" | "off" | "blocked";

export type CapabilityArea = "memory" | "dreams" | "curiosity" | "skills" | "network" | "tools";

/**
 * Why a part is in its state when the cause is not its own setting. `keys`
 * are the settings (or environment variables) that decide it; never values.
 */
export type CapabilityCause = {
  kind: "parent" | "environment" | "observed";
  detail: string;
  keys?: string[];
};

export type CapabilityReading = {
  state: CapabilityState;
  /** Mode name when the part has more than on/off (e.g. "mean", "verbal"). */
  mode?: string;
  /** What is missing when `blocked`. */
  missing?: string;
  because?: CapabilityCause;
  /**
   * Settings beyond `keys` that decide this reading for this turn (an
   * agent's own override). Counted for `source`.
   */
  controls?: string[];
  /** `config` when the owner set the deciding value somewhere `keys` cannot name. */
  source?: "config";
};

/**
 * What the gateway can see at the moment of asking. Each is optional: when
 * a fact was not observed the reading says only what the settings say. The
 * system prompt never carries these (they change between turns); the
 * `self_state` tool fills them in.
 */
export type CapabilityObservations = {
  /** The owner pressed Pause on curiosity research. */
  curiosityPaused?: boolean;
  /** A compute backend is registered, and whether it can run jobs or only read. */
  computeBackend?: "none" | "read-only" | "jobs";
  /** The P2P sidecar is connected to at least one peer. */
  p2pConnected?: boolean;
};

export type CapabilityContext = {
  config: BitterbotConfig;
  env: NodeJS.ProcessEnv;
  /** The agent taking this turn; per-agent overrides are read for it. */
  agentId?: string;
  observed?: CapabilityObservations;
};

export type Capability = {
  id: string;
  area: CapabilityArea;
  /** Short name the prompt line uses. */
  label: string;
  /** One line: what the part does when it runs. */
  does: string;
  /**
   * Config keys that switch it. The first is the one to change. Every key
   * must exist in the config schema (self-state.test.ts checks).
   */
  keys: string[];
  /**
   * Reads the state through the same function the part itself uses to
   * decide whether to run, so the settings side cannot disagree with it.
   */
  read: (ctx: CapabilityContext) => CapabilityReading;
};

export type ResolvedCapability = Omit<Capability, "read"> &
  Omit<CapabilityReading, "source"> & {
    /** `default` when no deciding key is set in the config file. */
    source: "default" | "config";
  };
