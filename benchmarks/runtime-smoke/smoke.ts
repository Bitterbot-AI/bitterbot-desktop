/**
 * PLAN-52 live smoke check: drive the embedded runner against a real provider
 * on one or both runtime engines, without the gateway and without touching
 * the live agent.
 *
 *   node --import tsx benchmarks/runtime-smoke/smoke.ts \
 *     --engines pi,bitterbot --model claude-haiku-4-5 [--compact] [--think high]
 *
 * Isolation: BITTERBOT_STATE_DIR points at a scratch directory before any
 * state path is resolved, the workspace and the agent directory are created
 * under it, and the session is a throwaway. Only the Anthropic API key is
 * read from the real install (the main agent's auth profiles); it is passed
 * to the runner through the process environment and never written or
 * printed. Nothing is asked of the live agent, so nothing is extracted into
 * its memory.
 *
 * What it asserts (on disk, not by asking the agent):
 * - a turn with a tool call: the reply quotes a token that only exists in a
 *   file in the scratch workspace, and the transcript holds
 *   user / assistant(toolCall) / toolResult / assistant;
 * - a follow-up turn on the same session file;
 * - with --compact: the explicit compaction path succeeds and a compaction
 *   entry is in the transcript.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

const REAL_STATE_DIR =
  process.env.BITTERBOT_STATE_DIR?.trim() || path.join(os.homedir(), ".bitterbot");
const args = parseArgs({
  options: {
    engines: { type: "string" },
    model: { type: "string" },
    compact: { type: "boolean" },
    root: { type: "string" },
    policy: { type: "string" },
    think: { type: "string" },
  },
});
const ROOT = args.values.root ?? path.join(REAL_STATE_DIR, "eval", "runtime-smoke");
process.env.BITTERBOT_STATE_DIR = path.join(ROOT, "state");
// The usage ledger of the scratch state must not count toward real budgets.
process.env.BITTERBOT_USAGE_LEDGER = "0";

const { resolveApiKeyForProvider } = await import("../../src/agents/model-auth.js");
const { runEmbeddedPiAgent } = await import("../../src/agents/embedded-runner.js");
const { compactEmbeddedPiSessionDirect } =
  await import("../../src/agents/embedded-runner/compact.js");
const { ensureBitterbotModelsJson } = await import("../../src/agents/models-config.js");

type Engine = "pi" | "bitterbot";
type Check = { name: string; ok: boolean; detail?: string };

const TOKEN = `smoke-${Math.random().toString(36).slice(2, 10)}`;

async function readTranscript(file: string): Promise<Array<Record<string, unknown>>> {
  const raw = await fs.readFile(file, "utf8").catch(() => "");
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function messageRoles(entries: Array<Record<string, unknown>>): string[] {
  return entries
    .filter((entry) => entry.type === "message")
    .map((entry) => String((entry.message as { role?: unknown }).role));
}

async function runEngine(engine: Engine, model: string, compact: boolean): Promise<Check[]> {
  const checks: Check[] = [];
  const dir = path.join(ROOT, `${engine}-${model}-${Date.now()}`);
  const workspaceDir = path.join(dir, "workspace");
  const agentDir = path.join(dir, "agent");
  await fs.mkdir(workspaceDir, { recursive: true });
  await fs.mkdir(agentDir, { recursive: true });
  await fs.writeFile(path.join(workspaceDir, "note.txt"), `The code word is ${TOKEN}.\n`);
  const sessionFile = path.join(dir, "session.jsonl");
  const cfg = {
    agents: {
      defaults: {
        workspace: workspaceDir,
        runtime: { engine },
        ...(args.values.policy === "offload" ? { compaction: { policy: "offload" } } : {}),
      },
    },
  } as never;
  await ensureBitterbotModelsJson(cfg, agentDir);
  const base = {
    sessionId: `smoke-${engine}`,
    sessionKey: `agent:main:smoke-${engine}`,
    sessionFile,
    workspaceDir,
    agentDir,
    config: cfg,
    provider: "anthropic",
    model,
    ...(args.values.think ? { thinkLevel: args.values.think as never } : {}),
  };
  const enqueue = async <T>(task: () => Promise<T>) => task();

  const turn = async (prompt: string, runId: string) => {
    const started = Date.now();
    const result = await runEmbeddedPiAgent({
      ...base,
      prompt,
      runId,
      timeoutMs: 180_000,
      enqueue,
    });
    const text = (result.payloads ?? []).map((p) => p.text ?? "").join("\n");
    return { text, ms: Date.now() - started, error: result.meta?.error };
  };

  try {
    const first = await turn(
      "Use the read tool on note.txt in your workspace and reply with only the code word it contains.",
      `smoke-${engine}-1`,
    );
    checks.push({
      name: "tool turn: reply contains the code word from the file",
      ok: first.text.includes(TOKEN),
      detail: `${first.ms} ms${first.error ? `, error: ${JSON.stringify(first.error).slice(0, 200)}` : ""}`,
    });
    const afterFirst = messageRoles(await readTranscript(sessionFile));
    checks.push({
      name: "transcript after turn 1 is user, assistant, toolResult, assistant",
      ok:
        afterFirst[0] === "user" &&
        afterFirst.includes("toolResult") &&
        afterFirst[afterFirst.length - 1] === "assistant",
      detail: afterFirst.join(","),
    });

    const second = await turn("Reply with the single word: done", `smoke-${engine}-2`);
    checks.push({
      name: "follow-up turn on the same session",
      ok: /done/i.test(second.text),
      detail: `${second.ms} ms`,
    });
    const afterSecond = messageRoles(await readTranscript(sessionFile));
    checks.push({
      name: "transcript grew by a user and an assistant message",
      ok: afterSecond.length >= afterFirst.length + 2,
      detail: `${afterFirst.length} -> ${afterSecond.length} messages`,
    });

    if (compact) {
      const result = await compactEmbeddedPiSessionDirect({
        ...base,
        customInstructions: "Keep the code word.",
        trigger: "manual",
      });
      checks.push({
        name: "explicit compaction succeeds",
        ok: result.ok && result.compacted,
        detail: result.ok ? undefined : String(result.reason).slice(0, 300),
      });
      const entries = await readTranscript(sessionFile);
      const compaction = entries.find((entry) => entry.type === "compaction");
      checks.push({
        name: "a compaction entry with a non-empty summary is in the transcript",
        ok: typeof compaction?.summary === "string" && compaction.summary.trim().length > 0,
        detail: compaction ? `${String(compaction.summary).length} chars` : "no entry",
      });
    }
  } catch (err) {
    checks.push({
      name: "run completed without throwing",
      ok: false,
      detail: err instanceof Error ? err.message.slice(0, 300) : "unknown error",
    });
  }
  return checks;
}

async function main(): Promise<void> {
  await fs.mkdir(ROOT, { recursive: true });
  const auth = await resolveApiKeyForProvider({
    provider: "anthropic",
    agentDir: path.join(REAL_STATE_DIR, "agents", "main", "agent"),
  });
  if (!auth.apiKey) {
    throw new Error("no Anthropic API key resolved from the main agent's auth profiles");
  }
  // In memory only: the scratch agent directory holds no credentials.
  process.env.ANTHROPIC_API_KEY = auth.apiKey;

  const engines = (args.values.engines ?? "pi,bitterbot").split(",") as Engine[];
  const model = args.values.model ?? "claude-haiku-4-5";
  let failed = 0;
  for (const engine of engines) {
    const checks = await runEngine(engine, model, args.values.compact === true);
    console.log(`\n== engine ${engine}, model ${model}`);
    for (const check of checks) {
      if (!check.ok) {
        failed += 1;
      }
      console.log(
        `${check.ok ? "PASS" : "FAIL"}  ${check.name}${check.detail ? `  (${check.detail})` : ""}`,
      );
    }
  }
  console.log(`\n${failed === 0 ? "all checks passed" : `${failed} check(s) failed`}`);
  process.exit(failed === 0 ? 0 : 1);
}

await main();
