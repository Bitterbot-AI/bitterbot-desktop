/**
 * PLAN-52 Phase 6: plugin hooks on both engines.
 *
 * A plugin registers every agent hook. The embedded runner then runs a tool
 * turn, a follow-up turn, an explicit compaction and a threshold compaction
 * with a scripted model (no network), once per engine. The hooks that fire,
 * their order and what they are given must be the same on `pi` and `bitterbot`.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import "./test-helpers/fast-coding-tools.js";
import type { BitterbotConfig } from "../config/config.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../plugins/hook-runner-global.js";
import { createMockPluginRegistry } from "../plugins/hooks.test-helpers.js";
import { ensureBitterbotModelsJson } from "./models-config.js";
import {
  CONTRACT_API_KEY,
  SCRIPTED_API,
  SCRIPTED_PROVIDER,
  ScriptedModel,
  type ScriptStep,
} from "./runtime/contract/scripted-model.js";
import type { RuntimeEngine } from "./runtime/engine.js";

let runEmbeddedPiAgent: typeof import("./embedded-runner.js").runEmbeddedPiAgent;
let compactEmbeddedPiSessionDirect: typeof import("./embedded-runner/compact.js").compactEmbeddedPiSessionDirect;
let tempRoot: string;

const HOOKS = [
  "before_agent_start",
  "llm_input",
  "llm_output",
  "before_tool_call",
  "after_tool_call",
  "tool_result_persist",
  "before_compaction",
  "after_compaction",
  "agent_end",
] as const;
type HookName = (typeof HOOKS)[number];
type Fired = { hook: HookName; detail: Record<string, unknown> };

let fired: Fired[] = [];

/** The fields of each hook event that a plugin can act on, without ids or timings. */
function describeEvent(hook: HookName, event: Record<string, unknown>): Record<string, unknown> {
  const count = (value: unknown) => (Array.isArray(value) ? value.length : undefined);
  switch (hook) {
    case "before_agent_start":
      return { prompt: String(event.prompt).slice(0, 40), messages: count(event.messages) };
    case "llm_input":
      return { prompt: String(event.prompt).slice(0, 40), history: count(event.historyMessages) };
    case "llm_output":
      return { texts: event.assistantTexts };
    case "before_tool_call":
      return { tool: event.toolName, params: event.params };
    case "after_tool_call":
      return { tool: event.toolName, params: event.params, error: event.error ?? null };
    case "tool_result_persist":
      return { tool: event.toolName, role: (event.message as { role?: string })?.role };
    case "before_compaction":
      return { messages: event.messageCount };
    case "after_compaction":
      return { messages: event.messageCount, compacted: event.compactedCount };
    case "agent_end":
      return { success: event.success, messages: count(event.messages) };
  }
}

beforeAll(async () => {
  ({ runEmbeddedPiAgent } = await import("./embedded-runner.js"));
  ({ compactEmbeddedPiSessionDirect } = await import("./embedded-runner/compact.js"));
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bitterbot-engine-hooks-"));
  initializeGlobalHookRunner(
    createMockPluginRegistry(
      HOOKS.map((hook) => ({
        hookName: hook,
        handler: (event: unknown) => {
          fired.push({ hook, detail: describeEvent(hook, event as Record<string, unknown>) });
          return undefined;
        },
      })),
    ),
  );
}, 120_000);

afterAll(async () => {
  resetGlobalHookRunner();
  await fs.rm(tempRoot, { recursive: true, force: true });
});

const immediateEnqueue = async <T>(task: () => Promise<T>) => task();

