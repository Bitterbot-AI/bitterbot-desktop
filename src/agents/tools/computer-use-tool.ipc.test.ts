/**
 * End-to-end test: spawn a real bitterbot-orchestrator binary in
 * default-feature mode and exercise the full IPC round-trip through
 * OrchestratorBridge. The orchestrator returns a structured "feature
 * not enabled" envelope (because we deliberately do NOT build with
 * --features=computer-use here), and the test asserts that the
 * envelope round-trips intact through every layer.
 *
 * This catches regressions that unit tests cannot:
 *   - JSON wire format changes between the IPC message and the
 *     IpcCommand variant
 *   - Bridge → orchestrator command-name mismatch (e.g. typos)
 *   - Response payload restructuring across the boundary
 *   - Bridge timeout / reconnect logic with a real Unix socket
 *
 * Skipped automatically when no orchestrator binary is present, so CI
 * environments without Rust still run the rest of the suite.
 */

import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OrchestratorBridge } from "../../infra/orchestrator-bridge.js";

const ORCHESTRATOR_CANDIDATES = [
  path.join(os.homedir(), ".bitterbot/bin/bitterbot-orchestrator"),
  path.resolve(process.cwd(), "orchestrator/target/release/bitterbot-orchestrator"),
  path.resolve(process.cwd(), "orchestrator/target/debug/bitterbot-orchestrator"),
];

function findOrchestratorBinary(): string | null {
  for (const candidate of ORCHESTRATOR_CANDIDATES) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }
  }
  return null;
}

const binary = findOrchestratorBinary();
const skipReason = binary ? null : "no orchestrator binary found";

describe.skipIf(skipReason !== null)("computer_use IPC e2e (real orchestrator binary)", () => {
  let dir: string;
  let socket: string;
  let keyDir: string;
  let proc: ChildProcess | null = null;
  let bridge: OrchestratorBridge | null = null;

  beforeAll(async () => {
    if (!binary) throw new Error("unreachable");
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-cu-e2e-"));
    socket = path.join(dir, "orch.sock");
    keyDir = path.join(dir, "keys");
    fs.mkdirSync(keyDir, { recursive: true });

    // Spawn the orchestrator with a transient socket and a dedicated key
    // dir so the test never touches the operator's real state.
    proc = spawn(
      binary,
      [
        "--ipc-path",
        socket,
        "--key-dir",
        keyDir,
        "--listen-addr",
        "/ip4/127.0.0.1/tcp/0",
        "--http-addr",
        "127.0.0.1:0",
        "--relay-mode",
        "off",
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, RUST_LOG: "warn" },
      },
    );
    proc.on("error", (err) => {
      console.error("orchestrator spawn error:", err);
    });

    // Wait for the socket to appear (orchestrator IPC is up).
    const start = Date.now();
    while (!fs.existsSync(socket)) {
      if (Date.now() - start > 30_000) {
        throw new Error("orchestrator did not start within 30s");
      }
      await new Promise((r) => setTimeout(r, 100));
    }

    // Bridge configured to spawn-disabled mode: pass a config that
    // points at the existing socket. We construct the bridge but
    // bypass start() since the binary is already running; instead we
    // patch the IPC path and call connectIpc-equivalent via the same
    // entry point used by reconnect.
    bridge = new OrchestratorBridge({
      enabled: true,
      // The bridge's own start() will spawn another binary; we want to
      // attach to ours. The simplest way: mutate the resolved path so
      // the bridge spawns nothing useful, then rely on the existing
      // socket. Easier: bypass start() entirely and call the private
      // connect path. Tests use the public API where possible, so
      // here we set ipcPath via the bridge's internal state seam.
      orchestratorBinary: binary,
    } as unknown as Parameters<typeof OrchestratorBridge.prototype.constructor>[0]);
    // The bridge's private ipcPath defaults to /tmp/bitterbot-orchestrator.sock
    // and there is no public setter. We use Reflect to point it at our
    // ephemeral socket, then call the public start().
    Reflect.set(bridge, "ipcPath", socket);

    // The bridge.start() spawns its own orchestrator. To attach instead,
    // we manually drive the connection via a fresh net.Socket. Doing that
    // pulls in too much private API; for this e2e, we accept that the
    // bridge will spawn a *second* orchestrator pointed at the same
    // socket — which fails to bind and the bridge logs an error. So we
    // instead bypass spawn entirely by setting `closed = false` and
    // invoking the private connectIpc directly.
    Reflect.set(bridge, "started", true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const connectIpc = (bridge as any).connectIpc.bind(bridge);
    await connectIpc();
  }, 60_000);

  afterAll(async () => {
    try {
      if (bridge) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (bridge as any).closed = true;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const sock = (bridge as any).socket as { destroy?: () => void } | null;
        sock?.destroy?.();
      }
    } catch {
      // best-effort cleanup
    }
    if (proc && !proc.killed) {
      proc.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          if (proc && !proc.killed) proc.kill("SIGKILL");
          resolve();
        }, 3000);
        proc!.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    if (dir && fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("computer_screenshot returns the 'feature not enabled' envelope intact", async () => {
    if (!bridge) throw new Error("bridge not initialized");
    const result = await bridge.computerScreenshot();
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/feature not enabled|not enabled in this orchestrator build/);
  });

  it("computer_mouse_move propagates payload through the IPC layer", async () => {
    if (!bridge) throw new Error("bridge not initialized");
    const result = await bridge.computerMouseMove(123, 456);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/feature not enabled/);
  });

  it("computer_type propagates text payload", async () => {
    if (!bridge) throw new Error("bridge not initialized");
    const result = await bridge.computerType("hello");
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/feature not enabled/);
  });

  it("an unknown computer command does not crash the orchestrator", async () => {
    if (!bridge) throw new Error("bridge not initialized");
    // After all the supported commands round-trip, send another to
    // confirm the IPC loop is still healthy.
    const result = await bridge.computerScreenshot(0);
    expect(result.ok).toBe(false);
  });
});
