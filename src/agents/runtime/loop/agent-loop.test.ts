/**
 * PLAN-52 Phase 2: contract tests for the owned Agent and agent loop, with a
 * scripted stream function (no network). They pin the event order, the state
 * the listeners see, the snapshot semantics, and the deliberate differences
 * from pi-agent-core listed in `agent-loop.ts`. Parity with pi itself is
 * checked in `agent-loop.differential.test.ts`.
 */
import { AssistantMessageEventStream } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import {
  ABORTED_BEFORE_MODEL_CALL,
  agentLoop,
  createFailureMessage,
  runAgentLoop,
  runAgentLoopContinue,
  STREAM_ENDED_MESSAGE,
} from "./agent-loop.js";
import { Agent } from "./agent.js";
import type { AgentEvent } from "./events.js";
import { PendingMessageQueue } from "./queues.js";
import { ABORT_SKIP_REASON, STEERING_SKIP_REASON } from "./tool-execution.js";

type Json = Record<string, unknown>;

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
/**
 * Yield one macrotask. Every pending microtask runs first, so all events of a
 * tool that has just settled are emitted before the caller goes on.
 */
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * Fixes the order in which concurrently running tool bodies finish, without
 * timers (timer order is a race on a loaded or coarse-clocked machine).
 * `turn(name)` resolves once the name before it has called `done` and one
 * macrotask has passed; a tool body awaits its turn, then calls `done` right
 * before it returns or throws. When the tools run one after the other the
 * earlier names are done already and only the macrotask remains.
 */
function finishOrder(...names: string[]) {
  const gates = names.map(() => {
    let open = () => {};
    const opened = new Promise<void>((resolve) => {
      open = resolve;
    });
    return { opened, open };
  });
  return {
    turn: async (name: string) => {
      const previous = gates[names.indexOf(name) - 1];
      if (previous) {
        await previous.opened;
      }
      await tick();
    },
    done: (name: string) => {
      gates[names.indexOf(name)]?.open();
    },
  };
}
const user = (text: string) =>
  ({ role: "user", content: [{ type: "text", text }], timestamp: 2 }) as never;
