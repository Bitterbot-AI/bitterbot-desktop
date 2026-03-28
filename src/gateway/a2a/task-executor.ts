/**
 * A2A Task Executor — bridges A2A tasks to Bitterbot sub-agent sessions.
 *
 * When an external agent sends a task via message/send or message/stream,
 * this module:
 * 1. Extracts the task text from the A2A message parts
 * 2. Spawns a sub-agent session via callGateway("agent")
 * 3. Waits for the session to complete via callGateway("agent.wait")
 * 4. Reads the final assistant reply from chat history
 * 5. Updates the A2A task status with the result
 */

import crypto from "node:crypto";
import type { BitterbotConfig } from "../../config/types.bitterbot.js";
import { callGateway } from "../call.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { A2aTaskManager } from "./task-manager.js";
import type { MessageSendParams } from "./types.js";

const log = createSubsystemLogger("a2a/executor");

/** Maximum time to wait for a sub-agent run to complete (10 minutes). */
const DEFAULT_RUN_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Extract plain text from A2A message parts.
 */
export function extractTaskText(params: MessageSendParams): string {
  return (
    params.message.parts
      ?.filter((p) => p.type === "text")
      .map((p) => (p as { text?: string }).text ?? "")
      .join("\n") ?? ""
  );
}

/**
 * Spawn a sub-agent session to execute an A2A task, then update the task
 * lifecycle when the session completes. This runs asynchronously — the caller
 * should NOT await it (the task is returned to the A2A client immediately in
 * "working" state while execution proceeds in the background).
 */
export async function executeA2aTask(params: {
  taskId: string;
  taskText: string;
  config: BitterbotConfig;
  taskManager: A2aTaskManager;
}): Promise<void> {
  const { taskId, taskText, config, taskManager } = params;
  const childSessionKey = `agent:default:a2a-task:${crypto.randomUUID()}`;
  const idempotencyKey = crypto.randomUUID();

  try {
    // 1. Patch the child session to set depth metadata.
    try {
      await callGateway({
        method: "sessions.patch",
        params: { key: childSessionKey, spawnDepth: 1 },
        timeoutMs: 10_000,
      });
    } catch {
      // Session patch failure is non-fatal — the session will still work,
      // it just won't have depth metadata set.
    }

    // 2. Spawn the sub-agent run.
    const response = await callGateway<{ runId: string }>({
      method: "agent",
      params: {
        message: taskText,
        sessionKey: childSessionKey,
        idempotencyKey,
        deliver: false,
        lane: "subagent",
        label: `a2a-task-${taskId.slice(0, 8)}`,
        timeout: 0, // no timeout — we control it via agent.wait
      },
      timeoutMs: 15_000,
    });

    const runId =
      typeof response?.runId === "string" && response.runId
        ? response.runId
        : idempotencyKey;

    // Link the session to the A2A task for traceability.
    taskManager.setSessionKey(taskId, childSessionKey);

    log.info(`A2A task ${taskId} → session ${childSessionKey}, run ${runId}`);

    // 3. Wait for the run to complete.
    const runTimeoutMs = DEFAULT_RUN_TIMEOUT_MS;
    const wait = await callGateway<{
      status?: string;
      endedAt?: number;
      error?: string;
    }>({
      method: "agent.wait",
      params: { runId, timeoutMs: runTimeoutMs },
      timeoutMs: runTimeoutMs + 15_000,
    });

    // 4. Read the final assistant reply from the session history.
    let resultText = "Task completed.";
    try {
      const history = await callGateway<{
        messages: Array<{ role?: string; content?: string | Array<{ type?: string; text?: string }> }>;
      }>({
        method: "chat.history",
        params: { sessionKey: childSessionKey, limit: 50 },
        timeoutMs: 10_000,
      });

      if (Array.isArray(history?.messages)) {
        // Walk backwards to find the last assistant message with text content.
        for (let i = history.messages.length - 1; i >= 0; i--) {
          const msg = history.messages[i];
          if (msg?.role !== "assistant") continue;
          if (typeof msg.content === "string" && msg.content.trim()) {
            resultText = msg.content;
            break;
          }
          if (Array.isArray(msg.content)) {
            const text = msg.content
              .filter((p) => p.type === "text" && p.text)
              .map((p) => p.text!)
              .join("\n");
            if (text.trim()) {
              resultText = text;
              break;
            }
          }
        }
      }
    } catch {
      // History retrieval failed — use generic completion message.
    }

    // 5. Update the A2A task based on run outcome.
    if (wait?.status === "error") {
      const errorMsg = wait.error ?? "Sub-agent run failed";
      log.warn(`A2A task ${taskId} failed: ${errorMsg}`);
      taskManager.updateStatus(taskId, "failed", {
        role: "agent",
        parts: [{ type: "text", text: errorMsg }],
      });
    } else if (wait?.status === "timeout") {
      log.warn(`A2A task ${taskId} timed out`);
      taskManager.updateStatus(taskId, "failed", {
        role: "agent",
        parts: [{ type: "text", text: "Task execution timed out" }],
      });
    } else {
      // Success — add the result as an artifact and complete.
      taskManager.addArtifact(taskId, {
        name: "result",
        description: "Agent response",
        parts: [{ type: "text", text: resultText }],
        index: 0,
      });
      taskManager.updateStatus(taskId, "completed", {
        role: "agent",
        parts: [{ type: "text", text: resultText }],
      });
      log.info(`A2A task ${taskId} completed`);
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    log.error(`A2A task ${taskId} execution error: ${errorMsg}`);
    try {
      taskManager.updateStatus(taskId, "failed", {
        role: "agent",
        parts: [{ type: "text", text: `Task execution failed: ${errorMsg}` }],
      });
    } catch {
      // If updating the task itself fails, there's nothing we can do.
    }
  }
}
