import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  tasks: [] as Array<Record<string, unknown>>,
  scheduled: new Set<string>(),
  updated: [] as Array<{ id: string; status: string }>,
  hasStore: true,
}));

vi.mock("../../tasks/store.js", () => ({
  getActiveTaskStore: () =>
    state.hasStore
      ? {
          list: (opts: { status?: string[] }) =>
            state.tasks.filter((t) => !opts.status || opts.status.includes(t.status as string)),
          get: (id: string) => state.tasks.find((t) => t.id === id),
          update: (id: string, input: { status: string }) => {
            state.updated.push({ id, status: input.status });
            return { ...state.tasks.find((t) => t.id === id), status: input.status };
          },
        }
      : null,
}));
vi.mock("../../tasks/stall-sweep.js", () => ({
  TASK_STALE_MS: 24 * 60 * 60_000,
  scheduledWakeupTaskIds: () => state.scheduled,
}));

import { taskHandlers } from "./tasks.js";

type Reply = [boolean, any, { message?: string } | undefined];
const call = (method: string, params: Record<string, unknown> = {}) =>
  new Promise<Reply>((resolve) => {
    void taskHandlers[method]({
      params,
      respond: (ok: boolean, payload: unknown, error: unknown) =>
        resolve([ok, payload, error as { message?: string }]),
    } as never);
  });

const day = 24 * 60 * 60_000;
const t = (id: string, status: string, ageMs: number) => ({
  id,
  goal: `goal ${id}`,
  status,
  source: "user",
  createdAt: Date.now() - ageMs,
  updatedAt: Date.now() - ageMs,
  lastSeenAt: Date.now() - ageMs,
  completedAt: null,
  wakeupCount: 0,
  output: null,
});

beforeEach(() => {
  state.tasks = [];
  state.scheduled = new Set();
  state.updated = [];
  state.hasStore = true;
});

describe("tasks.list", () => {
  it("splits active from finished and marks what is stranded", async () => {
    state.tasks = [
      t("parked", "waiting_external", 3 * day),
      t("orphan", "waiting_external", 3 * day),
      t("busy", "running", 1000),
      t("done", "completed", 2 * day),
    ];
    state.scheduled = new Set(["parked"]);

    const [ok, payload] = await call("tasks.list");

    expect(ok).toBe(true);
    const byId = Object.fromEntries(payload.active.map((x: { id: string }) => [x.id, x]));
    expect(byId.parked).toMatchObject({ hasWakeup: true, stranded: false });
    expect(byId.orphan).toMatchObject({ hasWakeup: false, stranded: true });
    expect(byId.busy.stranded).toBe(false);
    expect(payload.finished.map((x: { id: string }) => x.id)).toEqual(["done"]);
  });

  it("says so when the task store is not running", async () => {
    state.hasStore = false;
    const [ok, , error] = await call("tasks.list");
    expect(ok).toBe(false);
    expect(error?.message).toContain("not running");
  });
});

describe("tasks.stop", () => {
  it("stops an unfinished task", async () => {
    state.tasks = [t("orphan", "waiting_external", 3 * day)];

    const [ok, payload] = await call("tasks.stop", { id: "orphan" });

    expect(ok).toBe(true);
    expect(payload.status).toBe("stopped");
    expect(state.updated).toEqual([{ id: "orphan", status: "stopped" }]);
  });

  it("refuses an unknown task or one that already ended", async () => {
    state.tasks = [t("done", "completed", day)];
    expect((await call("tasks.stop", { id: "nope" }))[0]).toBe(false);
    expect((await call("tasks.stop", { id: "done" }))[2]?.message).toContain("already ended");
    expect(state.updated).toEqual([]);
  });
});
