import { describe, expect, it, vi } from "vitest";
import type { ConfigFileSnapshot } from "../../config/config.js";
import {
  announceContainerSetupLink,
  describeTokenSourceConflict,
  formatFirstBootTokenBanner,
  generateFirstBootToken,
  shouldGenerateFirstBootToken,
} from "./first-boot-token.js";

function snapshot(partial: Partial<ConfigFileSnapshot>): ConfigFileSnapshot {
  return {
    path: "/home/node/.bitterbot/bitterbot.json",
    exists: false,
    raw: null,
    parsed: {},
    resolved: {},
    valid: true,
    // A missing file's snapshot carries load-time defaults; they must NOT be written.
    config: { p2p: { enabled: true, bootstrapPeers: ["/dns4/x/tcp/9100/p2p/y"] } },
    hash: "h",
    issues: [],
    warnings: [],
    legacyIssues: [],
    ...partial,
  } as ConfigFileSnapshot;
}

describe("shouldGenerateFirstBootToken", () => {
  it("only for --allow-unconfigured, beyond loopback, with no auth at all", () => {
    expect(
      shouldGenerateFirstBootToken({ allowUnconfigured: true, bind: "lan", authMode: "none" }),
    ).toBe(true);
    expect(
      shouldGenerateFirstBootToken({ allowUnconfigured: false, bind: "lan", authMode: "none" }),
    ).toBe(false);
    expect(
      shouldGenerateFirstBootToken({ allowUnconfigured: true, bind: "loopback", authMode: "none" }),
    ).toBe(false);
    for (const authMode of ["token", "password", "trusted-proxy"]) {
      expect(shouldGenerateFirstBootToken({ allowUnconfigured: true, bind: "lan", authMode })).toBe(
        false,
      );
    }
  });
});

describe("generateFirstBootToken", () => {
  it("writes ONLY gateway.auth for a missing file and prints the token once to stdout", async () => {
    const writeConfig = vi.fn(async () => {});
    const write = vi.fn();
    const token = await generateFirstBootToken({
      port: 19001,
      readSnapshot: async () => snapshot({}),
      writeConfig,
      makeToken: () => "t0k3n",
      write,
      inContainer: true,
      issueSetupToken: () => "s3tup",
      bootstrapPairing: true,
    });
    expect(token).toBe("t0k3n");
    expect(writeConfig).toHaveBeenCalledWith({
      gateway: { auth: { mode: "token", token: "t0k3n" } },
    });
    expect(write).toHaveBeenCalledOnce();
    const banner = write.mock.calls[0][0] as string;
    expect(banner).toContain("Token:  t0k3n");
    // PLAN-56 Phase 4: the container banner carries the one-time setup link.
    expect(banner).toContain("http://127.0.0.1:19001/setup?token=s3tup");
    expect(banner).toContain("the first browser that");
    expect(banner).toContain("http://127.0.0.1:19001/");
    expect(banner).toContain(
      "docker compose exec -u node bitterbot-gateway node bitterbot.mjs config get gateway.auth.token",
    );
  });

  it("puts the setup link under gateway.controlUi.basePath", async () => {
    const write = vi.fn();
    await generateFirstBootToken({
      port: 19001,
      basePath: "/bb/",
      readSnapshot: async () => snapshot({}),
      writeConfig: async () => {},
      makeToken: () => "t0k3n",
      write,
      inContainer: true,
      issueSetupToken: () => "s3tup",
      bootstrapPairing: true,
    });
    expect(write.mock.calls[0][0]).toContain("http://127.0.0.1:19001/bb/setup?token=s3tup");
    expect(write.mock.calls[0][0]).toContain("works until setup finishes");
  });

  it("merges into an existing valid config", async () => {
    const writeConfig = vi.fn(async () => {});
    await generateFirstBootToken({
      port: 19001,
      readSnapshot: async () =>
        snapshot({ exists: true, config: { gateway: { port: 19001 }, p2p: { enabled: false } } }),
      writeConfig,
      makeToken: () => "abc",
      write: () => {},
      inContainer: false,
    });
    expect(writeConfig).toHaveBeenCalledWith({
      gateway: { port: 19001, auth: { mode: "token", token: "abc" } },
      p2p: { enabled: false },
    });
  });

  it("refuses to touch an invalid config file", async () => {
    const writeConfig = vi.fn(async () => {});
    await expect(
      generateFirstBootToken({
        port: 19001,
        readSnapshot: async () => snapshot({ exists: true, valid: false }),
        writeConfig,
        write: () => {},
      }),
    ).rejects.toThrow(/invalid/);
    expect(writeConfig).not.toHaveBeenCalled();
  });

  it("outside a container the retrieval hint is the plain CLI", () => {
    const banner = formatFirstBootTokenBanner({
      token: "x",
      configPath: "/c.json",
      port: 19001,
      inContainer: false,
    });
    expect(banner).toContain("bitterbot config get gateway.auth.token");
    expect(banner).not.toContain("docker compose");
    // A service manager's stdout log is not as private as the 0600 config.
    expect(banner).not.toContain("Token:  x");
  });

  it("without bootstrap pairing the banner asks for approval instead of promising auto-pairing", () => {
    const banner = formatFirstBootTokenBanner({
      token: "x",
      configPath: "/c.json",
      port: 19001,
      inContainer: true,
      bootstrapPairing: false,
    });
    expect(banner).not.toContain("the first browser that");
    expect(banner).toContain("devices approve");
  });
});

