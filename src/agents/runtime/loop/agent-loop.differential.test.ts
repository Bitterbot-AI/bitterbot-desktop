/**
 * PLAN-52 Phase 2: differential tests, owned Agent / agent loop vs
 * pi-agent-core 0.73.1.
 *
 * Every scenario runs twice with a scripted stream function (no network):
 * once through pi's `Agent`, once through ours with the four option-controlled
 * differences switched to pi's behaviour (`toolExecution` as pi resolves it,
 * `skipToolCallsOnSteering: false`, `skipToolCallsOnAbort: false`,
 * `abortBeforeModelCall: false`). Compared:
 * the full event sequence (type and payload, timestamps normalized), the
 * agent state seen by the listener at every event, what each model call
 * received, and the final `state`.
 *
 * This file goes away with the pi-agent-core dependency; `agent-loop.test.ts`
 * holds the tests that stay.
 */
import {
  Agent as PiAgent,
  agentLoop as piAgentLoop,
  agentLoopContinue as piAgentLoopContinue,
  runAgentLoop as piRunAgentLoop,
  runAgentLoopContinue as piRunAgentLoopContinue,
} from "@mariozechner/pi-agent-core";
import { AssistantMessageEventStream } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import {
  agentLoop as ourAgentLoop,
  agentLoopContinue as ourAgentLoopContinue,
  runAgentLoop as ourRunAgentLoop,
  runAgentLoopContinue as ourRunAgentLoopContinue,
} from "./agent-loop.js";
import { Agent as OurAgent } from "./agent.js";

type Json = Record<string, unknown>;
type AnyAgent = InstanceType<typeof OurAgent>;

const model = {
  id: "fake",
  name: "fake",
  api: "fake-api",
  provider: "fake",
  baseUrl: "",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1000,
  maxTokens: 100,
};
const usage = () => ({
  input: 1,
  output: 2,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 3,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const user = (text: string) => ({ role: "user", content: [{ type: "text", text }], timestamp: 2 });
const assistantMsg = (text: string, stopReason = "stop") => ({
  role: "assistant",
  content: [{ type: "text", text }],
  api: model.api,
  provider: model.provider,
  model: model.id,
  usage: usage(),
  stopReason,
  timestamp: 3,
});
const toolResultMsg = (id: string, text: string) => ({
  role: "toolResult",
  toolCallId: id,
  toolName: "a",
  content: [{ type: "text", text }],
  isError: false,
  timestamp: 4,
});

/** One scripted model response. */
type Turn = {
  text?: string;
  thinking?: string;
  tools?: Array<{ id: string; name: string; args?: Json }>;
  stopReason?: "stop" | "length" | "toolUse";
  /** Provider error after the optional text. */
  error?: string;
  /** Wait for the abort signal after the text delta, then end as aborted. */
  hang?: boolean;
  /** Do not emit `start`. */
  noStart?: boolean;
  /** The stream function throws. */
  throws?: string;
  /** End the stream with `end(result)` instead of a `done` event. */
  endWithResult?: boolean;
  onCall?: () => void;
};

type Seen = { messages: string[]; systemPrompt: unknown; tools: string[]; options: Json };

const OUR_OPTION_KEYS = new Set([
  "skipToolCallsOnSteering",
  "skipToolCallsOnAbort",
  "abortBeforeModelCall",
  "hasQueuedSteeringMessages",
]);

function describeMessage(m: Json): string {
  const content = (m.content ?? []) as Array<Json> | string;
  const text =
    typeof content === "string"
      ? content
      : content.map((c) => (c.type === "text" ? c.text : `<${String(c.type)}>`)).join("");
  if (m.role === "assistant") {
    return `assistant(${String(m.stopReason)}):${text}`;
  }
  if (m.role === "toolResult") {
    return `toolResult(${String(m.toolCallId)}${m.isError ? ",error" : ""}):${text}`;
  }
  return `${String(m.role)}:${text}`;
}

function scripted(script: Turn[], seen: Seen[]) {
  let index = 0;
  return (_model: unknown, context: Json, options: Json) => {
    const turn = script[index++] ?? { text: "done" };
    const signal = options?.signal as AbortSignal | undefined;
    seen.push({
      messages: (context.messages as Json[]).map(describeMessage),
      systemPrompt: context.systemPrompt,
      tools: ((context.tools as Json[]) ?? []).map((t) => String(t.name)),
      options: {
        keys: Object.keys(options)
          .filter((key) => !OUR_OPTION_KEYS.has(key))
          .toSorted(),
        reasoning: options.reasoning ?? null,
        sessionId: options.sessionId ?? null,
        transport: options.transport ?? null,
        apiKey: options.apiKey ?? null,
        maxRetryDelayMs: options.maxRetryDelayMs ?? null,
        thinkingBudgets: options.thinkingBudgets ?? null,
        toolExecution: options.toolExecution ?? null,
        aborted: signal?.aborted ?? null,
      },
    });
    turn.onCall?.();
    if (turn.throws) {
      throw new Error(turn.throws);
    }
    const stream = new AssistantMessageEventStream();
    const partial: Json = {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: usage(),
      stopReason: "stop",
      timestamp: 1,
    };
    const push = (event: Json) => stream.push(event as never);
    const fail = (reason: "aborted" | "error", errorMessage: string) =>
      push({ type: "error", reason, error: { ...partial, stopReason: reason, errorMessage } });
    void (async () => {
      if (signal?.aborted) {
        fail("aborted", "Request was aborted");
        return;
      }
      if (!turn.noStart) {
        push({ type: "start", partial: { ...partial } });
      }
      if (turn.thinking) {
        partial.content = [{ type: "thinking", thinking: turn.thinking }];
        push({ type: "thinking_start", contentIndex: 0, partial: { ...partial } });
        push({
          type: "thinking_delta",
          contentIndex: 0,
          delta: turn.thinking,
          partial: { ...partial },
        });
        push({
          type: "thinking_end",
          contentIndex: 0,
          content: turn.thinking,
          partial: { ...partial },
        });
      }
      if (turn.text) {
        const before = partial.content as Json[];
        const at = before.length;
        partial.content = [...before, { type: "text", text: "" }];
        push({ type: "text_start", contentIndex: at, partial: { ...partial } });
        partial.content = [...before, { type: "text", text: turn.text }];
        push({ type: "text_delta", contentIndex: at, delta: turn.text, partial: { ...partial } });
        if (turn.hang) {
          await new Promise((resolve) => signal?.addEventListener("abort", resolve));
          fail("aborted", "Request was aborted");
          return;
        }
        push({ type: "text_end", contentIndex: at, content: turn.text, partial: { ...partial } });
      }
      if (turn.error) {
        fail("error", turn.error);
        return;
      }
      for (const t of turn.tools ?? []) {
        const toolCall = { type: "toolCall", id: t.id, name: t.name, arguments: t.args ?? {} };
        partial.content = [...(partial.content as Json[]), toolCall];
        const at = (partial.content as Json[]).length - 1;
        push({ type: "toolcall_start", contentIndex: at, partial: { ...partial } });
        push({ type: "toolcall_end", contentIndex: at, toolCall, partial: { ...partial } });
      }
      const stopReason = turn.stopReason ?? (turn.tools?.length ? "toolUse" : "stop");
      const final = { ...partial, stopReason };
      if (turn.endWithResult) {
        stream.end(final as never);
        return;
      }
      push({ type: "done", reason: stopReason, message: final });
    })();
    return stream;
  };
}

const schema = { type: "object", properties: { n: { type: "number" } }, required: [] };
type Execute = (
  id: string,
  args: Json,
  signal: AbortSignal | undefined,
  onUpdate: (partial: Json) => void,
) => Promise<unknown>;
const tool = (name: string, execute?: Execute, extra: Json = {}) => ({
  name,
  label: name,
  description: name,
  parameters: schema,
  execute:
    execute ??
    (async (_id: string, args: Json) => ({
      content: [{ type: "text", text: `${name}:${JSON.stringify(args)}` }],
      details: { ok: true },
    })),
  ...extra,
});
const ok = (text: string, extra: Json = {}) => ({
  content: [{ type: "text", text }],
  details: {},
  ...extra,
});

/** JSON copy with every `timestamp` set to 0. */
function normalize(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (key, v) => (key === "timestamp" && typeof v === "number" ? 0 : v)) ??
      "null",
  );
}

