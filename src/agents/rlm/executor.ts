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
  constructor(private readonly llmCall: RLMLLMCallFn) {}

  // ── Plan 7, Phase 8: Query Result Cache ──
  private cache = new Map<string, CachedRLMResult>();
  private readonly cacheTtlMs = 60 * 60 * 1000; // 1 hour

  getCachedResult(query: string, scope: string): string | null {
    const hash = this.hashQuery(query, scope);
    const cached = this.cache.get(hash);
    if (!cached) return null;
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
      const oldest = [...this.cache.entries()].sort((a, b) => a[1].timestamp - b[1].timestamp)[0];
      if (oldest) this.cache.delete(oldest[0]);
    }
  }

  /** Invalidate cache (e.g., after new session extraction). */
  invalidateCache(): void {
    this.cache.clear();
  }

  private hashQuery(query: string, scope: string): string {
    return crypto
      .createHash("sha256")
      .update(`${scope}:${query.toLowerCase().trim()}`)
      .digest("hex")
      .slice(0, 16);
  }

  async execute(query: string, context: string, options: RLMExecutorOptions): Promise<RLMResult> {
    const trace: RLMTraceEntry[] = [];
    const costTracker = new CostTracker(
      options.maxBudget,
      options.maxSubCalls,
      options.maxIterations,
    );

    // Track sub-call cost for the sandbox callbacks
    let currentDepth = 0;

    // Create sandbox with LLM sub-call wiring
    const sandbox = new RLMSandbox({
      context,
      timeout: options.timeout,
      onLLMQuery: async (prompt: string, subContext?: string) => {
        if (!costTracker.canAffordSubCall()) {
          return "[Budget exceeded — cannot make more sub-calls]";
        }
        if (currentDepth >= options.maxDepth) {
          // At max depth, sub-calls are plain LLM calls (no recursion)
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
          costTracker.addSubCall();
          trace.push({
            type: "sub_call",
            content: `[sub-call] ${prompt.slice(0, 100)}...`,
            timestamp: Date.now(),
          });
          return result.text;
        }
        // Could support deeper recursion here in the future
        const messages: RLMMessage[] = [
          { role: "user", content: subContext ? `Context:\n${subContext}\n\n${prompt}` : prompt },
        ];
        currentDepth++;
        const result = await this.llmCall({
          messages,
          model: options.subModel,
          provider: options.subProvider,
          maxTokens: 2000,
        });
        currentDepth--;
        costTracker.addCost(result.cost);
        costTracker.addSubCall();
        trace.push({
          type: "sub_call",
          content: `[sub-call] ${prompt.slice(0, 100)}...`,
          timestamp: Date.now(),
        });
        return result.text;
      },
      onLLMQueryParallel: async (queries) => {
        const results: string[] = [];
        // Execute in parallel but track each call
        const promises = queries.map(async (q) => {
          if (!costTracker.canAffordSubCall()) {
            return "[Budget exceeded — cannot make more sub-calls]";
          }
          const messages: RLMMessage[] = [
            {
              role: "user",
              content: q.context ? `Context:\n${q.context}\n\n${q.prompt}` : q.prompt,
            },
          ];
          const result = await this.llmCall({
            messages,
            model: options.subModel,
            provider: options.subProvider,
            maxTokens: 2000,
          });
          costTracker.addCost(result.cost);
          costTracker.addSubCall();
          trace.push({
            type: "sub_call",
            content: `[parallel sub-call] ${q.prompt.slice(0, 80)}...`,
            timestamp: Date.now(),
          });
          return result.text;
        });
        return await Promise.all(promises);
      },
    });

    // Build context stats for the system prompt
    const contextStats = {
      chars: context.length,
      lines: context.split("\n").length,
      tokenEstimate: Math.ceil(context.length / 4),
    };

    // Initialize conversation with system prompt and user query
    const messages: RLMMessage[] = [
      { role: "system", content: buildRLMSystemPrompt(contextStats) },
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
            sandbox.dispose();
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
          sandbox.dispose();
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
          sandbox.dispose();
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
      sandbox.dispose();
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
      sandbox.dispose();
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