describe("describeTokenSourceConflict", () => {
  it("warns only when both are set and differ, without printing either", () => {
    expect(describeTokenSourceConflict(undefined, "e")).toBeNull();
    expect(describeTokenSourceConflict("c", undefined)).toBeNull();
    expect(describeTokenSourceConflict("same", " same ")).toBeNull();
    const msg = describeTokenSourceConflict("config-secret", "env-secret");
    expect(msg).toContain("config token is the one in use");
    expect(msg).not.toContain("config-secret");
    expect(msg).not.toContain("env-secret");
  });
});

describe("announceContainerSetupLink (token pinned with BITTERBOT_GATEWAY_TOKEN)", () => {
  const base = {
    port: 19001,
    inContainer: true,
    issueSetupToken: () => "s3tup",
    inProgress: () => false,
  };

  it("prints a setup link while the config is first-boot-only, under the base path", async () => {
    const write = vi.fn();
    const url = await announceContainerSetupLink({
      ...base,
      basePath: "/bb",
      readSnapshot: async () => snapshot({}),
      write,
    });
    expect(url).toBe("http://127.0.0.1:19001/bb/setup?token=s3tup");
    expect(write.mock.calls[0][0]).toContain(url);
    expect(write.mock.calls[0][0]).toContain("works until setup finishes");
  });

  it("prints again for a browser setup that never finished", async () => {
    const url = await announceContainerSetupLink({
      ...base,
      inProgress: () => true,
      readSnapshot: async () =>
        snapshot({ exists: true, resolved: { agents: { defaults: { workspace: "/w" } } } }),
      write: () => {},
    });
    expect(url).toContain("/setup?token=s3tup");
  });

  it("stays quiet once set up, outside a container, or with an invalid config", async () => {
    const issue = vi.fn(() => "s3tup");
    const write = vi.fn();
    const setUp = snapshot({ exists: true, resolved: { gateway: { mode: "local" } } });
    expect(
      await announceContainerSetupLink({
        ...base,
        issueSetupToken: issue,
        readSnapshot: async () => setUp,
        write,
      }),
    ).toBeNull();
    expect(
      await announceContainerSetupLink({
        ...base,
        inContainer: false,
        issueSetupToken: issue,
        readSnapshot: async () => snapshot({}),
        write,
      }),
    ).toBeNull();
    expect(
      await announceContainerSetupLink({
        ...base,
        issueSetupToken: issue,
        readSnapshot: async () => snapshot({ exists: true, valid: false }),
        write,
      }),
    ).toBeNull();
    expect(issue).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });
});
