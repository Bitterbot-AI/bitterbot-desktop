/**
 * PLAN-52A: the whole-run wall clock. `limitReached: "timeout"` existed in the
 * result type since deep recall shipped, but nothing ever produced it: only the
 * per-code-block sandbox timeout was enforced, so a slow provider could hold a
 * user turn open for minutes (the paper's p95 tail, Appendix F.2).
 */
import { describe, expect, it } from "vitest";
import { RLMDeadlineError, RLMExecutor } from "./executor.js";
import type { RLMExecutorOptions, RLMLLMCallFn } from "./types.js";

const baseOptions: RLMExecutorOptions = {
  model: "root",
  provider: "test",
  subModel: "sub",
  subProvider: "test",
  maxIterations: 10,
  maxDepth: 1,
  maxBudget: 1,
  maxSubCalls: 10,
  timeout: 5_000,
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("RLMExecutor wall clock", () => {
  it("cuts a slow root call and reports limitReached=timeout with partial output", async () => {
    let calls = 0;
    const slowLlm: RLMLLMCallFn = async () => {
      calls++;
      if (calls === 1) {
        return { text: '```js\nprint("partial finding");\n```', cost: 0.001 };
      }
      await sleep(3_000);
      return { text: '```js\nFINAL("too late");\n```', cost: 0.001 };
    };
    const executor = new RLMExecutor(slowLlm);
    const started = Date.now();
    // Generous cap: the first iteration (sandbox start included) must fit
    // inside it even on a loaded box; only the slow second call is cut.
    const result = await executor.execute("q", "ctx", { ...baseOptions, wallClockMs: 800 });
    expect(Date.now() - started).toBeLessThan(2_500);
    expect(result.success).toBe(false);
    expect(result.limitReached).toBe("timeout");
    // The partial REPL output survives so the tool layer can annotate it.
    expect(result.answer).toContain("partial finding");
    expect(result.error).toContain("wall-clock");
  });

  it("does not interfere when the run finishes inside the cap", async () => {
    const fastLlm: RLMLLMCallFn = async () => ({
      text: '```js\nFINAL("done");\n```',
      cost: 0.001,
    });
    const executor = new RLMExecutor(fastLlm);
    const result = await executor.execute("q", "ctx", { ...baseOptions, wallClockMs: 5_000 });
    expect(result.success).toBe(true);
    expect(result.answer).toBe("done");
    expect(result.limitReached).toBeUndefined();
  });

  it("has no cap when wallClockMs is unset", async () => {
    let calls = 0;
    const llm: RLMLLMCallFn = async () => {
      calls++;
      if (calls === 1) {
        await sleep(60);
        return { text: '```js\nprint("x");\n```', cost: 0.001 };
      }
      return { text: '```js\nFINAL("ok");\n```', cost: 0.001 };
    };
    const result = await new RLMExecutor(llm).execute("q", "ctx", baseOptions);
    expect(result.success).toBe(true);
  });

  it("exposes a named error class", () => {
    const err = new RLMDeadlineError(45_000);
    expect(err.name).toBe("RLMDeadlineError");
    expect(err.message).toContain("45000");
  });
});
