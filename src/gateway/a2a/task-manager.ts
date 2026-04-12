import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import type { BitterbotConfig } from "../../config/types.bitterbot.js";
import type {
  A2aArtifact,
  A2aMessage,
  A2aTask,
  A2aTaskState,
  A2aTaskStatus,
  A2aStreamEvent,
  MessageSendParams,
} from "./types.js";
import { A2aTaskStore, ensureA2aSchema } from "./task-store.js";

type TaskEventListener = (event: A2aStreamEvent) => void;

/**
 * Manages A2A task lifecycle.
 *
 * Each A2A task maps to a Bitterbot sub-agent session. The manager:
 * - Creates tasks from incoming messages
 * - Tracks state transitions (submitted → working → completed/failed)
 * - Stores conversation history and artifacts
 * - Notifies SSE listeners of state changes
 */
export class A2aTaskManager {
  private readonly store: A2aTaskStore;
  private readonly listeners = new Map<string, Set<TaskEventListener>>();

  constructor(
    private readonly db: DatabaseSync,
    private readonly config: BitterbotConfig,
  ) {
    ensureA2aSchema(db);
    this.store = new A2aTaskStore(db);
  }

  /**
   * Create a new task from an incoming A2A message/send request.
   */
  createTask(params: MessageSendParams): A2aTask {
    const taskId = randomUUID();
    const contextId = (params.metadata?.contextId as string) ?? undefined;

    this.store.createTask({
      id: taskId,
      contextId,
      metadata: params.metadata,
    });

    // Store the incoming user message.
    this.store.addMessage({
      id: randomUUID(),
      taskId,
      role: "user",
      parts: params.message.parts,
      metadata: params.message.metadata,
    });

    const task = this.buildTask(taskId);
    if (!task) {
      throw new Error("Failed to create task");
    }
    return task;
  }

  /**
   * Transition a task to a new state.
   */
  updateStatus(taskId: string, state: A2aTaskState, agentMessage?: A2aMessage): void {
    this.store.updateTaskStatus(taskId, state);

    if (agentMessage) {
      this.store.addMessage({
        id: randomUUID(),
        taskId,
        role: "agent",
        parts: agentMessage.parts,
        metadata: agentMessage.metadata,
      });
    }

    const status = this.buildStatus(state, agentMessage);
    const isFinal = state === "completed" || state === "failed" || state === "canceled";

    this.emit(taskId, {
      type: "status",
      taskId,
      status,
      final: isFinal,
    });

    if (isFinal) {
      this.listeners.delete(taskId);
    }
  }

  /**
   * Add an artifact to a task.
   */
  addArtifact(taskId: string, artifact: A2aArtifact): void {
    this.store.addArtifact({
      id: randomUUID(),
      taskId,
      name: artifact.name,
      description: artifact.description,
      parts: artifact.parts,
      index: artifact.index,
    });

    this.emit(taskId, {
      type: "artifact",
      taskId,
      artifact,
    });
  }

  /**
   * Link a Bitterbot session key to an A2A task.
   */
  setSessionKey(taskId: string, sessionKey: string): void {
    this.store.updateTaskSessionKey(taskId, sessionKey);
  }

  /**
   * Retrieve a task by ID with full history and artifacts.
   */
  getTask(taskId: string, historyLength?: number): A2aTask | undefined {
    return this.buildTask(taskId, historyLength);
  }

  /**
   * List tasks with optional filtering.
   */
  listTasks(params?: {
    contextId?: string;
    status?: A2aTaskState;
    limit?: number;
    offset?: number;
  }): A2aTask[] {
    const rows = this.store.listTasks(params);
    return rows.map((row) => this.buildTask(row.id)).filter((t): t is A2aTask => t !== undefined);
  }

  /**
   * Cancel a running task.
   */
  cancelTask(taskId: string): A2aTask | undefined {
    const row = this.store.getTask(taskId);
    if (!row) {
      return undefined;
    }
    const state = row.status as A2aTaskState;
    if (state === "completed" || state === "failed" || state === "canceled") {
      return undefined;
    }
    this.updateStatus(taskId, "canceled");
    return this.buildTask(taskId);
  }

  /**
   * Subscribe to streaming events for a task.
   */
  subscribe(taskId: string, listener: TaskEventListener): () => void {
    let set = this.listeners.get(taskId);
    if (!set) {
      set = new Set();
      this.listeners.set(taskId, set);
    }
    set.add(listener);
    return () => {
      set!.delete(listener);
      if (set!.size === 0) {
        this.listeners.delete(taskId);
      }
    };
  }

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  private buildTask(taskId: string, historyLength?: number): A2aTask | undefined {
    const row = this.store.getTask(taskId);
    if (!row) {
      return undefined;
    }

    const history = this.store.getMessages(taskId, historyLength);
    const artifacts = this.store.getArtifacts(taskId);

    const lastAgentMessage = [...history].toReversed().find((m) => m.role === "agent");

    return {
      id: row.id,
      contextId: row.context_id ?? undefined,
      status: this.buildStatus(row.status as A2aTaskState, lastAgentMessage),
      history: history.length > 0 ? history : undefined,
      artifacts: artifacts.length > 0 ? artifacts : undefined,
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
    };
  }

  private buildStatus(state: A2aTaskState, message?: A2aMessage): A2aTaskStatus {
    return {
      state,
      message,
      timestamp: new Date().toISOString(),
    };
  }

  private emit(taskId: string, event: A2aStreamEvent): void {
    const set = this.listeners.get(taskId);
    if (!set) {
      return;
    }
    for (const listener of set) {
      try {
        listener(event);
      } catch {
        // Swallow listener errors — don't let one bad listener break others.
      }
    }
  }
}
