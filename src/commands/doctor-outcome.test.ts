import { beforeEach, describe, expect, it } from "vitest";
import {
  doctorErrorMessages,
  doctorHasError,
  recordFinding,
  resetDoctorOutcome,
  worstDoctorLevel,
  worstFindingLevel,
} from "./doctor-outcome.js";

describe("doctor outcome accumulator", () => {
  beforeEach(() => resetDoctorOutcome());

  it("starts clean", () => {
    expect(worstDoctorLevel()).toBe("ok");
    expect(doctorHasError()).toBe(false);
    expect(doctorErrorMessages()).toEqual([]);
  });

  it("tracks the worst level, not the last", () => {
    recordFinding("Runtime", "ok", "node 22");
    recordFinding("Memory Database", "error", "db corrupt");
    recordFinding("Channels", "warn", "creds"); // must not downgrade below error
    expect(worstDoctorLevel()).toBe("error");
    expect(doctorHasError()).toBe(true);
    expect(doctorErrorMessages()).toEqual(["db corrupt"]);
  });

  it("warn alone does not count as error (does not block an update)", () => {
    recordFinding("Subsystems", "warn", "embedding backlog");
    recordFinding("Circles", "info", "mailbox relay");
    expect(worstDoctorLevel()).toBe("warn");
    expect(doctorHasError()).toBe(false);
  });

  it("rollup fields all derive from the same findings list", () => {
    // The earlier design kept a separate severity accumulator fed only by
    // opted-in sections, which let worstLevel === "error" coexist with
    // hasError === false in one report. That divergence must be impossible.
    recordFinding("Identity (P2P node)", "error", "unknown nodeTier");
    expect(worstFindingLevel()).toBe("error");
    expect(worstDoctorLevel()).toBe(worstFindingLevel());
    expect(doctorHasError()).toBe(true);
    expect(doctorErrorMessages()).toEqual(["unknown nodeTier"]);
  });

  it("reset clears everything for the next run", () => {
    recordFinding("Memory Database", "error", "boom");
    resetDoctorOutcome();
    expect(worstDoctorLevel()).toBe("ok");
    expect(doctorHasError()).toBe(false);
    expect(doctorErrorMessages()).toEqual([]);
  });
});