type Harness = {
  kind: "pi" | "ours";
  seen: Seen[];
  events: unknown[];
  log: string[];
  /** Create an agent wired to the recorder; `script` becomes its stream function. */
  agent: (options: Json, script: Turn[]) => AnyAgent;
  /** Loop config with the parity flags for the low-level functions. */
  config: (config: Json) => never;
  run: {
    runAgentLoop: typeof ourRunAgentLoop;
    runAgentLoopContinue: typeof ourRunAgentLoopContinue;
    agentLoop: typeof ourAgentLoop;
    agentLoopContinue: typeof ourAgentLoopContinue;
  };
  /** Run `fn`; a throw is written to the log instead of failing the scenario. */
  attempt: (label: string, fn: () => unknown) => Promise<void>;
  stream: (script: Turn[]) => never;
};

async function runScenario(kind: "pi" | "ours", scenario: (h: Harness) => Promise<unknown>) {
  const agents: AnyAgent[] = [];
  const h: Harness = {
    kind,
    seen: [],
    events: [],
    log: [],
    agent: (options, script) => {
      const parity =
        kind === "ours"
          ? {
              toolExecution: options.toolExecution ?? "parallel",
              skipToolCallsOnSteering: false,
              skipToolCallsOnAbort: false,
              abortBeforeModelCall: false,
            }
          : {};
      const initialState = { model, ...(options.initialState as Json | undefined) };
      const Ctor = (kind === "ours" ? OurAgent : PiAgent) as unknown as typeof OurAgent;
      const agent = new Ctor({
        streamFn: scripted(script, h.seen),
        ...options,
        ...parity,
        initialState,
      } as never);
      agent.subscribe((event, signal) => {
        const streaming = agent.state.streamingMessage as Json | undefined;
        h.events.push({
          event: normalize(event),
          state: {
            isStreaming: agent.state.isStreaming,
            streaming: streaming ? describeMessage(streaming) : null,
            pending: [...agent.state.pendingToolCalls],
            messages: agent.state.messages.length,
            errorMessage: agent.state.errorMessage ?? null,
          },
          aborted: signal.aborted,
          sameSignal: signal === agent.signal,
        });
      });
      agents.push(agent);
      return agent;
    },
    config: (config) =>
      ({
        model,
        convertToLlm: (messages: unknown[]) => messages,
        // pi's default, spelled out for both so the stream options match.
        toolExecution: "parallel",
        ...config,
        ...(kind === "ours"
          ? {
              skipToolCallsOnSteering: false,
              skipToolCallsOnAbort: false,
              abortBeforeModelCall: false,
            }
          : {}),
      }) as never,
    run:
      kind === "ours"
        ? {
            runAgentLoop: ourRunAgentLoop,
            runAgentLoopContinue: ourRunAgentLoopContinue,
            agentLoop: ourAgentLoop,
            agentLoopContinue: ourAgentLoopContinue,
          }
        : ({
            runAgentLoop: piRunAgentLoop,
            runAgentLoopContinue: piRunAgentLoopContinue,
            agentLoop: piAgentLoop,
            agentLoopContinue: piAgentLoopContinue,
          } as never),
    attempt: async (label, fn) => {
      try {
        await fn();
        h.log.push(`${label}: ok`);
      } catch (error) {
        h.log.push(`${label}: THROW ${error instanceof Error ? error.message : String(error)}`);
      }
    },
    stream: (script) => scripted(script, h.seen) as never,
  };
  const extra = await scenario(h);
  return {
    extra: normalize(extra ?? null),
    events: h.events,
    log: h.log,
    seen: h.seen,
    agents: agents.map((agent) => ({
      messages: normalize(agent.state.messages),
      described: (agent.state.messages as unknown as Json[]).map(describeMessage),
      isStreaming: agent.state.isStreaming,
      streamingMessage: agent.state.streamingMessage ?? null,
      pending: [...agent.state.pendingToolCalls],
      errorMessage: agent.state.errorMessage ?? null,
      queued: agent.hasQueuedMessages(),
      signal: agent.signal ?? null,
    })),
  };
}