const assistantMsg = (text: string) =>
  ({
    role: "assistant",
    content: [{ type: "text", text }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: usage(),
    stopReason: "stop",
    timestamp: 3,
  }) as never;

/** One scripted model response. */
type Turn = {
  text?: string;
  tools?: Array<{ id: string; name: string; args?: Json }>;
  /** Provider error after the optional text. */
  error?: string;
  /** Wait for the abort signal after the text delta, then end as aborted. */
  hang?: boolean;
  /** Do not emit `start`. */
  noStart?: boolean;
  /** The stream function throws. */
  throws?: string;
  /** End the stream without a `done` event and without a result. */
  endBare?: boolean;
  /** Stream normally even if the signal is already aborted. */
  ignoreAbort?: boolean;
  onCall?: () => void;
};

type Seen = { messages: string[]; systemPrompt: unknown; tools: string[]; options: Json };

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

function scripted(script: Turn[], seen: Seen[] = []) {
  let index = 0;
  return ((_model: unknown, context: Json, options: Json) => {
    const turn = script[index++] ?? { text: "done" };
    const signal = options?.signal as AbortSignal | undefined;
    seen.push({
      messages: (context.messages as Json[]).map(describeMessage),
      systemPrompt: context.systemPrompt,
      tools: ((context.tools as Json[]) ?? []).map((t) => String(t.name)),
      options,
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
      if (signal?.aborted && !turn.ignoreAbort) {
        fail("aborted", "Request was aborted");
        return;
      }
      if (!turn.noStart) {
        push({ type: "start", partial: { ...partial } });
      }
      if (turn.text) {
        partial.content = [{ type: "text", text: "" }];
        push({ type: "text_start", contentIndex: 0, partial: { ...partial } });
        partial.content = [{ type: "text", text: turn.text }];
        push({ type: "text_delta", contentIndex: 0, delta: turn.text, partial: { ...partial } });
        if (turn.hang) {
          await new Promise((resolve) => signal?.addEventListener("abort", resolve));
          fail("aborted", "Request was aborted");
          return;
        }
        push({ type: "text_end", contentIndex: 0, content: turn.text, partial: { ...partial } });
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
      if (turn.endBare) {
        stream.end();
        return;
      }
      const stopReason = turn.tools?.length ? "toolUse" : "stop";
      push({ type: "done", reason: stopReason, message: { ...partial, stopReason } });
    })();
    return stream;
  }) as never;
}

const schema = { type: "object", properties: { n: { type: "number" } }, required: [] };
type Execute = (
  id: string,
  args: Json,
  signal: AbortSignal | undefined,
  onUpdate: (partial: Json) => void,
) => Promise<unknown>;
const ok = (text: string, extra: Json = {}) => ({
  content: [{ type: "text", text }],
  details: {},
  ...extra,
});
const tool = (name: string, execute?: Execute, extra: Json = {}) =>
  ({
    name,
    label: name,
    description: name,
    parameters: schema,
    execute: execute ?? (async (_id: string, args: Json) => ok(`${name}:${JSON.stringify(args)}`)),
    ...extra,
  }) as never;

/** A tool that records when it starts and ends, and runs `onRun` in between. */
const tracked = (name: string, order: string[], onRun?: () => void | Promise<void>, ms = 2) =>
  tool(name, async () => {
    order.push(`${name}:start`);
    await onRun?.();
    await sleep(ms);
    order.push(`${name}:end`);
    return ok(`${name} ok`);
  });

const calls = (...names: string[]) => ({
  tools: names.map((name, i) => ({ id: `c${i + 1}`, name })),
});

/** One line per event; `message_update` runs are kept as individual lines. */
function fmt(e: AgentEvent): string {
  switch (e.type) {
    case "message_start":
    case "message_end":
      return `${e.type} ${describeMessage(e.message as unknown as Json)}`;
    case "message_update":
      return `message_update ${e.assistantMessageEvent.type}`;
    case "tool_execution_start":
      return `tool_execution_start ${e.toolCallId} ${e.toolName} ${JSON.stringify(e.args)}`;
    case "tool_execution_update": {
      const partial = e.partialResult as { content: Array<{ text: string }> };
      return `tool_execution_update ${e.toolCallId} ${partial.content[0]?.text}`;
    }
    case "tool_execution_end": {
      const result = e.result as { content: Array<{ text: string }>; details: unknown };
      return `tool_execution_end ${e.toolCallId} ${e.isError ? "error" : "ok"} ${result.content[0]?.text}`;
    }
    case "turn_end":
      return `turn_end ${describeMessage(e.message as unknown as Json)} results=${e.toolResults.length}`;
    case "agent_end":
      return `agent_end ${e.messages.map((m) => m.role).join(",")}`;
    default:
      return e.type;
  }
}

/** Create an agent with a scripted stream and an event recorder. */
function setup(options: Json, script: Turn[]) {
  const seen: Seen[] = [];
  const events: string[] = [];
  const raw: AgentEvent[] = [];
  const agent = new Agent({
    streamFn: scripted(script, seen),
    ...options,
    initialState: { model, ...(options.initialState as Json | undefined) },
  } as never);
  agent.subscribe((event) => {
    raw.push(event);
    events.push(fmt(event));
  });
  const stored = () => (agent.state.messages as unknown as Json[]).map(describeMessage);
  /** Events without the `message_update` lines. */
  const outline = () => events.filter((line) => !line.startsWith("message_update"));
  return { agent, seen, events, raw, stored, outline };
}

const PROMPT = ["agent_start", "turn_start", "message_start user:go", "message_end user:go"];
/** Outline of an assistant turn that streams `text` and stops. */
const textTurn = (text: string) => [
  "message_start assistant(stop):",
  `message_end assistant(stop):${text}`,
  `turn_end assistant(stop):${text} results=0`,
];
/** Outline of the events of one tool call with an immediate or executed result. */
const toolCallEvents = (id: string, name: string, status: "ok" | "error", text: string) => [
  `tool_execution_start ${id} ${name} {}`,
  `tool_execution_end ${id} ${status} ${text}`,
  `message_start toolResult(${id}${status === "error" ? ",error" : ""}):${text}`,
  `message_end toolResult(${id}${status === "error" ? ",error" : ""}):${text}`,
];

describe("Agent: turns and events", () => {
  it("plain text turn", async () => {
    const { agent, events, seen, stored } = setup({ initialState: { systemPrompt: "sys" } }, [
      { text: "hi" },
    ]);
    const streaming: boolean[] = [];
    agent.subscribe(() => {
      streaming.push(agent.state.isStreaming);
    });
    expect(agent.state.isStreaming).toBe(false);
    await agent.prompt("hello");

    expect(events).toEqual([
      "agent_start",
      "turn_start",
      "message_start user:hello",
      "message_end user:hello",
      "message_start assistant(stop):",
      "message_update text_start",
      "message_update text_delta",
      "message_update text_end",
      "message_end assistant(stop):hi",
      "turn_end assistant(stop):hi results=0",
      "agent_end user,assistant",
    ]);
    expect(streaming.every(Boolean)).toBe(true);
    expect(agent.state.isStreaming).toBe(false);
    expect(agent.signal).toBeUndefined();
    expect(stored()).toEqual(["user:hello", "assistant(stop):hi"]);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.messages).toEqual(["user:hello"]);
    expect(seen[0]?.systemPrompt).toBe("sys");
  });

  it("prompt accepts text with images, one message, or a batch", async () => {
    const { agent, stored, outline } = setup({}, [{ text: "1" }, { text: "2" }, { text: "3" }]);
    await agent.prompt("look", [{ type: "image", data: "AAAA", mimeType: "image/png" }]);
    await agent.prompt(user("single"));
    await agent.prompt([user("a"), user("b")]);
    expect(stored()).toEqual([
      "user:look<image>",
      "assistant(stop):1",
      "user:single",
      "assistant(stop):2",
      "user:a",
      "user:b",
      "assistant(stop):3",
    ]);
    expect(outline().slice(-9)).toEqual([
      "turn_start",
      "message_start user:a",
      "message_end user:a",
      "message_start user:b",
      "message_end user:b",
      ...textTurn("3"),
      "agent_end user,user,assistant",
    ]);
  });

  it("two tool calls run one after the other by default, with updates", async () => {
    const order: string[] = [];
    const { agent, events, outline, seen } = setup(
      {
        initialState: {
          tools: [
            tool("a", async (_id, _args, _signal, onUpdate) => {
              order.push("a:start");
              onUpdate(ok("half"));
              await sleep(5);
              order.push("a:end");
              return ok("A");
            }),
            tool("b", async () => {
              order.push("b:start");
              return ok("B");
            }),
          ],
        },
      },
      [calls("a", "b"), { text: "done" }],
    );
    agent.subscribe((event) => {
      if (event.type === "message_end" && event.message.role === "toolResult") {
        order.push(`result:${event.message.toolCallId}`);
      }
    });
    await agent.prompt("go");

    expect(outline()).toEqual([
      ...PROMPT,
      "message_start assistant(stop):",
      "message_end assistant(toolUse):<toolCall><toolCall>",
      "tool_execution_start c1 a {}",
      "tool_execution_update c1 half",
      "tool_execution_end c1 ok A",
      "message_start toolResult(c1):A",
      "message_end toolResult(c1):A",
      ...toolCallEvents("c2", "b", "ok", "B"),
      "turn_end assistant(toolUse):<toolCall><toolCall> results=2",
      "turn_start",
      ...textTurn("done"),
      "agent_end user,assistant,toolResult,toolResult,assistant",
    ]);
    expect(events.filter((line) => line.startsWith("message_update"))).toEqual([
      "message_update toolcall_start",
      "message_update toolcall_end",
      "message_update toolcall_start",
      "message_update toolcall_end",
      "message_update text_start",
      "message_update text_delta",
      "message_update text_end",
    ]);
    // The second tool starts only after the first one's result message.
    expect(order).toEqual(["a:start", "a:end", "result:c1", "b:start", "result:c2"]);
    expect(seen[1]?.messages).toEqual([
      "user:go",
      "assistant(toolUse):<toolCall><toolCall>",
      "toolResult(c1):A",
      "toolResult(c2):B",
    ]);
  });

  it("events carry the raw arguments, execute gets the prepared and coerced ones", async () => {
    const received: unknown[] = [];
    const steps: string[] = [];
    const { agent, events } = setup(
      {
        initialState: {
          tools: [
            tool("a", async (_id, args, _signal, onUpdate) => {
              steps.push("execute");
              received.push(args);
              onUpdate(ok("partial"));
              return ok("A");
            }),
            tool(
              "renamed",
              async (_id, args) => {
                received.push(args);
                return ok("R");
              },
              {
                prepareArguments: (args: Json) => {
                  steps.push("prepare");
                  return { n: args.count };
                },
              },
            ),
          ],
        },
        beforeToolCall: async (context: Json) => {
          steps.push(`before ${JSON.stringify(context.args)}`);
          return undefined;
        },
      },
      [
        {
          tools: [
            { id: "c1", name: "a", args: { n: "5" } },
            { id: "c2", name: "renamed", args: { count: "7" } },
          ],
        },
        { text: "done" },
      ],
    );
    await agent.prompt("go");
    expect(events.filter((line) => line.startsWith("tool_execution_start"))).toEqual([
      'tool_execution_start c1 a {"n":"5"}',
      'tool_execution_start c2 renamed {"count":"7"}',
    ]);
    expect(received).toEqual([{ n: 5 }, { n: 7 }]);
    expect(steps).toEqual(['before {"n":5}', "execute", "prepare", 'before {"n":7}']);
  });

  it("tool failures give error results and the run continues", async () => {
    const strict = tool("strict", undefined, {
      parameters: { type: "object", properties: { n: { type: "number" } }, required: ["n"] },
    });
    const { agent, raw, outline, seen } = setup(
      {
        initialState: {
          tools: [
            tool("boom", async () => {
              throw new Error("exploded");
            }),
            strict,
            tool("a"),
          ],
        },
        beforeToolCall: async (context: Json) => {
          const id = (context.toolCall as Json).id;
          if (id === "c4") {
            return { block: true, reason: "not allowed" };
          }
          return id === "c5" ? { block: true } : undefined;
        },
      },
      [
        {
          tools: [
            { id: "c1", name: "boom" },
            { id: "c2", name: "missing" },
            { id: "c3", name: "strict", args: { n: "x" } },
            { id: "c4", name: "a" },
            { id: "c5", name: "a" },
          ],
        },
        { text: "done" },
      ],
    );
    await agent.prompt("go");

    const ends = raw.filter((e) => e.type === "tool_execution_end");
    expect(ends.map((e) => (e.type === "tool_execution_end" ? e.isError : null))).toEqual([
      true,
      true,
      true,
      true,
      true,
    ]);
    const results = ends.map((e) => (e.type === "tool_execution_end" ? e.result : null)) as Array<{
      content: Array<{ type: string; text: string }>;
      details: unknown;
    }>;
    expect(results.map((r) => r.details)).toEqual([{}, {}, {}, {}, {}]);
    expect(results.map((r) => r.content[0]?.text)).toEqual([
      "exploded",
      "Tool missing not found",
      'Validation failed for tool "strict":\n  - n: must be number\n\nReceived arguments:\n{\n  "n": "x"\n}',
      "not allowed",
      "Tool execution was blocked",
    ]);
    const toolResults = agent.state.messages.filter((m) => m.role === "toolResult");
    expect(toolResults.map((m) => (m.role === "toolResult" ? m.isError : null))).toEqual([
      true,
      true,
      true,
      true,
      true,
    ]);
    expect(seen).toHaveLength(2);
    expect(outline().slice(-5)).toEqual([
      "turn_start",
      ...textTurn("done"),
      "agent_end user,assistant,toolResult,toolResult,toolResult,toolResult,toolResult,assistant",
    ]);
  });

  it("afterToolCall replaces fields one by one; a throwing hook gives an error result", async () => {
    const { agent, raw } = setup(
      {
        initialState: {
          tools: [tool("a", async () => ok("A", { details: { from: "tool" } }))],
        },
        afterToolCall: async (context: Json) => {
          switch ((context.toolCall as Json).id) {
            case "c1":
              return { content: [{ type: "text", text: "replaced" }] };
            case "c2":
              return { details: { replaced: true }, isError: true };
            case "c3":
              throw new Error("after failed");
            default:
              return undefined;
          }
        },
      },
      [calls("a", "a", "a", "a"), { text: "done" }],
    );
    await agent.prompt("go");
    const ends = raw.flatMap((e) =>
      e.type === "tool_execution_end" ? [{ result: e.result, isError: e.isError }] : [],
    );
    expect(ends).toEqual([
      {
        result: {
          content: [{ type: "text", text: "replaced" }],
          details: { from: "tool" },
          terminate: undefined,
        },
        isError: false,
      },
      {
        result: {
          content: [{ type: "text", text: "A" }],
          details: { replaced: true },
          terminate: undefined,
        },
        isError: true,
      },
      { result: { content: [{ type: "text", text: "after failed" }], details: {} }, isError: true },
      {
        result: { content: [{ type: "text", text: "A" }], details: { from: "tool" } },
        isError: false,
      },
    ]);
  });

  it("parallel execution: ends in completion order, result messages in source order", async () => {
    const order: string[] = [];
    // Both are started; b is made to finish first, without timers.
    const finish = finishOrder("b", "a");
    const gated = (name: string) =>
      tool(name, async () => {
        order.push(`${name}:start`);
        await finish.turn(name);
        order.push(`${name}:end`);
        finish.done(name);
        return ok(`${name} ok`);
      });
    const { agent, outline } = setup(
      { toolExecution: "parallel", initialState: { tools: [gated("a"), gated("b")] } },
      [calls("a", "b"), { text: "done" }],
    );
    await agent.prompt("go");
    expect(order).toEqual(["a:start", "b:start", "b:end", "a:end"]);
    expect(outline().slice(6, 14)).toEqual([
      "tool_execution_start c1 a {}",
      "tool_execution_start c2 b {}",
      "tool_execution_end c2 ok b ok",
      "tool_execution_end c1 ok a ok",
      "message_start toolResult(c1):a ok",
      "message_end toolResult(c1):a ok",
      "message_start toolResult(c2):b ok",
      "message_end toolResult(c2):b ok",
    ]);
  });

  it("terminate: the run stops only when every result of the batch sets it", async () => {
    const stop = tool("stop", async () => ok("stopping", { terminate: true }));
    const all = setup({ initialState: { tools: [stop] } }, [calls("stop", "stop"), { text: "x" }]);
    await all.agent.prompt("go");
    expect(all.seen).toHaveLength(1);
    expect(all.outline().slice(-2)).toEqual([
      "turn_end assistant(toolUse):<toolCall><toolCall> results=2",
      "agent_end user,assistant,toolResult,toolResult",
    ]);

    const mixed = setup({ initialState: { tools: [stop, tool("a")] } }, [
      calls("stop", "a"),
      { text: "continued" },
    ]);
    await mixed.agent.prompt("go");
    expect(mixed.seen).toHaveLength(2);
  });

  it("a stream without a start event still gets message_start and message_end", async () => {
    const { agent, events } = setup({}, [{ text: "no start", noStart: true }]);
    await agent.prompt("go");
    expect(events).toEqual([
      ...PROMPT,
      "message_start assistant(stop):no start",
      "message_end assistant(stop):no start",
      "turn_end assistant(stop):no start results=0",
      "agent_end user,assistant",
    ]);
  });

  it("message_end carries the stored object; message_start of an assistant message is a copy", async () => {
    const { agent } = setup({ initialState: { tools: [tool("a")] } }, [
      calls("a"),
      { text: "done" },
    ]);
    let lastStart: unknown;
    const identity: string[] = [];
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
    expect(identity).toEqual([
      "user stored=true start=true",
      "assistant stored=true start=false",
      "toolResult stored=true start=true",
      "assistant stored=true start=false",
    ]);
    expect(
      (agent.state.messages as unknown as Json[]).every((m) => m.mutatedByListener === true),
    ).toBe(true);
  });

  it("assistant message_start and message_update carry shallow copies of the stream's partials", async () => {
    const base = assistantMsg("") as unknown as Json;
    const startPartial = { ...base, content: [] };
    const deltaPartial = { ...base, content: [{ type: "text", text: "hi" }] };
    const final = { ...base, content: [{ type: "text", text: "hi" }] };
    const bare = { ...base, content: [{ type: "text", text: "bare" }] };
    let call = 0;
    const agent = new Agent({
      initialState: { model } as never,
      streamFn: (() => {
        const stream = new AssistantMessageEventStream();
        if (call++ === 0) {
          stream.push({ type: "start", partial: startPartial } as never);
          stream.push({
            type: "text_delta",
            contentIndex: 0,
            delta: "hi",
            partial: deltaPartial,
          } as never);
          stream.push({ type: "done", reason: "stop", message: final } as never);
        } else {
          stream.push({ type: "done", reason: "stop", message: bare } as never);
        }
        return stream;
      }) as never,
    });
    const messages: Array<[string, unknown]> = [];
    agent.subscribe((event) => {
      if (
        (event.type === "message_start" ||
          event.type === "message_update" ||
          event.type === "message_end") &&
        event.message.role === "assistant"
      ) {
        messages.push([event.type, event.message]);
      }
    });
    await agent.prompt("go");
    await agent.prompt("again");

    expect(messages.map(([type]) => type)).toEqual([
      "message_start",
      "message_update",
      "message_end",
      "message_start",
      "message_end",
    ]);
    expect(messages[0]?.[1]).toEqual(startPartial);
    expect(messages[0]?.[1]).not.toBe(startPartial);
    expect(messages[1]?.[1]).toEqual(deltaPartial);
    expect(messages[1]?.[1]).not.toBe(deltaPartial);
    expect(messages[2]?.[1]).toBe(final);
    expect(agent.state.messages[1]).toBe(final);
    // Without a start event, message_start is a copy of the final message.
    expect(messages[3]?.[1]).toEqual(bare);
    expect(messages[3]?.[1]).not.toBe(bare);
    expect(messages[4]?.[1]).toBe(bare);
    // The copies are shallow: the content array is shared.
    const updateMessage = messages[1]?.[1] as Json | undefined;
    expect(updateMessage?.content).toBe(deltaPartial.content);
  });
});

describe("Agent: steering and follow-up queues", () => {
  it("steering queued before prompt() goes into the first turn, one at a time", async () => {
    const { agent, outline, seen } = setup({}, [
      { text: "1" },
      { text: "2" },
      { text: "3" },
      { text: "4" },
    ]);
    agent.steer(user("s1"));
    agent.steer(user("s2"));
    agent.followUp(user("f1"));
    await agent.prompt("go");

    expect(seen.map((call) => call.messages.filter((m) => m.startsWith("user")))).toEqual([
      ["user:go", "user:s1"],
      ["user:go", "user:s1", "user:s2"],
      ["user:go", "user:s1", "user:s2", "user:f1"],
    ]);
    expect(outline()).toEqual([
      ...PROMPT,
      "message_start user:s1",
      "message_end user:s1",
      ...textTurn("1"),
      "turn_start",
      "message_start user:s2",
      "message_end user:s2",
      ...textTurn("2"),
      "turn_start",
      "message_start user:f1",
      "message_end user:f1",
      ...textTurn("3"),
      "agent_end user,user,assistant,user,assistant,user,assistant",
    ]);
    expect(agent.hasQueuedMessages()).toBe(false);
  });

  it('mode "all" drains the whole queue at once', async () => {
    const { agent, seen } = setup({ steeringMode: "all", followUpMode: "all" }, [
      { text: "1" },
      { text: "2" },
    ]);
    agent.steer(user("s1"));
    agent.steer(user("s2"));
    agent.followUp(user("f1"));
    agent.followUp(user("f2"));
    await agent.prompt("go");
    expect(seen.map((call) => call.messages.length)).toEqual([3, 6]);
    expect(agent.steeringMode).toBe("all");
    agent.steeringMode = "one-at-a-time";
    expect(agent.steeringQueue.mode).toBe("one-at-a-time");
  });

  it("a follow-up queued during a run starts another turn before agent_end", async () => {
    const holder: { agent?: Agent } = {};
    const { agent, outline } = setup({}, [
      { text: "first", onCall: () => holder.agent?.followUp(user("more")) },
      { text: "second" },
    ]);
    holder.agent = agent;
    await agent.prompt("go");
    expect(outline()).toEqual([
      ...PROMPT,
      ...textTurn("first"),
      "turn_start",
      "message_start user:more",
      "message_end user:more",
      ...textTurn("second"),
      "agent_end user,assistant,user,assistant",
    ]);
  });

  it("queue methods", () => {
    const { agent } = setup({}, []);
    expect(agent.hasQueuedMessages()).toBe(false);
    agent.followUp(user("f"));
    expect(agent.hasQueuedMessages()).toBe(true);
    expect(agent.hasQueuedSteeringMessages()).toBe(false);
    agent.steer(user("s"));
    expect(agent.hasQueuedSteeringMessages()).toBe(true);
    expect(agent.steeringQueue.hasItems()).toBe(true);
    agent.clearSteeringQueue();
    expect(agent.hasQueuedSteeringMessages()).toBe(false);
    expect(agent.hasQueuedMessages()).toBe(true);
    agent.clearFollowUpQueue();
    expect(agent.hasQueuedMessages()).toBe(false);
    agent.steer(user("s"));
    agent.followUp(user("f"));
    agent.clearAllQueues();
    expect(agent.hasQueuedMessages()).toBe(false);
  });

  it("PendingMessageQueue drains by mode", () => {
    const queue = new PendingMessageQueue("one-at-a-time");
    expect(queue.drain()).toEqual([]);
    queue.enqueue(user("1"));
    queue.enqueue(user("2"));
    queue.enqueue(user("3"));
    expect(queue.drain()).toEqual([user("1")]);
    queue.mode = "all";
    expect(queue.drain()).toEqual([user("2"), user("3")]);
    expect(queue.hasItems()).toBe(false);
    queue.enqueue(user("4"));
    queue.clear();
    expect(queue.drain()).toEqual([]);
  });
});

describe("Agent: abort, errors, listeners", () => {
  it("abort mid-stream ends the run with an aborted assistant message", async () => {
    const { agent, events, stored } = setup({}, [{ text: "partial", hang: true }]);
    const order: string[] = [];
    agent.subscribe(async (event) => {
      if (event.type === "agent_end") {
        await sleep(5);
        order.push("agent_end listener done");
      }
    });
    agent.followUp(user("stays queued"));
    const run = agent.prompt("go");
    await sleep(5);
    expect(agent.signal?.aborted).toBe(false);
    agent.abort();
    await agent.waitForIdle();
    order.push("idle");
    await run;

    expect(events).toEqual([
      ...PROMPT,
      "message_start assistant(stop):",
      "message_update text_start",
      "message_update text_delta",
      "message_end assistant(aborted):partial",
      "turn_end assistant(aborted):partial results=0",
      "agent_end user,assistant",
    ]);
    expect(order).toEqual(["agent_end listener done", "idle"]);
    expect(agent.state.errorMessage).toBe("Request was aborted");
    expect(stored()).toEqual(["user:go", "assistant(aborted):partial"]);
    expect(agent.hasQueuedMessages()).toBe(true);
  });

  it("a stream function that throws ends the run with a synthetic failure message", async () => {
    const { agent, events } = setup({}, [{ throws: "no auth" }]);
    await agent.prompt("go");
    expect(events).toEqual([...PROMPT, "agent_end assistant"]);
    expect(agent.state.messages).toHaveLength(2);
    expect(agent.state.messages[1]).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "" }],
      api: "fake-api",
      provider: "fake",
      model: "fake",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "error",
      errorMessage: "no auth",
      timestamp: expect.any(Number),
    });
    expect(agent.state.errorMessage).toBe("no auth");
    expect(agent.state.isStreaming).toBe(false);
  });

  it("convertToLlm, transformContext and getApiKey throws end the run the same way", async () => {
    for (const [label, options] of [
      [
        "convert failed",
        {
          convertToLlm: () => {
            throw new Error("convert failed");
          },
        },
      ],
      [
        "transform failed",
        {
          transformContext: async () => {
            throw new Error("transform failed");
          },
        },
      ],
      [
        "key failed",
        {
          getApiKey: () => {
            throw "key failed";
          },
        },
      ],
    ] as Array<[string, Json]>) {
      const { agent, events, stored } = setup(options, [{ text: "never" }]);
      await agent.prompt("go");
      expect(events).toEqual([...PROMPT, "agent_end assistant"]);
      expect(stored()).toEqual(["user:go", "assistant(error):"]);
      expect(agent.state.errorMessage).toBe(label);
    }
  });

  it("a throw after abort() gives stopReason aborted", async () => {
    const holder: { agent?: Agent } = {};
    const { agent, stored } = setup({}, [{ onCall: () => holder.agent?.abort(), throws: "late" }]);
    holder.agent = agent;
    await agent.prompt("go");
    expect(stored()).toEqual(["user:go", "assistant(aborted):"]);
  });

  it("a provider error ends the run through the normal events and leaves the queues", async () => {
    const { agent, events } = setup({}, [{ text: "some", error: "overloaded" }]);
    agent.followUp(user("queued"));
    await agent.prompt("go");
    expect(events).toEqual([
      ...PROMPT,
      "message_start assistant(stop):",
      "message_update text_start",
      "message_update text_delta",
      "message_update text_end",
      "message_end assistant(error):some",
      "turn_end assistant(error):some results=0",
      "agent_end user,assistant",
    ]);
    expect(agent.state.errorMessage).toBe("overloaded");
    expect(agent.hasQueuedMessages()).toBe(true);
  });

  it("errorMessage is cleared when the next run starts", async () => {
    const { agent } = setup({}, [{ error: "overloaded" }, { text: "fine" }]);
    await agent.prompt("go");
    expect(agent.state.errorMessage).toBe("overloaded");
    await agent.prompt("again");
    expect(agent.state.errorMessage).toBeUndefined();
  });

  it("a listener that throws fails the run; later listeners are not called for that event", async () => {
    const { agent, stored } = setup({ initialState: { tools: [tool("a")] } }, [
      calls("a"),
      { text: "never" },
    ]);
    let thrown = false;
    agent.subscribe((event) => {
      if (event.type === "tool_execution_end" && !thrown) {
        thrown = true;
        throw new Error("listener failed");
      }
    });
    const after: string[] = [];
    agent.subscribe((event) => {
      after.push(event.type);
    });
    await agent.prompt("go");
    expect(stored()).toEqual(["user:go", "assistant(toolUse):<toolCall>", "assistant(error):"]);
    expect(agent.state.errorMessage).toBe("listener failed");
    expect(after).not.toContain("tool_execution_end");
    expect(after.at(-1)).toBe("agent_end");
    expect(agent.state.pendingToolCalls.size).toBe(0);
    expect(agent.state.isStreaming).toBe(false);
  });

  it("a listener that throws on the failure agent_end rejects prompt(), and the agent is idle", async () => {
    const { agent } = setup({}, [{ text: "fine" }, { text: "again" }]);
    const off = agent.subscribe((event) => {
      if (event.type === "agent_end") {
        throw new Error("always fails");
      }
    });
    await expect(agent.prompt("go")).rejects.toThrow("always fails");
    expect(agent.state.isStreaming).toBe(false);
    expect(agent.signal).toBeUndefined();
    await agent.waitForIdle();
    off();
    await agent.prompt("again");
    expect(agent.state.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" });
  });

  it("a listener that throws on a tool update fails the run once the tool has settled", async () => {
    const order: string[] = [];
    const { agent, stored } = setup(
      {
        initialState: {
          tools: [
            tool("u", async (_id, _args, _signal, onUpdate) => {
              onUpdate(ok("partial"));
              // The rejected emit must not surface as an unhandled rejection
              // while the tool is still running (vitest would fail the file).
              await sleep(10);
              order.push("tool finished");
              return ok("U");
            }),
          ],
        },
      },
      [calls("u"), { text: "never" }],
    );
    agent.subscribe((event) => {
      if (event.type === "tool_execution_update") {
        throw new Error("update listener failed");
      }
    });
    await agent.prompt("go");
    expect(order).toEqual(["tool finished"]);
    expect(stored()).toEqual(["user:go", "assistant(toolUse):<toolCall>", "assistant(error):"]);
    expect(agent.state.errorMessage).toBe("update listener failed");
  });

  it("unsubscribe stops delivery; listeners get the run's signal", async () => {
    const { agent } = setup({}, [{ text: "1" }, { text: "2" }]);
    let count = 0;
    const signals = new Set<AbortSignal>();
    const off = agent.subscribe((_event, signal) => {
      count += 1;
      signals.add(signal);
      expect(signal).toBe(agent.signal);
    });
    await agent.prompt("go");
    const afterFirst = count;
    off();
    await agent.prompt("again");
    expect(count).toBe(afterFirst);
    expect(signals.size).toBe(1);
  });
});

