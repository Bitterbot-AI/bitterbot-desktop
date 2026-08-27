import { beforeEach, describe, expect, it, vi } from "vitest";

// note() writes to the terminal; stub it so we can assert print vs suppress.
const noteMock = vi.fn();
vi.mock("../terminal/note.js", () => ({ note: (...args: unknown[]) => noteMock(...args) }));

const {
  renderSection,
  renderSectionQuietIfAllInfo,
  ok,
  warn,
  error,
  info,
  setDoctorJsonMode,
  isDoctorJsonMode,
} = await import("./doctor-check.js");
const { resetDoctorOutcome, doctorFindings, doctorHasError, worstDoctorLevel } =
  await import("./doctor-outcome.js");

describe("doctor-check shared contract", () => {
  beforeEach(() => {
    resetDoctorOutcome();
    setDoctorJsonMode(false);
    noteMock.mockClear();
  });

  it("collects every result as a structured finding", () => {
    renderSection("Runtime", [ok("node 22"), warn("pnpm old")]);
    expect(doctorFindings()).toEqual([
      { section: "Runtime", level: "ok", message: "node 22" },
      { section: "Runtime", level: "warn", message: "pnpm old" },
    ]);
  });

  it("error-level results always gate the exit code (severity IS the gate)", () => {
    renderSection("Memory Database", [error("core table missing")]);
    expect(doctorHasError()).toBe(true);
    expect(worstDoctorLevel()).toBe("error");
  });

  it("warn-level results never gate (degraded-but-usable must not block updates)", () => {
    renderSection("Channels", [warn("bad creds")]);
    expect(doctorHasError()).toBe(false);
    expect(worstDoctorLevel()).toBe("warn");
  });

  it("prints in normal mode, suppresses in JSON mode", () => {
    renderSection("Canvas", [info("ok")]);
    expect(noteMock).toHaveBeenCalledTimes(1);

    noteMock.mockClear();
    setDoctorJsonMode(true);
    expect(isDoctorJsonMode()).toBe(true);
    renderSection("Canvas", [info("ok")]);
    expect(noteMock).not.toHaveBeenCalled(); // collected, not printed
    // ...but still collected for --json:
    expect(doctorFindings().some((f) => f.section === "Canvas")).toBe(true);
  });

  it("ignores empty result sets", () => {
    renderSection("Empty", []);
    expect(doctorFindings()).toEqual([]);
    expect(noteMock).not.toHaveBeenCalled();
  });

  it("quiet variant: an all-info section is recorded but not printed (p0-28)", () => {
    renderSectionQuietIfAllInfo("Wallet (USDC on Base)", [info("Wallet is not enabled")]);
    expect(noteMock).not.toHaveBeenCalled();
    expect(doctorFindings()).toEqual([
      { section: "Wallet (USDC on Base)", level: "info", message: "Wallet is not enabled" },
    ]);
  });

  it("quiet variant: any actionable result prints the section in full", () => {
    renderSectionQuietIfAllInfo("Wallet (USDC on Base)", [
      info("Network: base-sepolia"),
      warn("CDP credentials missing"),
    ]);
    expect(noteMock).toHaveBeenCalledTimes(1);
    expect(doctorFindings()).toHaveLength(2);
  });
});
