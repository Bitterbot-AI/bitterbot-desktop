import { beforeEach, describe, expect, it } from "vitest";
import {
  doctorErrorMessages,
  doctorHasError,
  recordDoctorLevel,
  recordDoctorResults,
  resetDoctorOutcome,
  worstDoctorLevel,
} from "./doctor-outcome.js";

describe("doctor outcome accumulator", () => {
  beforeEach(() => resetDoctorOutcome());

  it("starts clean", () => {
    expect(worstDoctorLevel()).toBe("ok");
    expect(doctorHasError()).toBe(false);
    expect(doctorErrorMessages()).toEqual([]);
  });

  it("tracks the worst level, not the last", () => {
    recordDoctorLevel("ok");
    recordDoctorLevel("error", "db corrupt");
    recordDoctorLevel("warn"); // must not downgrade below error
    expect(worstDoctorLevel()).toBe("error");
    expect(doctorHasError()).toBe(true);
    expect(doctorErrorMessages()).toEqual(["db corrupt"]);
  });

  it("warn alone does not count as error (does not block an update)", () => {
    recordDoctorLevel("warn", "embedding backlog");
    recordDoctorLevel("info");
    expect(worstDoctorLevel()).toBe("warn");
    expect(doctorHasError()).toBe(false);
  });

  it("records the worst across a results array and collects error messages", () => {
    recordDoctorResults([
      { level: "ok", message: "integrity ok" },
      { level: "error", message: "core table missing: chunks" },
      { level: "warn", message: "schema behind" },
    ]);
    expect(doctorHasError()).toBe(true);
    expect(doctorErrorMessages()).toEqual(["core table missing: chunks"]);
  });

  it("reset clears everything for the next run", () => {
    recordDoctorLevel("error", "boom");
    resetDoctorOutcome();
    expect(worstDoctorLevel()).toBe("ok");
    expect(doctorHasError()).toBe(false);
    expect(doctorErrorMessages()).toEqual([]);
  });
});
