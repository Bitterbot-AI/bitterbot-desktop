/**
 * Client construction: auth mode, headers, beta flags, Claude Code tool-name
 * mapping. Copied from vendored pi-ai 0.52.12 `providers/anthropic.js` so the
 * wire headers are identical; kept as data-returning functions so tests can
 * assert on them without a network.
 */

import type { Message, Model, Tool } from "@mariozechner/pi-ai";
import type { AnthropicClientOptions } from "./types.js";

// Stealth mode: mimic Claude Code's tool naming exactly (vendored value).
export const CLAUDE_CODE_VERSION = "2.1.2";

// Claude Code 2.x tool names (canonical casing), vendored list.
const CLAUDE_CODE_TOOLS = [
  "Read",
  "Write",
  "Edit",
  "Bash",
  "Grep",
  "Glob",
  "AskUserQuestion",
  "EnterPlanMode",
  "ExitPlanMode",
  "KillShell",
  "NotebookEdit",
  "Skill",
  "Task",
  "TaskOutput",
  "TodoWrite",
  "WebFetch",
  "WebSearch",
];
const CC_TOOL_LOOKUP = new Map(CLAUDE_CODE_TOOLS.map((t) => [t.toLowerCase(), t]));

/** Convert tool name to Claude Code canonical casing if it matches (case-insensitive). */
export function toClaudeCodeName(name: string): string {
  return CC_TOOL_LOOKUP.get(name.toLowerCase()) ?? name;
}

export function fromClaudeCodeName(name: string, tools?: readonly Tool[]): string {
  if (tools && tools.length > 0) {
    const lowerName = name.toLowerCase();
    const matchedTool = tools.find((tool) => tool.name.toLowerCase() === lowerName);
    if (matchedTool) {
      return matchedTool.name;
    }
  }
  return name;
}

export function isOAuthToken(apiKey: string): boolean {
  return apiKey.includes("sk-ant-oat");
}

export function mergeHeaders(
  ...headerSources: Array<Record<string, string> | undefined>
): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const headers of headerSources) {
    if (headers) {
      Object.assign(merged, headers);
    }
  }
  return merged;
}

// Copilot expects X-Initiator to indicate whether the request is user-initiated
// or agent-initiated (e.g. follow-up after assistant/tool messages).
function inferCopilotInitiator(messages: readonly Message[]): "agent" | "user" {
  const last = messages[messages.length - 1];
  return last && last.role !== "user" ? "agent" : "user";
}

export function hasCopilotVisionInput(messages: readonly Message[]): boolean {
  return messages.some((msg) => {
    if (msg.role === "user" && Array.isArray(msg.content)) {
      return msg.content.some((c) => c.type === "image");
    }
    if (msg.role === "toolResult" && Array.isArray(msg.content)) {
      return msg.content.some((c) => c.type === "image");
    }
    return false;
  });
}

export function buildCopilotDynamicHeaders(params: {
  messages: readonly Message[];
  hasImages: boolean;
}): Record<string, string> {
  const headers: Record<string, string> = {
    "X-Initiator": inferCopilotInitiator(params.messages),
    "Openai-Intent": "conversation-edits",
  };
  if (params.hasImages) {
    headers["Copilot-Vision-Request"] = "true";
  }
  return headers;
}

export type ResolvedClient = {
  clientOptions: AnthropicClientOptions;
  isOAuthToken: boolean;
};

/**
 * Same three branches as the vendored `createClient`: Copilot (Bearer, no
 * fine-grained streaming beta), OAuth setup-token (Bearer + Claude Code
 * identity headers), API key.
 */
export function resolveClientOptions(
  model: Model<"anthropic-messages">,
  apiKey: string,
  interleavedThinking: boolean,
  optionsHeaders?: Record<string, string>,
  dynamicHeaders?: Record<string, string>,
): ResolvedClient {
  if (model.provider === "github-copilot") {
    const betaFeatures: string[] = [];
    if (interleavedThinking) {
      betaFeatures.push("interleaved-thinking-2025-05-14");
    }
    return {
      clientOptions: {
        apiKey: null,
        authToken: apiKey,
        baseURL: model.baseUrl,
        dangerouslyAllowBrowser: true,
        defaultHeaders: mergeHeaders(
          {
            accept: "application/json",
            "anthropic-dangerous-direct-browser-access": "true",
            ...(betaFeatures.length > 0 ? { "anthropic-beta": betaFeatures.join(",") } : {}),
          },
          model.headers,
          dynamicHeaders,
          optionsHeaders,
        ),
      },
      isOAuthToken: false,
    };
  }
  const betaFeatures = ["fine-grained-tool-streaming-2025-05-14"];
  if (interleavedThinking) {
    betaFeatures.push("interleaved-thinking-2025-05-14");
  }
  if (isOAuthToken(apiKey)) {
    return {
      clientOptions: {
        apiKey: null,
        authToken: apiKey,
        baseURL: model.baseUrl,
        dangerouslyAllowBrowser: true,
        defaultHeaders: mergeHeaders(
          {
            accept: "application/json",
            "anthropic-dangerous-direct-browser-access": "true",
            "anthropic-beta": `claude-code-20250219,oauth-2025-04-20,${betaFeatures.join(",")}`,
            "user-agent": `claude-cli/${CLAUDE_CODE_VERSION} (external, cli)`,
            "x-app": "cli",
          },
          model.headers,
          optionsHeaders,
        ),
      },
      isOAuthToken: true,
    };
  }
  return {
    clientOptions: {
      apiKey,
      baseURL: model.baseUrl,
      dangerouslyAllowBrowser: true,
      defaultHeaders: mergeHeaders(
        {
          accept: "application/json",
          "anthropic-dangerous-direct-browser-access": "true",
          "anthropic-beta": betaFeatures.join(","),
        },
        model.headers,
        optionsHeaders,
      ),
    },
    isOAuthToken: false,
  };
}
