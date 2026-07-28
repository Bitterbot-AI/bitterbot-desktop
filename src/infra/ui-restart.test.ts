import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isUiProcessCommand,
  parsePidFromLsof,
  parsePidFromNetstat,
  parsePidFromSs,
  runUiRestart,
  type UiRestartDeps,
} from "./ui-restart.js";

// The post-update Control-UI restarter. Under test: the identity matcher
// (kill only OUR vite, never a stranger on the same port), the per-platform
// listener-pid parsers, and the full sequence with injected deps — including
// the supervisor handshake (start:all respawns its UI child; we only respawn
// when nobody does) and every refusal path.

const ROOT = "/repo/bitterbot-desktop";

let stateDir: string;
beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-ui-restart-"));
  process.env.BITTERBOT_STATE_DIR = stateDir;
});
afterEach(() => {
  delete process.env.BITTERBOT_STATE_DIR;
  fs.rmSync(stateDir, { recursive: true, force: true });
});

describe("isUiProcessCommand", () => {
  it("matches our vite and only our vite", () => {
    expect(
      isUiProcessCommand(`node ${ROOT}/desktop/node_modules/.bin/../vite/bin/vite.js`, ROOT),
    ).toBe(true);
    // Windows shape: backslashes normalize before comparing.
    expect(
      isUiProcessCommand(
        String.raw`node C:\repo\bitterbot-desktop\desktop\node_modules\vite\bin\vite.js`,
        String.raw`C:\repo\bitterbot-desktop`,
      ),
    ).toBe(true);
    // Someone else's vite on the same port: hands off.
    expect(isUiProcessCommand("node /home/x/other-app/node_modules/vite/bin/vite.js", ROOT)).toBe(
      false,
    );
    // Our repo but not the dev server (an editor on vite.config.ts, the
    // gateway itself): hands off.
    expect(isUiProcessCommand(`vim ${ROOT}/desktop/vite.config.ts`, ROOT)).toBe(false);
    expect(isUiProcessCommand(`node ${ROOT}/dist/entry.js`, ROOT)).toBe(false);
    // The bare `sh -c vite` wrapper shape still matches... when it names us.
    expect(isUiProcessCommand("sh -c vite", ROOT)).toBe(false);
    expect(isUiProcessCommand(`node ${ROOT}/desktop/node_modules/.bin/vite`, ROOT)).toBe(true);
    expect(isUiProcessCommand("", ROOT)).toBe(false);
  });
});

describe("listener pid parsers", () => {
  it("parses ss -ltnp output", () => {
    const out = `State  Recv-Q Send-Q Local Address:Port Peer Address:Port Process
LISTEN 0      511          *:5173            *:*    users:(("node",pid=19748,fd=23))`;
    expect(parsePidFromSs(out, 5173)).toBe(19748);
    expect(parsePidFromSs(out, 9999)).toBeNull();
  });

  it("parses lsof -ti output", () => {
    expect(parsePidFromLsof("19748\n")).toBe(19748);
    expect(parsePidFromLsof("")).toBeNull();
  });

  it("parses netstat -ano output, local column only", () => {
    const out = [
      "  TCP    0.0.0.0:19001      0.0.0.0:0      LISTENING       111",
      "  TCP    0.0.0.0:5173       0.0.0.0:0      LISTENING       22222",
      // :5173 in the FOREIGN column must not match.
      "  TCP    10.0.0.5:60000     10.0.0.9:5173  ESTABLISHED     333",
    ].join("\r\n");
    expect(parsePidFromNetstat(out, 5173)).toBe(22222);
    expect(parsePidFromNetstat(out, 8080)).toBeNull();
  });
});

