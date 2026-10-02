/**
 * Adversarial review (PLAN-52): the embedded runner end to end, scripted
 * model, no network. A failing test is a finding.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import "./test-helpers/fast-coding-tools.js";
import type { BitterbotConfig } from "../config/config.js";
import { ensureBitterbotModelsJson } from "./models-config.js";
import {
  CONTRACT_API_KEY,
  SCRIPTED_API,
  SCRIPTED_PROVIDER,
  ScriptedModel,
} from "./runtime/contract/scripted-model.js";
import type { RuntimeEngine } from "./runtime/engine.js";

let runEmbeddedPiAgent: typeof import("./embedded-runner.js").runEmbeddedPiAgent;
let tempRoot: string;

beforeAll(async () => {
  ({ runEmbeddedPiAgent } = await import("./embedded-runner.js"));
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bitterbot-engine-review-"));
}, 120_000);

afterAll(async () => {
  await fs.rm(tempRoot, { recursive: true, force: true });
});

const immediateEnqueue = async <T>(task: () => Promise<T>) => task();
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function setup(engine: RuntimeEngine, name: string, script: ScriptedModel) {
  const root = path.join(tempRoot, `${engine}-${name}`);
  const agentDir = path.join(root, "agent");
  const workspaceDir = path.join(root, "workspace");
  await fs.mkdir(agentDir, { recursive: true });
  await fs.mkdir(workspaceDir, { recursive: true });
  const sessionFile = path.join(root, "session.jsonl");
  const cfg = {
    models: {
      providers: {
        [SCRIPTED_PROVIDER]: {
          api: SCRIPTED_API,
          apiKey: CONTRACT_API_KEY,
          baseUrl: script.model.baseUrl,
          models: [
            {
              id: script.model.id,
              name: "scripted",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 200_000,
              maxTokens: 8_000,
            },
          ],
        },
      },
    },
    agents: { defaults: { runtime: { engine }, workspace: workspaceDir } },
  } as unknown as BitterbotConfig;
  await ensureBitterbotModelsJson(cfg, agentDir);
  return {
    workspaceDir,
    sessionFile,
    base: {
      sessionId: `review-${engine}-${name}`,
      sessionKey: `agent:main:review-${engine}-${name}`,
      sessionFile,
      workspaceDir,
      config: cfg,
      provider: SCRIPTED_PROVIDER,
      model: script.model.id,
      agentDir,
    },
  };
}

describe("review: a stopped run does not act", () => {
  // Verified during review: engine "pi" fails this the same way.
  for (const engine of ["bitterbot"] as const) {
    it(`${engine}: a run whose abort signal is already aborted calls no model and runs no tool`, async () => {
      const script = new ScriptedModel([
        {
          kind: "tools",
          calls: [
            { id: "call_1", name: "write", args: { path: "side-effect.txt", content: "written" } },
          ],
        },
        { kind: "text", text: "Wrote the file." },
      ]);
      const { base, workspaceDir, sessionFile } = await setup(engine, "pre-aborted", script);
      const controller = new AbortController();
      // The user stopped the run while it was still queued or setting up
      // (lane wait, sandbox, session lock, hooks).
      controller.abort();
      const result = await runEmbeddedPiAgent({
        ...base,
        prompt: "write side-effect.txt",
        timeoutMs: 30_000,
        runId: `run-${engine}-pre-aborted`,
        enqueue: immediateEnqueue,
        abortSignal: controller.signal,
      }).catch((error: unknown) => ({ error }));
      // The runner has returned: lock released, session disposed, run handle cleared.
      await sleep(1_500);
      const fileWritten = await fs
        .stat(path.join(workspaceDir, "side-effect.txt"))
        .then(() => true)
        .catch(() => false);
      const transcript = await fs.readFile(sessionFile, "utf8").catch(() => "");
      const persisted = transcript
        .split("\n")
        .filter(Boolean)
        .map(
          (line) =>
            JSON.parse(line) as {
              type: string;
              message?: { role: string; content?: Array<{ text?: string }> };
            },
        )
        .filter((entry) => entry.type === "message");
      const persistedRoles = persisted.map((entry) => entry.message!.role);
      const toolResults = persisted
        .filter((entry) => entry.message!.role === "toolResult")
        .map((entry) => String(entry.message!.content?.[0]?.text).slice(0, 120));
      script.dispose();
      expect({
        returned: "error" in (result as object) ? "threw" : "returned",
        modelCalls: script.calls.length,
        fileWritten,
        persistedRoles,
        toolResults,
      }).toEqual({
        returned: expect.any(String),
        modelCalls: 0,
        fileWritten: false,
        persistedRoles: [],
        toolResults: [],
      });
    }, 120_000);
  }
});
