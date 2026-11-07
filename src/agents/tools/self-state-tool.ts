/**
 * `self_state`: what each part of the agent does, whether it is on, off,
 * recording only or blocked right now, why, and the setting that changes it.
 *
 * The system prompt's `## Your Current State` block carries the names; this
 * is the detail. Both come from the capability registry
 * (../self-state/registry.ts), whose entries read state through the same
 * resolvers the parts use, so the answer matches what actually runs.
 * Read-only.
 */

import { Type } from "@sinclair/typebox";
import type { BitterbotConfig } from "../../config/config.js";
import { readConfigFileSnapshot } from "../../config/io.js";
import { stringEnum } from "../schema/typebox.js";
import { resolveCapabilities } from "../self-state/render.js";
import type { CapabilityArea } from "../self-state/types.js";
import { type AnyAgentTool, jsonResult, readStringParam } from "./common.js";

const AREAS = ["memory", "dreams", "curiosity", "skills", "network", "tools"] as const;

const SelfStateSchema = Type.Object({
  area: Type.Optional(stringEnum(AREAS)),
});

export function createSelfStateTool(options: {
  config?: BitterbotConfig;
  /** Guests do not see how the owner's agent is configured. */
  guest?: boolean;
}): AnyAgentTool | null {
  if (!options.config || options.guest) {
    return null;
  }
  const config = options.config;
  return {
    label: "Self state",
    name: "self_state",
    description:
      "What each part of you does and whether it is on, off, recording only (runs, keeps a record, changes nothing yet) or blocked (on, but missing something it needs) right now, whether that is the default or the owner's setting, and the config key that changes it. Optional area: memory, dreams, curiosity, skills, network, tools.",
    parameters: SelfStateSchema,
    execute: async (_toolCallId, args) => {
      const area = readStringParam(args as Record<string, unknown>, "area") as
        | CapabilityArea
        | undefined;
      let fileConfig: unknown;
      try {
        fileConfig = (await readConfigFileSnapshot()).resolved;
      } catch {
        fileConfig = undefined;
      }
      const parts = resolveCapabilities(config, { fileConfig })
        .filter((c) => !area || c.area === area)
        .map((c) => ({
          part: c.label,
          area: c.area,
          state: c.state,
          ...(c.mode ? { mode: c.mode } : {}),
          ...(c.missing ? { missing: c.missing } : {}),
          does: c.does,
          setBy: c.source === "config" ? "owner's config" : "default",
          setting: c.keys[0],
        }));
      return jsonResult({
        ok: true,
        note: "Read from the config this turn runs with. Some parts pick up a config change on the next turn, others (the P2P network, for one) only after a gateway restart.",
        parts,
      });
    },
  };
}
