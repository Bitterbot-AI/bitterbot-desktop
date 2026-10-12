/**
 * PLAN-56: doctor's pre-run update offer names the command that actually
 * updates a container or release-tarball install, never the package manager.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  note: vi.fn(),
  run: vi.fn(),
}));
vi.mock("../terminal/note.js", () => ({ note: mocks.note }));
vi.mock("../process/exec.js", () => ({ runCommandWithTimeout: mocks.run }));
vi.mock("../infra/update-runner.js", () => ({ runGatewayUpdate: vi.fn() }));

import { CONTAINER_UPDATE_COMMAND, TARBALL_UPDATE_COMMAND } from "../infra/install-kind.js";
import { maybeOfferUpdateBeforeDoctor } from "./doctor-update.js";

describe("doctor update advice by install kind", () => {
  let root: string;
  const savedKind = process.env.BITTERBOT_INSTALL_KIND;
  const savedTty = process.stdin.isTTY;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "bb-doctor-update-"));
    mocks.note.mockReset();
    mocks.run.mockResolvedValue({ code: 128, stdout: "", stderr: "fatal: not a git repository" });
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    if (savedKind === undefined) {
      delete process.env.BITTERBOT_INSTALL_KIND;
    } else {
      process.env.BITTERBOT_INSTALL_KIND = savedKind;
    }
    Object.defineProperty(process.stdin, "isTTY", { value: savedTty, configurable: true });
  });

  async function run() {
    await maybeOfferUpdateBeforeDoctor({
      runtime: {} as never,
      options: {},
      root,
      confirm: vi.fn(),
      outro: vi.fn(),
    });
    return mocks.note.mock.calls.map((c) => String(c[0])).join("\n");
  }

  it("a release-tarball install is told to run the in-place updater", async () => {
    delete process.env.BITTERBOT_INSTALL_KIND;
    fs.writeFileSync(path.join(root, ".bitterbot-install-kind"), "tarball\n");
    const text = await run();
    expect(text).toContain(TARBALL_UPDATE_COMMAND);
    expect(text).toContain("--rollback");
    expect(text).not.toContain("npm");
    expect(text).not.toContain("install.sh");
  });

  it("a container is told to pull a newer image", async () => {
    process.env.BITTERBOT_INSTALL_KIND = "container";
    const text = await run();
    expect(text).toContain(CONTAINER_UPDATE_COMMAND);
  });

  it("a plain package install keeps the package-manager advice", async () => {
    process.env.BITTERBOT_INSTALL_KIND = "package";
    const text = await run();
    expect(text).toContain("package manager");
  });
});
