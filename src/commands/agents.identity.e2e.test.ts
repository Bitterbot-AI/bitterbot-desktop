import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../runtime.js";

const configMocks = vi.hoisted(() => ({
  readConfigFileSnapshot: vi.fn(),
  writeConfigFile: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    readConfigFileSnapshot: configMocks.readConfigFileSnapshot,
    writeConfigFile: configMocks.writeConfigFile,
  };
});

import { agentsSetIdentityCommand } from "./agents.js";

const runtime: RuntimeEnv = {
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(),
};

const baseSnapshot = {
  path: "/tmp/bitterbot.json",
  exists: true,
  raw: "{}",
  parsed: {},
  valid: true,
  config: {},
  issues: [],
  legacyIssues: [],
};

describe("agents set-identity command", () => {
  beforeEach(() => {
    configMocks.readConfigFileSnapshot.mockReset();
    configMocks.writeConfigFile.mockClear();
    (runtime.log as ReturnType<typeof vi.fn>).mockClear();
    (runtime.error as ReturnType<typeof vi.fn>).mockClear();
    (runtime.exit as ReturnType<typeof vi.fn>).mockClear();
  });

  it("sets identity from explicit flags", async () => {
    configMocks.readConfigFileSnapshot.mockResolvedValue({
      ...baseSnapshot,
      config: { agents: { list: [{ id: "main" }] } },
    });

    await agentsSetIdentityCommand(
      { agent: "main", name: "Bitterbot", emoji: "🦞", theme: "helpful companion" },
      runtime,
    );

    expect(configMocks.writeConfigFile).toHaveBeenCalledTimes(1);
    const written = configMocks.writeConfigFile.mock.calls[0]?.[0] as {
      agents?: { list?: Array<{ id: string; identity?: Record<string, string> }> };
    };
    const main = written.agents?.list?.find((entry: { id: string }) => entry.id === "main");
    expect(main?.identity).toEqual({
      name: "Bitterbot",
      emoji: "🦞",
      theme: "helpful companion",
    });
  });

  it("errors when multiple agents match the same workspace", async () => {
    const workspace = path.join(os.tmpdir(), "bitterbot-shared-ws");

    configMocks.readConfigFileSnapshot.mockResolvedValue({
      ...baseSnapshot,
      config: {
        agents: {
          list: [
            { id: "main", workspace },
            { id: "ops", workspace },
          ],
        },
      },
    });

    await agentsSetIdentityCommand({ workspace }, runtime);

    expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("Multiple agents match"));
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(configMocks.writeConfigFile).not.toHaveBeenCalled();
  });

  it("accepts avatar-only updates via flags", async () => {
    configMocks.readConfigFileSnapshot.mockResolvedValue({
      ...baseSnapshot,
      config: { agents: { list: [{ id: "main" }] } },
    });

    await agentsSetIdentityCommand(
      { agent: "main", avatar: "https://example.com/avatar.png" },
      runtime,
    );

    const written = configMocks.writeConfigFile.mock.calls[0]?.[0] as {
      agents?: { list?: Array<{ id: string; identity?: Record<string, string> }> };
    };
    const main = written.agents?.list?.find((entry: { id: string }) => entry.id === "main");
    expect(main?.identity).toEqual({
      avatar: "https://example.com/avatar.png",
    });
  });

  it("errors when no identity fields provided", async () => {
    configMocks.readConfigFileSnapshot.mockResolvedValue({
      ...baseSnapshot,
      config: { agents: { list: [{ id: "main" }] } },
    });

    await agentsSetIdentityCommand({ agent: "main" }, runtime);

    expect(runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("No identity fields provided"),
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(configMocks.writeConfigFile).not.toHaveBeenCalled();
  });

  it("merges with existing identity config", async () => {
    configMocks.readConfigFileSnapshot.mockResolvedValue({
      ...baseSnapshot,
      config: {
        agents: {
          list: [{ id: "main", identity: { name: "OldName", emoji: "🤖" } }],
        },
      },
    });

    await agentsSetIdentityCommand({ agent: "main", name: "Nova" }, runtime);

    const written = configMocks.writeConfigFile.mock.calls[0]?.[0] as {
      agents?: { list?: Array<{ id: string; identity?: Record<string, string> }> };
    };
    const main = written.agents?.list?.find((entry: { id: string }) => entry.id === "main");
    expect(main?.identity).toEqual({
      name: "Nova",
      emoji: "🤖",
    });
  });
});
