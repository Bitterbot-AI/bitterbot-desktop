import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import type { WslSupervisorRecord } from "../../daemon/wsl-supervisor-record.js";
import {
  resolveSupervisedCommand,
  runGatewaySupervisor,
  type SupervisedChild,
  type SuperviseDeps,
} from "./supervise.js";

type ExitStep = {
  kind: "exit";
  uptimeMs: number;
  code: number | null;
  signal?: NodeJS.Signals | null;
};
type SignalStep = { kind: "signal"; uptimeMs: number };
type Step = ExitStep | SignalStep;

type Probe = { lockHeld: boolean; portOpen: boolean; pid: number | null };
const FREE: Probe = { lockHeld: false, portOpen: false, pid: null };
const held = (pid: number): Probe => ({ lockHeld: true, portOpen: true, pid });

class FakeChild extends EventEmitter implements SupervisedChild {
  kills: NodeJS.Signals[] = [];
  stdout = null;
  stderr = null;
  constructor(
    public pid: number,
    private readonly onKill: (child: FakeChild) => void,
  ) {
    super();
  }
  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.kills.push(signal);
    this.onKill(this);
    return true;
  }
}

const record: WslSupervisorRecord = {
  version: 1,
  createdAt: "2026-10-29T00:00:00.000Z",
  programArguments: ["/launcher", "gateway", "--port", "19001"],
  environment: { HOME: "/home/u" },
};

function createHarness(params: {
  steps: Step[];
  probes?: Probe[];
  lockHeld?: boolean;
  record?: WslSupervisorRecord | null;
}) {
  let clock = 1_000_000;
  const steps = [...params.steps];
  const probes = [...(params.probes ?? [])];
  const children: FakeChild[] = [];
  const sleeps: number[] = [];
  const exitLines: string[] = [];
  const logLines: string[] = [];
  const kills: Array<[number, NodeJS.Signals]> = [];
  let signalHandler: ((signal: NodeJS.Signals) => void) | null = null;
  let nextPid = 101;
  let released = 0;

  const deps: SuperviseDeps = {
    env: {},
    spawn: () => {
      const child = new FakeChild(nextPid++, (self) => {
        // A SIGTERM from the supervisor: the gateway stops cleanly, exit 0.
        setImmediate(() => {
          clock += 1_000;
          self.emit("exit", 0, null);
        });
      });
      children.push(child);
      const step = steps.shift();
      if (!step) {
        throw new Error("spawn beyond the scripted steps");
      }
      setImmediate(() => {
        clock += step.uptimeMs;
        if (step.kind === "exit") {
          child.emit("exit", step.code, step.signal ?? null);
        } else {
          signalHandler?.("SIGTERM");
        }
      });
      return child;
    },
    readRecord: async () => (params.record === undefined ? record : params.record),
    acquireLock: async () =>
      params.lockHeld
        ? { held: true, pid: 999 }
        : {
            lockPath: "/lock",
            release: async () => {
              released += 1;
            },
          },
    probeGateway: async () => probes.shift() ?? FREE,
    removeStaleOrchestratorSocket: async () => false,
    appendExitLine: async (line) => {
      exitLines.push(line);
    },
    logger: { write: () => undefined, line: (text) => logLines.push(text), close: () => undefined },
    onSignal: (handler) => {
      signalHandler = handler;
      return () => {
        signalHandler = null;
      };
    },
    kill: (pid, signal) => {
      kills.push([pid, signal]);
    },
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    pollMs: 5_000,
    resolveCommand: () => ({ command: "/launcher", args: ["gateway", "--port", "19001"], env: {} }),
  };
  return {
    deps,
    children,
    sleeps,
    exitLines,
    logLines,
    kills,
    signal: (signal: NodeJS.Signals) => signalHandler?.(signal),
    releasedCount: () => released,
  };
}

