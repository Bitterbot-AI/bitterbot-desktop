/**
 * PLAN-52 Phase 3: tools as the owned session runs them.
 *
 * The pi engine converts each tool to a pi `ToolDefinition`, and pi wraps it
 * back into an agent tool. The wrapper in between is where the
 * before-tool-call hook runs and where a thrown error becomes a JSON error
 * result (`{status: "error", tool, error}`, reported with `isError: false`),
 * which the subscriber and the model both rely on. The owned session needs
 * the same wrapper without the round trip.
 *
 * Until the pi engine is removed this reuses the pi adapter's wrapper, so the
 * two engines cannot drift; Phase 5 moves the wrapper here.
 */

import {
  toClientToolDefinitions,
  toToolDefinitions,
} from "../engines/pi/tool-definition-adapter.js";
import type { AnyAgentTool } from "../loop/index.js";

type ToolDefinitionLike = {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  prepareArguments?: (args: unknown) => unknown;
  executionMode?: "sequential" | "parallel";
  execute: (...args: never[]) => Promise<unknown>;
};

function fromDefinition(definition: ToolDefinitionLike): AnyAgentTool {
  const execute = definition.execute as unknown as (
    toolCallId: string,
    params: unknown,
    signal?: AbortSignal,
    onUpdate?: unknown,
    ctx?: unknown,
  ) => ReturnType<AnyAgentTool["execute"]>;
  return {
    name: definition.name,
    label: definition.label,
    description: definition.description,
    parameters: definition.parameters as AnyAgentTool["parameters"],
    ...(definition.prepareArguments
      ? { prepareArguments: definition.prepareArguments as AnyAgentTool["prepareArguments"] }
      : {}),
    ...(definition.executionMode ? { executionMode: definition.executionMode } : {}),
    execute: (toolCallId, params, signal, onUpdate) =>
      execute(toolCallId, params, signal, onUpdate, undefined),
  };
}

/** Wrap agent tools for the owned session (hook, error-to-result, plain JSON schema). */
export function toRuntimeTools(tools: Parameters<typeof toToolDefinitions>[0]): AnyAgentTool[] {
  return toToolDefinitions(tools).map((definition) =>
    fromDefinition(definition as unknown as ToolDefinitionLike),
  );
}

/** Client (hosted) tools: recorded and answered with a pending result. */
export function toRuntimeClientTools(
  ...args: Parameters<typeof toClientToolDefinitions>
): AnyAgentTool[] {
  return toClientToolDefinitions(...args).map((definition) =>
    fromDefinition(definition as unknown as ToolDefinitionLike),
  );
}
