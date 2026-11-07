import type { BitterbotConfig } from "../../config/config.js";

/**
 * What a part of the agent is doing right now.
 *
 * - `on`: it runs and acts.
 * - `recording`: it runs and keeps a record, but changes nothing yet
 *   (a shadow mode).
 * - `off`: it does not run.
 * - `blocked`: switched on, but something it needs is missing (an API key,
 *   a model, a connection), so it cannot run.
 */
export type CapabilityState = "on" | "recording" | "off" | "blocked";

export type CapabilityArea = "memory" | "dreams" | "curiosity" | "skills" | "network" | "tools";

export type CapabilityReading = {
  state: CapabilityState;
  /** Mode name when the part has more than on/off (e.g. "mean", "verbal"). */
  mode?: string;
  /** What is missing when `blocked`. */
  missing?: string;
};

export type CapabilityContext = {
  config: BitterbotConfig;
  env: NodeJS.ProcessEnv;
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
   * decide whether to run, so this can never disagree with what it does.
   */
  read: (ctx: CapabilityContext) => CapabilityReading;
};

export type ResolvedCapability = Omit<Capability, "read"> &
  CapabilityReading & {
    /** `default` when no key in `keys` is set in the config file. */
    source: "default" | "config";
  };
