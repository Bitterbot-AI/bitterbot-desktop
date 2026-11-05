import { validateProgram } from "./rediscovery-runtime.mjs";

const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** Mechanical diagnostics only. Never edits a proposal or imports task outcomes. */
export function programDiagnostics(candidate) {
  try {
    validateProgram(candidate);
    return { valid: true, errors: [] };
  } catch {
    // The frozen interpreter remains authoritative, including future contract changes.
  }
  const errors = [];
  const add = (path, rule, actual) => errors.push({ path, rule, actual });
  const keys = (value, expected, path) => {
    if (!object(value)) {
      add(path, "object required", typeof value);
      return false;
    }
    if (Object.keys(value).sort().join("|") !== [...expected].sort().join("|"))
      add(path, "exact property names required", expected);
    return true;
  };
  const string = (value, min, max, path) => {
    if (typeof value !== "string" || value.length < min || value.length > max)
      add(
        path,
        `string length ${min}..${max}`,
        typeof value === "string" ? value.length : typeof value,
      );
  };
  if (!keys(candidate, ["instructions", "delivery", "checks"], "$"))
    return { valid: false, errors };
  string(candidate.instructions, 0, 2000, "$.instructions");
  if (!["system", "each_turn"].includes(candidate.delivery))
    add("$.delivery", "system or each_turn", "invalid value");
  if (!Array.isArray(candidate.checks)) add("$.checks", "array required", typeof candidate.checks);
  else {
    if (candidate.checks.length > 6) add("$.checks", "at most 6 entries", candidate.checks.length);
    const ids = new Set();
    for (const [i, c] of candidate.checks.entries()) {
      const p = `$.checks[${i}]`;
      if (!keys(c, ["id", "source", "contains", "take", "when", "instruction"], p)) continue;
      if (typeof c.id !== "string" || !/^[a-z][a-z0-9_-]{0,39}$/.test(c.id))
        add(`${p}.id`, "lowercase identifier, 1..40 characters", "invalid identifier");
      if (ids.has(c.id)) add(`${p}.id`, "unique identifier required", "duplicate");
      ids.add(c.id);
      if (!["customer", "tools", "public"].includes(c.source))
        add(`${p}.source`, "customer, tools or public", "invalid value");
      if (!["always", "found", "missing"].includes(c.when))
        add(`${p}.when`, "always, found or missing", "invalid value");
      if (!Array.isArray(c.contains)) add(`${p}.contains`, "array required", typeof c.contains);
      else {
        if (c.contains.length < 1 || c.contains.length > 4)
          add(`${p}.contains`, "1..4 search strings", c.contains.length);
        c.contains.forEach((s, j) => string(s, 1, 80, `${p}.contains[${j}]`));
      }
      if (!Number.isInteger(c.take) || c.take < 1 || c.take > 3)
        add(`${p}.take`, "integer 1..3", "outside contract");
      string(c.instruction, 1, 500, `${p}.instruction`);
    }
  }
  const length = JSON.stringify(candidate).length;
  if (length > 4000) add("$", "compact JSON at most 4000 characters", length);
  if (errors.length === 0)
    add("$", "frozen interpreter validation failed; inspect identifier restrictions", "rejected");
  return { valid: false, errors };
}

/** Receives only the branch's own previous generation, never an evaluation record. */
export function compilerFeedback(response) {
  if (response === null || response === undefined) return null;
  const text = (response.content ?? [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");
  const base = {
    kind: "mechanical-compiler-feedback",
    previousSubmission: text.slice(0, 16000),
    submissionTruncated: text.length > 16000,
    instruction:
      "These are mechanical compilation results for your own previous submission, not execution results. Revise the program yourself within the same contract. Nothing has been automatically repaired. Both experimental arms receive this channel.",
  };
  if ((response.stopReason ?? response.stop_reason) === "max_tokens")
    return {
      ...base,
      valid: false,
      errors: [{ path: "$", rule: "complete generation required", actual: "max_tokens" }],
    };
  try {
    return { ...base, ...programDiagnostics(JSON.parse(text)) };
  } catch {
    return {
      ...base,
      valid: false,
      errors: [{ path: "$", rule: "valid JSON required", actual: "parse failure" }],
    };
  }
}

export function withCompilerFeedback(packet, ownPreviousResponse) {
  return { ...packet, compilerFeedback: compilerFeedback(ownPreviousResponse) };
}
