import { create } from "zustand";

export type TaskStatus = "pending" | "running" | "completed" | "error";

export interface CoworkTask {
  id: string;
  parentId?: string;
  label: string;
  status: TaskStatus;
  reasoning?: string;
  startedAt?: number;
  endedAt?: number;
  error?: string;
}

interface CoworkState {
  /** All tasks keyed by id */
  tasks: Map<string, CoworkTask>;
  /** Root-level task ids (no parent) */
  rootTaskIds: string[];

  /** Add or update a task */
  upsertTask: (task: CoworkTask) => void;
  /** Update task status */
  updateTaskStatus: (id: string, status: TaskStatus, error?: string) => void;
  /** Update task reasoning text */
  updateTaskReasoning: (id: string, reasoning: string) => void;
  /** Get child tasks of a parent */
  getChildren: (parentId: string) => CoworkTask[];
  /** Clear all tasks */
  clearTasks: () => void;
}

export const useCoworkStore = create<CoworkState>((set, get) => ({
  tasks: new Map(),
  rootTaskIds: [],

  upsertTask: (task) =>
    set((s) => {
      const next = new Map(s.tasks);
      const existing = next.get(task.id);
      if (existing) {
        next.set(task.id, { ...existing, ...task });
      } else {
        next.set(task.id, task);
      }
      const rootIds = task.parentId
        ? s.rootTaskIds
        : s.rootTaskIds.includes(task.id)
          ? s.rootTaskIds
          : [...s.rootTaskIds, task.id];
      return { tasks: next, rootTaskIds: rootIds };
    }),

  updateTaskStatus: (id, status, error) =>
    set((s) => {
      const task = s.tasks.get(id);
      if (!task) return s;
      const next = new Map(s.tasks);
      next.set(id, {
        ...task,
        status,
        error,
        endedAt: status === "completed" || status === "error" ? Date.now() : task.endedAt,
      });
      return { tasks: next };
    }),

  updateTaskReasoning: (id, reasoning) =>
    set((s) => {
      const task = s.tasks.get(id);
      if (!task) return s;
      const next = new Map(s.tasks);
      next.set(id, { ...task, reasoning });
      return { tasks: next };
    }),

  getChildren: (parentId) => {
    const tasks = get().tasks;
    return [...tasks.values()].filter((t) => t.parentId === parentId);
  },

  clearTasks: () => set({ tasks: new Map(), rootTaskIds: [] }),
}));