/** Run a scenario through both implementations and require equal outcomes. */
function differential(
  name: string,
  scenario: (h: Harness) => Promise<unknown>,
  check?: (outcome: Awaited<ReturnType<typeof runScenario>>) => void,
) {
  it(name, async () => {
    const pi = await runScenario("pi", scenario);
    const ours = await runScenario("ours", scenario);
    expect(ours).toEqual(pi);
    // Guard against a scenario that records nothing on either side.
    expect(pi.events.length + pi.log.length).toBeGreaterThan(0);
    check?.(pi);
  });
}

const eventTypes = (outcome: { events: unknown[] }) =>
  outcome.events.map((e) => ((e as Json).event as Json).type as string);

describe("differential: plain turns", () => {
  differential(
    "plain text",
    async (h) => {
      const agent = h.agent({ initialState: { systemPrompt: "sys" } }, [{ text: "hi" }]);
      await agent.prompt("hello");
    },
    (pi) => {
      expect(eventTypes(pi)).toEqual([
        "agent_start",
        "turn_start",
        "message_start",
        "message_end",
        "message_start",
        "message_update",
        "message_update",
        "message_update",
        "message_end",
        "turn_end",
        "agent_end",
      ]);
    },
  );

  differential("thinking, images, message arrays, two runs on one agent", async (h) => {
    const agent = h.agent({}, [{ thinking: "hm", text: "one" }, { text: "two" }, { text: "3" }]);
    await agent.prompt("look", [{ type: "image", data: "AAAA", mimeType: "image/png" }]);
    await agent.prompt([user("a"), user("b")] as never);
    await agent.prompt(user("single") as never);
  });

  differential("stream options and per-call key resolution", async (h) => {
    let keys = 0;
    const agent = h.agent(
      {
        initialState: { thinkingLevel: "high" },
        sessionId: "sess",
        transport: "sse",
        maxRetryDelayMs: 1234,
        thinkingBudgets: { low: 10 },
        getApiKey: (provider: string) => `key-${provider}-${++keys}`,
      },
      [{ tools: [{ id: "c1", name: "a" }] }, { text: "done" }],
    );
    agent.state.tools = [tool("a")] as never;
    await agent.prompt("go");
    agent.state.thinkingLevel = "off";
    await agent.prompt("again");
  });

  differential("stopReason length still executes tool calls", async (h) => {
    const agent = h.agent({ initialState: { tools: [tool("a")] } }, [
      { text: "cut", tools: [{ id: "c1", name: "a" }], stopReason: "length" },
      { text: "done" },
    ]);
    await agent.prompt("go");
  });

  differential("stream without start, and stream ended with end(result)", async (h) => {
    const agent = h.agent({}, [
      { text: "no start", noStart: true },
      { text: "ended", endWithResult: true },
      { text: "ended, no start", endWithResult: true, noStart: true },
    ]);
    await agent.prompt("one");
    await agent.prompt("two");
    await agent.prompt("three");
  });
});

