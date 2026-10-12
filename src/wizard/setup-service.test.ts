import { describe, expect, it } from "vitest";
import { detectSetupServiceSupport, serviceLabelFor } from "./setup-service.js";

describe("detectSetupServiceSupport (where the terminal QuickStart installs a service)", () => {
  const yes = async () => true;
  const no = async () => false;

  it("offers it on Linux with systemd and on macOS when none is installed", async () => {
    expect(
      await detectSetupServiceSupport({
        installKind: "package",
        platform: "linux",
        systemdAvailable: yes,
        isLoaded: no,
      }),
    ).toEqual({ kind: "available", label: "systemd user service" });
    expect(
      await detectSetupServiceSupport({ installKind: "tarball", platform: "darwin", isLoaded: no }),
    ).toEqual({ kind: "available", label: "macOS LaunchAgent" });
  });

  it("not in a container, not without systemd, and not again when one is installed", async () => {
    expect(
      await detectSetupServiceSupport({
        installKind: "container",
        platform: "linux",
        isLoaded: no,
      }),
    ).toMatchObject({ kind: "unavailable", reason: "container" });
    expect(
      await detectSetupServiceSupport({
        installKind: "package",
        platform: "linux",
        systemdAvailable: no,
        isLoaded: no,
      }),
    ).toMatchObject({ kind: "unavailable", reason: "no-systemd" });
    expect(
      await detectSetupServiceSupport({
        installKind: "package",
        platform: "linux",
        systemdAvailable: yes,
        isLoaded: yes,
      }),
    ).toEqual({ kind: "installed", label: "systemd user service" });
  });

  it("never offers a real install from a test run", async () => {
    expect(
      await detectSetupServiceSupport({ installKind: "package", env: { VITEST: "true" } }),
    ).toMatchObject({ kind: "unavailable", reason: "test" });
  });

  it("names the service manager per platform", () => {
    expect(serviceLabelFor("win32")).toBe("Windows scheduled task");
  });
});
