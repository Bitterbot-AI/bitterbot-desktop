import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const fsMocks = vi.hoisted(() => ({
  access: vi.fn(),
  realpath: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
  default: { access: fsMocks.access, realpath: fsMocks.realpath },
  access: fsMocks.access,
  realpath: fsMocks.realpath,
}));

import { resolveGatewayProgramArguments } from "./program-args.js";

const originalArgv = [...process.argv];

afterEach(() => {
  process.argv = [...originalArgv];
  vi.resetAllMocks();
});

describe("resolveGatewayProgramArguments", () => {
  it("uses realpath-resolved dist entry when running via npx shim", async () => {
    const argv1 = path.resolve("/tmp/.npm/_npx/63c3/node_modules/.bin/bitterbot");
    const entryPath = path.resolve("/tmp/.npm/_npx/63c3/node_modules/bitterbot/dist/entry.js");
    process.argv = ["node", argv1];
    fsMocks.realpath.mockResolvedValue(entryPath);
    fsMocks.access.mockImplementation(async (target: string) => {
      if (target === entryPath) {
        return;
      }
      throw new Error("missing");
    });

    const result = await resolveGatewayProgramArguments({ port: 18789 });

    expect(result.programArguments).toEqual([
      process.execPath,
      entryPath,
      "gateway",
      "--port",
      "18789",
    ]);
  });

  it("prefers symlinked path over realpath for stable service config", async () => {
    // Simulates pnpm global install where node_modules/bitterbot is a symlink
    // to .pnpm/bitterbot@X.Y.Z/node_modules/bitterbot
    const symlinkPath = path.resolve(
      "/Users/test/Library/pnpm/global/5/node_modules/bitterbot/dist/entry.js",
    );
    const realpathResolved = path.resolve(
      "/Users/test/Library/pnpm/global/5/node_modules/.pnpm/bitterbot@2026.1.21-2/node_modules/bitterbot/dist/entry.js",
    );
    process.argv = ["node", symlinkPath];
    fsMocks.realpath.mockResolvedValue(realpathResolved);
    fsMocks.access.mockResolvedValue(undefined); // Both paths exist

    const result = await resolveGatewayProgramArguments({ port: 18789 });

    // Should use the symlinked path, not the realpath-resolved versioned path
    expect(result.programArguments[1]).toBe(symlinkPath);
    expect(result.programArguments[1]).not.toContain("@2026.1.21-2");
  });

  it("falls back to node_modules package dist when .bin path is not resolved", async () => {
    const argv1 = path.resolve("/tmp/.npm/_npx/63c3/node_modules/.bin/bitterbot");
    const indexPath = path.resolve("/tmp/.npm/_npx/63c3/node_modules/bitterbot/dist/index.js");
    process.argv = ["node", argv1];
    fsMocks.realpath.mockRejectedValue(new Error("no realpath"));
    fsMocks.access.mockImplementation(async (target: string) => {
      if (target === indexPath) {
        return;
      }
      throw new Error("missing");
    });

    const result = await resolveGatewayProgramArguments({ port: 18789 });

    expect(result.programArguments).toEqual([
      process.execPath,
      indexPath,
      "gateway",
      "--port",
      "18789",
    ]);
  });
});

describe("release-tarball installs (PLAN-56 Phase 3a)", () => {
  const savedKind = process.env.BITTERBOT_INSTALL_KIND;
  const savedRoot = process.env.BITTERBOT_INSTALL_ROOT;
  afterEach(() => {
    if (savedKind === undefined) {
      delete process.env.BITTERBOT_INSTALL_KIND;
    } else {
      process.env.BITTERBOT_INSTALL_KIND = savedKind;
    }
    if (savedRoot === undefined) {
      delete process.env.BITTERBOT_INSTALL_ROOT;
    } else {
      process.env.BITTERBOT_INSTALL_ROOT = savedRoot;
    }
  });

  it("runs the service through the stable current/bin/bitterbot launcher", async () => {
    const root = path.resolve("/home/u/.bitterbot/app/1.5.0");
    const launcher = path.resolve("/home/u/.bitterbot/app/current/bin/bitterbot");
    process.env.BITTERBOT_INSTALL_KIND = "tarball";
    process.env.BITTERBOT_INSTALL_ROOT = root;
    process.argv = [path.join(root, "runtime/node/bin/node"), path.join(root, "dist/entry.js")];
    fsMocks.access.mockImplementation(async (target: string) => {
      if (target === launcher) {
        return;
      }
      throw new Error("missing");
    });

    const result = await resolveGatewayProgramArguments({ port: 19001 });

    expect(result.programArguments).toEqual([launcher, "gateway", "--port", "19001"]);
  });

  it("keeps the node + entry form when an explicit node path is requested", async () => {
    process.env.BITTERBOT_INSTALL_KIND = "tarball";
    process.env.BITTERBOT_INSTALL_ROOT = path.resolve("/home/u/.bitterbot/app/1.5.0");
    const entryPath = path.resolve("/home/u/.bitterbot/app/1.5.0/dist/entry.js");
    process.argv = ["node", entryPath];
    fsMocks.realpath.mockResolvedValue(entryPath);
    fsMocks.access.mockResolvedValue(undefined);

    const result = await resolveGatewayProgramArguments({
      port: 19001,
      runtime: "node",
      nodePath: "/usr/bin/node",
    });

    expect(result.programArguments[0]).toBe("/usr/bin/node");
  });
});
