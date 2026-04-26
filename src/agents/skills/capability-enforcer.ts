/**
 * PLAN-13 Phase B.5: runtime capability enforcer for tool dispatch.
 *
 * The load-time gate (capability-gate.ts) excludes over-claiming P2P skills
 * from the active prompt entirely. This module is the second half: even if
 * a skill survived the load gate, the LLM may still be coaxed into emitting
 * a tool call that no active skill's profile permits. This wrapper refuses
 * those calls at dispatch time.
 *
 * Attribution model — tool-call → skill is genuinely hard at the LLM
 * boundary (see PLAN-13 §B.5 follow-up). We use a conservative union:
 *
 *   - Compute the union profile across every P2P skill currently loaded
 *     into the active prompt (each skill resolved through capability-profile.ts).
 *   - Sensitive tool calls (wallet/shell/process/network) are allowed iff
 *     the union permits them.
 *   - Non-sensitive tool calls (read, search, computation, etc.) bypass the
 *     enforcer and run normally — the agent's baseline behavior is not
 *     bounded by skill profiles.
 *   - When the active set is empty (no P2P skills loaded), the enforcer is
 *     a no-op. The agent runs unrestricted, which matches today's behavior.
 *
 * This is permissive in the case where a verified P2P skill in the active
 * set declared `wallet: true` and a malicious skill with subtle injection
 * also got loaded — the union allows wallet, so the malicious skill could
 * piggyback. The mitigation is the load-time gate (which strips the
 * malicious skill if it declares wallet) and the Phase A injection scanner
 * (which strips skills whose bodies contain attack strings). Combined,
 * the residual surface is "skills that declared no wallet, were not flagged
 * by the scanner, and yet contain subtle prompt injection" — much smaller
 * than the unguarded baseline.
 */

import type { AnyAgentTool } from "../tools/common.js";
import type { CapabilityAxis } from "./capability-grants.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { type EffectiveCapabilityProfile, profileAllows } from "./capability-profile.js";

const log = createSubsystemLogger("skills/capability-enforcer");

const ENFORCER_WRAPPED = Symbol("capabilityEnforcerWrapped");

export type EnforcerContext = {
  /**
   * Returns the resolved profiles for every P2P skill currently in the
   * active prompt. Called per tool invocation so dynamic skill changes
   * reflect immediately. Return an empty array to make the enforcer a no-op.
   */
  activeP2PProfiles: () => EffectiveCapabilityProfile[];
  /**
   * Optional reputation hook. Called with the publisher pubkey when
   * available, but we don't have attribution back to a specific skill,
   * so the implementation may choose to record at the "active set" level.
   */
  recordDenial?: (denial: {
    tool: string;
    capability: CapabilityAxis;
    scope?: { host?: string; path?: string; mode?: "read" | "write" };
  }) => void;
  /**
   * Optional notification sink. Receives a one-line operator message when
   * a tool call is denied. Production wiring uses `enqueueSystemEvent`.
   */
  notifyDenial?: (message: string) => void;
};

export class CapabilityDenied extends Error {
  readonly capability: CapabilityAxis;
  readonly toolName: string;
  readonly scope?: { host?: string; path?: string; mode?: "read" | "write" };

  constructor(input: {
    toolName: string;
    capability: CapabilityAxis;
    scope?: { host?: string; path?: string; mode?: "read" | "write" };
    reason: string;
  }) {
    super(input.reason);
    this.name = "CapabilityDenied";
    this.toolName = input.toolName;
    this.capability = input.capability;
    this.scope = input.scope;
  }
}

/**
 * Tool-name → capability classification. We're deliberately conservative:
 * a tool not in this map is treated as non-sensitive and bypasses the
 * enforcer. Adding to this map is the way to bring more tools under the
 * gate (e.g. when wallet adds new actions).
 *
 * The `extractScope` function pulls per-call scope from the tool params
 * (e.g. host for network tools). Returns null if the call has no scope
 * relevant to that axis (in which case profileAllows treats it as
 * "any scope").
 */
type SensitiveToolRule = {
  matches: (toolName: string) => boolean;
  capability: CapabilityAxis;
  extractScope?: (params: unknown) =>
    | {
        host?: string;
        path?: string;
        mode?: "read" | "write";
      }
    | undefined;
};

const SENSITIVE_TOOL_RULES: SensitiveToolRule[] = [
  // Wallet — every action on the wallet tool is gated. This is the
  // highest-value axis: a malicious skill that motivates a wallet call
  // moves real money.
  {
    matches: (n) => n === "wallet" || n.startsWith("wallet_") || n.startsWith("wallet."),
    capability: "wallet",
  },
  // Shell / arbitrary command execution. The risk lists in
  // src/security/dangerous-tools.ts are the source of truth for "this is
  // shell-class"; we mirror them here.
  {
    matches: (n) =>
      n === "exec" ||
      n === "shell" ||
      n === "bash" ||
      n === "sessions_spawn" ||
      n === "sessions_send" ||
      n === "gateway",
    capability: "shell",
  },
  // Sub-process spawn — distinct from shell because it's lower-level
  // (no command parsing) and may bypass shell restrictions.
  {
    matches: (n) => n === "spawn" || n.startsWith("process_") || n.startsWith("spawn_"),
    capability: "process",
  },
  // Outbound network — the host scope is pulled from params so
  // profileAllows can do the suffix-match against the union outbound list.
  {
    matches: (n) =>
      n === "web_fetch" ||
      n === "fetch_url" ||
      n === "http_get" ||
      n === "http_post" ||
      n === "browser_fetch",
    capability: "network",
    extractScope: (params) => {
      if (!params || typeof params !== "object") return undefined;
      const p = params as Record<string, unknown>;
      const url =
        typeof p.url === "string" ? p.url : typeof p.target === "string" ? p.target : undefined;
      if (!url) return undefined;
      try {
        return { host: new URL(url).hostname };
      } catch {
        return undefined;
      }
    },
  },
];

