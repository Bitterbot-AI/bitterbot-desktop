import { beforeEach, describe, expect, it } from "vitest";

// Verifies the exact object shape doctorCommand emits under --json, driven by
// the real accumulator + contract (not a live doctor run, which needs a
// gateway + a model call). Mirrors the emission in doctor.ts.

const { renderSection, ok, warn, error, setDoctorJsonMode } = await import("./doctor-check.js");
const {
  resetDoctorOutcome,
  doctorFindings,
  doctorHasError,
  worstFindingLevel,
  doctorErrorMessages,
} = await import("./doctor-outcome.js");

function buildReport() {
  return {
    schema: 1,
    version: "test",
    worstLevel: worstFindingLevel(),
    hasError: doctorHasError(),
    blocksUpdate: doctorHasError(),
    errors: doctorErrorMessages(),
    findings: doctorFindings(),
    checkedAt: 0,
  };
}

describe("doctor --json report", () => {
  beforeEach(() => {
    resetDoctorOutcome();
    setDoctorJsonMode(true);
  });

  it("serializes findings + a healthy rollup", () => {
    renderSection("Runtime", [ok("node 22")]);
    renderSection("Circles", [warn("no a2aPublicUrl")]);
    const report = buildReport();
    // Round-trips through JSON cleanly.
    const parsed = JSON.parse(JSON.stringify(report));
    expect(parsed.schema).toBe(1);
    expect(parsed.worstLevel).toBe("warn");
    expect(parsed.hasError).toBe(false);
    expect(parsed.blocksUpdate).toBe(false);
    expect(parsed.findings).toHaveLength(2);
    expect(parsed.findings[0]).toEqual({ section: "Runtime", level: "ok", message: "node 22" });
  });

  it("reflects an error in the rollup (blocks the update gate)", () => {
    renderSection("Memory Database", [error("core table missing: chunks")]);
    const report = buildReport();
    expect(report.worstLevel).toBe("error");
    expect(report.hasError).toBe(true);
    expect(report.blocksUpdate).toBe(true);
    expect(report.errors).toContain("core table missing: chunks");
  });

  it("can never report worstLevel error with hasError false (regression)", () => {
    // Every section feeds the same findings list, so the rollup fields cannot
    // diverge the way the old opt-in gate design allowed.
    renderSection("Identity (P2P node)", [error("broken")]);
    const report = buildReport();
    expect(report.worstLevel === "error").toBe(report.hasError);
  });
});
