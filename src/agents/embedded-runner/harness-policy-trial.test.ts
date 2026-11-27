import { describe, expect, it } from "vitest";
import {
  clearTrialHarnessPolicy,
  registerTrialHarnessPolicy,
  resolveTrialHarnessPolicy,
} from "./harness-policy-trial.js";
import { defaultHarnessPolicy } from "./harness-policy.js";

const VALIDATION = "agent:main:skill-evolve-val-abc";

describe("trial harness policy registry (PLAN-64 Phase 6)", () => {
  it("returns the bound policy only for a validation session in that workspace", () => {
    const policy = defaultHarnessPolicy();
    policy.prompt.fragments.push({ id: "f", text: "t", order: 0 });
    registerTrialHarnessPolicy("/tmp/trial-a/workspace", policy);
    try {
      expect(
        resolveTrialHarnessPolicy({
          workspaceDir: "/tmp/trial-a/workspace/",
          sessionKey: VALIDATION,
        }),
      ).toBe(policy);
      // A normal session in the same directory never sees a trial policy.
      expect(
        resolveTrialHarnessPolicy({
          workspaceDir: "/tmp/trial-a/workspace",
          sessionKey: "agent:main:main",
        }),
      ).toBeNull();
      expect(
        resolveTrialHarnessPolicy({
          workspaceDir: "/tmp/trial-b/workspace",
          sessionKey: VALIDATION,
        }),
      ).toBeNull();
      expect(
        resolveTrialHarnessPolicy({ workspaceDir: undefined, sessionKey: VALIDATION }),
      ).toBeNull();
    } finally {
      clearTrialHarnessPolicy("/tmp/trial-a/workspace");
    }
    expect(
      resolveTrialHarnessPolicy({ workspaceDir: "/tmp/trial-a/workspace", sessionKey: VALIDATION }),
    ).toBeNull();
  });
});