function classifyTool(toolName: string): SensitiveToolRule | null {
  for (const rule of SENSITIVE_TOOL_RULES) {
    if (rule.matches(toolName)) return rule;
  }
  return null;
}

/**
 * Compute the union of an array of profiles. The agent is permitted to
 * use a capability iff any active skill's profile permits it.
 */
function unionProfile(profiles: EffectiveCapabilityProfile[]): EffectiveCapabilityProfile {
  const out: EffectiveCapabilityProfile = {
    network: { outbound: [] },
    fs: { read: [], write: [] },
    wallet: false,
    shell: false,
    process: false,
  };
  const netSet = new Set<string>();
  const fsReadSet = new Set<string>();
  const fsWriteSet = new Set<string>();
  for (const p of profiles) {
    for (const h of p.network.outbound) netSet.add(h);
    for (const r of p.fs.read) fsReadSet.add(r);
    for (const w of p.fs.write) fsWriteSet.add(w);
    if (p.wallet) out.wallet = true;
    if (p.shell) out.shell = true;
    if (p.process) out.process = true;
  }
  out.network.outbound = Array.from(netSet);
  out.fs.read = Array.from(fsReadSet);
  out.fs.write = Array.from(fsWriteSet);
  return out;
}

/**
 * The pure check, exposed for tests and for callers who want to enforce
 * outside the wrapper. Returns null on allow, or a CapabilityDenied
 * instance describing the refusal on deny.
 */
export function evaluateToolCall(
  toolName: string,
  params: unknown,
  ctx: EnforcerContext,
): CapabilityDenied | null {
  const rule = classifyTool(toolName);
  if (!rule) return null;

  const profiles = ctx.activeP2PProfiles();
  // No P2P skills active → the enforcer is a no-op. The agent's baseline
  // behavior is not bounded by skill profiles.
  if (profiles.length === 0) return null;

  const scope = rule.extractScope?.(params);
  const union = unionProfile(profiles);
  if (profileAllows(union, rule.capability, scope)) {
    return null;
  }

  return new CapabilityDenied({
    toolName,
    capability: rule.capability,
    scope,
    reason:
      `tool "${toolName}" requires capability ${rule.capability}` +
      (scope?.host ? ` for host ${scope.host}` : "") +
      `, but no active P2P skill grants it`,
  });
}

/**
 * Wrap a tool's execute() with the runtime capability gate. Mirrors the
 * structure of wrapToolWithBeforeToolCallHook so the wrapper composition
 * site at pi-tools.ts can stack them.
 */
export function wrapToolWithCapabilityEnforcer(
  tool: AnyAgentTool,
  ctx: EnforcerContext,
): AnyAgentTool {
  const execute = tool.execute;
  if (!execute) return tool;
  const toolName = tool.name || "tool";

  const wrapped: AnyAgentTool = {
    ...tool,
    execute: async (toolCallId, params, signal, onUpdate) => {
      const denial = evaluateToolCall(toolName, params, ctx);
      if (denial) {
        log.warn(
          `capability denied: tool=${denial.toolName} capability=${denial.capability}` +
            (denial.scope?.host ? ` host=${denial.scope.host}` : ""),
        );
        try {
          ctx.recordDenial?.({
            tool: denial.toolName,
            capability: denial.capability,
            scope: denial.scope,
          });
        } catch (err) {
          log.debug(`recordDenial threw: ${String(err)}`);
        }
        try {
          ctx.notifyDenial?.(
            `Tool "${denial.toolName}" denied: capability "${denial.capability}" not granted by any active P2P skill.`,
          );
        } catch (err) {
          log.debug(`notifyDenial threw: ${String(err)}`);
        }
        throw denial;
      }
      return await execute(toolCallId, params, signal, onUpdate);
    },
  };
  Object.defineProperty(wrapped, ENFORCER_WRAPPED, {
    value: true,
    enumerable: false,
  });
  return wrapped;
}

export function isToolWrappedWithCapabilityEnforcer(tool: AnyAgentTool): boolean {
  const tagged = tool as unknown as Record<symbol, unknown>;
  return tagged[ENFORCER_WRAPPED] === true;
}

/**
 * Convenience: wrap a list of tools. No-op if ctx is undefined so callers
 * can plug in unconditionally.
 */
export function wrapToolsWithCapabilityEnforcer(
  tools: AnyAgentTool[],
  ctx: EnforcerContext | undefined,
): AnyAgentTool[] {
  if (!ctx) return tools;
  return tools.map((tool) => wrapToolWithCapabilityEnforcer(tool, ctx));
}

export const __testing = {
  classifyTool,
  unionProfile,
  SENSITIVE_TOOL_RULES,
};
