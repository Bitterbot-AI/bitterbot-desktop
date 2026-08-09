/**
 * RLM Executor — Core execution loop for Recursive Language Model deep recall.
 *
 * Orchestrates the REPL loop: sends context metadata + query to a root LLM,
 * parses code blocks from responses, executes them in the sandbox, feeds
 * output back, and repeats until FINAL() is called or limits are reached.
 *
 * Based on: "Recursive Language Models" (Zhang, Kraska, Khattab, 2026)
 * Paper: https://arxiv.org/abs/2512.24601
 */

import crypto from "node:crypto";
import type {
  RLMExecutorOptions,
  RLMResult,
  RLMTraceEntry,
  RLMMessage,
  RLMLLMCallFn,
} from "./types.js";
import { CostTracker } from "./cost-tracker.js";
import {
  buildRLMSystemPrompt,
  buildRLMUserPrompt,
  buildRLMOutputFeedback,
  buildBudgetWarning,
} from "./prompts.js";
import { RLMSandbox } from "./sandbox.js";

/** Extract the first JavaScript code block from an LLM response. */
function extractCodeBlock(text: string): string | null {
  // Match ```js, ```javascript, or bare ``` code blocks
  const patterns = [/```(?:js|javascript)\s*\n([\s\S]*?)```/, /```\s*\n([\s\S]*?)```/];
  for (const re of patterns) {
    const match = text.match(re);
    if (match?.[1]?.trim()) {
      return match[1].trim();
    }
  }
  return null;
}

interface CachedRLMResult {
  answer: string;
  timestamp: number;
  queryHash: string;
}

export class RLMExecutor {
  constructor(
    private readonly llmCall: RLMLLMCallFn,
    /** Cache namespace (agent/session identity) so answers never cross agents. */
    private readonly cacheNamespace = "",
  ) {}

  // ── Plan 7, Phase 8: Query Result Cache ──
  // Class-level: tool instances (and their executors) are rebuilt per agent
  // turn, so an instance cache can never span turns. Entries are namespaced.
  private static cache = new Map<string, CachedRLMResult>();
  private get cache(): Map<string, CachedRLMResult> {
    return RLMExecutor.cache;
  }
  private readonly cacheTtlMs = 60 * 60 * 1000; // 1 hour

  getCachedResult(query: string, scope: string): string | null {
    const hash = this.hashQuery(query, scope);
    const cached = this.cache.get(hash);
    if (!cached) {
      return null;
    }
    if (Date.now() - cached.timestamp > this.cacheTtlMs) {
      this.cache.delete(hash);
      return null;
    }
    return cached.answer;
  }

  cacheResult(query: string, scope: string, answer: string): void {
    const hash = this.hashQuery(query, scope);
    this.cache.set(hash, { answer, timestamp: Date.now(), queryHash: hash });
    // Cap cache size
    if (this.cache.size > 50) {
      const oldest = [...this.cache.entries()].toSorted(
        (a, b) => a[1].timestamp - b[1].timestamp,
      )[0];
      if (oldest) {
        this.cache.delete(oldest[0]);
      }
    }
  }

  /** Invalidate cache (e.g., after new session extraction). */
  invalidateCache(): void {
    this.cache.clear();
  }

  private hashQuery(query: string, scope: string): string {
    return crypto
      .createHash("sha256")
      .update(`${this.cacheNamespace}:${scope}:${query.toLowerCase().trim()}`)
      .digest("hex")
      .slice(0, 16);
  }

