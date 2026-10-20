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

  it("a container's lan bind warns that exposure depends on the host port mapping", () => {
    if (process.platform !== "linux") {
      return;
    }
    runRuntimeChecks({ config: { gateway: { bind: "lan" } }, installKind: "container" });
    const container = messages().find((m) => m.startsWith("warn: Container: gateway bind=lan"));
    expect(container).toBeDefined();
    expect(container).toContain("docker compose port bitterbot-gateway 19001");
    expect(container).not.toContain("publishes 127.0.0.1 only");
  });
});
