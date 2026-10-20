/**
 * PLAN-49 Phase 0.5: the wallet provisioning mode resolver. Embedded is selected
 * only when opted in with a projectId; otherwise it falls back to the self-host
 * server wallet (byte-identical to today, J4).
 */
import { describe, expect, it } from "vitest";
import { resolveWalletProvisioning } from "./wallet-provisioning.js";

describe("resolveWalletProvisioning (PLAN-49 Phase 0.5)", () => {
  it("defaults to selfHostServer with no config (J4 fallback)", () => {
    expect(resolveWalletProvisioning().mode).toBe("selfHostServer");
    expect(resolveWalletProvisioning({}).mode).toBe("selfHostServer");
    expect(resolveWalletProvisioning({ provisioning: "selfHostServer" }).mode).toBe(
      "selfHostServer",
    );
  });

  it("selects embedded only when opted in AND a projectId is present", () => {
    const v = resolveWalletProvisioning({
      provisioning: "embedded",
      embedded: { projectId: "proj_abc" },
    });
    expect(v.mode).toBe("embedded");
    expect(v.embeddedProjectId).toBe("proj_abc");
    expect(v.reason).toBeUndefined();
  });

  it("falls back to self-host when embedded is requested without a projectId", () => {
    const v = resolveWalletProvisioning({ provisioning: "embedded" });
    expect(v.mode).toBe("selfHostServer");
    expect(v.reason).toMatch(/projectId is not set/);
  });

  it("treats a blank projectId as unset", () => {
    const v = resolveWalletProvisioning({
      provisioning: "embedded",
      embedded: { projectId: "   " },
    });
    expect(v.mode).toBe("selfHostServer");
  });
});
