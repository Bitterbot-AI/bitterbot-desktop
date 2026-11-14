import { expect, it, vi } from "vitest";
import { createSkillPackageTool } from "./skill-package-tool.js";
const host = vi.hoisted(() => ({
  authorize: vi.fn(() => {
    throw new Error("Approval required");
  }),
  queued: vi.fn(),
  release: { publisher: `ed25519:${"a".repeat(64)}`, skillId: "brief", scope: { kind: "private" } },
}));
vi.mock("../skills/collective/runtime.js", () => ({
  getCollectiveRuntime: () => ({
    policies: { authorize: host.authorize },
    store: { release: () => host.release },
  }),
}));
vi.mock("../skills/collective/service.js", () => ({ queuePackageOperation: host.queued }));
vi.mock("../skills/collective/local.js", () => ({ releaseLocalPackage: vi.fn() }));

it("does not let an agent grant permissions, certify outcomes, or activate an ungranted local proposal", async () => {
  const tool = createSkillPackageTool({
    config: { skills: { collective: { enabled: true } } },
    agentSessionKey: "agent:main:main",
  })!;
  for (const action of ["policy.set", "verdict", "activate", "replace"])
    await expect(tool.execute("call", { action, payload: "{}" })).rejects.toThrow();
  for (const action of ["evaluate", "adopt"])
    await expect(tool.execute("call", { action, releaseId: "a".repeat(64) })).rejects.toThrow(
      "Approval required",
    );
  expect(host.queued).not.toHaveBeenCalled();
  expect(host.authorize).toHaveBeenCalledTimes(2);
});