describe("differential: tools", () => {
  differential("two tools, sequential, with updates", async (h) => {
    const order: string[] = [];
    const agent = h.agent(
      {
        toolExecution: "sequential",
        initialState: {
          tools: [
            tool("a", async (_id, _args, _signal, onUpdate) => {
              order.push("a:start");
              onUpdate(ok("half"));
              await sleep(5);
              onUpdate(ok("almost"));
              order.push("a:end");
              return ok("A", { details: { d: 1 } });
            }),
            tool("b", async () => {
              order.push("b:start");
              return ok("B");
            }),
          ],
        },
      },
      [
        {
          text: "calling",
          tools: [
            { id: "c1", name: "a", args: { n: 1 } },
            { id: "c2", name: "b" },
          ],
        },
        { text: "done" },
      ],
    );
    await agent.prompt("go");
    return order;
  });

  differential("three tools, parallel, out-of-order completion", async (h) => {
    const order: string[] = [];
    const timed = (name: string, ms: number) =>
      tool(name, async (_id, _args, _signal, onUpdate) => {
        order.push(`${name}:start`);
        onUpdate(ok(`${name} running`));
        await sleep(ms);
        order.push(`${name}:end`);
        return ok(name);
      });
    const agent = h.agent(
      { initialState: { tools: [timed("a", 40), timed("b", 5), timed("c", 20)] } },
      [
        {
          tools: [
            { id: "c1", name: "a" },
            { id: "c2", name: "b" },
            { id: "c3", name: "missing" },
            { id: "c4", name: "c" },
          ],
        },
        { text: "done" },
      ],
    );
    await agent.prompt("go");
    return order;
  });

  differential("a sequential tool forces a parallel batch sequential", async (h) => {
    const order: string[] = [];
    const timed = (name: string, ms: number, extra: Json = {}) =>
      tool(
        name,
        async () => {
          order.push(`${name}:start`);
          await sleep(ms);
          order.push(`${name}:end`);
          return ok(name);
        },
        extra,
      );
    const agent = h.agent(
      {
        initialState: {
          tools: [timed("a", 15), timed("b", 1, { executionMode: "sequential" })],
        },
      },
      [
        {
          tools: [
            { id: "c1", name: "a" },
            { id: "c2", name: "b" },
          ],
        },
        { text: "done" },
      ],
    );
    await agent.prompt("go");
    return order;
  });

  for (const toolExecution of ["sequential", "parallel"]) {
    differential(`tool errors, coercion, prepareArguments (${toolExecution})`, async (h) => {
      const received: unknown[] = [];
      const echo = tool("echo", async (_id, args) => {
        received.push(args);
        return ok(JSON.stringify(args));
      });
      const strict = {
        ...echo,
        name: "strict",
        parameters: {
          type: "object",
          properties: { n: { type: "number" }, flag: { type: "boolean" } },
          required: ["n"],
        },
      };
      const renamed = {
        ...echo,
        name: "renamed",
        prepareArguments: (args: Json) => ({ n: args.count }),
      };
      const sameArgs = { ...echo, name: "same", prepareArguments: (args: Json) => args };
      const badPrepare = {
        ...echo,
        name: "badPrepare",
        prepareArguments: () => {
          throw new Error("prepare failed");
        },
      };
      const agent = h.agent(
        {
          toolExecution,
          initialState: {
            tools: [
              echo,
              strict,
              renamed,
              sameArgs,
              badPrepare,
              tool("boom", async () => {
                throw new Error("exploded");
              }),
              tool("boomString", async () => {
                throw "plain string";
              }),
            ],
          },
        },
        [
          {
            tools: [
              { id: "c1", name: "boom" },
              { id: "c2", name: "boomString" },
              { id: "c3", name: "missing", args: { x: 1 } },
              { id: "c4", name: "strict", args: {} },
              { id: "c5", name: "strict", args: { n: "not a number" } },
              { id: "c6", name: "strict", args: { n: "5", flag: "true" } },
              { id: "c7", name: "renamed", args: { count: "7" } },
              { id: "c8", name: "same", args: { n: 8 } },
              { id: "c9", name: "badPrepare" },
              { id: "c10", name: "echo", args: { n: 10, extra: "kept" } },
            ],
          },
          { text: "done" },
        ],
      );
      await agent.prompt("go");
      return received;
    });

    differential(`beforeToolCall and afterToolCall (${toolExecution})`, async (h) => {
      const hooks: unknown[] = [];
      const agent = h.agent(
        {
          toolExecution,
          initialState: {
            tools: [
              tool("a"),
              tool("t", async () => ok("T", { terminate: true, details: { from: "tool" } })),
            ],
          },
          beforeToolCall: async (context: Json, signal: AbortSignal) => {
            const toolCall = context.toolCall as Json;
            hooks.push({
              hook: "before",
              id: toolCall.id,
              args: context.args,
              raw: toolCall.arguments,
              assistant: describeMessage(context.assistantMessage as Json),
              contextMessages: ((context.context as Json).messages as Json[]).length,
              hasSignal: signal instanceof AbortSignal,
            });
            switch (toolCall.id) {
              case "c1":
                return { block: true, reason: "not allowed" };
              case "c2":
                return { block: true };
              case "c3":
                throw new Error("before failed");
              case "c4":
                return { block: false, reason: "ignored" };
              case "c5":
                // Not a block: the returned arguments are ignored.
                return { args: { n: 99 } };
              default:
                return undefined;
            }
          },
          afterToolCall: async (context: Json) => {
            const toolCall = context.toolCall as Json;
            hooks.push({
              hook: "after",
              id: toolCall.id,
              args: context.args,
              result: context.result,
              isError: context.isError,
            });
            switch (toolCall.id) {
              case "c5":
                return { content: [{ type: "text", text: "replaced" }] };
              case "c6":
                return { details: { replaced: true }, isError: true };
              case "c7":
                throw new Error("after failed");
              case "c8":
                return { terminate: false };
              case "c9":
                return { isError: false, content: [{ type: "text", text: "rescued" }] };
              default:
                return undefined;
            }
          },
        },
        [
          {
            tools: [
              { id: "c1", name: "a" },
              { id: "c2", name: "a" },
              { id: "c3", name: "a" },
              { id: "c4", name: "a", args: { n: "4" } },
              { id: "c5", name: "a", args: { n: 5 } },
              { id: "c6", name: "a" },
              { id: "c7", name: "a" },
              { id: "c8", name: "t" },
              { id: "c9", name: "missingButNoAfterHook" },
              { id: "c10", name: "a" },
            ],
          },
          { text: "done" },
        ],
      );
      await agent.prompt("go");
      return hooks;
    });
  }

  differential("terminate: all results, mixed, and with a queued follow-up", async (h) => {
    const stop = tool("stop", async () => ok("stopping", { terminate: true }));
    const all = h.agent({ initialState: { tools: [stop, tool("a")] } }, [
      {
        tools: [
          { id: "c1", name: "stop" },
          { id: "c2", name: "stop" },
        ],
      },
      { text: "never" },
    ]);
    await all.prompt("all terminate");

    const mixed = h.agent({ initialState: { tools: [stop, tool("a")] } }, [
      {
        tools: [
          { id: "c1", name: "stop" },
          { id: "c2", name: "a" },
        ],
      },
      { text: "continued" },
    ]);
    await mixed.prompt("mixed");

    const queued = h.agent({ initialState: { tools: [stop] } }, [
      { tools: [{ id: "c1", name: "stop" }] },
      { text: "after follow-up" },
    ]);
    queued.followUp(user("follow") as never);
    await queued.prompt("terminate then follow-up");

    const viaHook = h.agent(
      { initialState: { tools: [tool("a")] }, afterToolCall: async () => ({ terminate: true }) },
      [{ tools: [{ id: "c1", name: "a" }] }, { text: "never" }],
    );
    await viaHook.prompt("terminate via hook");
  });
});