  async execute(
    query: string,
    context: string,
    options: RLMExecutorOptions,
    externalSandbox?: RLMSandbox,
  ): Promise<RLMResult> {
    const trace: RLMTraceEntry[] = [];
    // Depth is capped at 3; ≥2 means sub-calls spawn their own mini-REPL.
    const maxDepth = Math.min(Math.max(1, options.maxDepth), 3);
    const costTracker = new CostTracker(
      options.maxBudget,
      options.maxSubCalls,
      options.maxIterations,
    );

    /**
     * Run one sub-call. At maxDepth 1 this is a plain LLM completion.
     * At maxDepth ≥ 2 the sub-call becomes a nested mini-RLM: the cheap model
     * gets its own REPL over the sub-context, with its sub-calls one level
     * shallower. Nested cost/sub-calls are charged to this run's tracker.
     *
     * The sub-call SLOT is reserved synchronously (before any await) so a
     * parallel batch can't all pass the affordability check on the same
     * snapshot; `budgetShare` splits the remaining budget across a batch so
     * N parallel sub-RLMs can't each spend the full remainder.
     */
    const runSubCall = async (
      prompt: string,
      subContext?: string,
      budgetShare = 1,
    ): Promise<string> => {
      if (!costTracker.canAffordSubCall()) {
        return "[Budget exceeded — cannot make more sub-calls]";
      }
      costTracker.addSubCall(); // reserve synchronously
      if (maxDepth >= 2) {
        const summary = costTracker.getSummary();
        const nested = await this.execute(prompt, subContext ?? context, {
          ...options,
          model: options.subModel,
          provider: options.subProvider,
          maxDepth: maxDepth - 1,
          maxIterations: Math.min(5, options.maxIterations),
          maxBudget: summary.budgetRemaining * budgetShare,
          maxSubCalls: Math.min(8, summary.subCallsRemaining),
        });
        costTracker.addCost(nested.cost);
        trace.push({
          type: "sub_call",
          content: `[sub-RLM depth=${maxDepth - 1}] ${prompt.slice(0, 100)}... (iterations=${nested.iterations}, subCalls=${nested.subCalls}, cost=$${nested.cost.toFixed(4)})`,
          timestamp: Date.now(),
        });
        return nested.answer ?? "[sub-RLM produced no answer]";
      }
      // Plain LLM completion (paper's depth-1 regime)
      const messages: RLMMessage[] = [
        { role: "user", content: subContext ? `Context:\n${subContext}\n\n${prompt}` : prompt },
      ];
      const result = await this.llmCall({
        messages,
        model: options.subModel,
        provider: options.subProvider,
        maxTokens: 2000,
      });
      costTracker.addCost(result.cost);
      trace.push({
        type: "sub_call",
        content: `[sub-call] ${prompt.slice(0, 100)}...`,
        timestamp: Date.now(),
      });
      return result.text;
    };

    const handlers = {
      onLLMQuery: (prompt: string, subContext?: string) => runSubCall(prompt, subContext),
      onLLMQueryParallel: (queries: Array<{ prompt: string; context?: string }>) => {
        const share = 1 / Math.max(1, queries.length);
        return Promise.all(queries.map((q) => runSubCall(q.prompt, q.context, share)));
      },
    };

    // Reuse a persistent sandbox when provided; otherwise create an owned one.
    const ownsSandbox = !externalSandbox;
    let sandbox: RLMSandbox;
    if (externalSandbox) {
      sandbox = externalSandbox;
      sandbox.setHandlers(handlers);
      sandbox.clearFinal();
    } else {
      sandbox = new RLMSandbox({
        context,
        timeout: options.timeout,
        liveApis: options.liveApis,
        ...handlers,
      });
    }
    const finishSandbox = () => {
      if (ownsSandbox) {
        sandbox.dispose();
      }
    };

    // Build context stats for the system prompt
    const contextStats = {
      chars: context.length,
      lines: context.split("\n").length,
      tokenEstimate: Math.ceil(context.length / 4),
    };

    // Initialize conversation with system prompt and user query
    const messages: RLMMessage[] = [
      {
        role: "system",
        content: buildRLMSystemPrompt(contextStats, { liveApis: sandbox.hasLiveApis() }),
      },
      { role: "user", content: buildRLMUserPrompt(query) },
    ];

    try {
      // Main REPL loop
      while (costTracker.addIteration()) {
        // Call root LLM
        const llmResult = await this.llmCall({
          messages,
          model: options.model,
          provider: options.provider,
          maxTokens: 4000,
        });
        costTracker.addCost(llmResult.cost);

        const responseText = llmResult.text;
        trace.push({ type: "llm_response", content: responseText, timestamp: Date.now() });
        messages.push({ role: "assistant", content: responseText });

        // Extract code block
        const code = extractCodeBlock(responseText);
        if (!code) {
          // No code block — check if the LLM called FINAL in text or is giving a direct answer
          // Sometimes the LLM just answers directly without code
          const finalAnswer = sandbox.resolveFinalAnswer();
          if (finalAnswer) {
            trace.push({ type: "final", content: finalAnswer, timestamp: Date.now() });
            finishSandbox();
            return {
              answer: finalAnswer,
              success: true,
              iterations: costTracker.getIterationCount(),
              subCalls: costTracker.getSubCallCount(),
              cost: costTracker.getTotalCost(),
              trace,
            };
          }
          // Ask the LLM to write code
          messages.push({
            role: "user",
            content:
              "Please write a JavaScript code block to explore the context. Use ```js ... ``` syntax.",
          });
          continue;
        }

        trace.push({ type: "code", content: code, timestamp: Date.now() });

        // Execute code in sandbox
        const execResult = await sandbox.execute(code);
        trace.push({
          type: "output",
          content: execResult.output || "(no output)",
          timestamp: Date.now(),
        });

        if (execResult.error) {
          trace.push({ type: "error", content: execResult.error, timestamp: Date.now() });
        }

        // Check if FINAL was called
        const finalAnswer = sandbox.resolveFinalAnswer();
        if (finalAnswer) {
          trace.push({ type: "final", content: finalAnswer, timestamp: Date.now() });
          finishSandbox();
          return {
            answer: finalAnswer,
            success: true,
            iterations: costTracker.getIterationCount(),
            subCalls: costTracker.getSubCallCount(),
            cost: costTracker.getTotalCost(),
            trace,
          };
        }

        // Check budget limits
        const limit = costTracker.isExceeded();
        if (limit) {
          finishSandbox();
          // Try to get any partial answer from the last output
          const partialAnswer = execResult.output || null;
          return {
            answer: partialAnswer,
            success: false,
            iterations: costTracker.getIterationCount(),
            subCalls: costTracker.getSubCallCount(),
            cost: costTracker.getTotalCost(),
            trace,
            limitReached:
              limit === "iterations" ? "iterations" : limit === "budget" ? "budget" : "sub_calls",
          };
        }

        // Feed output back to LLM
        let feedback = buildRLMOutputFeedback(execResult.output, execResult.error);

        // Add budget warning if running low
        const summary = costTracker.getSummary();
        if (
          summary.iterationsRemaining <= 3 ||
          summary.subCallsRemaining <= 3 ||
          summary.budgetRemaining < 0.1
        ) {
          feedback += "\n\n" + buildBudgetWarning(summary);
        }

        messages.push({ role: "user", content: feedback });
      }

      // Iteration limit reached
      finishSandbox();
      const lastOutput = trace.filter((t) => t.type === "output").pop()?.content;
      return {
        answer: lastOutput || null,
        success: false,
        iterations: costTracker.getIterationCount(),
        subCalls: costTracker.getSubCallCount(),
        cost: costTracker.getTotalCost(),
        trace,
        limitReached: "iterations",
      };
    } catch (err) {
      finishSandbox();
      const errorMsg = err instanceof Error ? err.message : String(err);
      trace.push({ type: "error", content: errorMsg, timestamp: Date.now() });
      return {
        answer: null,
        success: false,
        iterations: costTracker.getIterationCount(),
        subCalls: costTracker.getSubCallCount(),
        cost: costTracker.getTotalCost(),
        trace,
        error: errorMsg,
      };
    }
  }
}
