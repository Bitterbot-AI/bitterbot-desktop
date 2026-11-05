import { z } from "zod";

export const AssociationContextSchema = z
  .record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/), z.string().min(1).max(200))
  .refine((x) => Object.keys(x).length <= 16, "Too many context features");
export type AssociationContext = z.infer<typeof AssociationContextSchema>;
export type AssociationMethod = "hebbian" | "delta" | "context-table" | "feature-count";
export type AssociationOptions = {
  method?: AssociationMethod;
  learningRate?: number;
  halfLife?: number;
  maxObservations?: number;
};
type Counts = { n: number; success: number };
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** An external associative selector, not neural-weight training or an execution gate.
 * The three-factor rule uses context activity, centered action activity, and a
 * context-dependent reward residual. Scores are preferences, NOT calibrated odds.
 * Common uniformly sampled feedback is the primary evaluation setting. Under an
 * arbitrary behavior policy this is a heuristic, not an unbiased policy gradient.
 * Rebuild from retained receipts to forget observations; replay is never new data. */
export class ProcedureAssociation {
  readonly actions: readonly string[];
  readonly options: Required<AssociationOptions>;
  private readonly weights = new Map<string, Map<string, number>>();
  private readonly critic = new Map<string, number>();
  private readonly counts = new Map<string, Map<string, Counts>>();
  private readonly seen = new Set<string>();
  private readonly vocabulary = new Set<string>();
  private readonly decay: number;

  constructor(actions: readonly string[], options: AssociationOptions = {}) {
    if (
      actions.length < 1 ||
      actions.length > 32 ||
      new Set(actions).size !== actions.length ||
      actions.some((a) => !a || a.length > 200)
    )
      throw new Error("Invalid association candidate set");
    this.actions = Object.freeze([...actions]);
    this.options = {
      method: options.method ?? "hebbian",
      learningRate: options.learningRate ?? 0.3,
      halfLife: options.halfLife ?? 128,
      maxObservations: options.maxObservations ?? 4096,
    };
    if (
      !["hebbian", "delta", "context-table", "feature-count"].includes(this.options.method) ||
      !Number.isFinite(this.options.learningRate) ||
      this.options.learningRate <= 0 ||
      this.options.learningRate > 2 ||
      !Number.isFinite(this.options.halfLife) ||
      this.options.halfLife < 1 ||
      !Number.isInteger(this.options.maxObservations) ||
      this.options.maxObservations < 1 ||
      this.options.maxObservations > 16384
    )
      throw new Error("Invalid association options");
    this.decay = 2 ** (-1 / this.options.halfLife);
    for (const a of actions) {
      this.weights.set(a, new Map());
      this.counts.set(a, new Map());
    }
  }

  private encode(context: AssociationContext): { features: string[]; key: string; scale: number } {
    const entries = Object.entries(AssociationContextSchema.parse(context)).toSorted(([a], [b]) =>
      a.localeCompare(b),
    );
    const features = ["bias", ...entries.map((entry) => JSON.stringify(entry))];
    return { features, key: JSON.stringify(entries), scale: 1 / Math.sqrt(features.length) };
  }
  private dot(w: Map<string, number>, features: string[], scale: number): number {
    return features.reduce((sum, f) => sum + (w.get(f) ?? 0) * scale, 0);
  }
  private probability(c: Counts | undefined): number {
    return c ? (c.success + 1) / (c.n + 2) : 0.5;
  }

  rank(context: AssociationContext): Array<{ candidate: string; score: number }> {
    const { features, key, scale } = this.encode(context);
    return this.actions
      .map((candidate) => {
        const counts = this.counts.get(candidate)!;
        let score: number;
        if (this.options.method === "context-table") score = this.probability(counts.get(key));
        else if (this.options.method === "feature-count") {
          const supported = features.filter((f) => counts.has(f));
          score = supported.length
            ? supported.reduce((s, f) => s + this.probability(counts.get(f)), 0) / supported.length
            : 0.5;
        } else score = this.dot(this.weights.get(candidate)!, features, scale);
        return { candidate, score };
      })
      .toSorted(
        (a, b) =>
          b.score - a.score ||
          this.actions.indexOf(a.candidate) - this.actions.indexOf(b.candidate),
      );
  }

  observe(observation: {
    id: string;
    context: AssociationContext;
    candidate: string;
    reward: 0 | 1;
  }): boolean {
    if (
      !observation.id ||
      observation.id.length > 240 ||
      !this.weights.has(observation.candidate) ||
      ![0, 1].includes(observation.reward)
    )
      throw new Error("Invalid association observation");
    const { features, key, scale } = this.encode(observation.context);
    if (this.seen.has(observation.id)) return false;
    if (this.seen.size >= this.options.maxObservations)
      throw new Error("Association observation capacity reached");
    if (new Set([...this.vocabulary, ...features]).size > 4096)
      throw new Error("Association feature capacity reached");
    this.seen.add(observation.id);
    features.forEach((f) => this.vocabulary.add(f));
    const { method, learningRate: eta } = this.options;
    if (method === "context-table" || method === "feature-count") {
      for (const values of this.counts.values())
        for (const c of values.values()) {
          c.n *= this.decay;
          c.success *= this.decay;
        }
      const values = this.counts.get(observation.candidate)!;
      for (const f of method === "context-table" ? [key] : features) {
        const c = values.get(f) ?? { n: 0, success: 0 };
        values.set(f, { n: c.n + 1, success: c.success + observation.reward });
      }
      return true;
    }
    // Forgetting operates in observation time, never by replay count.
    for (const values of [...this.weights.values(), this.critic])
      for (const [f, v] of values) values.set(f, v * this.decay);
    const chosen = this.weights.get(observation.candidate)!;
    const baseline = clamp(
      0.5 + this.dot(method === "hebbian" ? this.critic : chosen, features, scale),
      0,
      1,
    );
    const residual = observation.reward - baseline;
    if (method === "hebbian") {
      for (const f of features)
        this.critic.set(f, (this.critic.get(f) ?? 0) + 0.1 * residual * scale);
      for (const [action, values] of this.weights) {
        const activity = Number(action === observation.candidate) - 1 / this.actions.length;
        for (const f of features)
          values.set(f, (values.get(f) ?? 0) + eta * residual * activity * scale);
      }
    } else {
      for (const f of features) chosen.set(f, (chosen.get(f) ?? 0) + eta * residual * scale);
    }
    // Bounded norms prevent uncontrolled reinforcement of frequently active features.
    for (const values of [...this.weights.values(), this.critic]) {
      const norm = Math.hypot(...values.values());
      if (norm > 8) for (const [f, v] of values) values.set(f, (v * 8) / norm);
    }
    return true;
  }
  get observations(): number {
    return this.seen.size;
  }
}