describe("differential: steering and follow-up", () => {
  for (const toolExecution of ["sequential", "parallel"]) {
    differential(
      `steering during a tool batch runs the whole batch (${toolExecution})`,
      async (h) => {
        const order: string[] = [];
        let agent: AnyAgent | undefined;
        const track = (name: string, onRun?: () => void) =>
          tool(name, async () => {
            order.push(name);
            onRun?.();
            await sleep(2);
            return ok(name);
          });
        agent = h.agent(
          {
            toolExecution,
            initialState: {
              tools: [
                track("a", () => agent?.steer(user("stop") as never)),
                track("b"),
                track("c"),
              ],
            },
          },
          [
            {
              tools: [
                { id: "c1", name: "a" },
                { id: "c2", name: "b" },
                { id: "c3", name: "c" },
              ],
            },
            { text: "ok, stopping" },
          ],
        );
        await agent.prompt("go");
        return order;
      },
    );
  }

  for (const mode of ["one-at-a-time", "all"]) {
    differential(`queued before prompt, steering then follow-up (${mode})`, async (h) => {
      const agent = h.agent({ steeringMode: mode, followUpMode: mode }, [
        { text: "1" },
        { text: "2" },
        { text: "3" },
        { text: "4" },
        { text: "5" },
      ]);
      agent.steer(user("s1") as never);
      agent.steer(user("s2") as never);
      agent.followUp(user("f1") as never);
      agent.followUp(user("f2") as never);
      h.log.push(`modes ${agent.steeringMode} ${agent.followUpMode} ${agent.hasQueuedMessages()}`);
      await agent.prompt("go");
      h.log.push(`queued after: ${agent.hasQueuedMessages()}`);
    });
  }

  differential("follow-up and steering queued during a run, mode switched", async (h) => {
    let agent: AnyAgent | undefined;
    agent = h.agent({ initialState: { tools: [tool("a")] } }, [
      {
        tools: [{ id: "c1", name: "a" }],
        onCall: () => {
          agent?.followUp(user("f1") as never);
          agent?.followUp(user("f2") as never);
        },
      },
      { text: "after tool", onCall: () => agent?.steer(user("s1") as never) },
      { text: "after steer" },
      { text: "after follow-ups" },
    ]);
    agent.followUpMode = "all";
    await agent.prompt("go");
  });

  differential("queue management outside a run", async (h) => {
    const agent = h.agent({}, [{ text: "1" }, { text: "2" }]);
    agent.steer(user("s") as never);
    agent.followUp(user("f") as never);
    h.log.push(`queued ${agent.hasQueuedMessages()}`);
    agent.clearSteeringQueue();
    h.log.push(`after clearSteering ${agent.hasQueuedMessages()}`);
    agent.clearFollowUpQueue();
    h.log.push(`after clearFollowUp ${agent.hasQueuedMessages()}`);
    agent.steer(user("s") as never);
    agent.followUp(user("f") as never);
    agent.clearAllQueues();
    h.log.push(`after clearAll ${agent.hasQueuedMessages()}`);
    agent.steeringMode = "all";
    h.log.push(`modes ${agent.steeringMode} ${agent.followUpMode}`);
    await agent.prompt("go");
    agent.steer(user("late") as never);
    agent.reset();
    h.log.push(`after reset ${agent.hasQueuedMessages()} ${agent.state.messages.length}`);
    await agent.prompt("again");
  });
});

