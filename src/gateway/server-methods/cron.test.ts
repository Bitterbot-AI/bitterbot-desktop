import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GatewayRequestHandlerOptions } from "./types.js";
import { CronEngine } from "../../cron/engine.js";
import { setCronEngineForTests } from "../../cron/runtime.js";
import { cronHandlers } from "./cron.js";

function makeContext(): GatewayRequestHandlerOptions["context"] {
  // Cron handlers don't read context; cast to a minimal shim.
  return {} as unknown as GatewayRequestHandlerOptions["context"];
}

async function tempEngine(): Promise<{ engine: CronEngine; storePath: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), "cron-rpc-"));
  const storePath = path.join(dir, "jobs.json");
  const engine = new CronEngine({
    storePath,
    enabled: true,
    tickMs: 10_000_000,
    runners: {
      main: async () => undefined,
      isolated: async () => undefined,
    },
  });
  await engine.start();
  setCronEngineForTests(engine);
  return { engine, storePath };
}

async function call(method: string, params: Record<string, unknown> = {}) {
  const responses: Array<{ ok: boolean; payload?: unknown; error?: unknown }> = [];
  const respond = (ok: boolean, payload?: unknown, error?: unknown) => {
    responses.push({ ok, payload, error });
  };
  await cronHandlers[method]?.({
    req: { type: "req", id: "1", method, params },
    params,
    client: null,
    isWebchatConnect: () => false,
    respond,
    context: makeContext(),
  });
  return responses[0];
}

describe("cron RPC handlers", () => {
  let engine: CronEngine | undefined;

  beforeEach(async () => {
    setCronEngineForTests(null);
    const ctx = await tempEngine();
    engine = ctx.engine;
  });

  afterEach(async () => {
    await engine?.stop();
    setCronEngineForTests(null);
  });

  it("returns an empty list initially via cron.list", async () => {
    const res = await call("cron.list", {});
    expect(res.ok).toBe(true);
    expect((res.payload as { jobs: unknown[] }).jobs).toEqual([]);
  });

  it("rejects malformed cron.add payloads with INVALID_REQUEST", async () => {
    const res = await call("cron.add", {
      schedule: { kind: "cron", expr: "boom" },
      sessionTarget: "isolated",
    });
    expect(res.ok).toBe(false);
  });

  it("round-trips add → list → run → remove", async () => {
    const added = await call("cron.add", {
      name: "smoke",
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "main",
      payload: { kind: "systemEvent", text: "hi" },
      enabled: false,
    });
    expect(added.ok).toBe(true);
    const wire = added.payload as { id: string; jobId: string; sessionTarget: string };
    expect(wire.jobId).toBe(wire.id);
    expect(wire.sessionTarget).toBe("main");

    const listed = await call("cron.list", {});
    expect(listed.ok).toBe(true);
    expect((listed.payload as { jobs: unknown[] }).jobs).toHaveLength(1);

    const ran = await call("cron.run", { jobId: wire.id, mode: "force" });
    expect(ran.ok).toBe(true);
    expect((ran.payload as { status: string }).status).toBe("ok");

    const removed = await call("cron.remove", { jobId: wire.id });
    expect(removed.ok).toBe(true);
    expect((removed.payload as { ok: boolean }).ok).toBe(true);

    const finalList = await call("cron.list", {});
    expect((finalList.payload as { jobs: unknown[] }).jobs).toEqual([]);
  });

  it("cron.runs returns persisted history after a manual run", async () => {
    const added = await call("cron.add", {
      name: "history",
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "main",
      payload: { kind: "systemEvent", text: "hi" },
    });
    const jobId = (added.payload as { id: string }).id;
    await call("cron.run", { jobId, mode: "force" });
    const runs = await call("cron.runs", { jobId });
    expect(runs.ok).toBe(true);
    expect((runs.payload as { runs: unknown[] }).runs.length).toBeGreaterThan(0);
  });

  it("persists added jobs to the store file", async () => {
    const added = await call("cron.add", {
      name: "persist",
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "main",
      payload: { kind: "systemEvent", text: "x" },
    });
    expect(added.ok).toBe(true);
    const storePath = engine!.status().storePath;
    const fileContents = await readFile(storePath, "utf8");
    const parsed = JSON.parse(fileContents) as { jobs: Array<{ name: string }> };
    expect(parsed.jobs).toHaveLength(1);
    expect(parsed.jobs[0].name).toBe("persist");
  });
});
