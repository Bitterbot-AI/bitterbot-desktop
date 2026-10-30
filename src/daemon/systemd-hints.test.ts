import { describe, expect, it } from "vitest";
import { isSystemdUnavailableDetail, renderSystemdUnavailableHints } from "./systemd-hints.js";

describe("renderSystemdUnavailableHints", () => {
  it("on WSL points at the WSL supervisor first and keeps systemd as the alternative", () => {
    const hints = renderSystemdUnavailableHints({ wsl: true });
    expect(hints[0]).toContain("WSL supervisor");
    expect(hints[0]).toContain("bitterbot gateway install");
    expect(hints[1]).toContain("systemd=true");
    expect(hints[1]).toContain("wsl --shutdown");
  });

  it("off WSL keeps the plain systemd hints", () => {
    const hints = renderSystemdUnavailableHints();
    expect(hints[0]).toContain("systemd user services are unavailable");
    expect(hints.join("\n")).not.toContain("WSL supervisor");
  });

  it("recognises the bus failure the WSL box reports", () => {
    expect(
      isSystemdUnavailableDetail("systemctl --user unavailable: Failed to connect to bus"),
    ).toBe(true);
    expect(isSystemdUnavailableDetail("active")).toBe(false);
  });
});
