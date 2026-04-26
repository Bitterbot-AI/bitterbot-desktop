/**
 * Handoff envelope for sub-agent spawn.
 *
 * Spawning a sub-agent without articulating the full intent is the most
 * common failure mode for delegated work: the child receives a one-line
 * task, asks redundant clarification questions, and produces shallow
 * output the parent then has to redo. The leaked Claude Code coordinator
 * enforced an explicit handoff context (goal/inputs/success/out-of-scope/
 * parent-context). This module is the same idea adapted to Bitterbot's
 * `sessions_spawn` tool.
 *
 * The envelope is OPTIONAL today (we accept the legacy plain-string
 * `task`), but when provided we validate the fields and render a
 * structured block at the top of the child's system prompt.
 */

export type HandoffEnvelope = {
  /** One-sentence goal. Required. */
  goal: string;
  /** Files, sessions, or upstream context the child needs. */
  inputs?: string[];
  /** How the parent will know the child succeeded. */
  success_criteria?: string[];
  /** Things the child should NOT do — bounds the work. */
  out_of_scope?: string[];
  /** 1-3 bullets of parent context so the child doesn't ask redundant questions. */
  parent_context?: string[];
};

const GOAL_MIN = 8;
const GOAL_MAX = 400;
const FIELD_ITEM_MIN = 3;
const FIELD_ITEM_MAX = 400;
const FIELD_ITEMS_MAX = 12;

/** Goals that are too vague to be useful. Cheap heuristic; deliberately
 *  permissive — too strict here just pushes parents to write fluff. */
const TRIVIAL_GOAL_RE =
  /^\s*(?:do (?:the )?(?:thing|task|work)|stuff|figure (?:it )?out|help|run it)\s*\.?\s*$/i;

export type EnvelopeValidationResult =
  | { ok: true; value: HandoffEnvelope }
  | { ok: false; field: string; message: string };

/** Coerce an unknown value into a HandoffEnvelope or return a typed error. */
export function validateHandoffEnvelope(input: unknown): EnvelopeValidationResult {
  if (!input || typeof input !== "object") {
    return { ok: false, field: "envelope", message: "handoff must be an object" };
  }
  const e = input as Record<string, unknown>;

  // Required: goal
  const goal = typeof e.goal === "string" ? e.goal.trim() : "";
  if (!goal) {
    return { ok: false, field: "goal", message: "handoff.goal is required" };
  }
  if (goal.length < GOAL_MIN) {
    return {
      ok: false,
      field: "goal",
      message: `handoff.goal must be at least ${GOAL_MIN} characters`,
    };
  }
  if (goal.length > GOAL_MAX) {
    return {
      ok: false,
      field: "goal",
      message: `handoff.goal must be ${GOAL_MAX} characters or fewer`,
    };
  }
  if (TRIVIAL_GOAL_RE.test(goal)) {
    return {
      ok: false,
      field: "goal",
      message: "handoff.goal is too vague — describe what the child should achieve",
    };
  }

  const validateList = (
    raw: unknown,
    fieldName: keyof HandoffEnvelope,
  ): { ok: true; list: string[] | undefined } | { ok: false; message: string } => {
    if (raw === undefined || raw === null) return { ok: true, list: undefined };
    if (!Array.isArray(raw)) {
      return { ok: false, message: `handoff.${String(fieldName)} must be an array of strings` };
    }
    if (raw.length === 0) return { ok: true, list: undefined };
    if (raw.length > FIELD_ITEMS_MAX) {
      return {
        ok: false,
        message: `handoff.${String(fieldName)} has too many items (max ${FIELD_ITEMS_MAX})`,
      };
    }
    const out: string[] = [];
    for (const item of raw) {
      if (typeof item !== "string") {
        return {
          ok: false,
          message: `handoff.${String(fieldName)} entries must be strings`,
        };
      }
      const trimmed = item.trim();
      if (trimmed.length < FIELD_ITEM_MIN) {
        return {
          ok: false,
          message: `handoff.${String(fieldName)} entries must be at least ${FIELD_ITEM_MIN} characters`,
        };
      }
      if (trimmed.length > FIELD_ITEM_MAX) {
        return {
          ok: false,
          message: `handoff.${String(fieldName)} entries must be ${FIELD_ITEM_MAX} characters or fewer`,
        };
      }
      out.push(trimmed);
    }
    return { ok: true, list: out };
  };

  const inputs = validateList(e.inputs, "inputs");
  if (!inputs.ok) return { ok: false, field: "inputs", message: inputs.message };

  const success = validateList(e.success_criteria, "success_criteria");
  if (!success.ok) return { ok: false, field: "success_criteria", message: success.message };

  const oos = validateList(e.out_of_scope, "out_of_scope");
  if (!oos.ok) return { ok: false, field: "out_of_scope", message: oos.message };

  const ctx = validateList(e.parent_context, "parent_context");
  if (!ctx.ok) return { ok: false, field: "parent_context", message: ctx.message };

  return {
    ok: true,
    value: {
      goal,
      inputs: inputs.list,
      success_criteria: success.list,
      out_of_scope: oos.list,
      parent_context: ctx.list,
    },
  };
}

/**
 * Render the envelope as a Markdown block to inject at the top of the
 * sub-agent's system prompt. Sections are emitted only when the parent
 * provided them, so a minimal envelope (goal only) renders cleanly.
 */
export function renderHandoffEnvelope(envelope: HandoffEnvelope): string {
  const lines: string[] = ["# Handoff", "", `**Goal:** ${envelope.goal}`, ""];

  const section = (heading: string, items?: string[]) => {
    if (!items || items.length === 0) return;
    lines.push(`**${heading}:**`);
    for (const item of items) {
      lines.push(`- ${item}`);
    }
    lines.push("");
  };

  section("Inputs", envelope.inputs);
  section("Success criteria", envelope.success_criteria);
  section("Out of scope", envelope.out_of_scope);
  section("Parent context", envelope.parent_context);

  return lines.join("\n").trimEnd();
}

// ── Test helpers ──

/** @internal */
export const __envelopeConsts = Object.freeze({
  GOAL_MIN,
  GOAL_MAX,
  FIELD_ITEM_MIN,
  FIELD_ITEM_MAX,
  FIELD_ITEMS_MAX,
});
