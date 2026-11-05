import { z } from "zod";
import type {
  LearningAdapter,
  LearningCost,
  LearningScope,
} from "./procedural-learning-contract.js";
import {
  addLearningCost,
  learningHash,
  ZERO_LEARNING_COST,
} from "./procedural-learning-contract.js";

const StepSchema = z
  .object({
    tool: z.string().min(1).max(200),
    // A host-supplied resolver builds typed arguments from the task input and prior
    // outcomes. The candidate chooses registered bindings, never arbitrary code.
    binding: z.string().min(1).max(200),
  })
  .strict();
const ProgramSchema = z.object({ steps: z.array(StepSchema).min(1).max(16) }).strict();

export type ProcedureTool = {
  /** Must call the same authorized, sandboxed dispatch path as an ordinary tool. */
  call(args: unknown, signal: AbortSignal): Promise<{ output: unknown; cost: LearningCost }>;
  quote: LearningCost;
};

/** Production adapter for bounded procedures over host-approved tools. No eval,
 * child processes, dynamic imports or privilege elevation in the interpreter.
 * The host owns argument schemas, authorization, isolation and the outcome oracle. */
export function createToolProcedureAdapter(options: {
  id: string;
  scope: LearningScope;
  isolation: "sandbox" | "read-only";
  tools: ReadonlyMap<string, ProcedureTool>;
  bindings: ReadonlyMap<string, (input: unknown, outputs: readonly unknown[]) => unknown>;
  qualificationCases: readonly unknown[];
  verifier: { revision: string; quote: LearningCost; verify: LearningAdapter["verify"] };
  describeExperience?: LearningAdapter["describeExperience"];
}): LearningAdapter {
  const tools = new Map(options.tools);
  const bindings = new Map(options.bindings);
  const parse = (program: string) => {
    if (program.length > 16000) throw new Error("Procedure too large");
    const parsed = ProgramSchema.parse(JSON.parse(program));
    for (const step of parsed.steps)
      if (!tools.has(step.tool) || !bindings.has(step.binding))
        throw new Error("Unregistered tool or argument binding");
    return parsed;
  };
  return {
    id: options.id,
    scope: options.scope,
    isolation: options.isolation,
    qualificationCases: options.qualificationCases,
    verifierHash: learningHash({
      revision: options.verifier.revision,
      scope: options.scope,
      qualificationCases: options.qualificationCases,
    }),
    quote(program) {
      return parse(program).steps.reduce(
        (sum, step) => addLearningCost(sum, tools.get(step.tool)!.quote),
        options.verifier.quote,
      );
    },
    async execute(program, input, signal) {
      const outputs: unknown[] = [];
      let cost = { ...ZERO_LEARNING_COST };
      for (const step of parse(program).steps) {
        signal.throwIfAborted();
        const args = bindings.get(step.binding)!(input, outputs);
        const result = await tools.get(step.tool)!.call(args, signal);
        cost = addLearningCost(cost, result.cost);
        outputs.push(result.output);
      }
      return { output: outputs.at(-1), cost };
    },
    verify: options.verifier.verify,
    describeExperience: options.describeExperience,
  };
}
