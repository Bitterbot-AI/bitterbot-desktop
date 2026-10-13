import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  INSTALL_ROOT_ENV,
  listOrchestratorBinaryCandidates,
  probeOrchestratorBinary,
} from "./orchestrator-binary.js";

describe("orchestrator binary bundled with a release tarball (PLAN-56 Phase 3a)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("probes <install root>/bin first when the launcher sets the install root", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "bb-orch-"));
    dirs.push(root);
    const name =
      process.platform === "win32" ? "bitterbot-orchestrator.exe" : "bitterbot-orchestrator";
    fs.mkdirSync(path.join(root, "bin"));
    fs.writeFileSync(path.join(root, "bin", name), "");
    const env = { [INSTALL_ROOT_ENV]: root } as NodeJS.ProcessEnv;
    const probe = probeOrchestratorBinary(undefined, env);
    expect(probe.found).toBe(true);
    if (probe.found) {
      expect(probe.source).toBe("bundled");
      expect(probe.path).toBe(path.join(root, "bin", name));
    }
  });

  it("an explicit config override still wins over the bundled binary", () => {
    const env = { [INSTALL_ROOT_ENV]: "/nonexistent-root" } as NodeJS.ProcessEnv;
    const candidates = listOrchestratorBinaryCandidates(
      { orchestratorBinary: "/opt/custom/orchestrator" },
      env,
    );
    expect(candidates.map((c) => c.source)).toEqual([
      "config",
      "bundled",
      "release",
      "debug",
      "prebuilt",
    ]);
  });

  it("adds no bundled candidate outside a tarball install", () => {
    const candidates = listOrchestratorBinaryCandidates(undefined, {} as NodeJS.ProcessEnv);
    expect(candidates.some((c) => c.source === "bundled")).toBe(false);
  });
});
