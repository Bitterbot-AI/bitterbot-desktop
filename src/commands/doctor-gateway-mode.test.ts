import { describe, expect, it } from "vitest";
import { gatewayModeUnsetFinding } from "./doctor-gateway-mode.js";

describe("gatewayModeUnsetFinding", () => {
  it("is informational in the container (compose passes --allow-unconfigured)", () => {
    const finding = gatewayModeUnsetFinding({ installKind: "container", configFileExists: false });
    expect(finding.level).toBe("info");
    expect(finding.message).toContain("--allow-unconfigured");
  });

  it("warns elsewhere, and a missing file is called fine, not an error", () => {
    const finding = gatewayModeUnsetFinding({ installKind: "tarball", configFileExists: false });
    expect(finding.level).toBe("warn");
    expect(finding.message).toContain("No config file yet. That is fine");
    expect(finding.message).not.toContain("Missing config");
    expect(
      gatewayModeUnsetFinding({ installKind: "git", configFileExists: true }).message,
    ).not.toContain("No config file yet");
  });
});
