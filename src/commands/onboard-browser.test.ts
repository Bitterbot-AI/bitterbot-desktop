import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { verifySetupToken } from "../gateway/setup-token.js";
import type { RuntimeEnv } from "../runtime.js";
import { buildSetupUrl, resolveOnboardSurface, runBrowserOnboarding } from "./onboard-browser.js";

describe("resolveOnboardSurface", () => {
  const env = { stdinIsTty: true, inContainer: false, remote: false };

  it("defaults to the browser and opens it on a desktop terminal", () => {
    expect(resolveOnboardSurface({ opts: {}, ...env })).toEqual({
      kind: "browser",
      open: true,
      headless: false,
      inContainer: false,
    });
  });

  it("--no-browser keeps the terminal wizard", () => {
    expect(resolveOnboardSurface({ opts: { browser: false }, ...env })).toEqual({
      kind: "terminal",
    });
  });

  it("terminal-only flags keep the terminal wizard unless --browser is explicit", () => {
    expect(resolveOnboardSurface({ opts: { flow: "advanced" }, ...env }).kind).toBe("terminal");
    expect(resolveOnboardSurface({ opts: { authChoice: "apiKey" }, ...env }).kind).toBe("terminal");
    expect(
      resolveOnboardSurface({ opts: { flow: "quickstart", browser: true }, ...env }).kind,
    ).toBe("browser");
  });

  it("--json and the --skip-* switches keep the terminal wizard; switches left off do not", () => {
    for (const opts of [
      { json: true },
      { skipChannels: true },
      { skipHealth: true },
      { skipSkills: true },
    ]) {
      expect(resolveOnboardSurface({ opts, ...env }).kind).toBe("terminal");
    }
    // The CLI passes every switch, false when absent.
    expect(
      resolveOnboardSurface({
        opts: { json: false, skipChannels: false, skipHealth: false, skipSkills: false },
        ...env,
      }).kind,
    ).toBe("browser");
  });

  it("headless, SSH and container sessions print the link instead of opening it", () => {
    for (const variant of [
      { ...env, remote: true },
      { ...env, inContainer: true },
      { ...env, inContainer: true, stdinIsTty: false },
    ]) {
      const surface = resolveOnboardSurface({ opts: {}, ...variant });
      expect(surface).toMatchObject({ kind: "browser", open: false });
    }
    // Explicit --browser without a terminal: print the link (scripts).
    expect(
      resolveOnboardSurface({ opts: { browser: true }, ...env, stdinIsTty: false }),
    ).toMatchObject({ kind: "browser", open: false });
  });

  it("without a terminal, the default is an error, not a background gateway", () => {
    const surface = resolveOnboardSurface({ opts: {}, ...env, stdinIsTty: false });
    expect(surface.kind).toBe("no-terminal");
    expect(surface.kind === "no-terminal" && surface.message).toContain(
      "bitterbot onboard --browser",
    );
    expect(surface.kind === "no-terminal" && surface.message).toContain("--non-interactive");
  });
});

describe("buildSetupUrl", () => {
  it("is loopback, respects the Control UI base path and encodes the token", () => {
    expect(buildSetupUrl({ port: 19001, token: "a+b" })).toBe(
      "http://127.0.0.1:19001/setup?token=a%2Bb",
    );
    expect(buildSetupUrl({ port: 18000, basePath: "/bb/", token: "t" })).toBe(
      "http://127.0.0.1:18000/bb/setup?token=t",
    );
    expect(buildSetupUrl({ port: 19001 })).toBe("http://127.0.0.1:19001/setup");
  });
});

describe("runBrowserOnboarding", () => {
  let dir: string;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-onboard-browser-"));
    for (const key of ["BITTERBOT_STATE_DIR", "BITTERBOT_CONFIG_PATH"]) {
      saved[key] = process.env[key];
    }
    process.env.BITTERBOT_STATE_DIR = dir;
    process.env.BITTERBOT_CONFIG_PATH = path.join(dir, "bitterbot.json");
  });
  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function runtime(): RuntimeEnv & { lines: string[] } {
    const lines: string[] = [];
    return {
      lines,
      log: (...args: unknown[]) => void lines.push(args.join(" ")),
      error: (...args: unknown[]) => void lines.push(args.join(" ")),
      exit: ((code: number) => {
        throw new Error(`exit ${code}`);
      }) as RuntimeEnv["exit"],
    };
  }

  it("starts the gateway when nothing listens, mints a one-time token and opens the link", async () => {
    const rt = runtime();
    const startGateway = vi.fn(() => ({ pid: 42, logPath: "/tmp/gw.log" }));
    const openUrl = vi.fn(async () => true);
    const result = await runBrowserOnboarding(
      {},
      rt,
      { kind: "browser", open: true, headless: false, inContainer: false },
      {
        isListening: async () => false,
        startGateway,
        waitForGateway: async () => true,
        openUrl,
      },
    );
    expect(startGateway).toHaveBeenCalledWith(19001);
    expect(result?.tokenIssued).toBe(true);
    const token = new URL(result!.url).searchParams.get("token");
    expect(verifySetupToken(token, { stateDir: dir }).ok).toBe(true);
    expect(result!.url.startsWith("http://127.0.0.1:19001/setup?token=")).toBe(true);
    expect(openUrl).toHaveBeenCalledWith(result!.url);
    expect(rt.lines.join("\n")).toContain("link valid 30 minutes, works until setup finishes");
  });

  it("reuses a running gateway and only prints the link when headless", async () => {
    const rt = runtime();
    const startGateway = vi.fn();
    const openUrl = vi.fn(async () => true);
    await runBrowserOnboarding(
      {},
      rt,
      { kind: "browser", open: false, headless: true, inContainer: false },
      { isListening: async () => true, startGateway, openUrl },
    );
    expect(startGateway).not.toHaveBeenCalled();
    expect(openUrl).not.toHaveBeenCalled();
    expect(rt.lines.join("\n")).toContain("ssh -N -L 19001:127.0.0.1:19001");
  });

  it("does not mint a setup token once setup is complete (admin sign-in instead)", async () => {
    fs.writeFileSync(
      path.join(dir, "bitterbot.json"),
      JSON.stringify({ gateway: { mode: "local" }, agents: { defaults: { workspace: dir } } }),
    );
    const rt = runtime();
    const result = await runBrowserOnboarding(
      {},
      rt,
      { kind: "browser", open: false, headless: false, inContainer: false },
      { isListening: async () => true },
    );
    expect(result?.tokenIssued).toBe(false);
    expect(result?.url).toBe("http://127.0.0.1:19001/setup");
    expect(fs.existsSync(path.join(dir, "setup-token.json"))).toBe(false);
  });

  it("mints a new link when an earlier browser setup wrote config but never finished", async () => {
    fs.writeFileSync(
      path.join(dir, "bitterbot.json"),
      JSON.stringify({ agents: { defaults: { workspace: dir } } }),
    );
    fs.writeFileSync(path.join(dir, "setup-in-progress.json"), "{}\n");
    const result = await runBrowserOnboarding(
      {},
      runtime(),
      { kind: "browser", open: false, headless: false, inContainer: false },
      { isListening: async () => true },
    );
    expect(result?.tokenIssued).toBe(true);
  });

  it("in a container, a stopped gateway is an error with the compose command", async () => {
    const rt = runtime();
    await expect(
      runBrowserOnboarding(
        {},
        rt,
        { kind: "browser", open: false, headless: true, inContainer: true },
        { isListening: async () => false },
      ),
    ).rejects.toThrow("exit 1");
    expect(rt.lines.join("\n")).toContain("docker compose up -d");
  });
});
