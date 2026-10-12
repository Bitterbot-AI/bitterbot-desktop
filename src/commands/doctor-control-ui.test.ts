import { describe, expect, it } from "vitest";
import { CONTAINER_UPDATE_COMMAND, TARBALL_REINSTALL_COMMAND } from "../infra/install-kind.js";
import { controlUiMissingFix } from "./doctor-control-ui.js";

describe("controlUiMissingFix", () => {
  it("never tells a container or tarball user to build the UI with pnpm", () => {
    expect(controlUiMissingFix("container")).toContain(CONTAINER_UPDATE_COMMAND);
    expect(controlUiMissingFix("container")).not.toContain("pnpm");
    expect(controlUiMissingFix("tarball")).toContain(TARBALL_REINSTALL_COMMAND);
    expect(controlUiMissingFix("tarball")).not.toContain("ui:build");
    expect(controlUiMissingFix("package")).toContain("reinstall");
  });

  it("a checkout (or an unknown kind) builds it", () => {
    expect(controlUiMissingFix("git")).toContain("ui:build");
    expect(controlUiMissingFix(undefined)).toContain("ui:build");
  });
});