/** Hooks started with `void` finish on a later tick; wait until the list stops growing. */
async function settled(): Promise<Fired[]> {
  let seen = -1;
  while (seen !== fired.length) {
    seen = fired.length;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return fired;
}

type Scenario = {
  name: string;
  steps: ScriptStep[];
  prompts: string[];
  compact?: boolean;
};

async function runScenario(engine: RuntimeEngine, scenario: Scenario): Promise<Fired[]> {
  const root = path.join(tempRoot, `${engine}-${scenario.name}`);
  const agentDir = path.join(root, "agent");
  const workspaceDir = path.join(root, "workspace");
  await fs.mkdir(agentDir, { recursive: true });
  await fs.mkdir(workspaceDir, { recursive: true });
  await fs.writeFile(path.join(workspaceDir, "note.txt"), "hello from the note\n");
  const script = new ScriptedModel(scenario.steps);
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

  const base = {
    sessionId: "engine-hooks-session",
    sessionKey: "agent:main:engine-hooks",
    sessionFile: path.join(root, "session.jsonl"),
    workspaceDir,
    config: cfg,
    provider: SCRIPTED_PROVIDER,
    model: script.model.id,
    agentDir,
  };
  fired = [];
  for (const [index, prompt] of scenario.prompts.entries()) {
    await runEmbeddedPiAgent({
      ...base,
      prompt,
      timeoutMs: 30_000,
      runId: `run-${engine}-${scenario.name}-${index}`,
      enqueue: immediateEnqueue,
    });
    await settled();
  }
  if (scenario.compact) {
    const result = await compactEmbeddedPiSessionDirect({ ...base, trigger: "manual" });
    expect(result).toMatchObject({ ok: true, compacted: true });
  }
  const result = [...(await settled())];
  expect(script.remaining, "every scripted step was used").toBe(0);
  script.dispose();
  return result;
}

const toolTurn: Scenario = {
  name: "turns",
  prompts: ["read note.txt and tell me what it says", "thanks"],
  steps: [
    { kind: "tools", calls: [{ id: "call_1", name: "read", args: { path: "note.txt" } }] },
    { kind: "text", text: "The note says hello." },
    { kind: "text", text: "You're welcome." },
  ],
};

const manualCompaction: Scenario = {
  name: "manual",
  prompts: toolTurn.prompts,
  steps: [...toolTurn.steps, { kind: "text", text: "SUMMARY: the note says hello." }],
  compact: true,
};

// Two prompts that are each larger than the kept tail (20k tokens), then a
// turn whose reported input is over the threshold: the first turn is cut.
const filler = (label: string) => `${label} ${"lorem ipsum dolor sit amet ".repeat(4_500)}`;
const thresholdCompaction: Scenario = {
  name: "threshold",
  prompts: [filler("first"), filler("second"), "third"],
  steps: [
    { kind: "text", text: "one" },
    { kind: "text", text: "two" },
    { kind: "text", text: "three", inputTokens: 190_000 },
    { kind: "text", text: "SUMMARY: three filler turns." },
  ],
};

describe("plugin hooks on both engines", () => {
  const results = new Map<string, Fired[]>();
  const get = async (engine: RuntimeEngine, scenario: Scenario) => {
    const key = `${engine}:${scenario.name}`;
    let result = results.get(key);
    if (!result) {
      result = await runScenario(engine, scenario);
      results.set(key, result);
    }
    return result;
  };
  const names = (list: Fired[]) => list.map((entry) => entry.hook);

  for (const engine of ["pi", "bitterbot"] as const) {
    it(`${engine}: a tool turn fires the agent, model and tool hooks`, async () => {
      const list = await get(engine, toolTurn);
      expect(names(list)).toEqual([
        "before_agent_start",
        "llm_input",
        "before_tool_call",
        "after_tool_call",
        "tool_result_persist",
        "agent_end",
        "llm_output",
        "before_agent_start",
        "llm_input",
        "agent_end",
        "llm_output",
      ]);
      const before = list.find((entry) => entry.hook === "before_tool_call")!;
      expect(before.detail).toEqual({ tool: "read", params: { path: "note.txt" } });
      const after = list.find((entry) => entry.hook === "after_tool_call")!;
      expect(after.detail).toMatchObject({ tool: "read", error: null });
      const ends = list.filter((entry) => entry.hook === "agent_end");
      expect(ends.map((entry) => entry.detail.success)).toEqual([true, true]);
    }, 120_000);

    it(`${engine}: explicit compaction fires before_compaction and after_compaction`, async () => {
      const list = await get(engine, manualCompaction);
      const compaction = list.filter((entry) => entry.hook.endsWith("_compaction"));
      expect(names(compaction)).toEqual(["before_compaction", "after_compaction"]);
    }, 120_000);

    it(`${engine}: threshold compaction fires before_compaction and after_compaction`, async () => {
      const list = await get(engine, thresholdCompaction);
      const compaction = list.filter((entry) => entry.hook.endsWith("_compaction"));
      expect(names(compaction)).toEqual(["before_compaction", "after_compaction"]);
    }, 120_000);
  }

  for (const scenario of [toolTurn, manualCompaction, thresholdCompaction]) {
    it(`${scenario.name}: the same hooks with the same payloads on both engines`, async () => {
      const pi = await get("pi", scenario);
      const owned = await get("bitterbot", scenario);
      expect(owned).toEqual(pi);
    }, 180_000);
  }
});
