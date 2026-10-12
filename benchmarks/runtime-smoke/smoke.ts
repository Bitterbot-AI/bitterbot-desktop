/**
 * PLAN-52 live smoke check: drive the embedded runner against a real provider
 * on one or both runtime engines, without the gateway and without touching
 * the live agent.
 *
 *   node --import tsx benchmarks/runtime-smoke/smoke.ts \
 *     --engines pi,bitterbot --model claude-haiku-4-5 [--compact] [--think high]
 *   node --import tsx benchmarks/runtime-smoke/smoke.ts \
 *     --engines bitterbot --model claude-opus-4-8 --overflow
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
 *   entry is in the transcript;
 * - with --overflow (replaces the checks above): the session is seeded with a
 *   history under the context window, then one prompt carries a paste that
 *   takes the request over it. The run must recover by compacting and still
 *   answer. The seed is sized with the provider's token counter. A run costs
 *   one summary call over the seeded history on the chosen model.
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
    overflow: { type: "boolean" },
    window: { type: "string" },
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
const { openTranscript } = await import("../../src/agents/runtime/open-transcript.js");

/** Kept as a label for the scratch directories and run ids; the runtime is always the owned one. */
type Engine = "bitterbot";
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

/** Text shaped like a pasted service log: dense in tokens, cheap to generate. */
function logText(chars: number, seed: number): string {
  const lines: string[] = [];
  let size = 0;
  let n = seed * 100_000;
  while (size < chars) {
    n += 1;
    const hex = ((n * 2_654_435_761) >>> 0).toString(16).padStart(8, "0");
    const line = `2026-10-01T${String(n % 24).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}:07Z worker-${n % 17} INFO request ${hex} completed in ${(n * 37) % 900} ms status=200 path=/api/v1/items/${(n * 7919) % 100_000}`;
    lines.push(line);
    size += line.length + 1;
  }
  return lines.join("\n");
}

/** Characters per token for `logText`, measured by the provider's counter. */
async function measureCharsPerToken(model: string): Promise<number> {
  const sample = logText(40_000, 99);
  const key = process.env.ANTHROPIC_API_KEY ?? "";
  const oauth = key.includes("sk-ant-oat");
  const response = await fetch("https://api.anthropic.com/v1/messages/count_tokens", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      ...(oauth
        ? { authorization: `Bearer ${key}`, "anthropic-beta": "oauth-2025-04-20" }
        : { "x-api-key": key }),
    },
    body: JSON.stringify({ model, messages: [{ role: "user", content: sample }] }),
  });
  if (!response.ok) {
    throw new Error(`count_tokens failed with HTTP ${response.status}`);
  }
  const body = (await response.json()) as { input_tokens?: number };
  if (!body.input_tokens) {
    throw new Error("count_tokens returned no input_tokens");
  }
  return sample.length / body.input_tokens;
}

const SEED_TURNS = 10;
/** Share of the window the seeded history takes (under every compaction threshold in use). */
const SEED_SHARE = 0.72;
/** Share of the window the pasted prompt takes; with the seed and the fixed prompt part this is over 100%. */
const PASTE_SHARE = 0.34;

/**
 * Overflow recovery: a history that fits, then one prompt that does not.
 * Asserted on the transcript: a compaction entry appears after the prompt was
 * sent, and the run still ends with an answer.
 */
