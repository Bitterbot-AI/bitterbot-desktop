import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  bootstrapPairingAllowed,
  bootstrapPairingEnabled,
  bootstrapPairingUsed,
  markBootstrapPairingUsed,
} from "./bootstrap-pairing.js";

const base = {
  isControlUi: true,
  sharedAuthOk: true,
  enabled: true,
  reason: "not-paired",
  pairedCount: 0,
  role: "operator",
  scopes: ["operator.admin", "operator.approvals", "operator.pairing"],
  alreadyUsed: false,
};

afterEach(() => {
  delete process.env.BITTERBOT_BOOTSTRAP_PAIRING;
});

describe("bootstrapPairingAllowed", () => {
  it("pairs the first Control UI device that proves the gateway token", () => {
    expect(bootstrapPairingAllowed(base)).toBe(true);
  });

  it("never applies once any device is paired, or after it was used once", () => {
    expect(bootstrapPairingAllowed({ ...base, pairedCount: 1 })).toBe(false);
    expect(bootstrapPairingAllowed({ ...base, alreadyUsed: true })).toBe(false);
  });

  it("needs the shared token or password, not just a device token", () => {
    expect(bootstrapPairingAllowed({ ...base, sharedAuthOk: false })).toBe(false);
  });

  it("grants only what the Control UI asks for, as an operator", () => {
    expect(bootstrapPairingAllowed({ ...base, role: "node" })).toBe(false);
    expect(bootstrapPairingAllowed({ ...base, scopes: ["operator.admin", "node.invoke"] })).toBe(
      false,
    );
  });

  it("is only for a new Control UI device, and can be turned off", () => {
    expect(bootstrapPairingAllowed({ ...base, isControlUi: false })).toBe(false);
    expect(bootstrapPairingAllowed({ ...base, reason: "scope-upgrade" })).toBe(false);
    expect(bootstrapPairingAllowed({ ...base, enabled: false })).toBe(false);
  });
});

describe("bootstrapPairingEnabled", () => {
  it("is off unless configured or the deploy template sets the env var", () => {
    expect(bootstrapPairingEnabled(undefined)).toBe(false);
    process.env.BITTERBOT_BOOTSTRAP_PAIRING = "1";
    expect(bootstrapPairingEnabled(undefined)).toBe(true);
    expect(bootstrapPairingEnabled(false)).toBe(false);
  });

  it("remembers that it was used", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-bootstrap-"));
    try {
      expect(bootstrapPairingUsed(dir)).toBe(false);
      markBootstrapPairingUsed(dir);
      expect(bootstrapPairingUsed(dir)).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
