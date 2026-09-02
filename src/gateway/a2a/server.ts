import type { BitterbotConfig } from "../../config/types.bitterbot.js";
import type { A2aTaskManager } from "./task-manager.js";
import type {
  JsonRpcRequest,
  JsonRpcResponse,
  MessageSendParams,
  TaskGetParams,
  TaskListParams,
  TaskCancelParams,
  A2aTaskState,
} from "./types.js";
import { executeA2aTask, extractTaskText } from "./task-executor.js";
import { A2aErrorCodes } from "./types.js";

type A2aServerContext = {
  taskManager: A2aTaskManager;
  config?: BitterbotConfig;
  /**
   * PLAN-43 Phase 1 (R1): true when the caller authenticated with a real
   * credential (bearer token) or is a local direct request. Under
   * a2a.authentication "none" everyone reaches dispatch, so task reads by
   * untrusted callers require the per-task access token instead.
   */
  callerTrusted?: boolean;
  /** PLAN-43 Phase 1: pre-resolved sellable skill for exact-ID invocation. */
  skillInvocation?: { skillId: string; name: string; text: string };
};

/**
 * Dispatch a JSON-RPC 2.0 request to the appropriate A2A handler.
 */
export function handleA2aJsonRpc(request: JsonRpcRequest, ctx: A2aServerContext): JsonRpcResponse {
  if (request.jsonrpc !== "2.0") {
    return errorResponse(request.id, A2aErrorCodes.INVALID_REQUEST, "Invalid JSON-RPC version");
  }

  switch (request.method) {
    case "message/send":
      return handleMessageSend(request, ctx);
    case "tasks/get":
      return handleTasksGet(request, ctx);
    case "tasks/list":
      return handleTasksList(request, ctx);
    case "tasks/cancel":
      return handleTasksCancel(request, ctx);
    default:
      return errorResponse(
        request.id,
        A2aErrorCodes.METHOD_NOT_FOUND,
        `Unknown method: ${request.method}`,
      );
  }
}

/**
 * Returns the method name if this is a streaming request (message/stream),
 * or null for non-streaming methods.
 */
export function isStreamingMethod(request: JsonRpcRequest): boolean {
  return request.method === "message/stream";
}

// ---------------------------------------------------------------------------
// Method handlers
// ---------------------------------------------------------------------------

function handleMessageSend(request: JsonRpcRequest, ctx: A2aServerContext): JsonRpcResponse {
  const params = request.params as MessageSendParams | undefined;
  if (!params?.message) {
    return errorResponse(request.id, A2aErrorCodes.INVALID_PARAMS, "Missing message in params");
  }
  if (!params.message.role || !Array.isArray(params.message.parts)) {
    return errorResponse(
      request.id,
      A2aErrorCodes.INVALID_PARAMS,
      "Message must have role and parts",
    );
  }

  const task = ctx.taskManager.createTask(params);
  ctx.taskManager.updateStatus(task.id, "working");

  // Spawn sub-agent execution in the background. The response is returned
  // immediately with the task in "working" state — the client polls via
  // tasks/get or uses message/stream for real-time updates.
  if (ctx.config) {
    const taskText = extractTaskText(params);
    void executeA2aTask({
      taskId: task.id,
      taskText,
      config: ctx.config,
      taskManager: ctx.taskManager,
      skillInvocation: ctx.skillInvocation,
    });
  }

  // The access token rides ONLY on the create response (task reads never
  // include it) — it is the creator's capability to poll tasks/get.
  const created = ctx.taskManager.getTask(task.id);
  const accessToken = ctx.taskManager.getAccessToken(task.id);
  return successResponse(request.id, accessToken ? { ...created, accessToken } : created);
}

/**
 * PLAN-43 Phase 1 (R1): task reads/cancels by untrusted callers require the
 * per-task access token. NOT_FOUND (not UNAUTHORIZED) on a bad token, so an
 * unauthorized probe cannot confirm a task id exists.
 */
function taskAccessDenied(
  ctx: A2aServerContext,
  taskId: string,
  token: string | undefined,
): boolean {
  if (ctx.callerTrusted) {
    return false;
  }
  return !ctx.taskManager.verifyAccessToken(taskId, token);
}

function handleTasksGet(request: JsonRpcRequest, ctx: A2aServerContext): JsonRpcResponse {
  const params = request.params as TaskGetParams | undefined;
  if (!params?.id) {
    return errorResponse(request.id, A2aErrorCodes.INVALID_PARAMS, "Missing task id");
  }

  if (taskAccessDenied(ctx, params.id, params.accessToken)) {
    return errorResponse(request.id, A2aErrorCodes.TASK_NOT_FOUND, "Task not found");
  }

  const task = ctx.taskManager.getTask(params.id, params.historyLength);
  if (!task) {
    return errorResponse(request.id, A2aErrorCodes.TASK_NOT_FOUND, "Task not found");
  }

  return successResponse(request.id, task);
}

function handleTasksList(request: JsonRpcRequest, ctx: A2aServerContext): JsonRpcResponse {
  // Enumerating tasks is a trusted-caller surface only: an access token
  // scopes ONE task, and there is no anonymous list capability.
  if (!ctx.callerTrusted) {
    return errorResponse(request.id, A2aErrorCodes.UNAUTHORIZED, "Authentication required");
  }
  const params = (request.params ?? {}) as TaskListParams;
  const tasks = ctx.taskManager.listTasks({
    contextId: params.contextId,
    status: params.status as A2aTaskState | undefined,
    limit: params.limit,
    offset: params.offset,
  });

  return successResponse(request.id, tasks);
}

function handleTasksCancel(request: JsonRpcRequest, ctx: A2aServerContext): JsonRpcResponse {
  const params = request.params as TaskCancelParams | undefined;
  if (!params?.id) {
    return errorResponse(request.id, A2aErrorCodes.INVALID_PARAMS, "Missing task id");
  }

  if (taskAccessDenied(ctx, params.id, params.accessToken)) {
    return errorResponse(request.id, A2aErrorCodes.TASK_NOT_FOUND, "Task not found");
  }

  const task = ctx.taskManager.cancelTask(params.id);
  if (!task) {
    return errorResponse(
      request.id,
      A2aErrorCodes.TASK_NOT_CANCELABLE,
      "Task not found or already in a final state",
    );
  }

  return successResponse(request.id, task);
}

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

function successResponse(id: string | number | undefined, result: unknown): JsonRpcResponse {
  // The HTTP handler filters notifications (no id) with a 204 before reaching
  // dispatch, so id is always defined here. Coerce undefined → null defensively
  // to keep the JSON-RPC envelope spec-shaped.
  return { jsonrpc: "2.0", result, id: id ?? null };
}

function errorResponse(
  id: string | number | null | undefined,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    error: { code, message, ...(data !== undefined ? { data } : {}) },
    id: id ?? null,
  };
}