describe("Agent: continue() and concurrency", () => {
  it("continue() preconditions", async () => {
    const empty = setup({}, []);
    await expect(empty.agent.continue()).rejects.toThrow("No messages to continue from");

    const assistantLast = setup({ initialState: { messages: [user("q"), assistantMsg("a")] } }, []);
    await expect(assistantLast.agent.continue()).rejects.toThrow(
      "Cannot continue from message role: assistant",
    );
    expect(assistantLast.events).toEqual([]);
  });

  it("continue() from an assistant message runs queued steering, then follow-ups, as a prompt", async () => {
    const { agent, outline, events } = setup(
      { initialState: { messages: [user("q"), assistantMsg("a")] } },
      [{ text: "steered" }, { text: "second steer" }, { text: "followed" }],
    );
    agent.steer(user("s1"));
    agent.steer(user("s2"));
    agent.followUp(user("f1"));
    await agent.continue();
    // s1 is the prompt; the initial steering poll is skipped, so s2 arrives after the turn.
    expect(outline()).toEqual([
      "agent_start",
      "turn_start",
      "message_start user:s1",
      "message_end user:s1",
      ...textTurn("steered"),
      "turn_start",
      "message_start user:s2",
      "message_end user:s2",
      ...textTurn("second steer"),
      "turn_start",
      "message_start user:f1",
      "message_end user:f1",
      ...textTurn("followed"),
      "agent_end user,assistant,user,assistant,user,assistant",
    ]);

    events.length = 0;
    agent.followUp(user("f2"));
    await agent.continue();
    expect(outline().slice(0, 4)).toEqual([
      "agent_start",
      "turn_start",
      "message_start user:f2",
      "message_end user:f2",
    ]);
  });

  it("continue() from a user or tool result message emits no prompt events", async () => {
    const { agent, outline, seen } = setup({ initialState: { messages: [user("pending")] } }, [
      { text: "answer" },
    ]);
    await agent.continue();
    expect(outline()).toEqual([
      "agent_start",
      "turn_start",
      ...textTurn("answer"),
      "agent_end assistant",
    ]);
    expect(seen[0]?.messages).toEqual(["user:pending"]);
  });

  it("prompt() and continue() during a run throw and leave the run alone", async () => {
    const { agent, stored } = setup({}, [{ text: "partial", hang: true }]);
    const run = agent.prompt("go");
    await sleep(2);
    await expect(agent.prompt("again")).rejects.toThrow(
      "Agent is already processing a prompt. Use steer() or followUp() to queue messages, or wait for completion.",
    );
    await expect(agent.continue()).rejects.toThrow(
      "Agent is already processing. Wait for completion before continuing.",
    );
    expect(agent.state.isStreaming).toBe(true);
    agent.abort();
    await run;
    expect(stored()).toEqual(["user:go", "assistant(aborted):partial"]);
  });

  it("waitForIdle() resolves at once when idle and after the agent_end listeners otherwise", async () => {
    const { agent } = setup({}, [{ text: "1" }]);
    await agent.waitForIdle();
    const order: string[] = [];
    agent.subscribe(async (event) => {
      if (event.type === "agent_end") {
        await sleep(5);
        order.push("listener");
      }
    });
    const run = agent.prompt("go");
    await agent.waitForIdle();
    order.push("idle");
    await run;
    expect(order).toEqual(["listener", "idle"]);
  });
});

