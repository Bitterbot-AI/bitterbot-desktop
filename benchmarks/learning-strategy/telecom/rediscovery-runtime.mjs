import assert from "node:assert/strict";
import { ACTOR } from "./episode.mjs";
import { forbidden } from "./feedback.mjs";

export const PROGRAM_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["instructions", "delivery", "checks"],
  properties: {
    instructions: { type: "string" },
    delivery: { type: "string", enum: ["system", "each_turn"] },
    checks: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "source", "contains", "take", "when", "instruction"],
        properties: {
          id: { type: "string" },
          source: { type: "string", enum: ["customer", "tools", "public"] },
          contains: { type: "array", items: { type: "string" } },
          take: { type: "integer" },
          when: { type: "string", enum: ["always", "found", "missing"] },
          instruction: { type: "string" },
        },
      },
    },
  },
};
const exact = (object, keys) => assert.deepEqual(Object.keys(object).sort(), [...keys].sort());
export function validateProgram(p) {
  exact(p, ["instructions", "delivery", "checks"]);
  assert.ok(typeof p.instructions === "string" && p.instructions.length <= 2000);
  assert.ok(["system", "each_turn"].includes(p.delivery));
  assert.ok(Array.isArray(p.checks) && p.checks.length <= 6);
  assert.equal(new Set(p.checks.map((c) => c.id)).size, p.checks.length);
  for (const c of p.checks) {
    exact(c, ["id", "source", "contains", "take", "when", "instruction"]);
    assert.ok(/^[a-z][a-z0-9_-]{0,39}$/.test(c.id));
    assert.ok(["customer", "tools", "public"].includes(c.source));
    assert.ok(["always", "found", "missing"].includes(c.when));
    assert.ok(Array.isArray(c.contains) && c.contains.length >= 1 && c.contains.length <= 4);
    assert.ok(c.contains.every((s) => typeof s === "string" && s.length >= 1 && s.length <= 80));
    assert.ok(Number.isInteger(c.take) && c.take >= 1 && c.take <= 3);
    assert.ok(
      typeof c.instruction === "string" && c.instruction.length >= 1 && c.instruction.length <= 500,
    );
  }
  const text = JSON.stringify(p);
  assert.ok(text.length <= 4000, "Program exceeds archive's 4000-character contract");
  assert.ok(!forbidden.test(text), "Instance identifier in generated program");
  return p;
}
export function decodeProgram(actor) {
  return actor === ACTOR ? null : validateProgram(JSON.parse(actor));
}
export function executionInstructions(actor) {
  const p = decodeProgram(actor);
  if (!p || p.delivery === "each_turn") return ACTOR;
  return (
    ACTOR +
    "\n\nGenerated procedure (subordinate to policy):\n" +
    p.instructions +
    "\n" +
    p.checks.map((c) => c.instruction).join("\n")
  );
}

/** Literal retrieval, not an inference engine. Only the current actor request is read. */
export function actorEvidence(messages) {
  const rows = [],
    names = new Map();
  let latestPublic = [];
  for (const [message, m] of messages.entries()) {
    const blocks = typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content;
    for (const b of blocks) {
      if (m.role === "assistant" && b.type === "tool_use") names.set(b.id, b.name);
      if (m.role === "user" && b.type === "tool_result")
        rows.push({
          source: "tools",
          message,
          text: `${names.get(b.tool_use_id) ?? "tool"}: ${typeof b.content === "string" ? b.content : JSON.stringify(b.content)}`,
        });
      if (m.role !== "user" || b.type !== "text") continue;
      let report;
      try {
        report = JSON.parse(b.text);
      } catch {
        continue;
      }
      if (report.kind !== "customer-public-report") continue;
      rows.push({ source: "customer", message, text: report.speech });
      latestPublic = (report.observations?.records ?? []).map((r) => ({
        source: "public",
        message,
        text: JSON.stringify(r),
      }));
    }
  }
  return [...rows, ...latestPublic];
}
export function projectProgram(request, p) {
  const rows = actorEvidence(request.messages);
  const checks = p.checks.map((c) => {
    const matches = rows
      .filter(
        (r) =>
          r.source === c.source &&
          c.contains.some((s) => r.text.toLowerCase().includes(s.toLowerCase())),
      )
      .slice(-c.take);
    const deliver =
      c.when === "always" || (c.when === "found" ? matches.length > 0 : matches.length === 0);
    return {
      id: c.id,
      source: c.source,
      found: matches.length > 0,
      evidence: matches.map((r) => ({
        message: r.message,
        text: r.text.slice(0, 1200),
        truncated: r.text.length > 1200,
      })),
      ...(deliver ? { instruction: c.instruction } : {}),
    };
  });
  const projection = {
    instructions: p.instructions,
    checks,
    note: "Generated advisory procedure. Retrieved customer/tool excerpts are historical, not automatically current or true. Public facts use only the latest explicit snapshot. A literal match does not establish that a prerequisite is met; no match does not establish absence. Recheck after changes and use the full original dialogue. Follow policy and consent; this module takes no action and cannot prevent handoff.",
  };
  const messages = structuredClone(request.messages),
    last = messages.at(-1);
  assert.equal(last?.role, "user");
  if (typeof last.content === "string") last.content = [{ type: "text", text: last.content }];
  last.content.push({
    type: "text",
    text: "Generated execution support:\n" + JSON.stringify(projection),
  });
  return { request: { ...request, messages }, projection };
}
export function programProvider(provider, actor, onProjection = () => {}) {
  const p = decodeProgram(actor);
  return {
    call: async (request, options) => {
      if (!p || p.delivery !== "each_turn" || options.tag.split(":").at(-2) !== "actor")
        return provider.call(request, options);
      const projected = projectProgram(request, p);
      onProjection({ tag: options.tag, projection: projected.projection });
      return provider.call(projected.request, options);
    },
  };
}
