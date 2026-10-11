import { describe, expect, it, vi } from "vitest";
import type { ConfigFileSnapshot } from "../../config/config.js";
import {
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
      bootstrapPairing: true,
    });
    expect(token).toBe("t0k3n");
    expect(writeConfig).toHaveBeenCalledWith({
      gateway: { auth: { mode: "token", token: "t0k3n" } },
    });
    expect(write).toHaveBeenCalledOnce();
    const banner = write.mock.calls[0][0] as string;
    expect(banner).toContain("Token:  t0k3n");
    expect(banner).toContain("the first browser that");
    expect(banner).toContain("http://127.0.0.1:19001/");
    expect(banner).toContain(
      "docker compose exec -u node bitterbot-gateway node bitterbot.mjs config get gateway.auth.token",
    );
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