describe("Agent: state and snapshot semantics", () => {
  it("defaults", () => {
    const agent = new Agent();
    expect(agent.state.systemPrompt).toBe("");
    expect(agent.state.model.id).toBe("unknown");
    expect(agent.state.thinkingLevel).toBe("off");
    expect(agent.state.tools).toEqual([]);
    expect(agent.state.messages).toEqual([]);
    expect(agent.state.isStreaming).toBe(false);
    expect(agent.state.pendingToolCalls.size).toBe(0);
    expect(agent.transport).toBe("auto");
    expect(agent.steeringMode).toBe("one-at-a-time");
    expect(agent.followUpMode).toBe("one-at-a-time");
    expect(agent.toolExecution).toBe("sequential");
    expect(agent.skipToolCallsOnSteering).toBe(true);
    expect(agent.skipToolCallsOnAbort).toBe(true);
    expect(agent.abortBeforeModelCall).toBe(true);
    expect(typeof agent.streamFn).toBe("function");
  });

  it("assigning state.messages or state.tools copies the array; the getter is live", () => {
    const { agent } = setup({}, []);
    const messages = [user("m1")];
    agent.state.messages = messages;
    messages.push(user("not in state"));
    expect(agent.state.messages).toHaveLength(1);
    agent.state.messages.push(user("m2"));
    expect(agent.state.messages).toHaveLength(2);
    const tools = [tool("a")];
    agent.state.tools = tools;
    tools.push(tool("b"));
    expect(agent.state.tools).toHaveLength(1);
  });

  it("the reducer runs before the listeners", async () => {
    const { agent } = setup({ initialState: { tools: [tool("a")] } }, [
      { text: "x", tools: [{ id: "c1", name: "a" }] },
      { error: "overloaded" },
    ]);
    const seenState: string[] = [];
    const pendingSets = new Set<ReadonlySet<string>>();
    agent.subscribe((event) => {
      pendingSets.add(agent.state.pendingToolCalls);
      const streaming = agent.state.streamingMessage as unknown as Json | undefined;
      seenState.push(
        [
          event.type,
          `streaming=${streaming ? String(streaming.role) : "-"}`,
          `pending=${[...agent.state.pendingToolCalls].join("+")}`,
          `messages=${agent.state.messages.length}`,
          `error=${agent.state.errorMessage ?? "-"}`,
        ].join(" "),
      );
    });
    await agent.prompt("go");
    expect(seenState.filter((line) => !line.startsWith("message_update"))).toEqual([
      "agent_start streaming=- pending= messages=0 error=-",
      "turn_start streaming=- pending= messages=0 error=-",
      "message_start streaming=user pending= messages=0 error=-",
      "message_end streaming=- pending= messages=1 error=-",
      "message_start streaming=assistant pending= messages=1 error=-",
      "message_end streaming=- pending= messages=2 error=-",
      "tool_execution_start streaming=- pending=c1 messages=2 error=-",
      "tool_execution_end streaming=- pending= messages=2 error=-",
      "message_start streaming=toolResult pending= messages=2 error=-",
      "message_end streaming=- pending= messages=3 error=-",
      "turn_end streaming=- pending= messages=3 error=-",
      "turn_start streaming=- pending= messages=3 error=-",
      "message_start streaming=assistant pending= messages=3 error=-",
      "message_end streaming=- pending= messages=4 error=-",
      "turn_end streaming=- pending= messages=4 error=overloaded",
      "agent_end streaming=- pending= messages=4 error=overloaded",
    ]);
    // A new Set per change: initial, after start, after end.
    expect(pendingSets.size).toBe(3);
    expect(seenState).toContain("message_update streaming=assistant pending= messages=1 error=-");
  });

  it("reset() clears the transcript, runtime state and queues", async () => {
    const { agent } = setup({}, [{ error: "overloaded" }]);
    await agent.prompt("go");
    agent.steer(user("s"));
    agent.followUp(user("f"));
    agent.reset();
    expect(agent.state.messages).toEqual([]);
    expect(agent.state.errorMessage).toBeUndefined();
    expect(agent.state.isStreaming).toBe(false);
    expect(agent.hasQueuedMessages()).toBe(false);
  });

  it("a run works on the snapshot taken at its start", async () => {
    const holder: { agent?: Agent } = {};
    const laterSeen: Seen[] = [];
    const { agent, seen, stored } = setup(
      { initialState: { systemPrompt: "first", tools: [tool("a")] } },
      [calls("a"), { text: "still the first stream" }],
    );
    holder.agent = agent;
    agent.subscribe((event) => {
      if (event.type === "tool_execution_end") {
        agent.state.systemPrompt = "second";
        agent.state.messages = [user("replaced history")];
        agent.state.tools = [tool("b")];
        agent.streamFn = scripted([{ text: "from the replaced stream" }], laterSeen);
        agent.toolExecution = "parallel";
      }
    });
    await agent.prompt("go");

    // The second model call of the run still sees the run's own context.
    expect(seen).toHaveLength(2);
    expect(seen[1]?.systemPrompt).toBe("first");
    expect(seen[1]?.tools).toEqual(["a"]);
    expect(seen[1]?.messages).toEqual([
      "user:go",
      "assistant(toolUse):<toolCall>",
      "toolResult(c1):a:{}",
    ]);
    expect(seen[1]?.options.toolExecution).toBe("sequential");
    // Later message_end events were appended to the replaced array.
    expect(stored()).toEqual([
      "user:replaced history",
      "toolResult(c1):a:{}",
      "assistant(stop):still the first stream",
    ]);

    await agent.prompt("next");
    expect(laterSeen).toHaveLength(1);
    expect(laterSeen[0]?.systemPrompt).toBe("second");
    expect(laterSeen[0]?.tools).toEqual(["b"]);
    expect(laterSeen[0]?.options.toolExecution).toBe("parallel");
    expect(laterSeen[0]?.messages.at(-1)).toBe("user:next");
  });

  it("transformContext runs before every model call and its result is not written back", async () => {
    const lengths: number[] = [];
    const { agent, seen, stored } = setup(
      {
        initialState: { tools: [tool("a")], messages: [user("old 1"), assistantMsg("old 2")] },
        transformContext: async (messages: Json[], signal: AbortSignal) => {
          expect(signal).toBeInstanceOf(AbortSignal);
          lengths.push(messages.length);
          return messages.slice(2);
        },
      },
      [calls("a"), { text: "done" }],
    );
    await agent.prompt("go");
    expect(lengths).toEqual([3, 5]);
    expect(seen.map((call) => call.messages)).toEqual([
      ["user:go"],
      ["user:go", "assistant(toolUse):<toolCall>", "toolResult(c1):a:{}"],
    ]);
    expect(stored()).toHaveLength(6);
  });

  it("the default convertToLlm drops custom roles; getApiKey is resolved per call", async () => {
    let keys = 0;
    const { agent, seen } = setup(
      {
        initialState: {
          tools: [tool("a")],
          thinkingLevel: "high",
          messages: [{ role: "note", text: "custom", timestamp: 1 }],
        },
        sessionId: "sess",
        getApiKey: (provider: string) => `key-${provider}-${++keys}`,
      },
      [calls("a"), { text: "done" }],
    );
    await agent.prompt("go");
    expect(seen[0]?.messages).toEqual(["user:go"]);
    expect(seen.map((call) => call.options.apiKey)).toEqual(["key-fake-1", "key-fake-2"]);
    expect(seen[0]?.options).toMatchObject({
      reasoning: "high",
      sessionId: "sess",
      transport: "auto",
    });
    expect(seen[0]?.options.signal).toBeInstanceOf(AbortSignal);
    expect(agent.state.messages[0]).toMatchObject({ role: "note" });
  });
});

