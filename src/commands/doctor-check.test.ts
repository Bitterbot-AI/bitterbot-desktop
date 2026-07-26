import { beforeEach, describe, expect, it, vi } from "vitest";

// note() writes to the terminal; stub it so we can assert print vs suppress.
const noteMock = vi.fn();
vi.mock("../terminal/note.js", () => ({ note: (...args: unknown[]) => noteMock(...args) }));

const { renderSection, ok, warn, error, info, setDoctorJsonMode, isDoctorJsonMode } =
  await import("./doctor-check.js");
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

  it("does NOT gate the exit code by default (warn/error only surface)", () => {
    renderSection("Channels", [error("bad creds")]);
    expect(doctorHasError()).toBe(false); // not opted into the gate
    expect(worstDoctorLevel()).toBe("ok");
  });

  it("gates the exit code when gateExitCode is set", () => {
    renderSection("Memory Database", [error("core table missing")], { gateExitCode: true });
    expect(doctorHasError()).toBe(true);
    expect(worstDoctorLevel()).toBe("error");
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
});
