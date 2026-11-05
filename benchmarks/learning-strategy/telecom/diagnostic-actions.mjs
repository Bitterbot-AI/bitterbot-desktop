import assert from "node:assert/strict";

// Offline candidate for a future protocol. The frozen rediscovery2 collector does not import this.
export function diagnosticActionCatalog(context) {
  const catalog = [];
  for (const [role, tools] of [
    ["assistant", context.agentTools],
    ["user", context.userTools],
  ]) {
    for (const tool of tools) {
      const { name, parameters } = tool.function;
      if (name === "transfer_to_human_agents") continue;
      assert.match(name, /^[a-zA-Z_][a-zA-Z0-9_]*$/);
      catalog.push({ tool: `${role}.${name}`, role, name, parameters });
    }
  }
  assert.equal(new Set(catalog.map((t) => t.tool)).size, catalog.length);
  return catalog;
}

export function diagnosticActionSchema(context) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["tool", "argumentsJson"],
    properties: {
      tool: { type: "string", enum: diagnosticActionCatalog(context).map((t) => t.tool) },
      argumentsJson: { type: "string" },
    },
  };
}

export function validateDiagnosticActions(actions, context) {
  const catalog = diagnosticActionCatalog(context),
    errors = [],
    decoded = [];
  if (!Array.isArray(actions) || actions.length < 1 || actions.length > 6)
    return {
      valid: false,
      errors: [{ path: "$", rule: "Expected 1..6 diagnostic actions" }],
      actions: [],
    };
  for (const [i, action] of actions.entries()) {
    const at = `$[${i}]`;
    if (!action || typeof action !== "object" || Array.isArray(action)) {
      errors.push({ path: at, rule: "Expected an action object" });
      continue;
    }
    if (Object.keys(action).sort().join(",") !== "argumentsJson,tool")
      errors.push({
        path: at,
        rule: "Only tool and argumentsJson are allowed; role is encoded in tool",
      });
    const selected = catalog.find((t) => t.tool === action.tool);
    if (!selected) {
      const name =
        typeof action.tool === "string" ? action.tool.split(".").slice(1).join(".") : null;
      errors.push({
        path: `${at}.tool`,
        rule: "Unknown role-qualified diagnostic action",
        actual: action.tool ?? null,
        availableForName: catalog.filter((t) => t.name === name).map((t) => t.tool),
      });
    }
    let args;
    try {
      if (typeof action.argumentsJson !== "string") throw Error("Expected JSON text");
      args = JSON.parse(action.argumentsJson);
      if (!args || typeof args !== "object" || Array.isArray(args))
        throw Error("Expected a JSON object");
      for (const key of selected?.parameters?.required ?? [])
        if (!Object.hasOwn(args, key))
          errors.push({
            path: `${at}.argumentsJson.${key}`,
            rule: "Required native argument is missing",
          });
    } catch (error) {
      errors.push({ path: `${at}.argumentsJson`, rule: error.message });
    }
    if (selected && args)
      decoded.push({
        role: selected.role,
        name: selected.name,
        argumentsJson: action.argumentsJson,
      });
  }
  // A caller must validate the complete sequence before running any native action.
  return errors.length
    ? { valid: false, errors, actions: [] }
    : { valid: true, errors, actions: decoded };
}
