import path from "node:path";
import { expect, it } from "vitest";
import type { BitterbotConfig } from "../../../config/config.js";
import { resolveEffectiveToolPolicy, isToolAllowedByPolicies } from "../../agent-tools.policy.js";
import { resolveSandboxConfigForAgent } from "../../sandbox/config.js";
import { isolatedPackageConfig, packageHostConfiguration } from "./isolated-config.js";

it("retains global, provider, agent and sandbox denials while removing setup and private mounts", () => {
  const original: BitterbotConfig = {
    tools: {
      deny: ["exec"],
      byProvider: { fixture: { deny: ["edit"] } },
      sandbox: { tools: { deny: ["process"] } },
    },
    agents: {
      defaults: {
        sandbox: {
          docker: {
            setupCommand: "install stuff",
            binds: ["/private:/private:rw"],
            network: "bridge",
          },
        },
      },
      list: [{ id: "writer", tools: { allow: ["read", "write"] } }],
    },
  };
  const isolated = isolatedPackageConfig(original, "writer", "/scratch", "fixture/model");
  const policies = resolveEffectiveToolPolicy({
    config: isolated,
    sessionKey: "agent:writer:package-validation:run",
    modelProvider: "fixture",
    modelId: "model",
  });
  const sandbox = resolveSandboxConfigForAgent(isolated, "writer");
  const layers = [
    policies.globalPolicy,
    policies.agentPolicy,
    policies.globalProviderPolicy,
    sandbox.tools,
  ];
  for (const tool of ["exec", "edit", "process"])
    expect(isToolAllowedByPolicies(tool, layers)).toBe(false);
  expect(isToolAllowedByPolicies("read", layers)).toBe(true);
  expect(sandbox.docker.network).toBe("none");
  expect(sandbox.docker.binds).toBeUndefined();
  expect(sandbox.docker.setupCommand).toBeUndefined();
  expect(isolated.plugins?.enabled).toBe(false);
  expect(isolated.agents?.defaults?.toolCache?.enabled).toBe(false);
  expect(isolated.tools?.elevated?.enabled).toBe(false);
  expect(packageHostConfiguration(original, "writer")).not.toBe(
    packageHostConfiguration({ ...original, tools: { allow: [] } }, "writer"),
  );
});

it("preserves an explicit empty allowlist", () => {
  const isolated = isolatedPackageConfig(
    { tools: { allow: [] } },
    "main",
    "/scratch",
    "fixture/model",
  );
  const policies = resolveEffectiveToolPolicy({ config: isolated });
  expect(isToolAllowedByPolicies("read", [policies.globalPolicy])).toBe(false);
});

it("mounts the exact trial package read-only even for shell subprocesses", () => {
  const isolated = isolatedPackageConfig({}, "main", "/scratch", "fixture/model", true);
  expect(resolveSandboxConfigForAgent(isolated, "main").docker.binds).toEqual([
    `${path.join("/scratch", "skill")}:/workspace/skill:ro`,
  ]);
});

it("uses provider sampling defaults for models that reject temperature overrides", () => {
  const model = "anthropic/claude-opus-4-8";
  const config = isolatedPackageConfig({}, "main", "/scratch", model);
  expect(config.agents?.defaults?.models?.[model]?.params).toEqual({ maxTokens: 4096 });
});
