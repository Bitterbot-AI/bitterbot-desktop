/**
 * Tests for RLM Deep Recall: sandbox, executor, cost tracker, and context builder.
 */
import { describe, it, expect, beforeEach } from "vitest";
import type { RLMLLMCallFn, RLMExecutorOptions } from "./types.js";
import { CostTracker } from "./cost-tracker.js";
import { RLMExecutor } from "./executor.js";
import { RLMSandbox } from "./sandbox.js";

// ---------------------------------------------------------------------------
// CostTracker
// ---------------------------------------------------------------------------

describe("CostTracker", () => {
  it("tracks cost and returns budget status", () => {
    const tracker = new CostTracker(0.5, 20, 15);
    expect(tracker.isExceeded()).toBeNull();
    tracker.addCost(0.1);
    tracker.addCost(0.1);
    expect(tracker.getTotalCost()).toBeCloseTo(0.2);
    expect(tracker.isExceeded()).toBeNull();
  });

  it("detects budget exceeded", () => {
    const tracker = new CostTracker(0.1, 20, 15);
    tracker.addCost(0.11);
    expect(tracker.isExceeded()).toBe("budget");
  });

  it("detects sub-call limit exceeded", () => {
    const tracker = new CostTracker(1.0, 2, 15);
    tracker.addSubCall();
    tracker.addSubCall();
    expect(tracker.isExceeded()).toBeNull();
    tracker.addSubCall();
    expect(tracker.isExceeded()).toBe("sub_calls");
  });

  it("detects iteration limit exceeded", () => {
    const tracker = new CostTracker(1.0, 20, 3);
    expect(tracker.addIteration()).toBe(true);
    expect(tracker.addIteration()).toBe(true);
    expect(tracker.addIteration()).toBe(true);
    expect(tracker.addIteration()).toBe(false);
    expect(tracker.isExceeded()).toBe("iterations");
  });

  it("canAffordSubCall heuristic works", () => {
    const tracker = new CostTracker(0.1, 20, 15);
    expect(tracker.canAffordSubCall()).toBe(true);
    // Simulate 5 sub-calls at $0.01 each
    for (let i = 0; i < 5; i++) {
      tracker.addCost(0.01);
      tracker.addSubCall();
    }
    expect(tracker.canAffordSubCall()).toBe(true);
    // Add more cost to push near limit
    tracker.addCost(0.04);
    // Average cost is 0.09/5 = 0.018, total = 0.09, next would = 0.108 > 0.10
    expect(tracker.canAffordSubCall()).toBe(false);
  });

  it("summary returns correct values", () => {
    const tracker = new CostTracker(1.0, 10, 5);
    tracker.addCost(0.25);
    tracker.addSubCall();
    tracker.addSubCall();
    tracker.addIteration();
    const summary = tracker.getSummary();
    expect(summary.cost).toBeCloseTo(0.25);
    expect(summary.subCalls).toBe(2);
    expect(summary.iterations).toBe(1);
    expect(summary.budgetRemaining).toBeCloseTo(0.75);
    expect(summary.subCallsRemaining).toBe(8);
    expect(summary.iterationsRemaining).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// RLMSandbox
// ---------------------------------------------------------------------------

describe("RLMSandbox", () => {
  let sandbox: RLMSandbox;

  beforeEach(() => {
    sandbox = new RLMSandbox({
      context: "Line 1: Hello World\nLine 2: Foo Bar\nLine 3: Test Data\nLine 4: Hello Again",
      timeout: 5000,
      onLLMQuery: async (prompt) => `Mock response for: ${prompt.slice(0, 50)}`,
    });
  });

  it("executes simple code and captures output", async () => {
    const result = await sandbox.execute('print("hello from sandbox");');
    expect(result.output).toBe("hello from sandbox");
    expect(result.error).toBeUndefined();
  });

  it("provides access to context variable", async () => {
    const result = await sandbox.execute("print(len(context));");
    expect(result.output).toBe("73"); // length of the context string
    expect(result.error).toBeUndefined();
  });

  it("grep filters matching lines", async () => {
    const result = await sandbox.execute(`
      const matches = grep(context, "Hello");
      print(matches.length);
      print(matches[0]);
    `);
    expect(result.output).toContain("2");
    expect(result.output).toContain("Line 1: Hello World");
  });

  it("chunk splits text correctly", async () => {
    const result = await sandbox.execute(`
      const chunks = chunk(context, 20);
      print(chunks.length);
      print(chunks[0].length);
    `);
    const lines = result.output.split("\n");
    expect(Number(lines[0])).toBeGreaterThan(1);
    expect(Number(lines[1])).toBeLessThanOrEqual(20);
  });

  it("store/get persists across executions", async () => {
    await sandbox.execute('store("key1", "value1");');
    const result = await sandbox.execute('print(get("key1"));');
    expect(result.output).toBe("value1");
  });

  it("FINAL signals completion", async () => {
    await sandbox.execute('FINAL("The answer is 42");');
    expect(sandbox.getFinalAnswer()).toBe("The answer is 42");
    expect(sandbox.resolveFinalAnswer()).toBe("The answer is 42");
  });

  it("FINAL_VAR resolves from store", async () => {
    await sandbox.execute(`
      store("result", "computed value");
      FINAL_VAR("result");
    `);
    expect(sandbox.getFinalVarName()).toBe("result");
    expect(sandbox.resolveFinalAnswer()).toBe("computed value");
  });

  it("handles errors gracefully", async () => {
    const result = await sandbox.execute("undeclaredVariable.foo();");
    expect(result.error).toBeDefined();
  });

  it("llm_query callback works", async () => {
    const result = await sandbox.execute(`
      const answer = await llm_query("What is 2+2?");
      print(answer);
    `);
    expect(result.output).toContain("Mock response for");
  });

  it("textStats returns correct values", async () => {
    const result = await sandbox.execute(`
      const stats = textStats(context);
      print(JSON.stringify(stats));
    `);
    const stats = JSON.parse(result.output);
    expect(stats.chars).toBe(73);
    expect(stats.lines).toBe(4);
    expect(stats.words).toBeGreaterThan(0);
  });

  it("getLines extracts line range", async () => {
    const result = await sandbox.execute(`
      const lines = getLines(context, 2, 3);
      print(lines);
    `);
    expect(result.output).toContain("Line 2: Foo Bar");
    expect(result.output).toContain("Line 3: Test Data");
    expect(result.output).not.toContain("Line 1");
  });

  it("does not expose filesystem or network", async () => {
    const result1 = await sandbox.execute("print(typeof require);");
    expect(result1.output).toBe("undefined");

    const result2 = await sandbox.execute("print(typeof process);");
    expect(result2.output).toBe("undefined");

    const result3 = await sandbox.execute("print(typeof fetch);");
    expect(result3.output).toBe("undefined");
  });

  it("reset clears state", async () => {
    await sandbox.execute('store("x", 1); FINAL("done");');
    expect(sandbox.resolveFinalAnswer()).toBe("done");
    sandbox.reset();
    expect(sandbox.resolveFinalAnswer()).toBeNull();
    const result = await sandbox.execute('print(get("x"));');
    expect(result.output).toBe("undefined");
  });

  it("clearFinal clears completion signals but keeps the store", async () => {
    await sandbox.execute('store("kept", "yes"); FINAL("done");');
    sandbox.clearFinal();
    expect(sandbox.resolveFinalAnswer()).toBeNull();
    const result = await sandbox.execute('print(get("kept"));');
    expect(result.output).toBe("yes");
  });

  it("exportStore/importStore round-trips serializable entries", async () => {
    await sandbox.execute('store("a", {x: 1}); store("b", "text");');
    const exported = sandbox.exportStore();
    expect(exported).toEqual({ a: { x: 1 }, b: "text" });

    const fresh = new RLMSandbox({
      context: "other",
      timeout: 5000,
      onLLMQuery: async () => "mock",
    });
    fresh.importStore(exported);
    const result = await fresh.execute('print(JSON.stringify(get("a")));');
    expect(result.output).toBe('{"x":1}');
    fresh.dispose();
  });

  it("updateContext swaps context but preserves the store", async () => {
    await sandbox.execute('store("keep", "v1");');
    sandbox.updateContext("brand new context");
    const result = await sandbox.execute('print(context); print(get("keep"));');
    expect(result.output).toContain("brand new context");
    expect(result.output).toContain("v1");
  });

  it("live APIs are injected when provided and guarded on error", async () => {
    const live = new RLMSandbox({
      context: "bootstrap snapshot",
      timeout: 5000,
      onLLMQuery: async () => "mock",
      liveApis: {
        search: async (query) => [{ snippet: `hit for ${query}`, score: 0.9, source: "memory" }],
        loadTranscript: async (id) => (id === "s1" ? "[t] USER: hello" : null),
        listSessions: async () => {
          throw new Error("db locked");
        },
      },
    });
    expect(live.hasLiveApis()).toBe(true);

    const searchResult = await live.execute(
      'const r = await search("gccrf"); print(r[0].snippet + " @" + r[0].score);',
    );
    expect(searchResult.output).toBe("hit for gccrf @0.9");

    const transcriptResult = await live.execute(
      'print(await loadTranscript("s1")); print(await loadTranscript("nope"));',
    );
    expect(transcriptResult.output).toContain("[t] USER: hello");
    expect(transcriptResult.output).toContain("null");

    // Errors come back as data, never as sandbox crashes
    const listResult = await live.execute("const s = await listSessions(); print(s[0].sessionId);");
    expect(listResult.output).toContain("listSessions error: db locked");
    expect(listResult.error).toBeUndefined();
    live.dispose();
  });

  it("live APIs are absent when not provided", async () => {
    expect(sandbox.hasLiveApis()).toBe(false);
    const result = await sandbox.execute("print(typeof search);");
    expect(result.output).toBe("undefined");
  });
});

// ---------------------------------------------------------------------------
// RLMExecutor
// ---------------------------------------------------------------------------

describe("RLMExecutor", () => {
  const defaultOptions: RLMExecutorOptions = {
    model: "gpt-4o-mini",
    provider: "openai",
    subModel: "gpt-4o-mini",
    subProvider: "openai",
    maxIterations: 10,
    maxDepth: 1,
    maxBudget: 1.0,
    maxSubCalls: 20,
    timeout: 5000,
  };

  it("executes a simple query with FINAL in first iteration", async () => {
    const mockLlm: RLMLLMCallFn = async ({ messages }) => {
      // Check if this is the first call (has system message)
      const lastMsg = messages[messages.length - 1]!;
      if (lastMsg.role === "user" && lastMsg.content.includes("Question:")) {
        return {
          text: '```js\nconst matches = grep(context, "important");\nFINAL("Found " + matches.length + " matches");\n```',
          cost: 0.001,
        };
      }
      return { text: "Done", cost: 0.001 };
    };

    const executor = new RLMExecutor(mockLlm);
    const result = await executor.execute(
      "Find important items",
      "Line 1: important data\nLine 2: normal data\nLine 3: important info",
      defaultOptions,
    );

    expect(result.success).toBe(true);
    expect(result.answer).toBe("Found 2 matches");
    expect(result.iterations).toBe(1);
    expect(result.cost).toBeGreaterThan(0);
  });

  it("handles multi-step exploration", async () => {
    let callCount = 0;
    const mockLlm: RLMLLMCallFn = async ({ messages }) => {
      callCount++;
      const _lastMsg = messages[messages.length - 1]!;

      if (callCount === 1) {
        // First call: explore
        return {
          text: '```js\nconst stats = textStats(context);\nprint("Context has " + stats.lines + " lines");\nstore("lineCount", stats.lines);\n```',
          cost: 0.001,
        };
      }
      if (callCount === 2) {
        // Second call: find answer
        return {
          text: '```js\nconst count = get("lineCount");\nFINAL("The context has " + count + " lines of data");\n```',
          cost: 0.001,
        };
      }
      return { text: "Done", cost: 0 };
    };

    const executor = new RLMExecutor(mockLlm);
    const result = await executor.execute("How many lines?", "A\nB\nC\nD\nE", defaultOptions);

    expect(result.success).toBe(true);
    expect(result.answer).toBe("The context has 5 lines of data");
    expect(result.iterations).toBe(2);
  });

  it("respects iteration limit", async () => {
    // LLM never calls FINAL — should hit iteration limit
    const mockLlm: RLMLLMCallFn = async () => ({
      text: '```js\nprint("still searching...");\n```',
      cost: 0.001,
    });

    const executor = new RLMExecutor(mockLlm);
    const result = await executor.execute("Find something", "test context", {
      ...defaultOptions,
      maxIterations: 3,
    });

    expect(result.success).toBe(false);
    expect(result.limitReached).toBe("iterations");
    expect(result.iterations).toBeGreaterThanOrEqual(3);
  });

  it("handles code errors and continues", async () => {
    let callCount = 0;
    const mockLlm: RLMLLMCallFn = async () => {
      callCount++;
      if (callCount === 1) {
        return {
          text: "```js\nundefinedVar.method();\n```",
          cost: 0.001,
        };
      }
      // After error feedback, produce correct code
      return {
        text: '```js\nFINAL("recovered from error");\n```',
        cost: 0.001,
      };
    };

    const executor = new RLMExecutor(mockLlm);
    const result = await executor.execute("test", "context", defaultOptions);

    expect(result.success).toBe(true);
    expect(result.answer).toBe("recovered from error");
    expect(result.trace.some((t) => t.type === "error")).toBe(true);
  });

  it("handles LLM response without code block", async () => {
    let callCount = 0;
    const mockLlm: RLMLLMCallFn = async () => {
      callCount++;
      if (callCount === 1) {
        return { text: "I need to think about this...", cost: 0.001 };
      }
      return {
        text: '```js\nFINAL("found it");\n```',
        cost: 0.001,
      };
    };

    const executor = new RLMExecutor(mockLlm);
    const result = await executor.execute("test", "context", defaultOptions);

    expect(result.success).toBe(true);
    expect(result.answer).toBe("found it");
  });

  it("parallel sub-calls reserve slots synchronously against the cap", async () => {
    const mockLlm: RLMLLMCallFn = async ({ model }) => {
      if (model === "root-model") {
        return {
          text: '```js\nconst rs = await llm_query_parallel([{prompt:"a"},{prompt:"b"},{prompt:"c"}]);\nFINAL(String(rs.filter(r => r.includes("Budget exceeded")).length));\n```',
          cost: 0.001,
        };
      }
      return { text: "sub answer", cost: 0.0001 };
    };

    const executor = new RLMExecutor(mockLlm);
    const result = await executor.execute("test", "context", {
      ...defaultOptions,
      model: "root-model",
      subModel: "sub-model",
      maxSubCalls: 2,
    });

    // 3 parallel queries against a cap of 2: exactly one must be refused,
    // even though all three dispatch before any sub-call completes.
    expect(result.answer).toBe("1");
  });

  it("maxDepth 2 runs sub-calls as nested mini-RLMs", async () => {
    const rootCalls: string[] = [];
    const mockLlm: RLMLLMCallFn = async ({ messages, model }) => {
      const system = messages.find((m) => m.role === "system");
      const lastMsg = messages[messages.length - 1]!;
      rootCalls.push(`${model}:${lastMsg.content.slice(0, 40)}`);
      if (model === "root-model") {
        return {
          text: '```js\nconst answer = await llm_query("count the lines", "A\\nB\\nC");\nFINAL(answer);\n```',
          cost: 0.001,
        };
      }
      // Nested mini-RLM: the sub model also gets a REPL system prompt
      if (system && lastMsg.content.includes("Question:")) {
        return {
          text: '```js\nFINAL("3 lines (from nested REPL)");\n```',
          cost: 0.0005,
        };
      }
      return { text: "plain completion", cost: 0.0005 };
    };

    const executor = new RLMExecutor(mockLlm);
    const result = await executor.execute("How many lines?", "outer context", {
      ...defaultOptions,
      model: "root-model",
      subModel: "sub-model",
      maxDepth: 2,
    });

    expect(result.success).toBe(true);
    expect(result.answer).toBe("3 lines (from nested REPL)");
    // The nested run's iterations show up as a sub-RLM trace entry
    expect(result.trace.some((t) => t.type === "sub_call" && t.content.includes("sub-RLM"))).toBe(
      true,
    );
    // Nested cost charged to the parent run
    expect(result.cost).toBeGreaterThan(0.001);
  });

  it("maxDepth 1 keeps sub-calls as plain completions", async () => {
    const subSystemPrompts: number[] = [];
    const mockLlm: RLMLLMCallFn = async ({ messages, model }) => {
      if (model === "root-model") {
        return {
          text: '```js\nconst a = await llm_query("summarize", "some text");\nFINAL(a);\n```',
          cost: 0.001,
        };
      }
      subSystemPrompts.push(messages.filter((m) => m.role === "system").length);
      return { text: "plain summary", cost: 0.0005 };
    };

    const executor = new RLMExecutor(mockLlm);
    const result = await executor.execute("test", "context", {
      ...defaultOptions,
      model: "root-model",
      subModel: "sub-model",
      maxDepth: 1,
    });

    expect(result.answer).toBe("plain summary");
    // Plain sub-calls carry no REPL system prompt
    expect(subSystemPrompts).toEqual([0]);
  });

  it("reuses an external sandbox and preserves its store across runs", async () => {
    const sandbox = new RLMSandbox({
      context: "shared context",
      timeout: 5000,
      onLLMQuery: async () => "[unbound]",
    });

    const firstLlm: RLMLLMCallFn = async () => ({
      text: '```js\nstore("finding", "cached-insight");\nFINAL("first done");\n```',
      cost: 0.001,
    });
    const executor1 = new RLMExecutor(firstLlm);
    const r1 = await executor1.execute("first", "shared context", defaultOptions, sandbox);
    expect(r1.answer).toBe("first done");

    // Second run on the same sandbox: stale FINAL must not short-circuit,
    // and the store from run 1 must still be readable.
    const secondLlm: RLMLLMCallFn = async () => ({
      text: '```js\nFINAL("recalled: " + get("finding"));\n```',
      cost: 0.001,
    });
    const executor2 = new RLMExecutor(secondLlm);
    const r2 = await executor2.execute("second", "shared context", defaultOptions, sandbox);
    expect(r2.answer).toBe("recalled: cached-insight");
    expect(r2.iterations).toBe(1);

    // External sandbox is not disposed by the executor
    const probe = await sandbox.execute('print(get("finding"));');
    expect(probe.output).toBe("cached-insight");
    sandbox.dispose();
  });

  it("tracks sub-calls via llm_query", async () => {
    let callCount = 0;
    const mockLlm: RLMLLMCallFn = async ({ messages: _messages }) => {
      callCount++;
      if (callCount === 1) {
        return {
          text: '```js\nconst answer = await llm_query("summarize this");\nFINAL(answer);\n```',
          cost: 0.001,
        };
      }
      // Sub-call response
      return { text: "Summary: test data", cost: 0.0005 };
    };

    const executor = new RLMExecutor(mockLlm);
    const result = await executor.execute("summarize", "test data here", defaultOptions);

    expect(result.success).toBe(true);
    expect(result.subCalls).toBeGreaterThanOrEqual(1);
    expect(result.cost).toBeGreaterThan(0.001);
  });
});