describe("difference 1: sequential by default", () => {
  it("tool calls do not overlap unless toolExecution is parallel", async () => {
    const order: string[] = [];
    const { agent } = setup(
      { initialState: { tools: [tracked("a", order, undefined, 10), tracked("b", order)] } },
      [calls("a", "b"), { text: "done" }],
    );
    await agent.prompt("go");
    expect(order).toEqual(["a:start", "a:end", "b:start", "b:end"]);
  });

  it("the low-level loop is sequential when toolExecution is not set", async () => {
    const order: string[] = [];
    await runAgentLoop(
      [user("go")],
      {
        systemPrompt: "",
        messages: [],
        tools: [tracked("a", order, undefined, 10), tracked("b", order)],
      },
      { model, convertToLlm: (messages: unknown[]) => messages } as never,
      () => {},
      undefined,
      scripted([calls("a", "b"), { text: "done" }]),
    );
    expect(order).toEqual(["a:start", "a:end", "b:start", "b:end"]);
  });

  it('a tool with executionMode "sequential" makes a parallel batch sequential', async () => {
    const order: string[] = [];
    const b = { ...(tracked("b", order) as Json), executionMode: "sequential" } as never;
    const { agent } = setup(
      {
        toolExecution: "parallel",
        initialState: { tools: [tracked("a", order, undefined, 10), b] },
      },
      [calls("a", "b"), { text: "done" }],
    );
    await agent.prompt("go");
    expect(order).toEqual(["a:start", "a:end", "b:start", "b:end"]);
  });
});

