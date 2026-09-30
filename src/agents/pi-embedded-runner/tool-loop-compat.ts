import type { AgentSession } from "@mariozechner/pi-coding-agent";

export const STEERING_SKIP_REASON = "Skipped due to queued user message.";

/**
 * Restore the tool-loop semantics the embedded runner was built on
 * (pi-agent-core 0.52), which 0.73 changed by default:
 *
 * - Tool calls from one assistant message run one after another. 0.73
 *   defaults to parallel, which would race writes against execs, stack exec
 *   approval prompts and run wallet/payment tools concurrently against their
 *   spend caps.
 * - A steering message (e.g. the user saying "stop" mid-run) skips the rest
 *   of the current batch. 0.73 only looks at steering after the whole batch;
 *   0.52 ran the first call, then skipped the remaining ones.
 *
 * The steering check is chained in front of AgentSession's own beforeToolCall
 * (extension tool_call hooks), which still runs for every call not skipped.
 */
export function applyToolLoopCompat(session: AgentSession): void {
  const agent = session.agent;
  agent.toolExecution = "sequential";
  const sessionHook = agent.beforeToolCall;
  agent.beforeToolCall = async (context, signal) => {
    if (session.getSteeringMessages().length > 0) {
      const calls = context.assistantMessage.content.filter((block) => block.type === "toolCall");
      if (calls.findIndex((call) => call.id === context.toolCall.id) > 0) {
        return { block: true, reason: STEERING_SKIP_REASON };
      }
    }
    return sessionHook ? await sessionHook(context, signal) : undefined;
  };
}
