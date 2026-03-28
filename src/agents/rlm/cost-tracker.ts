/**
 * Cost tracking and budget enforcement for RLM sessions.
 * Tracks token usage and estimated cost per sub-call, enforcing
 * per-invocation budget limits.
 */

export class CostTracker {
  private totalCost = 0;
  private subCallCount = 0;
  private iterationCount = 0;

  constructor(
    private readonly maxBudget: number,
    private readonly maxSubCalls: number,
    private readonly maxIterations: number,
  ) {}

  /** Record a cost increment from an LLM call. Returns false if budget exceeded. */
  addCost(cost: number): boolean {
    this.totalCost += cost;
    return this.totalCost <= this.maxBudget;
  }

  /** Increment sub-call counter. Returns false if limit exceeded. */
  addSubCall(): boolean {
    this.subCallCount++;
    return this.subCallCount <= this.maxSubCalls;
  }

  /** Increment iteration counter. Returns false if limit exceeded. */
  addIteration(): boolean {
    this.iterationCount++;
    return this.iterationCount <= this.maxIterations;
  }

  /** Check if any budget/limit is exceeded. */
  isExceeded(): "budget" | "sub_calls" | "iterations" | null {
    if (this.totalCost > this.maxBudget) return "budget";
    if (this.subCallCount > this.maxSubCalls) return "sub_calls";
    if (this.iterationCount > this.maxIterations) return "iterations";
    return null;
  }

  /** Check if we can afford another sub-call (heuristic: average cost so far). */
  canAffordSubCall(): boolean {
    if (this.subCallCount >= this.maxSubCalls) return false;
    if (this.subCallCount === 0) return this.totalCost < this.maxBudget;
    const avgCost = this.totalCost / this.subCallCount;
    return this.totalCost + avgCost <= this.maxBudget;
  }

  getTotalCost(): number { return this.totalCost; }
  getSubCallCount(): number { return this.subCallCount; }
  getIterationCount(): number { return this.iterationCount; }

  getSummary() {
    return {
      cost: this.totalCost,
      subCalls: this.subCallCount,
      iterations: this.iterationCount,
      budgetRemaining: Math.max(0, this.maxBudget - this.totalCost),
      subCallsRemaining: Math.max(0, this.maxSubCalls - this.subCallCount),
      iterationsRemaining: Math.max(0, this.maxIterations - this.iterationCount),
    };
  }
}