describe("runGatewaySupervisor", () => {
  it("relaunches crashes with a doubling backoff and stops on SIGTERM without relaunching", async () => {
    const h = createHarness({
      steps: [
        { kind: "exit", uptimeMs: 30_000, code: 1 },
        { kind: "exit", uptimeMs: 2_000, code: null, signal: "SIGKILL" },
        { kind: "signal", uptimeMs: 60_000 },
      ],
    });
    const code = await runGatewaySupervisor(h.deps);
    expect(code).toBe(0);
    expect(h.children).toHaveLength(3);
    expect(h.sleeps).toEqual([5_000, 10_000]);
    expect(h.children[2].kills).toEqual(["SIGTERM"]);
    expect(h.exitLines).toHaveLength(3);
    expect(h.exitLines[0]).toMatch(
      /^\d{4}-\d{2}-\d{2}T[\d:.]+Z pid=101 exit=1 uptime=30s decision=exit 1 after 30s; relaunch in 5s \(failure 1\)$/,
    );
    expect(h.exitLines[1]).toContain(
      "pid=102 signal=SIGKILL uptime=2s decision=signal SIGKILL after 2s; relaunch in 10s (failure 2)",
    );
    expect(h.exitLines[2]).toContain(
      "pid=103 exit=0 uptime=61s decision=supervisor stopping; gateway exit 0",
    );
    expect(h.releasedCount()).toBe(1);
  });

  it("treats exit 0 with a child holding the lock as a SIGUSR1 restart handoff and adopts it", async () => {
    const h = createHarness({
      steps: [
        { kind: "exit", uptimeMs: 3_600_000, code: 0 },
        { kind: "signal", uptimeMs: 10_000 },
      ],
      // start: free -> spawn; after grace: the respawned child holds the lock;
      // adoption polls: held, held, then free -> take over and spawn again.
      probes: [FREE, held(555), held(555), held(555), FREE],
    });
    await runGatewaySupervisor(h.deps);
    expect(h.children).toHaveLength(2);
    expect(h.sleeps).toEqual([20_000, 5_000, 5_000]);
    expect(h.exitLines[0]).toContain(
      "pid=101 exit=0 uptime=3600s decision=exit 0 after 3600s; checking for a restart handoff",
    );
    expect(
      h.logLines.some((l) => l.includes("restart handoff: a new gateway holds the lock")),
    ).toBe(true);
    expect(
      h.logLines.some((l) => l.includes("waiting on an externally started gateway (pid 555")),
    ).toBe(true);
    expect(h.logLines.some((l) => l.includes("taking over"))).toBe(true);
  });

  it("relaunches once after an exit 0 that left nothing running, then stops if it happens again", async () => {
    const h = createHarness({
      steps: [
        { kind: "exit", uptimeMs: 60_000, code: 0 },
        { kind: "exit", uptimeMs: 5_000, code: 0 },
      ],
    });
    const code = await runGatewaySupervisor(h.deps);
    expect(code).toBe(0);
    expect(h.children).toHaveLength(2);
    expect(h.sleeps).toEqual([20_000, 0, 20_000]);
    expect(h.logLines.some((l) => l.includes("relaunching once"))).toBe(true);
    expect(h.logLines.some((l) => l.includes("not relaunching"))).toBe(true);
  });

  it("does not spawn while an externally started gateway runs; takes over when it exits", async () => {
    const h = createHarness({
      steps: [{ kind: "signal", uptimeMs: 1_000 }],
      probes: [held(13753), held(13753), FREE],
    });
    await runGatewaySupervisor(h.deps);
    expect(h.sleeps.slice(0, 2)).toEqual([5_000, 5_000]);
    expect(h.children).toHaveLength(1);
    const waiting = h.logLines.find((l) =>
      l.startsWith("waiting on an externally started gateway"),
    );
    expect(waiting).toContain("pid 13753");
    expect(
      h.logLines.filter((l) => l.startsWith("waiting on an externally started gateway")),
    ).toHaveLength(1);
  });

  it("SIGTERM during an adoption wait forwards the stop to the adopted gateway", async () => {
    const h = createHarness({ steps: [], probes: [held(13753)] });
    // Signal as soon as the first wait starts.
    const original = h.deps.sleep;
    h.deps.sleep = async (ms, cancel) => {
      h.signal("SIGTERM");
      await original(ms, cancel);
    };
    const code = await runGatewaySupervisor(h.deps);
    expect(code).toBe(0);
    expect(h.children).toHaveLength(0);
    expect(h.kills).toEqual([[13753, "SIGTERM"]]);
  });

  it("exits at once when another supervisor holds the lock", async () => {
    const h = createHarness({ steps: [], lockHeld: true });
    expect(await runGatewaySupervisor(h.deps)).toBe(0);
    expect(h.children).toHaveLength(0);
    expect(h.logLines[0]).toContain("another supervisor is already running (pid 999)");
  });

  it("exits with 1 when nothing was recorded to run", async () => {
    const h = createHarness({ steps: [], record: null });
    expect(await runGatewaySupervisor(h.deps)).toBe(1);
    expect(h.logLines.some((l) => l.includes("bitterbot gateway install"))).toBe(true);
  });
});

describe("resolveSupervisedCommand", () => {
  const base = { execPath: "/usr/bin/node", argv1: "/opt/bb/dist/entry.js" };

  it("runs the recorded launcher with the recorded gateway arguments and environment", () => {
    const cmd = resolveSupervisedCommand(record, {
      ...base,
      env: {
        PATH: "/usr/bin",
        BITTERBOT_INSTALL_ROOT: "/home/u/.bitterbot/app/1.11.0",
        BITTERBOT_NODE_OPTIONS_READY: "1",
      },
      existsSync: (p) => p === "/launcher",
    });
    expect(cmd.command).toBe("/launcher");
    expect(cmd.args).toEqual(["gateway", "--port", "19001"]);
    expect(cmd.env.HOME).toBe("/home/u");
    expect(cmd.cwd).toBe("/home/u");
    // Not a `bin/bitterbot` launcher: install markers are kept.
    expect(cmd.env.BITTERBOT_INSTALL_ROOT).toBe("/home/u/.bitterbot/app/1.11.0");
  });

  it("falls back to the current release launcher from BITTERBOT_INSTALL_ROOT and drops the install markers", () => {
    const cmd = resolveSupervisedCommand(
      { ...record, programArguments: ["/gone/bitterbot", "gateway", "--port", "19001"] },
      {
        ...base,
        env: {
          BITTERBOT_INSTALL_ROOT: "/home/u/.bitterbot/app/1.11.0",
          BITTERBOT_NODE_OPTIONS_READY: "1",
        },
        existsSync: (p) => p === "/home/u/.bitterbot/app/current/bin/bitterbot",
      },
    );
    expect(cmd.command).toBe("/home/u/.bitterbot/app/current/bin/bitterbot");
    expect(cmd.args).toEqual(["gateway", "--port", "19001"]);
    expect(cmd.env.BITTERBOT_INSTALL_ROOT).toBeUndefined();
    expect(cmd.env.BITTERBOT_NODE_OPTIONS_READY).toBeUndefined();
  });

  it("falls back to this process's node and entry when nothing else exists", () => {
    const cmd = resolveSupervisedCommand(
      { ...record, programArguments: ["/gone/bitterbot", "gateway"] },
      { ...base, env: {}, existsSync: () => false },
    );
    expect(cmd.command).toBe("/usr/bin/node");
    expect(cmd.args).toEqual(["/opt/bb/dist/entry.js", "gateway"]);
  });
});