describe("difference 2: steering skips the rest of a tool batch", () => {
  const skipped = (id: string, name: string) =>
    toolCallEvents(id, name, "error", STEERING_SKIP_REASON);

  it("steering queued during the first call skips the remaining calls", async () => {
    const order: string[] = [];
    const holder: { agent?: Agent } = {};
    const hooks: string[] = [];
    const { agent, outline, raw, seen } = setup(
      {
        initialState: {
          tools: [
            tracked("a", order, () => holder.agent?.steer(user("stop"))),
            tracked("b", order),
            tracked("c", order),
          ],
        },
        beforeToolCall: async (context: Json) => {
          hooks.push(`before ${String((context.toolCall as Json).id)}`);
          return undefined;
        },
        afterToolCall: async (context: Json) => {
          hooks.push(`after ${String((context.toolCall as Json).id)}`);
          return undefined;
        },
      },
      [calls("a", "b", "c"), { text: "ok, stopping" }],
    );
    holder.agent = agent;
    await agent.prompt("go");

    expect(STEERING_SKIP_REASON).toBe("Skipped due to queued user message.");
    expect(order).toEqual(["a:start", "a:end"]);
    expect(hooks).toEqual(["before c1", "after c1"]);
    expect(outline()).toEqual([
      ...PROMPT,
      "message_start assistant(stop):",
      "message_end assistant(toolUse):<toolCall><toolCall><toolCall>",
      ...toolCallEvents("c1", "a", "ok", "a ok"),
      ...skipped("c2", "b"),
      ...skipped("c3", "c"),
      "turn_end assistant(toolUse):<toolCall><toolCall><toolCall> results=3",
      "turn_start",
      "message_start user:stop",
      "message_end user:stop",
      ...textTurn("ok, stopping"),
      "agent_end user,assistant,toolResult,toolResult,toolResult,user,assistant",
    ]);
    const end = raw.find((e) => e.type === "tool_execution_end" && e.toolCallId === "c2");
    expect(end).toMatchObject({
      isError: true,
      result: { content: [{ type: "text", text: STEERING_SKIP_REASON }], details: {} },
    });
    expect(agent.state.messages[3]).toMatchObject({
      role: "toolResult",
      toolCallId: "c2",
      toolName: "b",
      isError: true,
      content: [{ type: "text", text: STEERING_SKIP_REASON }],
      details: {},
    });
    expect(seen[1]?.messages.at(-1)).toBe("user:stop");
  });

  it("steering queued before the batch: the first call still runs", async () => {
    const order: string[] = [];
    const holder: { agent?: Agent } = {};
    const { agent, outline } = setup(
      { initialState: { tools: [tracked("a", order), tracked("b", order)] } },
      [{ ...calls("a", "b"), onCall: () => holder.agent?.steer(user("stop")) }, { text: "ok" }],
    );
    holder.agent = agent;
    await agent.prompt("go");
    expect(order).toEqual(["a:start", "a:end"]);
    expect(outline().slice(6, 14)).toEqual([
      ...toolCallEvents("c1", "a", "ok", "a ok"),
      ...skipped("c2", "b"),
    ]);
  });

  it("an unknown tool or invalid arguments report their own error, not the skip", async () => {
    const order: string[] = [];
    const holder: { agent?: Agent } = {};
    const strict = tool("strict", undefined, {
      parameters: { type: "object", properties: { n: { type: "number" } }, required: ["n"] },
    });
    const { agent, raw } = setup(
      {
        initialState: {
          tools: [tracked("a", order, () => holder.agent?.steer(user("stop"))), strict],
        },
      },
      [calls("a", "missing", "strict", "a"), { text: "ok" }],
    );
    holder.agent = agent;
    await agent.prompt("go");
    const texts = raw.flatMap((e) =>
      e.type === "tool_execution_end"
        ? [(e.result as { content: Array<{ text: string }> }).content[0]?.text.split("\n")[0]]
        : [],
    );
    expect(texts).toEqual([
      "a ok",
      "Tool missing not found",
      'Validation failed for tool "strict":',
      STEERING_SKIP_REASON,
    ]);
  });

  it("the check is live: clearing the steering queue lets later calls run", async () => {
    const order: string[] = [];
    const holder: { agent?: Agent } = {};
    const { agent, raw } = setup(
      {
        initialState: {
          tools: [
            tracked("a", order, () => holder.agent?.steer(user("stop"))),
            tracked("b", order),
            tracked("c", order),
          ],
        },
      },
      [calls("a", "b", "c"), { text: "ok" }],
    );
    holder.agent = agent;
    agent.subscribe((event) => {
      if (event.type === "tool_execution_end" && event.toolCallId === "c2") {
        agent.clearSteeringQueue();
      }
    });
    await agent.prompt("go");
    expect(order).toEqual(["a:start", "a:end", "c:start", "c:end"]);
    expect(raw.flatMap((e) => (e.type === "tool_execution_end" ? [e.isError] : []))).toEqual([
      false,
      true,
      false,
    ]);
  });

  it("in parallel mode the first call runs and the rest are skipped while steering is queued", async () => {
    const order: string[] = [];
    const { agent } = setup(
      {
        toolExecution: "parallel",
        initialState: { tools: [tracked("a", order), tracked("b", order)] },
      },
      [calls("a", "b", "a"), { text: "ok" }],
    );
    agent.followUp(user("follow-ups do not skip anything"));
    const holder = { steered: false };
    agent.subscribe((event) => {
      if (event.type === "tool_execution_start" && !holder.steered) {
        holder.steered = true;
        agent.steer(user("stop"));
      }
    });
    await agent.prompt("go");
    expect(order).toEqual(["a:start", "a:end"]);
  });

  it("skipToolCallsOnSteering: false runs the whole batch (pi 0.73 behaviour)", async () => {
    const order: string[] = [];
    const holder: { agent?: Agent } = {};
    const { agent, outline } = setup(
      {
        skipToolCallsOnSteering: false,
        initialState: {
          tools: [
            tracked("a", order, () => holder.agent?.steer(user("stop"))),
            tracked("b", order),
          ],
        },
      },
      [calls("a", "b"), { text: "ok" }],
    );
    holder.agent = agent;
    await agent.prompt("go");
    expect(order).toEqual(["a:start", "a:end", "b:start", "b:end"]);
    expect(outline().slice(14, 18)).toEqual([
      "turn_end assistant(toolUse):<toolCall><toolCall> results=2",
      "turn_start",
      "message_start user:stop",
      "message_end user:stop",
    ]);
  });

  it("the option is read at run start", async () => {
    const order: string[] = [];
    const holder: { agent?: Agent } = {};
    const { agent } = setup(
      {
        initialState: {
          tools: [
            tracked("a", order, () => {
              holder.agent?.steer(user("stop"));
              if (holder.agent) {
                holder.agent.skipToolCallsOnSteering = false;
              }
            }),
            tracked("b", order),
          ],
        },
      },
      [calls("a", "b"), { text: "ok" }],
    );
    holder.agent = agent;
    await agent.prompt("go");
    expect(order).toEqual(["a:start", "a:end"]);
  });

  it("the low-level loop skips only when hasQueuedSteeringMessages is given", async () => {
    const run = async (extra: Json) => {
      const order: string[] = [];
      await runAgentLoop(
        [user("go")],
        { systemPrompt: "", messages: [], tools: [tracked("a", order), tracked("b", order)] },
        { model, convertToLlm: (messages: unknown[]) => messages, ...extra } as never,
        () => {},
        undefined,
        scripted([calls("a", "b"), { text: "done" }]),
      );
      return order;
    };
    expect(await run({})).toEqual(["a:start", "a:end", "b:start", "b:end"]);
    expect(await run({ hasQueuedSteeringMessages: () => true })).toEqual(["a:start", "a:end"]);
    expect(
      await run({ hasQueuedSteeringMessages: () => true, skipToolCallsOnSteering: false }),
    ).toEqual(["a:start", "a:end", "b:start", "b:end"]);
  });
});