describe("differential: abort and failures", () => {
  differential("abort mid-stream", async (h) => {
    const agent = h.agent({}, [{ text: "partial", hang: true }]);
    agent.followUp(user("left in queue") as never);
    const order: string[] = [];
    agent.subscribe(async (event) => {
      if (event.type === "agent_end") {
        await sleep(5);
        order.push("agent_end listener done");
      }
    });
    const run = agent.prompt("go");
    await sleep(5);
    h.log.push(`signal before abort: ${agent.signal?.aborted}`);
    agent.abort();
    await agent.waitForIdle();
    order.push("idle");
    await run;
    agent.abort();
    return order;
  });

  for (const toolExecution of ["sequential", "parallel"]) {
    differential(`abort mid-tool runs the remaining calls (${toolExecution})`, async (h) => {
      const order: string[] = [];
      let agent: AnyAgent | undefined;
      agent = h.agent(
        {
          toolExecution,
          initialState: {
            tools: [
              tool("slow", async (_id, _args, signal) => {
                order.push("slow:start");
                await sleep(2);
                agent?.abort();
                await sleep(2);
                if (signal?.aborted) {
                  throw new Error("slow aborted");
                }
                return ok("slow");
              }),
              tool("next", async (_id, _args, signal) => {
                order.push(`next:start aborted=${signal?.aborted}`);
                await sleep(8);
                return ok(`next ran, aborted=${signal?.aborted}`);
              }),
            ],
          },
        },
        [
          {
            tools: [
              { id: "c1", name: "slow" },
              { id: "c2", name: "next" },
            ],
          },
          { text: "never streamed" },
        ],
      );
      await agent.prompt("go");
      return order;
    });
  }

  differential("stream function throws on the first and on a later call", async (h) => {
    const first = h.agent({}, [{ throws: "no auth" }, { text: "recovered" }]);
    await h.attempt("first", () => first.prompt("go"));
    await h.attempt("retry", () => first.continue());

    const later = h.agent({ initialState: { tools: [tool("a")] } }, [
      { tools: [{ id: "c1", name: "a" }] },
      { throws: "second call failed" },
    ]);
    await h.attempt("later", () => later.prompt("go"));
  });

  differential("convertToLlm, transformContext and getApiKey throw", async (h) => {
    const convert = h.agent(
      {
        convertToLlm: () => {
          throw new Error("convert failed");
        },
      },
      [{ text: "never" }],
    );
    await h.attempt("convertToLlm", () => convert.prompt("go"));

    const transform = h.agent(
      {
        transformContext: async () => {
          throw new Error("transform failed");
        },
      },
      [{ text: "never" }],
    );
    await h.attempt("transformContext", () => transform.prompt("go"));

    const apiKey = h.agent(
      {
        getApiKey: () => {
          throw "key failed";
        },
      },
      [{ text: "never" }],
    );
    await h.attempt("getApiKey", () => apiKey.prompt("go"));
  });

  differential("a throw after abort gives an aborted failure message", async (h) => {
    let agent: AnyAgent | undefined;
    agent = h.agent({}, [
      {
        onCall: () => agent?.abort(),
        throws: "thrown after abort",
      },
    ]);
    await h.attempt("prompt", () => agent.prompt("go"));
  });

  differential("provider error leaves the queues alone", async (h) => {
    const agent = h.agent({}, [{ text: "some text", error: "overloaded" }, { text: "next" }]);
    agent.followUp(user("queued follow-up") as never);
    await agent.prompt("go");
    h.log.push(`queued: ${agent.hasQueuedMessages()}`);
    await h.attempt("continue runs the queued follow-up", () => agent.continue());
  });

  differential("listener throws", async (h) => {
    const once = h.agent({ initialState: { tools: [tool("a")] } }, [
      { tools: [{ id: "c1", name: "a" }] },
      { text: "never" },
    ]);
    let thrown = false;
    once.subscribe((event) => {
      if (event.type === "tool_execution_end" && !thrown) {
        thrown = true;
        throw new Error("listener failed");
      }
    });
    await h.attempt("once", () => once.prompt("go"));

    const onEnd = h.agent({}, [{ text: "fine" }]);
    let ends = 0;
    onEnd.subscribe((event) => {
      if (event.type === "agent_end" && ++ends === 1) {
        throw new Error("agent_end listener failed");
      }
    });
    await h.attempt("first agent_end", () => onEnd.prompt("go"));

    const always = h.agent({}, [{ text: "fine" }]);
    always.subscribe((event) => {
      if (event.type === "agent_end") {
        throw new Error("always fails");
      }
    });
    await h.attempt("every agent_end", () => always.prompt("go"));
    h.log.push(`idle after rejection: ${always.state.isStreaming} ${always.signal === undefined}`);

    const inUpdate = h.agent(
      {
        toolExecution: "sequential",
        initialState: {
          tools: [
            tool("u", async (_id, _args, _signal, onUpdate) => {
              onUpdate(ok("partial"));
              return ok("U");
            }),
          ],
        },
      },
      [{ tools: [{ id: "c1", name: "u" }] }, { text: "never" }],
    );
    inUpdate.subscribe((event) => {
      if (event.type === "tool_execution_update") {
        throw new Error("update listener failed");
      }
    });
    await h.attempt("update", () => inUpdate.prompt("go"));
  });
});

