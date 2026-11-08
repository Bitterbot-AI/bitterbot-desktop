/**
 * `self_state`: what each part of the agent does, what its settings switch
 * on, what the gateway can see of it right now (an owner pause, a missing
 * backend, no peers), why, and the setting that changes it.
 *
 * The system prompt's `## Your Current State` block carries the names from
 * the settings alone; this adds the live observations. Both come from the
 * capability registry (../self-state/registry.ts), whose entries read
 * settings through the same resolvers the parts use. Read-only.
 */

import { Type } from "@sinclair/typebox";
import { getComputeBackend, getComputeRuntime } from "../../compute/awareness/index.js";
import type { BitterbotConfig } from "../../config/config.js";
import { readConfigFileSnapshot } from "../../config/io.js";
import { getP2pStatus } from "../../infra/p2p-status.js";
import { peekMemorySearchManager } from "../../memory/index.js";
import { resolveSessionAgentId } from "../agent-scope.js";
import { stringEnum } from "../schema/typebox.js";
import { resolveCapabilities } from "../self-state/render.js";
import type {
  CapabilityArea,
  CapabilityObservations,
  ResolvedCapability,
} from "../self-state/types.js";
import { type AnyAgentTool, jsonResult, readStringParam } from "./common.js";

const AREAS = ["memory", "dreams", "curiosity", "skills", "network", "tools"] as const;

const SelfStateSchema = Type.Object({
  area: Type.Optional(stringEnum(AREAS)),
});

/** What can be seen right now without starting anything (never builds the memory manager). */
async function observe(config: BitterbotConfig, agentId: string): Promise<CapabilityObservations> {
  const observed: CapabilityObservations = {};
  try {
    const { manager } = await peekMemorySearchManager({ cfg: config, agentId });
    if (manager?.curiosityResearchPaused) {
      observed.curiosityPaused = await manager.curiosityResearchPaused();
    }
  } catch {
    // not observed
  }
  const backend = getComputeBackend();
  observed.computeBackend = !backend
    ? "none"
    : typeof backend.submit === "function" && getComputeRuntime() !== null
      ? "jobs"
      : "read-only";
  // Only a gateway that started the sidecar publishes P2P status.
  const p2p = getP2pStatus();
  if (p2p.enabled) {
    observed.p2pConnected = p2p.peerCount > 0;
  }
  return observed;
}

function describe(c: ResolvedCapability, nextTurn?: ResolvedCapability) {
  return {
    part: c.label,
    area: c.area,
    state: c.state,
    ...(c.mode ? { mode: c.mode } : {}),
    ...(c.missing ? { missing: c.missing } : {}),
    ...(c.because ? { because: c.because.detail } : {}),
    does: c.does,
    setBy:
      c.because?.kind === "environment"
        ? "environment"
        : c.because?.kind === "observed"
          ? "owner (live)"
          : c.source === "config"
            ? "owner's config"
            : "default",
    settings: [...(c.because?.keys ?? []), ...(c.controls ?? []), ...c.keys].filter(
      (key, i, all) => all.indexOf(key) === i,
    ),
    ...(nextTurn && nextTurn.state !== c.state ? { nextTurn: nextTurn.state } : {}),
  };
}

export function createSelfStateTool(options: {
  config?: BitterbotConfig;
  agentSessionKey?: string;
  /** Guests do not see how the owner's agent is configured. */
  guest?: boolean;
}): AnyAgentTool | null {
  if (!options.config || options.guest) {
    return null;
  }
  const config = options.config;
  const agentId = resolveSessionAgentId({ sessionKey: options.agentSessionKey, config });
  return {
    label: "Self state",
    name: "self_state",
    description:
      "What each part of you does and its state right now: on, recording only (keeps a record, changes no behaviour yet), paused by the owner, blocked (on, but missing something it needs, such as a backend, a model or peers) or off; why, whether the owner or a default set it, and the settings that change it. Optional area: memory, dreams, curiosity, skills, network, tools.",
    parameters: SelfStateSchema,
    execute: async (_toolCallId, args) => {
      const area = readStringParam(args as Record<string, unknown>, "area") as
        | CapabilityArea
        | undefined;
      // One snapshot gives both who set what (before load-time defaults) and
      // the config as it stands now, which the next turn will run with.
      let fileConfig: unknown;
      let nextConfig: BitterbotConfig | undefined;
      try {
        const snapshot = await readConfigFileSnapshot();
        if (snapshot.valid) {
          fileConfig = snapshot.resolved;
          nextConfig = snapshot.config;
        }
      } catch {
        // provenance unknown: reported as default unless the turn's config sets it
      }
      const observed = await observe(config, agentId);
      const now = resolveCapabilities(config, { agentId, observed, fileConfig });
      const next = nextConfig
        ? resolveCapabilities(nextConfig, { agentId, observed, fileConfig })
        : [];
      const parts = now
        .map((c, i) => ({ c, next: next[i] }))
        .filter(({ c }) => !area || c.area === area)
        .map(({ c, next: n }) => describe(c, n));
      return jsonResult({
        ok: true,
        note: "States come from the settings this turn runs with plus what the gateway can see now (owner pause, compute backend, P2P peers). It cannot see every runtime failure (a model call that errors, a sidecar crash between turns). nextTurn appears when the config file changed since this turn started; some parts (the P2P network, for one) take a change only after a gateway restart.",
        parts,
      });
    },
  };
}
