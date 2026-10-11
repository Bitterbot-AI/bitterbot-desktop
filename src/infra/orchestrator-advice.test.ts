import { describe, expect, it } from "vitest";
import { CONTAINER_UPDATE_COMMAND, TARBALL_UPDATE_COMMAND } from "./install-kind.js";
import { orchestratorMissingAdvice, orchestratorSignatureStatus } from "./orchestrator-advice.js";

describe("orchestratorMissingAdvice", () => {
  it("never tells a container or tarball user to run pnpm or cargo", () => {
    for (const kind of ["container", "tarball"] as const) {
      const text = orchestratorMissingAdvice(kind).join("\n");
      expect(text).not.toContain("pnpm");
      expect(text).not.toContain("cargo");
    }
  });

  it("points each kind at the way it gets the binary", () => {
    expect(orchestratorMissingAdvice("container").join("\n")).toContain(CONTAINER_UPDATE_COMMAND);
    const tarball = orchestratorMissingAdvice("tarball").join("\n");
    expect(tarball).toContain("$BITTERBOT_INSTALL_ROOT/bin");
    expect(tarball).toContain(TARBALL_UPDATE_COMMAND);
    const git = orchestratorMissingAdvice("git").join("\n");
    expect(git).toContain("pnpm install");
    expect(git).toContain("cargo build --release");
    expect(git).not.toMatch(/none may be published/);
    expect(orchestratorMissingAdvice("package").join("\n")).toContain("p2p.orchestratorBinary");
  });
});

describe("orchestratorSignatureStatus", () => {
  it("names the gate each source passed", () => {
    expect(orchestratorSignatureStatus("bundled", "tarball")).toContain("release tarball");
    expect(orchestratorSignatureStatus("release", "container")).toContain("image was built");
    expect(orchestratorSignatureStatus("release", "git")).toContain("built from source");
    expect(orchestratorSignatureStatus("debug", "git")).toContain("built from source");
    expect(orchestratorSignatureStatus("prebuilt", "git")).toContain("minisign");
    expect(orchestratorSignatureStatus("config", "git")).toContain("does not verify");
  });
});
