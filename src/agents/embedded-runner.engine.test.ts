/**
 * PLAN-52 Phase 4: the embedded runner on both engines.
 *
 * `runEmbeddedPiAgent` and the explicit compaction path run a real turn with
 * a scripted model (no network), once with `runtime.engine: "pi"` and once
 * with `"bitterbot"`. The reply, the transcript, and what the model was sent
 * must be the same on both.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import "./test-helpers/fast-coding-tools.js";
import type { BitterbotConfig } from "../config/config.js";
import { ensureBitterbotModelsJson } from "./models-config.js";
import { normalizeTranscript } from "./runtime/contract/harness.js";
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

beforeAll(async () => {
  ({ runEmbeddedPiAgent } = await import("./embedded-runner.js"));
  ({ compactEmbeddedPiSessionDirect } = await import("./embedded-runner/compact.js"));
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bitterbot-engine-"));
}, 120_000);

afterAll(async () => {
  await fs.rm(tempRoot, { recursive: true, force: true });
});

const immediateEnqueue = async <T>(task: () => Promise<T>) => task();

type Outcome = {
  replies: string[];
  transcript: string[];
  calls: Array<{ tools: string[]; messages: string[]; system: string; key: string | undefined }>;
  compaction?: { ok: boolean; compacted: boolean; summary?: string };
};

async function runScenario(engine: RuntimeEngine, steps: ScriptStep[], compact: boolean) {
  const root = path.join(tempRoot, `${engine}-${compact ? "compact" : "turns"}`);
  const agentDir = path.join(root, "agent");
  // The same workspace path text for both engines would need a shared dir; the
  // system prompt is compared with the root replaced instead.
  const workspaceDir = path.join(root, "workspace");
  await fs.mkdir(agentDir, { recursive: true });
  await fs.mkdir(workspaceDir, { recursive: true });
  await fs.writeFile(path.join(workspaceDir, "note.txt"), "hello from the note\n");
  const sessionFile = path.join(root, "session.jsonl");
  const script = new ScriptedModel(steps);
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
    sessionId: "engine-test-session",
    sessionKey: "agent:main:engine-test",
    sessionFile,
    workspaceDir,
    config: cfg,
    provider: SCRIPTED_PROVIDER,
    model: script.model.id,
    agentDir,
  };
  const replies: string[] = [];
  for (const [index, prompt] of ["read note.txt and tell me what it says", "thanks"].entries()) {
    const result = await runEmbeddedPiAgent({
      ...base,
      prompt,
      timeoutMs: 30_000,
      runId: `run-${engine}-${index}`,
      enqueue: immediateEnqueue,
    });
    replies.push(result.payloads?.map((p) => p.text).join("|") ?? "");
  }
  const outcome: Outcome = { replies, transcript: [], calls: [] };
  if (compact) {
    const result = await compactEmbeddedPiSessionDirect({
      ...base,
      customInstructions: "keep the note content",
      trigger: "manual",
    });
    outcome.compaction = {
      ok: result.ok,
      compacted: result.compacted,
      summary: result.result?.summary,
    };
  }
  outcome.transcript = normalizeTranscript(sessionFile);
  outcome.calls = script.calls.map((call) => ({
    tools: call.tools,
    messages: call.messages.map((m) => m.split(root).join("ROOT")),
    system: call.systemPrompt.split(root).join("ROOT"),
    key: call.apiKey,
  }));
  expect(script.remaining, "every scripted step was used").toBe(0);
  script.dispose();
  return outcome;
}

const turnSteps: ScriptStep[] = [
  { kind: "tools", calls: [{ id: "call_1", name: "read", args: { path: "note.txt" } }] },
  { kind: "text", text: "The note says hello." },
  { kind: "text", text: "You're welcome." },
];

describe("embedded runner on both engines", () => {
  const outcomes = new Map<string, Outcome>();
  const get = async (engine: RuntimeEngine, compact: boolean) => {
    const key = `${engine}:${compact}`;
    let outcome = outcomes.get(key);
    if (!outcome) {
      outcome = await runScenario(
        engine,
        compact
          ? [...turnSteps, { kind: "text", text: "SUMMARY: the note says hello." }]
          : turnSteps,
        compact,
      );
      outcomes.set(key, outcome);
    }
    return outcome;
  };

  for (const engine of ["pi", "bitterbot"] as const) {
    it(`${engine}: a tool turn and a follow-up turn through runEmbeddedPiAgent`, async () => {
      const outcome = await get(engine, false);
      expect(outcome.replies).toEqual(["The note says hello.", "You're welcome."]);
      expect(outcome.calls).toHaveLength(3);
      expect(outcome.calls[0]!.key).toBe(CONTRACT_API_KEY);
      expect(outcome.calls[0]!.tools).toContain("read");
      expect(outcome.calls[0]!.system.length).toBeGreaterThan(200);
      // The tool ran against the workspace and the model saw its output.
      expect(outcome.calls[1]!.messages.join("\n")).toContain("hello from the note");
      const roles = outcome.transcript
        .map((line) => JSON.parse(line) as { type: string; message?: { role: string } })
        .filter((entry) => entry.type === "message")
        .map((entry) => entry.message!.role);
      expect(roles).toEqual(["user", "assistant", "toolResult", "assistant", "user", "assistant"]);
    }, 120_000);
  }

  it("both engines send the model the same thing and write the same transcript", async () => {
    const pi = await get("pi", false);
    const owned = await get("bitterbot", false);
    expect(owned.replies).toEqual(pi.replies);
    expect(owned.calls.map((c) => c.tools)).toEqual(pi.calls.map((c) => c.tools));
    expect(owned.calls.map((c) => c.messages)).toEqual(pi.calls.map((c) => c.messages));
    expect(owned.calls.map((c) => c.system)).toEqual(pi.calls.map((c) => c.system));
    expect(owned.transcript).toEqual(pi.transcript);
  }, 120_000);

  it("explicit compaction works on both engines and produces the same entry", async () => {
    const pi = await get("pi", true);
    const owned = await get("bitterbot", true);
    for (const outcome of [pi, owned]) {
      expect(outcome.compaction).toMatchObject({ ok: true, compacted: true });
      expect(outcome.compaction?.summary).toContain("SUMMARY: the note says hello.");
      expect(outcome.transcript.some((line) => line.includes('"type":"compaction"'))).toBe(true);
    }
    expect(owned.compaction).toEqual(pi.compaction);
    expect(owned.transcript).toEqual(pi.transcript);
    // The summary request itself (prompt text and custom instructions).
    expect(owned.calls.at(-1)!.messages).toEqual(pi.calls.at(-1)!.messages);
    expect(owned.calls.at(-1)!.messages.join("\n")).toContain(
      "Additional focus: keep the note content",
    );
  }, 180_000);
});
