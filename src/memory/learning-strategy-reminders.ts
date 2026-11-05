import type { StrategyReminder } from "./learning-strategy-contract.js";

type Fact = { value: boolean; evidence: string };
export type ReminderMatch = { id: string; text: string; evidence: string[] };

/** Episode-local host observations. Never reads a task, hidden state, or verifier. */
export class StrategyReminderSession {
  private readonly facts = new Map<string, Fact>();
  private readonly revisions = new Map<string, number>();
  private readonly delivered = new Map<string, string>();

  observe(key: string, value: boolean, evidence: string): void {
    if (!key || typeof value !== "boolean" || !evidence)
      throw new Error("Reminder observations require a fact and evidence reference");
    if (this.facts.get(key)?.value === value) return;
    this.revisions.set(key, (this.revisions.get(key) ?? 0) + 1);
    this.facts.set(key, { value, evidence });
  }

  /** Hosts invalidate affected facts before a possible mutation or entity change. */
  invalidate(keys: readonly string[]): void {
    for (const key of keys) {
      if (!this.facts.delete(key)) continue;
      this.revisions.set(key, (this.revisions.get(key) ?? 0) + 1);
    }
  }

  reset(): void {
    this.facts.clear();
    this.revisions.clear();
    this.delivered.clear();
  }

  take(rules: readonly StrategyReminder[]): ReminderMatch[] {
    const matches: ReminderMatch[] = [];
    for (const rule of rules) {
      const satisfied = (predicates: StrategyReminder["when"]) =>
        predicates.every((p) =>
          p.is === "unknown" ? !this.facts.has(p.fact) : this.facts.get(p.fact)?.value === p.is,
        );
      if (!satisfied(rule.when) || (rule.unless?.length && satisfied(rule.unless))) continue;
      const keys = [
        ...new Set([...rule.when, ...(rule.unless ?? [])].map((p) => p.fact)),
      ].toSorted();
      const signature = JSON.stringify([
        rule,
        keys.map((key) => [key, this.revisions.get(key) ?? 0]),
      ]);
      if (this.delivered.get(rule.id) === signature) continue;
      this.delivered.set(rule.id, signature);
      matches.push({
        id: rule.id,
        text: rule.text,
        evidence: [
          ...new Set(
            keys.flatMap((key) => (this.facts.has(key) ? [this.facts.get(key)!.evidence] : [])),
          ),
        ],
      });
    }
    return matches;
  }
}
