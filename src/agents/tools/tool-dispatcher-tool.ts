/**
 * `list_tools` / `use_tool`: the client-side deferral meta-tools.
 *
 * `use_tool` closes over the FULLY WRAPPED tool objects (post policy filter,
 * before-tool-call hook, capability enforcer, abort relay, cache, result
 * spill). Dispatching through it therefore runs every gate a direct call
 * would run: exec approvals, wallet consent and group policy live either in
 * those wrappers or inside the tool implementation itself, and both are the
 * same object here. Input is validated against the target's JSON schema with
 * the same ajv path pi-agent uses for direct calls (`validateToolArguments`).
 */

import { validateToolArguments } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import type { ToolHotSetLane } from "../../config/types.tools.js";
import type { AnyAgentTool } from "./common.js";
import { normalizeToolName } from "../tool-policy.js";
import { jsonResult } from "./common.js";

export const LIST_TOOLS_NAME = "list_tools";
export const USE_TOOL_NAME = "use_tool";
export const META_TOOL_NAMES: readonly string[] = [LIST_TOOLS_NAME, USE_TOOL_NAME];

const ONE_LINE_MAX_CHARS = 140;

const ListToolsSchema = Type.Object({
  query: Type.Optional(
    Type.String({
      description:
        "Case-insensitive substring (or regex) matched against tool names and descriptions.",
    }),
  ),
  name: Type.Optional(
    Type.String({
      description: "Return the FULL definition (description + JSON schema) of this one tool.",
    }),
  ),
});

const UseToolSchema = Type.Object({
  name: Type.String({ description: "Tool name exactly as returned by list_tools." }),
  input: Type.Object(
    {},
    {
      additionalProperties: true,
      description: "Arguments for the target tool; must satisfy its JSON schema.",
    },
  ),
});

export function oneLineDescription(description: string | undefined): string {
  const firstLine = (description ?? "").trim().split(/\r?\n/)[0]?.trim() ?? "";
  if (firstLine.length <= ONE_LINE_MAX_CHARS) {
    return firstLine;
  }
  return `${firstLine.slice(0, ONE_LINE_MAX_CHARS - 1)}…`;
}

function buildMatcher(query: string | undefined): ((tool: AnyAgentTool) => boolean) | null {
  const trimmed = query?.trim() ?? "";
  if (!trimmed) {
    return null;
  }
  let regex: RegExp | null = null;
  try {
    regex = new RegExp(trimmed, "i");
  } catch {
    regex = null;
  }
  const lowered = trimmed.toLowerCase();
  return (tool) => {
    const haystack = `${tool.name}\n${tool.description ?? ""}`;
    if (regex?.test(haystack)) {
      return true;
    }
    return haystack.toLowerCase().includes(lowered);
  };
}

function findTool(registry: readonly AnyAgentTool[], name: string): AnyAgentTool | undefined {
  const wanted = normalizeToolName(name);
  return registry.find((tool) => normalizeToolName(tool.name) === wanted);
}

function errorResult(error: string, extra?: Record<string, unknown>) {
  return jsonResult({ ok: false, status: "error", error, ...extra });
}

export function createListToolsTool(params: {
  lane: ToolHotSetLane;
  hot: readonly AnyAgentTool[];
  deferred: readonly AnyAgentTool[];
}): AnyAgentTool {
  const { lane, hot, deferred } = params;
  const hotNames = hot.map((tool) => tool.name);
  return {
    name: LIST_TOOLS_NAME,
    label: "List tools",
    description:
      "List the tools that are registered but not loaded with a schema in this session " +
      "(name + one-line description), optionally filtered by `query`. Pass `name` to get " +
      "one tool's full description and JSON schema. Run any listed tool with use_tool.",
    parameters: ListToolsSchema,
    execute: async (_toolCallId, rawParams) => {
      const input = (rawParams ?? {}) as { query?: string; name?: string };
      const name = input.name?.trim();
      if (name) {
        const tool = findTool([...deferred, ...hot], name);
        if (!tool) {
          return errorResult(`unknown tool: ${name}`, { hint: "call list_tools without name" });
        }
        return jsonResult({
          ok: true,
          name: tool.name,
          hot: hotNames.includes(tool.name),
          description: tool.description ?? "",
          parameters: tool.parameters ?? {},
          usage: `use_tool({ name: "${tool.name}", input: { ... } })`,
        });
      }
      const matcher = buildMatcher(input.query);
      const rows = deferred
        .filter((tool) => (matcher ? matcher(tool) : true))
        .map((tool) => ({ name: tool.name, description: oneLineDescription(tool.description) }));
      return jsonResult({
        ok: true,
        lane,
        hot: hotNames,
        count: rows.length,
        tools: rows,
        usage: "list_tools({ name }) for a schema, then use_tool({ name, input })",
      });
    },
  };
}

export function createUseToolTool(params: { registry: readonly AnyAgentTool[] }): AnyAgentTool {
  const { registry } = params;
  return {
    name: USE_TOOL_NAME,
    label: "Use tool",
    description:
      "Run a registered tool that is not loaded with a schema in this session. `input` is " +
      "validated against the target tool's JSON schema (see list_tools({ name })) and the " +
      "tool's result is returned verbatim; the same approvals and policies apply as a direct call.",
    parameters: UseToolSchema,
    execute: async (toolCallId, rawParams, signal, onUpdate) => {
      const input = (rawParams ?? {}) as { name?: unknown; input?: unknown };
      const name = typeof input.name === "string" ? input.name.trim() : "";
      if (!name) {
        return errorResult("use_tool: `name` is required");
      }
      const target = findTool(registry, name);
      if (!target) {
        return errorResult(`use_tool: unknown tool "${name}"`, {
          hint: "call list_tools to see what is registered",
        });
      }
      const args =
        input.input && typeof input.input === "object" && !Array.isArray(input.input)
          ? (input.input as Record<string, unknown>)
          : {};
      let validated: unknown;
      try {
        validated = validateToolArguments(target, {
          type: "toolCall",
          id: toolCallId,
          name: target.name,
          arguments: args,
        });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err), {
          tool: target.name,
          hint: `list_tools({ name: "${target.name}" }) returns the schema`,
        });
      }
      // Verbatim: the target's own gates (approvals, consent, policy) already
      // ran inside its wrappers, and its result shape is what the model expects.
      return await target.execute(toolCallId, validated, signal, onUpdate);
    },
  };
}
