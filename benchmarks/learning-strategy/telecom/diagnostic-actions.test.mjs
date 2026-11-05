import assert from "node:assert/strict";
import test from "node:test";
import {
  diagnosticActionCatalog,
  diagnosticActionSchema,
  validateDiagnosticActions,
} from "./diagnostic-actions.mjs";

const definition = (name, required = []) => ({
  function: { name, parameters: { type: "object", required } },
});
const context = {
  agentTools: [definition("get_details_by_id", ["id"]), definition("transfer_to_human_agents")],
  userTools: [
    definition("check_installed_apps"),
    definition("check_network_status"),
    definition("grant_app_permission", ["app_name", "permission"]),
  ],
};
const action = (tool, args = {}) => ({ tool, argumentsJson: JSON.stringify(args) });

test("provider vocabulary binds the native role to each tool and excludes terminal handoff", () => {
  const catalog = diagnosticActionCatalog(context),
    schema = diagnosticActionSchema(context);
  assert.ok(schema.properties.tool.enum.includes("assistant.get_details_by_id"));
  assert.ok(!schema.properties.tool.enum.includes("user.get_details_by_id"));
  assert.ok(schema.properties.tool.enum.includes("user.grant_app_permission"));
  assert.ok(!catalog.some((t) => t.name === "transfer_to_human_agents"));
});

test("wrong-role error names the available action and blocks the entire sequence", () => {
  const result = validateDiagnosticActions(
    [
      action("user.check_installed_apps"),
      action("assistant.grant_app_permission", { app_name: "messaging", permission: "phone" }),
    ],
    context,
  );
  assert.equal(result.valid, false);
  assert.deepEqual(result.actions, []);
  assert.deepEqual(result.errors[0].availableForName, ["user.grant_app_permission"]);
});

test("valid qualified actions decode without changing argument text", () => {
  const argumentsJson = '{"app_name": "messaging", "permission": "phone"}';
  const result = validateDiagnosticActions(
    [{ tool: "user.grant_app_permission", argumentsJson }],
    context,
  );
  assert.equal(result.valid, true);
  assert.deepEqual(result.actions, [{ role: "user", name: "grant_app_permission", argumentsJson }]);
});

test("malformed arguments and oversized batches fail before native execution", () => {
  for (const actions of [
    [{ tool: "user.check_network_status", argumentsJson: "[]" }],
    [action("assistant.get_details_by_id")],
    Array.from({ length: 7 }, () => action("user.check_network_status")),
  ]) {
    const result = validateDiagnosticActions(actions, context);
    assert.equal(result.valid, false);
    assert.deepEqual(result.actions, []);
  }
});
