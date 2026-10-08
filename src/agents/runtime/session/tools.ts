/**
 * PLAN-52 Phase 3: tools as the owned session runs them.
 *
 * Each agent tool is wrapped by `tool-definition-adapter.ts` (before-tool-call
 * hook, thrown error to a JSON error result, plain JSON schema) and turned
 * back into an agent tool for the loop here.
 */

import type { AnyAgentTool } from "../loop/index.js";
import {
  type ToolDefinition,
  toClientToolDefinitions,
  toToolDefinitions,
} from "./tool-definition-adapter.js";

function fromDefinition(definition: ToolDefinition): AnyAgentTool {
  return {
    name: definition.name,
    label: definition.label,
    description: definition.description,
    parameters: definition.parameters,
    ...(definition.prepareArguments
      ? { prepareArguments: definition.prepareArguments as AnyAgentTool["prepareArguments"] }
      : {}),
    ...(definition.executionMode ? { executionMode: definition.executionMode } : {}),
    execute: (toolCallId, params, signal, onUpdate) =>
      definition.execute(toolCallId, params, signal, onUpdate, undefined),
  };
}

/** Wrap agent tools for the owned session (hook, error-to-result, plain JSON schema). */
export function toRuntimeTools(tools: Parameters<typeof toToolDefinitions>[0]): AnyAgentTool[] {
  return toToolDefinitions(tools).map(fromDefinition);
}

/** Client (hosted) tools: recorded and answered with a pending result. */
export function toRuntimeClientTools(
  ...args: Parameters<typeof toClientToolDefinitions>
): AnyAgentTool[] {
  return toClientToolDefinitions(...args).map(fromDefinition);
}
