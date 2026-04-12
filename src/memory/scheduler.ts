/**
 * MemoryScheduler: manages memory operation priorities and resource allocation.
 *
 * Schedules memory operations by priority, manages LLM/embedding budgets,
 * and provides preloading for anticipated memory needs.
 */

import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("memory/scheduler");

export type MemoryOperationType =
  | "embed"
  | "consolidate"
  | "dream"
  | "curiosity"
  | "search"
  | "preload"
  | "discovery"
  | "backfill";

export type MemoryOperation = {
  id: string;
  type: MemoryOperationType;
  priority: number; // 0-1, higher = more urgent
  estimatedCost: number; // Estimated API calls
  execute: () => Promise<void>;
  createdAt: number;
};

export type ComputeTier = "local" | "cloud";

export type BudgetConfig = {
  llmCallsPerHour?: number;
  embeddingCallsPerHour?: number;
  localLlmCallsPerHour?: number;
};

const DEFAULT_BUDGET: Required<BudgetConfig> = {
  llmCallsPerHour: 20,
  embeddingCallsPerHour: 100,
  localLlmCallsPerHour: Infinity,
};

export class MemoryScheduler {
  private readonly queue: MemoryOperation[] = [];
  private readonly llmBudget: { used: number; limit: number; resetAt: number };
  private readonly embeddingBudget: { used: number; limit: number; resetAt: number };
  private readonly localLlmBudget: { used: number; limit: number; resetAt: number };
  private processing = false;

  constructor(config?: BudgetConfig) {
    const now = Date.now();
    const hourMs = 60 * 60 * 1000;
    this.llmBudget = {
      used: 0,
      limit: config?.llmCallsPerHour ?? DEFAULT_BUDGET.llmCallsPerHour,
      resetAt: now + hourMs,
    };
    this.embeddingBudget = {
      used: 0,
      limit: config?.embeddingCallsPerHour ?? DEFAULT_BUDGET.embeddingCallsPerHour,
      resetAt: now + hourMs,
    };
    this.localLlmBudget = {
      used: 0,
      limit: config?.localLlmCallsPerHour ?? DEFAULT_BUDGET.localLlmCallsPerHour,
      resetAt: now + hourMs,
    };
  }

  /**
   * Schedule a memory operation for execution.
   */
  schedule(op: MemoryOperation): void {
    this.queue.push(op);
    this.queue.sort((a, b) => b.priority - a.priority);
    void this.processQueue();
  }

  /**
   * Get current budget status.
   */
  getBudgetStatus(): {
    llm: { used: number; limit: number; remaining: number };
    embedding: { used: number; limit: number; remaining: number };
    localLlm: { used: number; limit: number; remaining: number };
  } {
    this.resetBudgetsIfNeeded();
    return {
      llm: {
        used: this.llmBudget.used,
        limit: this.llmBudget.limit,
        remaining: Math.max(0, this.llmBudget.limit - this.llmBudget.used),
      },
      embedding: {
        used: this.embeddingBudget.used,
        limit: this.embeddingBudget.limit,
        remaining: Math.max(0, this.embeddingBudget.limit - this.embeddingBudget.used),
      },
      localLlm: {
        used: this.localLlmBudget.used,
        limit: this.localLlmBudget.limit,
        remaining: Math.max(0, this.localLlmBudget.limit - this.localLlmBudget.used),
      },
    };
  }

  /**
   * Record an LLM call against the budget.
   */
  recordLlmCall(count = 1): void {
    this.resetBudgetsIfNeeded();
    this.llmBudget.used += count;
  }

  /**
   * Record an embedding call against the budget.
   */
  recordEmbeddingCall(count = 1): void {
    this.resetBudgetsIfNeeded();
    this.embeddingBudget.used += count;
  }

  /**
   * Record a local LLM call against the local budget.
   */
  recordLocalLlmCall(count = 1): void {
    this.resetBudgetsIfNeeded();
    this.localLlmBudget.used += count;
  }

  /**
   * Check if an operation type has budget remaining.
   * Optionally specify a compute tier to check tier-specific budgets.
   */
  hasBudget(type: MemoryOperationType, tier?: ComputeTier): boolean {
    this.resetBudgetsIfNeeded();
    if (type === "dream" || type === "curiosity" || type === "discovery") {
      if (tier === "local") {
        return this.localLlmBudget.used < this.localLlmBudget.limit;
      }
      return this.llmBudget.used < this.llmBudget.limit;
    }
    if (type === "embed" || type === "preload" || type === "backfill") {
      return this.embeddingBudget.used < this.embeddingBudget.limit;
    }
    return true; // search, consolidate always have budget
  }

  /**
   * Get queue length by type.
   */
  getQueueStatus(): Record<MemoryOperationType, number> {
    const counts: Record<MemoryOperationType, number> = {
      embed: 0,
      consolidate: 0,
      dream: 0,
      curiosity: 0,
      search: 0,
      preload: 0,
      discovery: 0,
      backfill: 0,
    };
    for (const op of this.queue) {
      counts[op.type]++;
    }
    return counts;
  }

  private async processQueue(): Promise<void> {
    if (this.processing) return;
    this.processing = true;

    try {
      while (this.queue.length > 0) {
        const op = this.queue[0];
        if (!op) break;

        if (!this.hasBudget(op.type)) {
          log.debug(`deferring ${op.type} operation: budget exhausted`);
          // Don't remove the op — leave it in the queue for the next budget window.
          // Break out of the processing loop; we'll retry when budget resets or
          // a new operation triggers processQueue().
          break;
        }

        this.queue.shift();
        try {
          await op.execute();
        } catch (err) {
          log.warn(`scheduled ${op.type} operation failed: ${String(err)}`);
        }
      }
    } finally {
      this.processing = false;
    }
  }

  private resetBudgetsIfNeeded(): void {
    const now = Date.now();
    const hourMs = 60 * 60 * 1000;

    if (now >= this.llmBudget.resetAt) {
      this.llmBudget.used = 0;
      this.llmBudget.resetAt = now + hourMs;
    }
    if (now >= this.embeddingBudget.resetAt) {
      this.embeddingBudget.used = 0;
      this.embeddingBudget.resetAt = now + hourMs;
    }
    if (now >= this.localLlmBudget.resetAt) {
      this.localLlmBudget.used = 0;
      this.localLlmBudget.resetAt = now + hourMs;
    }
  }
}
