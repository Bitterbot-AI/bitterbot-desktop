import { Type } from "@sinclair/typebox";
import { type AnyAgentTool, jsonResult, readStringParam, readStringArrayParam } from "./common.js";

const CompleteToolSchema = Type.Object({
  summary: Type.String({ description: "Brief summary of what was accomplished" }),
  tasks_completed: Type.Optional(
    Type.Array(Type.String(), { description: "List of completed task descriptions" }),
  ),
  attachments: Type.Optional(
    Type.Array(Type.String(), { description: "File paths of deliverables" }),
  ),
});

const PlanToolSchema = Type.Object({
  tasks: Type.Array(
    Type.Object({
      id: Type.String({ description: "Unique task identifier" }),
      label: Type.String({ description: "Short description of the task" }),
      parent_id: Type.Optional(Type.String({ description: "Parent task id for subtasks" })),
    }),
    { description: "Ordered list of tasks to complete" },
  ),
});

/**
 * Tool that signals the agent has completed all tasks.
 * The run loop can inspect toolMetas for "complete" to detect termination.
 */
export function createCompleteTool(): AnyAgentTool {
  return {
    label: "Complete",
    name: "complete",
    description:
      "Signal that all tasks are finished. Call this tool when you have completed every planned task. " +
      "Include a brief summary of what was accomplished, the list of completed tasks, and any relevant file paths as attachments.",
    parameters: CompleteToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const summary = readStringParam(params, "summary", { required: true });
      const tasksCompleted = readStringArrayParam(params, "tasks_completed");
      const attachments = readStringArrayParam(params, "attachments");

      return jsonResult({
        status: "complete",
        summary,
        tasks_completed: tasksCompleted ?? [],
        attachments: attachments ?? [],
      });
    },
  };
}

/**
 * Tool that emits a structured task plan for the current work.
 * The frontend picks this up via agent events to populate the CoworkPanel.
 */
export function createPlanTool(): AnyAgentTool {
  return {
    label: "Plan",
    name: "plan",
    description:
      "Emit a structured task plan for the current work. Call at the start of complex tasks to show the user what you will do. " +
      "Each task should have a unique id and label. Use parent_id to create subtask hierarchies.",
    parameters: PlanToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const tasks = params.tasks;

      if (!Array.isArray(tasks) || tasks.length === 0) {
        return jsonResult({ ok: false, error: "At least one task is required" });
      }

      const normalized = tasks.map((t: Record<string, unknown>) => ({
        id: String(t.id ?? ""),
        label: String(t.label ?? ""),
        parent_id: typeof t.parent_id === "string" ? t.parent_id : undefined,
      }));

      return jsonResult({
        ok: true,
        action: "plan",
        tasks: normalized,
      });
    },
  };
}
