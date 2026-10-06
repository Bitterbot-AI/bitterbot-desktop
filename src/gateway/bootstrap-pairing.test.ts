import { describe, expect, it } from "vitest";
import { bootstrapPairingAllowed } from "./bootstrap-pairing.js";

const base = {
  isControlUi: true,
  sharedAuthOk: true,
  enabled: undefined,
  reason: "not-paired",
  pairedCount: 0,
};

describe("bootstrapPairingAllowed", () => {
  it("pairs the first Control UI device that proves the gateway token", () => {
    expect(bootstrapPairingAllowed(base)).toBe(true);
  });

  it("never applies once any device is paired", () => {
    expect(bootstrapPairingAllowed({ ...base, pairedCount: 1 })).toBe(false);
  });

  it("needs the shared token or password, not just a device token", () => {
    expect(bootstrapPairingAllowed({ ...base, sharedAuthOk: false })).toBe(false);
  });

  it("is only for the Control UI, only for a new device, and can be turned off", () => {
    expect(bootstrapPairingAllowed({ ...base, isControlUi: false })).toBe(false);
    expect(bootstrapPairingAllowed({ ...base, reason: "scope-upgrade" })).toBe(false);
    expect(bootstrapPairingAllowed({ ...base, reason: "role-upgrade" })).toBe(false);
    expect(bootstrapPairingAllowed({ ...base, enabled: false })).toBe(false);
  });
});
