import { beforeEach, describe, expect, it } from "vitest";
import { setDoctorJsonMode } from "./doctor-check.js";
import { doctorFindings, resetDoctorOutcome } from "./doctor-outcome.js";
import { runRuntimeChecks } from "./doctor-runtime.js";

function messages(): string[] {
  return doctorFindings().map((f) => `${f.level}: ${f.message}`);
}

describe("runRuntimeChecks install-kind awareness", () => {
  beforeEach(() => {
    resetDoctorOutcome();
    setDoctorJsonMode(true);
  });

  it("names the install kind", () => {
    runRuntimeChecks({ config: {}, installKind: "tarball", whichPnpm: () => ({ found: false }) });
    expect(messages().some((m) => m.includes("Install: release tarball"))).toBe(true);
  });

  it("only a source checkout needs pnpm", () => {
    runRuntimeChecks({ config: {}, installKind: "container", whichPnpm: () => ({ found: false }) });
    runRuntimeChecks({ config: {}, installKind: "tarball", whichPnpm: () => ({ found: false }) });
    expect(messages().some((m) => m.includes("pnpm"))).toBe(false);
    runRuntimeChecks({ config: {}, installKind: "git", whichPnpm: () => ({ found: false }) });
    expect(messages().some((m) => m.startsWith("warn: pnpm not found"))).toBe(true);
  });

  it("a container's lan bind is not a LAN exposure warning", () => {
    if (process.platform !== "linux") {
      return;
    }
    runRuntimeChecks({ config: { gateway: { bind: "lan" } }, installKind: "container" });
    expect(messages().some((m) => m.startsWith("warn: Linux + gateway bind"))).toBe(false);
    expect(messages().some((m) => m.startsWith("info: Container: gateway bind=lan"))).toBe(true);
  });
});