describe("differential: continue, concurrency, state", () => {
  differential("continue() preconditions and branches", async (h) => {
    const empty = h.agent({}, []);
    await h.attempt("empty", () => empty.continue());

    const assistantLast = h.agent({ initialState: { messages: [user("q"), assistantMsg("a")] } }, [
      { text: "steered" },
      { text: "followed" },
      { text: "second steer" },
    ]);
    await h.attempt("assistant last, empty queues", () => assistantLast.continue());
    assistantLast.steer(user("s1") as never);
    assistantLast.steer(user("s2") as never);
    assistantLast.followUp(user("f1") as never);
    await h.attempt("assistant last, steering", () => assistantLast.continue());
    await h.attempt("assistant last, follow-up", () => assistantLast.continue());
    await h.attempt("assistant last, nothing left", () => assistantLast.continue());

    const userLast = h.agent({ initialState: { messages: [user("pending")] } }, [{ text: "r" }]);
    userLast.steer(user("polled at start") as never);
    await h.attempt("user last", () => userLast.continue());

    const toolResultLast = h.agent(
      {
        initialState: {
          messages: [
            user("q"),
            {
              ...assistantMsg("", "toolUse"),
              content: [{ type: "toolCall", id: "c1", name: "a", arguments: {} }],
            },
            toolResultMsg("c1", "result"),
          ],
        },
      },
      [{ text: "r" }],
    );
    await h.attempt("toolResult last", () => toolResultLast.continue());
  });

  differential("prompt() and continue() during a run throw", async (h) => {
    const agent = h.agent({}, [{ text: "partial", hang: true }, { text: "second" }]);
    const run = agent.prompt("go");
    await sleep(2);
    await h.attempt("prompt during run", () => agent.prompt("again"));
    await h.attempt("continue during run", () => agent.continue());
    h.log.push(`streaming ${agent.state.isStreaming}`);
    agent.abort();
    await run;
    await h.attempt("prompt after run", () => agent.prompt("again"));
  });

  differential("snapshot: changes during a run apply to the next run", async (h) => {
    let agent: AnyAgent | undefined;
    const replacement = h.stream([{ text: "from the replaced stream" }]);
    agent = h.agent({ initialState: { systemPrompt: "first", tools: [tool("a")] } }, [
      { tools: [{ id: "c1", name: "a" }] },
      { text: "still the first stream" },
    ]);
    agent.subscribe((event) => {
      if (event.type === "tool_execution_end" && agent) {
        agent.state.systemPrompt = "second";
        agent.state.messages = [user("replaced history") as never];
        agent.state.tools = [tool("b")] as never;
        agent.state.model = { ...model, id: "other" } as never;
        agent.streamFn = replacement;
        agent.sessionId = "changed";
        agent.transformContext = async (messages) => messages.slice(-1);
      }
    });
    await agent.prompt("go");
    await agent.prompt("next");
  });

  differential("state setters copy, getters are live, reset", async (h) => {
    const agent = h.agent({}, [{ text: "r" }]);
    const messages = [user("m1")];
    const tools = [tool("a")];
    agent.state.messages = messages as never;
    agent.state.tools = tools as never;
    messages.push(user("not in state"));
    tools.push(tool("b"));
    h.log.push(`copied: ${agent.state.messages.length} ${agent.state.tools.length}`);
    agent.state.messages.push(user("m2") as never);
    h.log.push(`live: ${agent.state.messages.length}`);
    await agent.prompt("go");
    h.log.push(`default model: ${agent.state.model.id}`);
    agent.reset();
    h.log.push(
      `reset: ${agent.state.messages.length} ${agent.state.tools.length} ${agent.state.isStreaming}`,
    );
  });

  differential("default state, default convertToLlm, transformContext per call", async (h) => {
    const defaults = h.agent({ initialState: { model: undefined } }, []);
    h.log.push(
      JSON.stringify({
        systemPrompt: defaults.state.systemPrompt,
        model: defaults.state.model,
        thinkingLevel: defaults.state.thinkingLevel,
        tools: defaults.state.tools,
        messages: defaults.state.messages,
        transport: defaults.transport,
        steeringMode: defaults.steeringMode,
        followUpMode: defaults.followUpMode,
      }),
    );

    const transformed: number[] = [];
    const agent = h.agent(
      {
        initialState: {
          tools: [tool("a")],
          messages: [{ role: "note", text: "custom role", timestamp: 1 }, user("old")],
        },
        transformContext: async (messages: Json[], signal: AbortSignal) => {
          transformed.push(messages.length);
          h.log.push(`transform signal ${signal instanceof AbortSignal}`);
          return messages.filter((m) => m.role !== "user" || describeMessage(m) !== "user:old");
        },
      },
      [{ tools: [{ id: "c1", name: "a" }] }, { text: "done" }],
    );
    await agent.prompt("go");
    return transformed;
  });

  differential("message_end carries the stored object, message_start a copy", async (h) => {
    const agent = h.agent({ initialState: { tools: [tool("a")] } }, [
      { text: "x", tools: [{ id: "c1", name: "a" }] },
      { text: "done" },
    ]);
    const identity: string[] = [];
    let lastStart: unknown;
    agent.subscribe((event) => {
      if (event.type === "message_start") {
        lastStart = event.message;
      }
      if (event.type === "message_end") {
        const stored = agent.state.messages[agent.state.messages.length - 1];
        identity.push(
          `${event.message.role} stored=${stored === event.message} start=${lastStart === event.message}`,
        );
        (event.message as unknown as Json).mutatedByListener = true;
      }
    });
    await agent.prompt("go");
    return identity;
  });

  differential("multiple listeners, unsubscribe, waitForIdle", async (h) => {
    const agent = h.agent({}, [{ text: "1" }, { text: "2" }]);
    const order: string[] = [];
    const off = agent.subscribe(async (event) => {
      await sleep(1);
      order.push(`slow:${event.type}`);
    });
    agent.subscribe((event) => {
      order.push(`fast:${event.type}`);
    });
    await agent.waitForIdle();
    order.push("idle before run");
    const run = agent.prompt("go");
    const idle = agent.waitForIdle().then(() => order.push("idle"));
    await run;
    order.push("prompt resolved");
    await idle;
    off();
    await agent.prompt("again");
    return order;
  });
});

