import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { P2pConfig } from "../config/types.p2p.js";
import { OrchestratorBridge } from "./orchestrator-bridge.js";

/**
 * Regression tests for the 2026-08-26 post-reboot crash: a stale
 * /tmp/bitterbot-orchestrator.sock made the fresh daemon fail to bind and
 * exit, the gateway's single fixed-delay connect got ECONNREFUSED, and the
 * rejection escaped as an uncaught exception that killed the whole node.
 *
 * The bridge under test spawns a FAKE orchestrator: `node -e '<script>'` via
 * the orchestratorBinary config override, with the IPC path pointed at a temp
 * directory through BITTERBOT_ORCHESTRATOR_IPC_PATH.
 */

const tmpDirs: string[] = [];
let ipcPath: string;

const cfg = (overrides: Partial<P2pConfig> = {}): P2pConfig =>
  ({
    enabled: true,
    orchestratorBinary: process.execPath,
    bootstrapPeers: [],
    ...overrides,
  }) as P2pConfig;

/**
 * A fake daemon: node binary + `-e` script args. The bridge appends its own
 * flags (--ipc-path etc.); `-e` scripts ignore extra argv, which is exactly
 * what we want.
 */
const fakeDaemonArgs = (script: string) => ["-e", script];

// The bridge builds args itself, so smuggle the script through argv by
// overriding buildArgs — reaching into a private member deliberately: the
// public contract under test is start(), not arg assembly.
const withFakeDaemon = (bridge: OrchestratorBridge, script: string) => {
  (bridge as unknown as { buildArgs: () => string[] }).buildArgs = () => fakeDaemonArgs(script);
  return bridge;
};

beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-orch-"));
  tmpDirs.push(dir);
  ipcPath = path.join(dir, "orch.sock");
  process.env.BITTERBOT_ORCHESTRATOR_IPC_PATH = ipcPath;
});

afterEach(async () => {
  delete process.env.BITTERBOT_ORCHESTRATOR_IPC_PATH;
  while (tmpDirs.length) {
    const dir = tmpDirs.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe.runIf(process.platform !== "win32")("orchestrator bridge boot resilience", () => {
  it("removes a stale socket file and connects to the daemon that then binds", async () => {
    // The reboot scenario: a socket file exists but nothing listens on it.
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(ipcPath, resolve));
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.writeFileSync(ipcPath, ""); // net cleans up on close(); recreate the stale file
    expect(fs.existsSync(ipcPath)).toBe(true);

    // Fake daemon: binds the IPC path after a short delay, then idles.
    const bridge = withFakeDaemon(
      new OrchestratorBridge(cfg()),
      `
      const net = require("node:net");
      setTimeout(() => {
        const srv = net.createServer((sock) => sock.on("data", () => {}));
        srv.listen(${JSON.stringify(ipcPath)});
        setInterval(() => {}, 1000);
      }, 300);
      `,
    );
    try {
      await bridge.start();
      expect(bridge.getHealth().ipcConnected).toBe(true);
      expect(bridge.getHealth().everConnected).toBe(true);
    } finally {
      await bridge.stop();
    }
  }, 30_000);

  it("leaves a LIVE socket alone and connects to it", async () => {
    // Another orchestrator already owns the socket: never unlink it.
    const server = net.createServer((sock) => sock.on("data", () => {}));
    await new Promise<void>((resolve) => server.listen(ipcPath, resolve));

    const bridge = withFakeDaemon(
      new OrchestratorBridge(cfg()),
      // Fake daemon that would fail to bind (address in use) and just idles.
      `setInterval(() => {}, 1000);`,
    );
    try {
      await bridge.start();
      expect(fs.existsSync(ipcPath)).toBe(true);
      expect(bridge.getHealth().ipcConnected).toBe(true);
    } finally {
      await bridge.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 30_000);

  it("boots on WITHOUT killing anything when IPC never comes up", async () => {
    // The crash class under regression: the daemon runs but never binds. The
    // gateway must degrade to isolated mode, not throw (and certainly not die).
    const bridge = withFakeDaemon(new OrchestratorBridge(cfg()), `setInterval(() => {}, 1000);`);
    // Shrink the budget so the test is fast.
    const internals = bridge as unknown as { start: () => Promise<void> };
    const budget = 2_500;
    // Patch the module constant path: not exported, so emulate by racing start
    // against the clock — start() must resolve (not reject) even though no
    // socket ever appears, within budget + slack.
    const started = Date.now();
    try {
      await Promise.race([
        internals.start.call(bridge),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("start() hung past the connect budget")), 25_000),
        ),
      ]);
      expect(bridge.getHealth().ipcConnected).toBe(false);
      expect(bridge.getHealth().processRunning).toBe(true);
      expect(bridge.getHealth().lastError).toMatch(/IPC not reachable/);
      expect(Date.now() - started).toBeGreaterThan(budget); // it did retry, not bail instantly
    } finally {
      await bridge.stop();
    }
  }, 40_000);

  it("still fails loudly when the daemon dies before binding", async () => {
    // A binary that exits immediately is a config/binary problem, not a slow
    // boot: start() must reject so doctor and the isolated-node log fire.
    const bridge = withFakeDaemon(new OrchestratorBridge(cfg()), `process.exit(3);`);
    await expect(bridge.start()).rejects.toThrow();
    await bridge.stop();
  }, 30_000);
});
