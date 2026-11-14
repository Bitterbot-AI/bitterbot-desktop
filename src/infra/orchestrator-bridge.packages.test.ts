import { expect, it, vi } from "vitest";
import { OrchestratorBridge } from "./orchestrator-bridge.js";

it("refuses a legacy peer before requesting an incomplete package", async () => {
  const circleRequest = vi.fn(async (_peer: string, _body: string) =>
    Buffer.from(JSON.stringify({ ok: false, error: "Unknown method" })).toString("base64"),
  );
  const bridge = { circleRequest } as unknown as OrchestratorBridge;
  await expect(
    OrchestratorBridge.prototype.requestPackageObject.call(bridge, "peer", {
      releaseId: "a".repeat(64),
      objectHash: "b".repeat(64),
      offset: 0,
    }),
  ).rejects.toThrow("does not support complete skill packages");
  expect(circleRequest).toHaveBeenCalledTimes(1);
  expect(JSON.parse(Buffer.from(circleRequest.mock.calls[0][1], "base64").toString()).method).toBe(
    "skill-package/1/capabilities",
  );
});