describe("differential: low-level loop functions", () => {
  const collect = (events: unknown[]) => (event: unknown) => {
    events.push(normalize(event));
  };

  differential("runAgentLoop with shouldStopAfterTurn", async (h) => {
    const context = { systemPrompt: "sys", messages: [user("old")], tools: [tool("a")] };
    const stops: unknown[] = [];
    const messages = await h.run.runAgentLoop(
      [user("go")] as never,
      context as never,
      h.config({
        getSteeringMessages: async () => {
          h.log.push("steering polled");
          return [];
        },
        getFollowUpMessages: async () => {
          h.log.push("follow-up polled");
          return [];
        },
        shouldStopAfterTurn: (stop: Json) => {
          stops.push({
            message: describeMessage(stop.message as Json),
            toolResults: (stop.toolResults as Json[]).length,
            context: ((stop.context as Json).messages as Json[]).length,
            newMessages: (stop.newMessages as Json[]).length,
          });
          return stops.length === 2;
        },
      }),
      collect(h.events),
      undefined,
      h.stream([
        { tools: [{ id: "c1", name: "a" }] },
        { tools: [{ id: "c2", name: "a" }] },
        { text: "never" },
      ]),
    );
    return { messages, stops, contextUntouched: context.messages.length };
  });

  differential("runAgentLoop without optional callbacks, api key fallback", async (h) => {
    const messages = await h.run.runAgentLoop(
      [user("go")] as never,
      { systemPrompt: "", messages: [] } as never,
      h.config({ apiKey: "static-key", getApiKey: () => undefined }),
      collect(h.events),
      undefined,
      h.stream([{ tools: [{ id: "c1", name: "no tools at all" }] }, { text: "done" }]),
    );
    return messages;
  });

  differential("runAgentLoopContinue appends to the given context", async (h) => {
    const context = { systemPrompt: "", messages: [user("pending")], tools: [] };
    await h.attempt("empty", () =>
      h.run.runAgentLoopContinue(
        { systemPrompt: "", messages: [] } as never,
        h.config({}),
        collect(h.events),
      ),
    );
    await h.attempt("assistant last", () =>
      h.run.runAgentLoopContinue(
        { systemPrompt: "", messages: [assistantMsg("a")] } as never,
        h.config({}),
        collect(h.events),
      ),
    );
    const messages = await h.run.runAgentLoopContinue(
      context as never,
      h.config({}),
      collect(h.events),
      undefined,
      h.stream([{ text: "r" }]),
    );
    return { messages, context: context.messages.map((m) => describeMessage(m as Json)) };
  });

  differential("agentLoop and agentLoopContinue streams", async (h) => {
    const stream = h.run.agentLoop(
      [user("go")] as never,
      { systemPrompt: "", messages: [], tools: [tool("a")] } as never,
      h.config({}),
      undefined,
      h.stream([{ tools: [{ id: "c1", name: "a" }] }, { text: "done" }]),
    );
    for await (const event of stream) {
      h.events.push(normalize(event));
    }
    const result = await stream.result();

    const continued = h.run.agentLoopContinue(
      { systemPrompt: "", messages: [user("pending")] } as never,
      h.config({}),
      undefined,
      h.stream([{ text: "r" }]),
    );
    for await (const event of continued) {
      h.events.push(normalize(event));
    }
    await h.attempt("agentLoopContinue on empty context", () =>
      h.run.agentLoopContinue({ systemPrompt: "", messages: [] } as never, h.config({})),
    );
    return { result, continued: await continued.result() };
  });
});