async function runOverflow(engine: Engine, model: string): Promise<Check[]> {
  const checks: Check[] = [];
  const dir = path.join(ROOT, `${engine}-${model}-overflow-${Date.now()}`);
  const workspaceDir = path.join(dir, "workspace");
  const agentDir = path.join(dir, "agent");
  await fs.mkdir(workspaceDir, { recursive: true });
  await fs.mkdir(agentDir, { recursive: true });
  const sessionFile = path.join(dir, "session.jsonl");
  const window = Number(args.values.window ?? 200_000);
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

  try {
    const charsPerToken = await measureCharsPerToken(model);
    const seedTokens = Math.floor(window * SEED_SHARE);
    const perTurnChars = Math.floor((seedTokens / SEED_TURNS) * charsPerToken);
    const store = openTranscript(sessionFile);
    let running = 0;
    for (let turn = 0; turn < SEED_TURNS; turn++) {
      const text =
        turn === 0
          ? `The code word is ${TOKEN}. Keep it. Log chunk 1 follows.\n${logText(perTurnChars, turn)}`
          : `Log chunk ${turn + 1} follows.\n${logText(perTurnChars, turn)}`;
      store.appendMessage({
        role: "user",
        content: [{ type: "text", text }],
        timestamp: Date.now(),
      } as never);
      running += Math.ceil(text.length / charsPerToken);
      store.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: `Stored log chunk ${turn + 1}.` }],
        api: "anthropic-messages",
        provider: "anthropic",
        model,
        // What a real call would have reported: the history so far as input.
        usage: {
          input: running,
          output: 8,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: running + 8,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: Date.now(),
      } as never);
    }
    const seeded = await readTranscript(sessionFile);
    checks.push({
      name: "seeded history is on disk and under the window",
      ok: messageRoles(seeded).length === SEED_TURNS * 2 && running < window,
      detail: `${running} tokens in ${SEED_TURNS} turns, ${charsPerToken.toFixed(2)} chars per token`,
    });

    const paste = logText(Math.floor(window * PASTE_SHARE * charsPerToken), 50);
    const started = Date.now();
    const result = await runEmbeddedPiAgent({
      sessionId: `smoke-overflow-${engine}`,
      sessionKey: `agent:main:smoke-overflow-${engine}`,
      sessionFile,
      workspaceDir,
      agentDir,
      config: cfg,
      provider: "anthropic",
      model,
      ...(args.values.think ? { thinkLevel: args.values.think as never } : {}),
      prompt: `One more log chunk follows. After reading it, reply with only the code word I gave you at the start.\n${paste}`,
      runId: `smoke-overflow-${engine}-1`,
      timeoutMs: 600_000,
      enqueue: async <T>(task: () => Promise<T>) => task(),
    });
    const text = (result.payloads ?? []).map((p) => p.text ?? "").join("\n");
    const entries = await readTranscript(sessionFile);
    const compactionAt = entries.findLastIndex((entry) => entry.type === "compaction");
    const compaction = compactionAt >= 0 ? entries[compactionAt] : undefined;
    const messages = entries.filter((entry) => entry.type === "message");
    const last = messages[messages.length - 1]?.message as
      | { role?: string; stopReason?: string; usage?: { input?: number; cacheRead?: number } }
      | undefined;
    const errors = messages
      .map(
        (entry) => entry.message as { role?: string; stopReason?: string; errorMessage?: string },
      )
      .filter((message) => message.role === "assistant" && message.stopReason === "error");
    const overWindow = messages
      .map(
        (entry) =>
          entry.message as {
            role?: string;
            usage?: { input?: number; cacheRead?: number; cacheWrite?: number };
          },
      )
      .filter(
        (message) =>
          message.role === "assistant" &&
          (message.usage?.input ?? 0) +
            (message.usage?.cacheRead ?? 0) +
            (message.usage?.cacheWrite ?? 0) >
            window,
      );
    checks.push({
      // Without this the scenario would also pass on a plain threshold compaction.
      name: "the oversized request was refused, or accepted and reported over the window",
      ok: errors.length > 0 || overWindow.length > 0,
      detail: errors.length
        ? `${errors.length} refused: ${String(errors[0]?.errorMessage).slice(0, 140)}`
        : overWindow.length
          ? `${overWindow.length} accepted over the window`
          : "the request fit: raise PASTE_SHARE",
    });
    checks.push({
      name: "a compaction entry was written after the seeded history",
      ok: compactionAt >= seeded.length && String(compaction?.summary ?? "").trim().length > 0,
      detail: compaction
        ? `entry ${compactionAt + 1} of ${entries.length}, summary ${String(compaction.summary).length} chars, tokensBefore ${String(compaction.tokensBefore)}`
        : "no entry",
    });
    checks.push({
      name: "the run ended with an assistant answer, not an error",
      ok: last?.role === "assistant" && last.stopReason === "stop" && text.trim().length > 0,
      detail: `${Date.now() - started} ms, stopReason ${String(last?.stopReason)}, prompt ${(last?.usage?.input ?? 0) + (last?.usage?.cacheRead ?? 0)} tokens${result.meta?.error ? `, error: ${JSON.stringify(result.meta.error).slice(0, 200)}` : ""}`,
    });
    checks.push({
      name: "the answer still has the code word from the compacted part",
      ok: text.includes(TOKEN),
      detail: text.trim().slice(0, 80),
    });
  } catch (err) {
    checks.push({
      name: "run completed without throwing",
      ok: false,
      detail: err instanceof Error ? err.message.slice(0, 300) : "unknown error",
    });
  }
  return checks;
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

  const engines = (args.values.engines ?? "bitterbot").split(",") as Engine[];
  const model = args.values.model ?? "claude-haiku-4-5";
  let failed = 0;
  for (const engine of engines) {
    const checks = args.values.overflow
      ? await runOverflow(engine, model)
      : await runEngine(engine, model, args.values.compact === true);
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
