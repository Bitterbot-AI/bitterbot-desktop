import path from "node:path";
import { describe, expect, it } from "vitest";
import { formatCliCommand } from "./command-format.js";
import { applyCliProfileEnv, parseCliProfileArgs } from "./profile.js";

describe("parseCliProfileArgs", () => {
  it("leaves gateway --dev for subcommands", () => {
    const res = parseCliProfileArgs([
      "node",
      "bitterbot",
      "gateway",
      "--dev",
      "--allow-unconfigured",
    ]);
    if (!res.ok) {
      throw new Error(res.error);
    }
    expect(res.profile).toBeNull();
    expect(res.argv).toEqual(["node", "bitterbot", "gateway", "--dev", "--allow-unconfigured"]);
  });

  it("still accepts global --dev before subcommand", () => {
    const res = parseCliProfileArgs(["node", "bitterbot", "--dev", "gateway"]);
    if (!res.ok) {
      throw new Error(res.error);
    }
    expect(res.profile).toBe("dev");
    expect(res.argv).toEqual(["node", "bitterbot", "gateway"]);
  });

  it("parses --profile value and strips it", () => {
    const res = parseCliProfileArgs(["node", "bitterbot", "--profile", "work", "status"]);
    if (!res.ok) {
      throw new Error(res.error);
    }
    expect(res.profile).toBe("work");
    expect(res.argv).toEqual(["node", "bitterbot", "status"]);
  });

  it("rejects missing profile value", () => {
    const res = parseCliProfileArgs(["node", "bitterbot", "--profile"]);
    expect(res.ok).toBe(false);
  });

  it("rejects combining --dev with --profile (dev first)", () => {
    const res = parseCliProfileArgs(["node", "bitterbot", "--dev", "--profile", "work", "status"]);
    expect(res.ok).toBe(false);
  });

  it("rejects combining --dev with --profile (profile first)", () => {
    const res = parseCliProfileArgs(["node", "bitterbot", "--profile", "work", "--dev", "status"]);
    expect(res.ok).toBe(false);
  });
});

describe("applyCliProfileEnv", () => {
  it("fills env defaults for dev profile", () => {
    const env: Record<string, string | undefined> = {};
    applyCliProfileEnv({
      profile: "dev",
      env,
      homedir: () => "/home/peter",
    });
    const expectedStateDir = path.join(path.resolve("/home/peter"), ".bitterbot-dev");
    expect(env.BITTERBOT_PROFILE).toBe("dev");
    expect(env.BITTERBOT_STATE_DIR).toBe(expectedStateDir);
    expect(env.BITTERBOT_CONFIG_PATH).toBe(path.join(expectedStateDir, "bitterbot.json"));
  });

  it("does not override explicit env values", () => {
    const env: Record<string, string | undefined> = {
      BITTERBOT_STATE_DIR: "/custom",
      BITTERBOT_GATEWAY_PORT: "19099",
    };
    applyCliProfileEnv({
      profile: "dev",
      env,
      homedir: () => "/home/peter",
    });
    expect(env.BITTERBOT_STATE_DIR).toBe("/custom");
    expect(env.BITTERBOT_GATEWAY_PORT).toBe("19099");
    expect(env.BITTERBOT_CONFIG_PATH).toBe(path.join("/custom", "bitterbot.json"));
  });

  it("uses BITTERBOT_HOME when deriving profile state dir", () => {
    const env: Record<string, string | undefined> = {
      BITTERBOT_HOME: "/srv/bitterbot-home",
      HOME: "/home/other",
    };
    applyCliProfileEnv({
      profile: "work",
      env,
      homedir: () => "/home/fallback",
    });

    const resolvedHome = path.resolve("/srv/bitterbot-home");
    expect(env.BITTERBOT_STATE_DIR).toBe(path.join(resolvedHome, ".bitterbot-work"));
    expect(env.BITTERBOT_CONFIG_PATH).toBe(
      path.join(resolvedHome, ".bitterbot-work", "bitterbot.json"),
    );
  });
});

describe("formatCliCommand", () => {
  it("returns command unchanged when no profile is set", () => {
    expect(formatCliCommand("bitterbot doctor --fix", {})).toBe("bitterbot doctor --fix");
  });

  it("returns command unchanged when profile is default", () => {
    expect(formatCliCommand("bitterbot doctor --fix", { BITTERBOT_PROFILE: "default" })).toBe(
      "bitterbot doctor --fix",
    );
  });

  it("returns command unchanged when profile is Default (case-insensitive)", () => {
    expect(formatCliCommand("bitterbot doctor --fix", { BITTERBOT_PROFILE: "Default" })).toBe(
      "bitterbot doctor --fix",
    );
  });

  it("returns command unchanged when profile is invalid", () => {
    expect(formatCliCommand("bitterbot doctor --fix", { BITTERBOT_PROFILE: "bad profile" })).toBe(
      "bitterbot doctor --fix",
    );
  });

  it("returns command unchanged when --profile is already present", () => {
    expect(
      formatCliCommand("bitterbot --profile work doctor --fix", { BITTERBOT_PROFILE: "work" }),
    ).toBe("bitterbot --profile work doctor --fix");
  });

  it("returns command unchanged when --dev is already present", () => {
    expect(formatCliCommand("bitterbot --dev doctor", { BITTERBOT_PROFILE: "dev" })).toBe(
      "bitterbot --dev doctor",
    );
  });

  it("inserts --profile flag when profile is set", () => {
    expect(formatCliCommand("bitterbot doctor --fix", { BITTERBOT_PROFILE: "work" })).toBe(
      "bitterbot --profile work doctor --fix",
    );
  });

  it("trims whitespace from profile", () => {
    expect(
      formatCliCommand("bitterbot doctor --fix", { BITTERBOT_PROFILE: "  jbbitterbot  " }),
    ).toBe("bitterbot --profile jbbitterbot doctor --fix");
  });

  it("handles command with no args after bitterbot", () => {
    expect(formatCliCommand("bitterbot", { BITTERBOT_PROFILE: "test" })).toBe(
      "bitterbot --profile test",
    );
  });

  it("handles pnpm wrapper", () => {
    expect(formatCliCommand("pnpm bitterbot doctor", { BITTERBOT_PROFILE: "work" })).toBe(
      "pnpm bitterbot --profile work doctor",
    );
  });
});
