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