describe("runUiRestart", () => {
  const VITE_CMD = `node ${ROOT}/desktop/node_modules/vite/bin/vite.js`;

  function makeDeps(overrides: { probes: boolean[]; command?: string; lsofPid?: string }): {
    deps: UiRestartDeps;
    kills: Array<{ pid: number; force: boolean }>;
    spawns: Array<{ cmd: string; args: string[]; cwd?: string }>;
  } {
    const probes = [...overrides.probes];
    const kills: Array<{ pid: number; force: boolean }> = [];
    const spawns: Array<{ cmd: string; args: string[]; cwd?: string }> = [];
    const deps: UiRestartDeps = {
      platform: "darwin", // lsof + ps path, no /proc reads
      settleMs: 0,
      termWaitMs: 0,
      supervisorWaitMs: 0,
      respawnConfirmMs: 0,
      sleep: async () => {},
      probe: async () => (probes.length > 1 ? (probes.shift() as boolean) : (probes[0] ?? false)),
      killImpl: async (pid, force) => {
        kills.push({ pid, force });
      },
      runCommand: async (argv) => {
        if (argv[0] === "lsof") {
          return { stdout: overrides.lsofPid ?? "4242\n", stderr: "", code: 0 };
        }
        if (argv[0] === "ps") {
          return { stdout: overrides.command ?? VITE_CMD, stderr: "", code: 0 };
        }
        return { stdout: "", stderr: "unexpected command", code: 1 };
      },
      spawnImpl: ((cmd: string, args: string[], opts: { cwd?: string }) => {
        spawns.push({ cmd, args, cwd: opts?.cwd });
        return { on: vi.fn(), unref: vi.fn() };
      }) as unknown as UiRestartDeps["spawnImpl"],
    };
    return { deps, kills, spawns };
  }

  it("does nothing when no UI is listening (restart only what was running)", async () => {
    const { deps, kills, spawns } = makeDeps({ probes: [false] });
    const res = await runUiRestart({ root: ROOT, reason: "test", deps });
    expect(res.action).toBe("ui-not-running");
    expect(kills).toHaveLength(0);
    expect(spawns).toHaveLength(0);
  });

  it("refuses to kill a listener that is not our vite", async () => {
    const { deps, kills } = makeDeps({
      probes: [true],
      command: "node /home/x/unrelated/server.js",
    });
    const res = await runUiRestart({ root: ROOT, reason: "test", deps });
    expect(res.action).toBe("identity-mismatch");
    expect(kills).toHaveLength(0);
  });

  it("kills our stale vite and stands down when the supervisor brings it back", async () => {
    // probe: running → freed after TERM → supervisor respawned it.
    const { deps, kills, spawns } = makeDeps({ probes: [true, false, true] });
    const res = await runUiRestart({ root: ROOT, reason: "test", deps });
    expect(res.action).toBe("restarted-by-supervisor");
    expect(kills).toEqual([{ pid: 4242, force: false }]);
    expect(spawns).toHaveLength(0); // never race a second dev server
  });

  it("respawns pnpm dev itself when nobody brings the UI back", async () => {
    // probe: running → freed → supervisor never returns → our respawn opens it.
    const { deps, kills, spawns } = makeDeps({ probes: [true, false, false, true] });
    const res = await runUiRestart({ root: ROOT, reason: "test", deps });
    expect(res.action).toBe("respawned");
    expect(kills).toEqual([{ pid: 4242, force: false }]);
    expect(spawns).toHaveLength(1);
    expect(spawns[0]).toMatchObject({ cmd: "pnpm", args: ["dev"] });
    expect(spawns[0]!.cwd).toBe(path.join(ROOT, "desktop"));
  });

  it("escalates to SIGKILL when TERM does not free the port, then gives up legibly", async () => {
    // probe: running → still up after TERM → still up after KILL.
    const { deps, kills } = makeDeps({ probes: [true, true, true] });
    const res = await runUiRestart({ root: ROOT, reason: "test", deps });
    expect(res.action).toBe("kill-failed");
    expect(kills).toEqual([
      { pid: 4242, force: false },
      { pid: 4242, force: true },
    ]);
  });

  it("leaves an unidentifiable listener alone when no pid is found", async () => {
    const { deps, kills } = makeDeps({ probes: [true], lsofPid: "" });
    const res = await runUiRestart({ root: ROOT, reason: "test", deps });
    expect(res.action).toBe("pid-not-found");
    expect(kills).toHaveLength(0);
  });
});