describe("difference 3: no tool call starts after an abort", () => {
  const abortingTool = (order: string[], holder: { agent?: Agent }) =>
    tool("slow", async (_id, _args, signal) => {
      order.push("slow:start");
      await sleep(2);
      holder.agent?.abort();
      await sleep(2);
      if (signal?.aborted) {
        throw new Error("slow aborted");
      }
      return ok("slow");
    });

  it("abort during the first call: the remaining calls get an error result and do not run", async () => {
    const order: string[] = [];
    const hooks: string[] = [];
    const holder: { agent?: Agent } = {};
    const { agent, outline, seen } = setup(
      {
        initialState: {
          tools: [abortingTool(order, holder), tracked("b", order), tracked("c", order)],
        },
        beforeToolCall: async (context: Json) => {
          hooks.push(`before ${String((context.toolCall as Json).id)}`);
          return undefined;
        },
        afterToolCall: async (context: Json) => {
          hooks.push(`after ${String((context.toolCall as Json).id)}`);
          return undefined;
        },
      },
      [calls("slow", "b", "missing"), { text: "never streamed" }],
    );
    holder.agent = agent;
    await agent.prompt("go");

    expect(ABORT_SKIP_REASON).toBe("Aborted before execution.");
    expect(order).toEqual(["slow:start"]);
    expect(hooks).toEqual(["before c1", "after c1"]);
    expect(outline()).toEqual([
      ...PROMPT,
      "message_start assistant(stop):",
      "message_end assistant(toolUse):<toolCall><toolCall><toolCall>",
      ...toolCallEvents("c1", "slow", "error", "slow aborted"),
      ...toolCallEvents("c2", "b", "error", ABORT_SKIP_REASON),
      ...toolCallEvents("c3", "missing", "error", ABORT_SKIP_REASON),
      "turn_end assistant(toolUse):<toolCall><toolCall><toolCall> results=3",
      "turn_start",
      "message_start assistant(aborted):",
      "message_end assistant(aborted):",
      "turn_end assistant(aborted): results=0",
      "agent_end user,assistant,toolResult,toolResult,toolResult,assistant",
    ]);
    // The closing aborted message comes from the loop (difference 4), not from a model call.
    expect(seen).toHaveLength(1);
    expect(agent.state.errorMessage).toBe("Request was aborted");
    expect(agent.state.messages[3]).toMatchObject({
      role: "toolResult",
      toolCallId: "c2",
      isError: true,
      content: [{ type: "text", text: ABORT_SKIP_REASON }],
      details: {},
    });
  });

  it("skipToolCallsOnAbort: false runs the remaining calls with the aborted signal (pi behaviour)", async () => {
    const order: string[] = [];
    const holder: { agent?: Agent } = {};
    const { agent, outline } = setup(
      {
        skipToolCallsOnAbort: false,
        initialState: {
          tools: [
            abortingTool(order, holder),
            tool("next", async (_id, _args, signal) => {
              order.push(`next:start aborted=${signal?.aborted}`);
              return ok("next ran");
            }),
          ],
        },
      },
      [calls("slow", "next"), { text: "never streamed" }],
    );
    holder.agent = agent;
    await agent.prompt("go");
    expect(order).toEqual(["slow:start", "next:start aborted=true"]);
    expect(outline().slice(6, 14)).toEqual([
      ...toolCallEvents("c1", "slow", "error", "slow aborted"),
      ...toolCallEvents("c2", "next", "ok", "next ran"),
    ]);
  });

  it("abort before the batch starts skips the first call too", async () => {
    const order: string[] = [];
    const { agent, outline } = setup({ initialState: { tools: [tracked("a", order)] } }, [
      calls("a"),
      { text: "never streamed" },
    ]);
    agent.subscribe((event) => {
      if (event.type === "message_end" && event.message.role === "assistant") {
        agent.abort();
      }
    });
    await agent.prompt("go");
    expect(order).toEqual([]);
    expect(outline().slice(6, 10)).toEqual(toolCallEvents("c1", "a", "error", ABORT_SKIP_REASON));
  });

  it("abort during beforeToolCall: the call is not executed and afterToolCall is not called", async () => {
    const order: string[] = [];
    const hooks: string[] = [];
    const holder: { agent?: Agent } = {};
    const { agent, raw } = setup(
      {
        initialState: { tools: [tracked("a", order)] },
        beforeToolCall: async () => {
          holder.agent?.abort();
          return undefined;
        },
        afterToolCall: async () => {
          hooks.push("after");
          return undefined;
        },
      },
      [calls("a"), { text: "never streamed" }],
    );
    holder.agent = agent;
    await agent.prompt("go");
    expect(order).toEqual([]);
    expect(hooks).toEqual([]);
    expect(raw.find((e) => e.type === "tool_execution_end")).toMatchObject({
      isError: true,
      result: { content: [{ type: "text", text: ABORT_SKIP_REASON }], details: {} },
    });
  });

  it("parallel mode: calls prepared before the abort are not executed either", async () => {
    const order: string[] = [];
    const holder: { agent?: Agent } = {};
    const { agent, outline } = setup(
      {
        toolExecution: "parallel",
        initialState: { tools: [tracked("a", order), tracked("b", order)] },
        // The abort arrives while the second call is being prepared.
        beforeToolCall: async (context: Json) => {
          if ((context.toolCall as Json).id === "c2") {
            holder.agent?.abort();
          }
          return undefined;
        },
      },
      [calls("a", "b", "a"), { text: "never streamed" }],
    );
    holder.agent = agent;
    await agent.prompt("go");
    expect(order).toEqual([]);
    expect(outline().filter((line) => line.startsWith("tool_execution_end"))).toEqual([
      `tool_execution_end c3 error ${ABORT_SKIP_REASON}`,
      `tool_execution_end c1 error ${ABORT_SKIP_REASON}`,
      `tool_execution_end c2 error ${ABORT_SKIP_REASON}`,
    ]);
  });
});

describe("difference 4: no model call after an abort", () => {
  const abortingTool = (holder: { agent?: Agent }) =>
    tool("slow", async () => {
      await sleep(2);
      holder.agent?.abort();
      return ok("slow finished");
    });

  it("abort during a tool batch: the run ends without another stream function call", async () => {
    const holder: { agent?: Agent } = {};
    const prepared: string[] = [];
    const { agent, events, raw, seen, stored } = setup(
      {
        initialState: { tools: [abortingTool(holder), tool("b")] },
        transformContext: async (messages: Json[]) => {
          prepared.push("transformContext");
          return messages;
        },
        getApiKey: () => {
          prepared.push("getApiKey");
          return "key";
        },
      },
      [calls("slow", "b"), { text: "never streamed" }],
    );
    holder.agent = agent;
    agent.followUp(user("stays queued"));
    await agent.prompt("go");

    expect(ABORTED_BEFORE_MODEL_CALL).toBe("Request was aborted");
    expect(seen).toHaveLength(1);
    // Prepared once, for the first call only.
    expect(prepared).toEqual(["transformContext", "getApiKey"]);
    expect(events).toEqual([
      "agent_start",
      "turn_start",
      "message_start user:go",
      "message_end user:go",
      "message_start assistant(stop):",
      "message_update toolcall_start",
      "message_update toolcall_end",
      "message_update toolcall_start",
      "message_update toolcall_end",
      "message_end assistant(toolUse):<toolCall><toolCall>",
      "tool_execution_start c1 slow {}",
      "tool_execution_end c1 ok slow finished",
      "message_start toolResult(c1):slow finished",
      "message_end toolResult(c1):slow finished",
      "tool_execution_start c2 b {}",
      `tool_execution_end c2 error ${ABORT_SKIP_REASON}`,
      `message_start toolResult(c2,error):${ABORT_SKIP_REASON}`,
      `message_end toolResult(c2,error):${ABORT_SKIP_REASON}`,
      "turn_end assistant(toolUse):<toolCall><toolCall> results=2",
      "turn_start",
      "message_start assistant(aborted):",
      "message_end assistant(aborted):",
      "turn_end assistant(aborted): results=0",
      "agent_end user,assistant,toolResult,toolResult,assistant",
    ]);
    expect(stored().at(-1)).toBe("assistant(aborted):");
    const last = agent.state.messages.at(-1);
    expect(last).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "" }],
      api: "fake-api",
      provider: "fake",
      model: "fake",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "aborted",
      errorMessage: ABORTED_BEFORE_MODEL_CALL,
      timestamp: expect.any(Number),
    });
    // message_end carries the stored object, message_start a copy of it.
    const closing = raw.filter(
      (e) =>
        (e.type === "message_start" || e.type === "message_end") && e.message.role === "assistant",
    );
    const [start, end] = closing.slice(-2);
    expect(end?.type === "message_end" && end.message).toBe(last);
    expect(start?.type === "message_start" && start.message).not.toBe(last);
    expect(agent.state.errorMessage).toBe(ABORTED_BEFORE_MODEL_CALL);
    expect(agent.state.isStreaming).toBe(false);
    expect(agent.hasQueuedMessages()).toBe(true);
  });

  it("a stream function that ignores the signal cannot continue the run", async () => {
    const run = async (options: Json) => {
      const holder: { agent?: Agent } = {};
      const result = setup({ ...options, initialState: { tools: [abortingTool(holder)] } }, [
        calls("slow"),
        { text: "ignored the abort", ignoreAbort: true, ...calls("slow") },
        { text: "and went on", ignoreAbort: true },
      ]);
      holder.agent = result.agent;
      await result.agent.prompt("go");
      return result;
    };

    const guarded = await run({});
    expect(guarded.seen).toHaveLength(1);
    expect(guarded.stored()).toEqual([
      "user:go",
      "assistant(toolUse):<toolCall>",
      "toolResult(c1):slow finished",
      "assistant(aborted):",
    ]);

    // pi's behaviour: the aborted run goes on for as long as the stream function answers.
    const unguarded = await run({ abortBeforeModelCall: false });
    expect(unguarded.seen).toHaveLength(3);
    expect(unguarded.stored().at(-1)).toBe("assistant(stop):and went on");
    expect(unguarded.agent.state.errorMessage).toBeUndefined();
  });

  it("abortBeforeModelCall: false leaves the abort to the stream function", async () => {
    const holder: { agent?: Agent } = {};
    const { agent, seen, stored } = setup(
      { abortBeforeModelCall: false, initialState: { tools: [abortingTool(holder)] } },
      [calls("slow"), { text: "never streamed" }],
    );
    holder.agent = agent;
    await agent.prompt("go");
    expect(seen).toHaveLength(2);
    const secondSignal = seen[1]?.options.signal as AbortSignal | undefined;
    expect(secondSignal?.aborted).toBe(true);
    expect(stored().at(-1)).toBe("assistant(aborted):");
  });

  it("abort before the first model call of continue() and of prompt()", async () => {
    const prepared: string[] = [];
    const options = {
      initialState: { messages: [user("pending")] },
      transformContext: async (messages: Json[]) => {
        prepared.push("transformContext");
        return messages;
      },
      convertToLlm: (messages: Json[]) => {
        prepared.push("convertToLlm");
        return messages;
      },
    };
    const continued = setup(options, [{ text: "never streamed" }]);
    continued.agent.subscribe((event) => {
      if (event.type === "agent_start") {
        continued.agent.abort();
      }
    });
    await continued.agent.continue();
    expect(continued.events).toEqual([
      "agent_start",
      "turn_start",
      "message_start assistant(aborted):",
      "message_end assistant(aborted):",
      "turn_end assistant(aborted): results=0",
      "agent_end assistant",
    ]);
    expect(continued.seen).toHaveLength(0);
    expect(prepared).toEqual([]);
    expect(continued.stored()).toEqual(["user:pending", "assistant(aborted):"]);
    expect(continued.agent.state.errorMessage).toBe(ABORTED_BEFORE_MODEL_CALL);

    const prompted = setup({}, [{ text: "never streamed" }]);
    prompted.agent.subscribe((event) => {
      if (event.type === "message_end") {
        prompted.agent.abort();
      }
    });
    await prompted.agent.prompt("go");
    expect(prompted.events).toEqual([
      ...PROMPT,
      "message_start assistant(aborted):",
      "message_end assistant(aborted):",
      "turn_end assistant(aborted): results=0",
      "agent_end user,assistant",
    ]);
    expect(prompted.seen).toHaveLength(0);
  });

  it("an abort while the context is prepared is caught right before the call", async () => {
    const holder: { agent?: Agent } = {};
    const prepared: string[] = [];
    const { agent, seen, stored } = setup(
      {
        transformContext: async (messages: Json[]) => {
          prepared.push("transformContext");
          holder.agent?.abort();
          return messages;
        },
        convertToLlm: (messages: Json[]) => {
          prepared.push("convertToLlm");
          return messages;
        },
      },
      [{ text: "never streamed" }],
    );
    holder.agent = agent;
    await agent.prompt("go");
    expect(prepared).toEqual(["transformContext", "convertToLlm"]);
    expect(seen).toHaveLength(0);
    expect(stored()).toEqual(["user:go", "assistant(aborted):"]);
  });

  it("the low-level loop does the same for a signal that is aborted from the start", async () => {
    const controller = new AbortController();
    controller.abort();
    const seen: Seen[] = [];
    const types: string[] = [];
    const messages = await runAgentLoop(
      [user("go")],
      { systemPrompt: "", messages: [] },
      { model, convertToLlm: (all: unknown[]) => all } as never,
      (event) => {
        types.push(event.type);
      },
      controller.signal,
      scripted([{ text: "never streamed", ignoreAbort: true }], seen),
    );
    expect(seen).toHaveLength(0);
    expect(types).toEqual([
      "agent_start",
      "turn_start",
      "message_start",
      "message_end",
      "message_start",
      "message_end",
      "turn_end",
      "agent_end",
    ]);
    expect(messages.at(-1)).toMatchObject({
      role: "assistant",
      stopReason: "aborted",
      errorMessage: ABORTED_BEFORE_MODEL_CALL,
    });
  });
});

