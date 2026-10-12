/**
 * PLAN-52 Phase 0: runtime contract suite.
 *
 * Each scenario drives one agent session with a scripted model and records
 * the normalized event sequence, the transcript, the in-memory messages, and
 * what the model was sent. The committed snapshots are the contract: they
 * were recorded on the pi engine before Phase 6 removed it, except for the
 * scenarios listed in DELIBERATE_DIFFERENCES, whose golden was recorded on
 * the owned engine. Changing a golden is a behaviour change.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { afterAll, describe, expect, it } from "vitest";
import {
  CONTRACT_API_KEY,
  type ContractSession,
  type ContractVariant,
  createContractSession,
} from "./harness.js";
import { ScriptedModel, type ScriptStep } from "./scripted-model.js";

type Result = {
  events: string[];
  transcript: string[];
  messages: string[];
  calls: string[];
  errors: string[];
  notes: Record<string, unknown>;
};

type Ctx = { variant: ContractVariant; dir: string };

const VARIANTS: ContractVariant[] = ["bitterbot"];

/** Scenarios where the owned engine differs from pi on purpose (golden recorded on it). */
export const DELIBERATE_DIFFERENCES = new Set<string>(["abort during a tool call"]);

const roots: string[] = [];
afterAll(() => {
  for (const dir of roots) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-contract-"));
  roots.push(dir);
  return dir;
}

const text = (t: string, inputTokens?: number): ScriptStep => ({
  kind: "text",
  text: t,
  inputTokens,
});
const calls = (
  ...list: Array<[id: string, name: string, args?: Record<string, unknown>]>
): ScriptStep => ({
  kind: "tools",
  calls: list.map(([id, name, args]) => ({ id, name, args: args ?? {} })),
});

function tool(
  name: string,
  execute: (args: Record<string, unknown>, signal?: AbortSignal) => Promise<string>,
  parameters: Record<string, unknown> = { type: "object", properties: {} },
): AgentTool {
  return {
    name,
    label: name,
    description: `${name} tool`,
    parameters: parameters as AgentTool["parameters"],
    execute: async (_id, args, signal) => ({
      content: [{ type: "text", text: await execute(args as Record<string, unknown>, signal) }],
      details: {},
    }),
  };
}
const ok = (name: string, log?: string[]) =>
  tool(name, async () => {
    log?.push(name);
    return `${name} ok`;
  });

function collect(s: ContractSession, script: ScriptedModel, extra?: Partial<Result>): Result {
  return {
    events: [...s.events],
    transcript: s.transcript(),
    messages: s.messages(),
    calls: script.calls.map(
      (c) =>
        `#${c.index} tools=[${c.tools.join(",")}] key=${c.apiKey === CONTRACT_API_KEY ? "ok" : String(c.apiKey)} system=${JSON.stringify(c.systemPrompt)} :: ${c.messages.join(" | ")}`,
    ),
    errors: extra?.errors ?? [],
    notes: { scriptRemaining: script.remaining, ...extra?.notes },
  };
}

async function waitFor(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

const OVERFLOW = "prompt is too long: 250000 tokens > 200000 maximum";

const scenarios: Record<string, (ctx: Ctx) => Promise<Result>> = {
  "plain turn on a new session": async (ctx) => {
    const script = new ScriptedModel([text("hello there")]);
    const s = await createContractSession({ ...ctx, script, systemPrompt: "you are a test" });
    await s.prompt("hi");
    await s.settle();
    const result = collect(s, script);
    await s.dispose();
    return result;
  },

  "two turns": async (ctx) => {
    const script = new ScriptedModel([text("one"), text("two")]);
    const s = await createContractSession({ ...ctx, script });
    await s.prompt("first");
    await s.settle();
    await s.prompt("second");
    await s.settle();
    const result = collect(s, script);
    await s.dispose();
    return result;
  },

  "multi-tool turn runs sequentially": async (ctx) => {
    const log: string[] = [];
    const script = new ScriptedModel([calls(["c1", "a"], ["c2", "b"], ["c3", "a"]), text("done")]);
    const s = await createContractSession({ ...ctx, script, tools: [ok("a", log), ok("b", log)] });
    await s.prompt("go");
    await s.settle();
    const result = collect(s, script, { notes: { executed: log } });
    await s.dispose();
    return result;
  },

  "steering during the first tool skips the rest of the batch": async (ctx) => {
    const log: string[] = [];
    let session: ContractSession | undefined;
    const script = new ScriptedModel([
      calls(["c1", "a"], ["c2", "b"], ["c3", "c"]),
      text("ack stop"),
    ]);
    const a = tool("a", async () => {
      log.push("a");
      await session?.steer("stop please");
      return "a ok";
    });
    session = await createContractSession({
      ...ctx,
      script,
      tools: [a, ok("b", log), ok("c", log)],
    });
    await session.prompt("go");
    await session.settle();
    const result = collect(session, script, { notes: { executed: log } });
    await session.dispose();
    return result;
  },

  "abort while the model is streaming": async (ctx) => {
    const script = new ScriptedModel([{ kind: "hang", partialText: "partial ans" }, text("later")]);
    const s = await createContractSession({ ...ctx, script });
    const running = s.prompt("go");
    await waitFor(() => s.events.some((e) => e.startsWith("message_update")), "streaming");
    await s.abort();
    await running;
    await s.settle();
    const afterAbort = s.events.length;
    await s.prompt("again");
    await s.settle();
    const result = collect(s, script, { notes: { eventsAtAbort: afterAbort } });
    await s.dispose();
    return result;
  },

  "abort during a tool call": async (ctx) => {
    const log: string[] = [];
    const script = new ScriptedModel([calls(["c1", "slow"], ["c2", "b"]), text("unreached")]);
    const slow = tool("slow", (_args, signal) => {
      log.push("slow");
      return new Promise<string>((_resolve, reject) => {
        const fail = () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        };
        if (signal?.aborted) {
          fail();
        } else {
          signal?.addEventListener("abort", fail, { once: true });
        }
      });
    });
    const s = await createContractSession({ ...ctx, script, tools: [slow, ok("b", log)] });
    const running = s.prompt("go");
    await waitFor(() => log.includes("slow"), "slow tool start");
    await s.abort();
    await running;
    await s.settle();
    const result = collect(s, script, { notes: { executed: log } });
    await s.dispose();
    return result;
  },

  "tool failures: throw, unknown tool, invalid arguments, coercion": async (ctx) => {
    const seen: unknown[] = [];
    const script = new ScriptedModel([
      calls(["c1", "boom"], ["c2", "missing"], ["c3", "needs", {}], ["c4", "needs", { n: "5" }]),
      text("done"),
    ]);
    const boom = tool("boom", async () => {
      throw new Error("kaboom");
    });
    const needs = tool(
      "needs",
      async (args) => {
        seen.push(args.n);
        return `n=${String(args.n)} (${typeof args.n})`;
      },
      { type: "object", properties: { n: { type: "number" } }, required: ["n"] },
    );
    const s = await createContractSession({ ...ctx, script, tools: [boom, needs] });
    await s.prompt("go");
    await s.settle();
    const result = collect(s, script, { notes: { seen } });
    await s.dispose();
    return result;
  },

  "retry: one 429 then success": async (ctx) => {
    const script = new ScriptedModel([
      { kind: "error", message: "429 Too Many Requests" },
      text("ok now"),
    ]);
    const s = await createContractSession({ ...ctx, script });
    await s.prompt("go");
    await s.settle();
    const result = collect(s, script);
    await s.dispose();
    return result;
  },

  "retry: persistent 503 gives up after maxRetries": async (ctx) => {
    const failure: ScriptStep = { kind: "error", message: "503 service unavailable" };
    const script = new ScriptedModel([failure, failure, failure, failure, text("never")]);
    const s = await createContractSession({
      ...ctx,
      script,
      retry: { maxRetries: 3, baseDelayMs: 2 },
    });
    await s.prompt("go");
    await s.settle();
    const result = collect(s, script);
    await s.dispose();
    return result;
  },

  "non-retryable provider error": async (ctx) => {
    const script = new ScriptedModel([
      { kind: "error", message: "400 invalid request body" },
      text("next"),
    ]);
    const s = await createContractSession({ ...ctx, script });
    await s.prompt("go");
    await s.settle();
    await s.prompt("try again");
    await s.settle();
    const result = collect(s, script);
    await s.dispose();
    return result;
  },

  "overflow: compact once and retry": async (ctx) => {
    const script = new ScriptedModel([
      text("first answer"),
      { kind: "error", message: OVERFLOW },
      text("SUMMARY OF EARLIER TURNS"),
      text("recovered"),
    ]);
    const s = await createContractSession({ ...ctx, script, compaction: { keepRecentTokens: 1 } });
    await s.prompt("first question");
    await s.settle();
    await s.prompt("second question");
    await s.settle();
    const result = collect(s, script);
    await s.dispose();
    return result;
  },

  "overflow: second overflow after the retry is reported, not retried": async (ctx) => {
    const script = new ScriptedModel([
      text("first answer"),
      { kind: "error", message: OVERFLOW },
      text("SUMMARY"),
      { kind: "error", message: OVERFLOW },
      text("unreached"),
    ]);
    const s = await createContractSession({ ...ctx, script, compaction: { keepRecentTokens: 1 } });
    await s.prompt("first question");
    await s.settle();
    await s.prompt("second question");
    await s.settle();
    const result = collect(s, script);
    await s.dispose();
    return result;
  },

  "threshold compaction after a large turn": async (ctx) => {
    const script = new ScriptedModel([
      text("small"),
      text("big answer", 190_000),
      // keepRecentTokens 1 cuts inside the last turn: history summary + turn-prefix summary.
      text("HISTORY SUMMARY"),
      text("TURN PREFIX SUMMARY"),
      text("after"),
    ]);
    const s = await createContractSession({ ...ctx, script, compaction: { keepRecentTokens: 1 } });
    await s.prompt("q1");
    await s.settle();
    await s.prompt("q2");
    await s.settle();
    await s.prompt("q3");
    await s.settle();
    const result = collect(s, script);
    await s.dispose();
    return result;
  },

  "manual compaction, then 'Already compacted'": async (ctx) => {
    const script = new ScriptedModel([
      text("a1"),
      text("a2"),
      text("HISTORY SUMMARY"),
      text("TURN PREFIX SUMMARY"),
      text("a3"),
    ]);
    const s = await createContractSession({ ...ctx, script, compaction: { keepRecentTokens: 1 } });
    await s.prompt("q1");
    await s.settle();
    await s.prompt("q2");
    await s.settle();
    const errors: string[] = [];
    const first = (await s.compact("focus on decisions")) as {
      summary?: string;
      tokensBefore?: number;
    };
    await s.compact().catch((err: unknown) => errors.push(String((err as Error).message)));
    await s.settle();
    await s.prompt("q3");
    await s.settle();
    const result = collect(s, script, {
      errors,
      notes: { summary: first?.summary, hasTokensBefore: typeof first?.tokensBefore === "number" },
    });
    await s.dispose();
    return result;
  },

  "compaction disabled: no threshold or overflow compaction": async (ctx) => {
    const script = new ScriptedModel([
      text("big", 199_000),
      { kind: "error", message: OVERFLOW },
      text("unreached"),
    ]);
    const s = await createContractSession({ ...ctx, script, compaction: { enabled: false } });
    await s.prompt("q1");
    await s.settle();
    await s.prompt("q2");
    await s.settle();
    const result = collect(s, script);
    await s.dispose();
    return result;
  },

  "reload from disk continues the same transcript": async (ctx) => {
    const script = new ScriptedModel([calls(["c1", "a"]), text("turn one done"), text("turn two")]);
    const first = await createContractSession({ ...ctx, script, tools: [ok("a")] });
    await first.prompt("q1");
    await first.settle();
    await first.dispose();
    const second = await createContractSession({ ...ctx, script, tools: [ok("a")] });
    const restored = second.messages();
    await second.prompt("q2");
    await second.settle();
    const result = collect(second, script, { notes: { restored } });
    await second.dispose();
    return result;
  },

  "prompt while streaming is rejected": async (ctx) => {
    const script = new ScriptedModel([{ kind: "hang" }, text("unreached")]);
    const s = await createContractSession({ ...ctx, script });
    const running = s.prompt("go");
    await waitFor(() => s.session.isStreaming, "streaming");
    const errors: string[] = [];
    await s.prompt("again").catch((err: unknown) => errors.push(String((err as Error).message)));
    await s.abort();
    await running;
    await s.settle();
    const result = collect(s, script, { errors });
    await s.dispose();
    return result;
  },
};

const results = new Map<string, Result>();
async function run(name: string, variant: ContractVariant): Promise<Result> {
  const key = `${variant}::${name}`;
  let result = results.get(key);
  if (!result) {
    result = await scenarios[name]!({ variant, dir: tempDir() });
    results.set(key, result);
  }
  return result;
}

describe("runtime contract", () => {
  for (const name of Object.keys(scenarios)) {
    describe(name, () => {
      for (const variant of VARIANTS) {
        it(
          variant,
          async () => {
            const result = await run(name, variant);
            expect(
              result.notes.scriptRemaining,
              "unused script steps are part of the golden",
            ).toBeDefined();
            // The committed golden is the contract.
            expect(result).toMatchSnapshot();
          },
          30_000,
        );
      }
    });
  }
});
