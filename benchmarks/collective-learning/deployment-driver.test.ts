import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { writeNewJson, type DeploymentSpec } from "./deployment-contract.js";
import { DeploymentStudyDriver } from "./deployment-driver.js";
import type { WorkerClient } from "./worker-client.js";

it.each(["smoke", "retention"] as const)(
  "cancels active %s work without starting the second task",
  async (method) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "bb-study-abort-"));
    const spec: DeploymentSpec = {
      schemaVersion: 1,
      id: "abort-fixture",
      purpose: "development-pilot",
      baseConfig: "unused",
      authAgentDirectory: "unused",
      model: "fixture/model",
      sandboxImage: "unused",
      initialPackageDirectory: "unused",
      corpusFile: "unused",
      seed: 1,
      conditions: ["frozen"],
      groupCeiling: { providerUsd: 10, toolCalls: 100, wallMs: 1000 },
      maxCanaryBatches: 5,
      retentionHours: 24,
    };
    await writeNewJson(path.join(root, "deployment.json"), spec);
    const driver = await DeploymentStudyDriver.open(root, () => {}, false);
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    let rejectTask: ((error: Error) => void) | undefined;
    const first = {
      call: vi.fn(async (name: string) => {
        if (name === "status")
          return {
            learningEndedAt: String(Date.now() - 25 * 3600000),
            finalRanAt: String(Date.now() - 24 * 3600000),
          };
        if (name !== "tasks") throw new Error("Unexpected worker request");
        return new Promise((_, reject) => {
          rejectTask = reject;
          started();
        });
      }),
      child: {
        kill: vi.fn(() => {
          rejectTask?.(new Error("stopped"));
        }),
      },
      close: async () => {},
    };
    const second = { call: vi.fn(), child: { kill: vi.fn() }, close: async () => {} };
    driver.clients = [first as unknown as WorkerClient, second as unknown as WorkerClient];
    driver.condition = "frozen";
    try {
      if (method === "retention") {
        first.call.mockResolvedValueOnce({ learningEndedAt: null, finalRanAt: null });
        await expect(driver.retention(new AbortController().signal)).rejects.toThrow(
          "precede retention",
        );
        expect(driver.db.prepare("SELECT COUNT(*) AS n FROM study_commands").get()?.n).toBe(0);
      }
      const abort = new AbortController();
      const rejected = expect(driver[method](abort.signal)).rejects.toThrow("stopped");
      await ready;
      abort.abort();
      await rejected;
      expect(first.child.kill).toHaveBeenCalledTimes(1);
      expect(second.child.kill).toHaveBeenCalledTimes(1);
      expect(second.call).not.toHaveBeenCalled();
    } finally {
      await driver.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);
