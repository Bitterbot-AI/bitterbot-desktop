import { describe, expect, it, vi } from "vitest";
import { readConfigFileSnapshot } from "./doctor.e2e-harness.js";

// The keystone of the update gate: doctorCommand must actually call
// runtime.exit(1) when a check records an error-level finding. Everything
// upstream (findings accumulator, renderSection) and downstream (update-runner
// treating doctor exit 1 as a failed step) is unit-tested; this pins the link
// between them that used to be missing — doctor once printed errors and exited
// 0, making the update gate decorative.

const VALID_SNAPSHOT = {
  path: "/tmp/bitterbot.json",
  exists: true,
  raw: "{}",
  parsed: {},
  valid: true,
  config: {},
  issues: [],
  legacyIssues: [],
};

describe("doctor exit code", () => {
  it("exits 1 when the config snapshot is invalid (error-level finding)", async () => {
    readConfigFileSnapshot.mockResolvedValue({
      ...VALID_SNAPSHOT,
      valid: false,
      issues: [{ path: "gateway.mode", message: "invalid value" }],
    });

    const exit = vi.fn();
    const { doctorCommand } = await import("./doctor.js");
    await doctorCommand(
      { log: vi.fn(), error: vi.fn(), exit },
      { nonInteractive: true, workspaceSuggestions: false },
    );

    expect(exit).toHaveBeenCalledWith(1);
    // Generous timeout: the first doctorCommand run in a process pays cold
    // costs (DNS bootstrap probes, gateway health) that dwarf the checks.
  }, 120_000);

  it("exits 0 and emits parseable JSON as the last log line under --json", async () => {
    readConfigFileSnapshot.mockResolvedValue(VALID_SNAPSHOT);

    const log = vi.fn();
    const exit = vi.fn();
    const { doctorCommand } = await import("./doctor.js");
    await doctorCommand({ log, error: vi.fn(), exit }, { json: true, workspaceSuggestions: false });

    expect(exit).not.toHaveBeenCalled();
    const lastLine = log.mock.calls.at(-1)?.[0];
    const report = JSON.parse(String(lastLine));
    expect(report.schema).toBe(1);
    expect(report.hasError).toBe(false);
    expect(report.blocksUpdate).toBe(report.hasError);
    expect(Array.isArray(report.findings)).toBe(true);
    expect(report.findings.length).toBeGreaterThan(0);
  }, 60_000);
});
