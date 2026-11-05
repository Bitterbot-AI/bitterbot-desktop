import { z } from "zod";
import { LearningScopeSchema, type LearningCost } from "./procedural-learning-contract.js";

const ReminderPredicateSchema = z
  .object({
    fact: z.string().regex(/^[a-z][a-zA-Z0-9_.]{0,79}$/),
    is: z.union([z.boolean(), z.literal("unknown")]),
  })
  .strict();
export const StrategyReminderSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
    when: z.array(ReminderPredicateSchema).min(1).max(4),
    /** Suppress only when all these predicates hold. */
    unless: z.array(ReminderPredicateSchema).min(1).max(4).optional(),
    text: z.string().trim().min(1).max(300),
  })
  .strict();
export type StrategyReminder = z.infer<typeof StrategyReminderSchema>;
export const StrategyRemindersSchema = z
  .array(StrategyReminderSchema)
  .max(4)
  .refine(
    (rules) => new Set(rules.map((r) => r.id)).size === rules.length,
    "Duplicate reminder ids",
  );

/** Data interpreted by a host, never executable source, permissions, or a verifier. */
export const LearningStrategySchema = z
  .object({
    schemaVersion: z.literal(1),
    scope: LearningScopeSchema,
    actor: z.string().trim().min(1).max(4000),
    proposer: z.string().trim().min(1).max(4000),
    reminders: StrategyRemindersSchema.optional(),
    parents: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(4),
    sharing: z.enum(["private", "shareable"]),
    expiresAt: z.number().int().positive(),
  })
  .strict();
export type LearningStrategy = z.infer<typeof LearningStrategySchema>;
export const StrategyEditSchema = z
  .object({
    actor: LearningStrategySchema.shape.actor,
    proposer: LearningStrategySchema.shape.proposer,
  })
  .strict();
export type StrategyEdit = z.infer<typeof StrategyEditSchema>;
/** A bounded addition; the host preserves the parent actor and fixed proposer. */
export const StrategyAppendSchema = z
  .object({ append: z.string().trim().min(1).max(600) })
  .strict();
export const StrategyConditionalEditSchema = z
  .object({ reminders: StrategyRemindersSchema })
  .strict();
export type StrategyPanel = {
  id: string;
  scope: LearningStrategy["scope"];
  partition: "development" | "held-out";
  model: string;
  verifierHash: string;
  cases: Array<{ id: string; input: unknown }>;
  isolation: "sandbox";
  /** Host declaration about all feedback on this panel. Defaults to private. */
  sharing?: "private" | "shareable";
  /** Frozen host limit for development feedback, 1..32000 characters; default 6000. */
  feedbackLimit?: number;
  /** Opt-in vocabulary interpreted by this host; absent hosts reject conditional candidates. */
  reminderFacts?: string[];
  quote: (strategy: LearningStrategy, input: unknown) => LearningCost;
  execute: (
    strategy: LearningStrategy,
    input: unknown,
    signal: AbortSignal,
  ) => Promise<{
    output: unknown;
    cost: LearningCost;
  }>;
  verify: (
    input: unknown,
    output: unknown,
  ) => Promise<{
    passed: boolean;
    cost: LearningCost;
    feedback: string;
  }>;
};
export type StrategyEvaluation = {
  batch: string;
  strategy: string;
  panel: string;
  successes: number;
  total: number;
  score: number;
  cost: LearningCost;
};