describe("difference 5: a stream that ends without a final message", () => {
  it("ends the turn with an error message that keeps the partial content", async () => {
    const { agent, events } = setup({}, [{ text: "half an answer", endBare: true }]);
    agent.followUp(user("not polled after an error"));
    await agent.prompt("go");
    expect(events).toEqual([
      ...PROMPT,
      "message_start assistant(stop):",
      "message_update text_start",
      "message_update text_delta",
      "message_update text_end",
      "message_end assistant(error):half an answer",
      "turn_end assistant(error):half an answer results=0",
      "agent_end user,assistant",
    ]);
    expect(agent.state.errorMessage).toBe(STREAM_ENDED_MESSAGE);
    expect(agent.state.messages[1]).toMatchObject({
      role: "assistant",
      stopReason: "error",
      errorMessage: STREAM_ENDED_MESSAGE,
      usage: { input: 1, output: 2 },
    });
    expect(agent.hasQueuedMessages()).toBe(true);
  });

  it("without a start event the message is the synthetic failure message", async () => {
    const { agent, events } = setup({}, [{ noStart: true, endBare: true }]);
    await agent.prompt("go");
    expect(events).toEqual([
      ...PROMPT,
      "message_start assistant(error):",
      "message_end assistant(error):",
      "turn_end assistant(error): results=0",
      "agent_end user,assistant",
    ]);
    expect(agent.state.messages[1]).toMatchObject({
      content: [{ type: "text", text: "" }],
      api: "fake-api",
      provider: "fake",
      model: "fake",
      errorMessage: STREAM_ENDED_MESSAGE,
    });
  });

  it("tool calls of the unfinished message are not executed; aborted runs report aborted", async () => {
    const order: string[] = [];
    const failed = setup({ initialState: { tools: [tracked("a", order)] } }, [
      { ...calls("a"), endBare: true },
    ]);
    await failed.agent.prompt("go");
    expect(failed.stored()).toEqual(["user:go", "assistant(error):<toolCall>"]);

    const aborted = setup({ initialState: { tools: [tracked("a", order)] } }, [
      { ...calls("a"), endBare: true },
    ]);
    aborted.agent.subscribe((event) => {
      if (event.type === "message_start" && event.message.role === "assistant") {
        aborted.agent.abort();
      }
    });
    await aborted.agent.prompt("go");
    expect(aborted.stored()).toEqual(["user:go", "assistant(aborted):<toolCall>"]);
    expect(aborted.agent.state.errorMessage).toBe(STREAM_ENDED_MESSAGE);
    expect(aborted.seen).toHaveLength(1);
    expect(order).toEqual([]);
  });
});

describe("differences 6 and 7, and the low-level functions", () => {
  it("agentLoop streams the events and resolves with the new messages", async () => {
    const stream = agentLoop(
      [user("go")],
      { systemPrompt: "", messages: [user("old")], tools: [tool("a")] },
      { model, convertToLlm: (messages: unknown[]) => messages } as never,
      undefined,
      scripted([calls("a"), { text: "done" }]),
    );
    const types: string[] = [];
    for await (const event of stream) {
      types.push(event.type);
    }
    const messages = await stream.result();
    expect(types[0]).toBe("agent_start");
    expect(types.at(-1)).toBe("agent_end");
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "toolResult", "assistant"]);
  });

  it("agentLoop ends its stream with a failure message when the loop rejects", async () => {
    const stream = agentLoop(
      [user("go")],
      { systemPrompt: "", messages: [] },
      { model, convertToLlm: (messages: unknown[]) => messages } as never,
      undefined,
      scripted([{ throws: "no auth" }]),
    );
    const events: AgentEvent[] = [];
    for await (const event of stream) {
      events.push(event);
    }
    expect(events.map((e) => e.type)).toEqual([
      "agent_start",
      "turn_start",
      "message_start",
      "message_end",
      "agent_end",
    ]);
    const messages = await stream.result();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      role: "assistant",
      stopReason: "error",
      errorMessage: "no auth",
    });
  });

  it("runAgentLoop does not mutate the given context; runAgentLoopContinue appends to it", async () => {
    const config = { model, convertToLlm: (messages: unknown[]) => messages } as never;
    const context = { systemPrompt: "", messages: [user("old")] as never[] };
    const added = await runAgentLoop(
      [user("go")],
      context,
      config,
      () => {},
      undefined,
      scripted([{ text: "r" }]),
    );
    expect(added.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(context.messages).toHaveLength(1);

    const continued = await runAgentLoopContinue(
      context,
      config,
      () => {},
      undefined,
      scripted([{ text: "r" }]),
    );
    expect(continued.map((m) => m.role)).toEqual(["assistant"]);
    expect(context.messages).toHaveLength(2);

    await expect(
      runAgentLoopContinue({ systemPrompt: "", messages: [] }, config, () => {}),
    ).rejects.toThrow("Cannot continue: no messages in context");
    await expect(
      runAgentLoopContinue({ systemPrompt: "", messages: [assistantMsg("a")] }, config, () => {}),
    ).rejects.toThrow("Cannot continue from message role: assistant");
  });

  it("shouldStopAfterTurn ends the run before the queues are polled", async () => {
    const polls: string[] = [];
    const types: string[] = [];
    await runAgentLoop(
      [user("go")],
      { systemPrompt: "", messages: [], tools: [tool("a")] },
      {
        model,
        convertToLlm: (messages: unknown[]) => messages,
        getSteeringMessages: async () => {
          polls.push("steering");
          return [];
        },
        getFollowUpMessages: async () => {
          polls.push("follow-up");
          return [];
        },
        shouldStopAfterTurn: () => true,
      } as never,
      (event) => {
        types.push(event.type);
      },
      undefined,
      scripted([calls("a"), { text: "never" }]),
    );
    expect(polls).toEqual(["steering"]);
    expect(types.slice(-2)).toEqual(["turn_end", "agent_end"]);
  });

  it("onUpdate calls made after the tool settled are ignored", async () => {
    let lateUpdate: ((partial: Json) => void) | undefined;
    const { agent, events } = setup(
      {
        initialState: {
          tools: [
            tool("u", async (_id, _args, _signal, onUpdate) => {
              lateUpdate = onUpdate;
              onUpdate(ok("in time"));
              return ok("U");
            }),
          ],
        },
      },
      [calls("u"), { text: "done" }],
    );
    agent.subscribe((event) => {
      if (event.type === "tool_execution_end") {
        lateUpdate?.(ok("late"));
      }
    });
    await agent.prompt("go");
    lateUpdate?.(ok("after the run"));
    await sleep(2);
    expect(events.filter((line) => line.startsWith("tool_execution_update"))).toEqual([
      "tool_execution_update c1 in time",
    ]);
  });

  it("failure messages do not share their usage object", () => {
    const a = createFailureMessage(model as never, new Error("x"), false);
    const b = createFailureMessage(model as never, "y", true);
    expect(a.usage).toEqual(b.usage);
    expect(a.usage).not.toBe(b.usage);
    expect(a.usage.cost).not.toBe(b.usage.cost);
    expect([a.stopReason, a.errorMessage, b.stopReason, b.errorMessage]).toEqual([
      "error",
      "x",
      "aborted",
      "y",
    ]);
  });
});
