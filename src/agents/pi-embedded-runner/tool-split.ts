import type { AgentTool } from "@mariozechner/pi-agent-core";
import { toToolDefinitions } from "../pi-tool-definition-adapter.js";

// We always pass tools via `customTools` so our policy filtering, sandbox integration,
// and extended toolset remain consistent across providers.
type AnyAgentTool = AgentTool;

export function splitSdkTools(options: { tools: AnyAgentTool[]; sandboxEnabled: boolean }): {
  customTools: ReturnType<typeof toToolDefinitions>;
} {
  const { tools } = options;
  return {
    customTools: toToolDefinitions(tools),
  };
}

/**
 * The `tools` option of pi's createAgentSession (pi-coding-agent >= 0.73) is a
 * name allowlist over built-in AND custom tools: an empty array enables no
 * tools at all, and omitting it enables pi's own read/bash/edit/write. Pass
 * exactly our custom tool names so the session gets our toolset and nothing else.
 */
export function sessionToolAllowlist(customTools: ReadonlyArray<{ name: string }>): string[] {
  return customTools.map((tool) => tool.name);
}
