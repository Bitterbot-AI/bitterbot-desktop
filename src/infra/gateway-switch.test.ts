import { describe, expect, it, vi } from "vitest";
import {
  buildRestorePlan,
  decideGatewaySwitch,
  definitionFollowsCurrent,
  definitionPort,
  executeGatewaySwitch,
  formatElapsed,
  isBitterbotGatewayCommand,
  restartCommandFor,
  targetMismatch,
  type GatewaySwitchDeps,
  type GatewaySwitchFindings,
  type GatewayTarget,
  type InstallRef,
  type ListenerFindings,
  type RawServiceDefinition,
  type ServiceDefinition,
  type ServiceFindings,
} from "./gateway-switch.js";

const SELF: InstallRef = {
  root: "/home/u/.bitterbot/app/1.5.0",
  kind: "tarball",
  version: "1.5.0",
};
const CLONE: InstallRef = { root: "/home/u/bitterbot-desktop", kind: "git", version: "1.4.0" };
const OLD_TARBALL: InstallRef = {
  root: "/home/u/.bitterbot/app/1.4.0",
  kind: "tarball",
  version: "1.4.0",
};

const CLONE_DEF: ServiceDefinition = {
  programArguments: [
    "/usr/bin/node",
    "/home/u/bitterbot-desktop/dist/index.js",
    "gateway",
    "--port",
    "19001",
  ],
  environment: { BITTERBOT_GATEWAY_TOKEN: "tok" },
  sourcePath: "/home/u/.config/systemd/user/bitterbot-gateway.service",
};
const CLONE_RAW: RawServiceDefinition = {
  path: "/home/u/.config/systemd/user/bitterbot-gateway.service",
  content: "[Service]\nUser=u\nEnvironmentFile=/home/u/secrets.env\nExecStart=/usr/bin/node ...\n",
};
const NEW_LAUNCHER = "/home/u/.bitterbot/app/current/bin/bitterbot";
const NEW_DEF: ServiceDefinition = {
  programArguments: [NEW_LAUNCHER, "gateway", "--port", "19001"],
};

function listener(over: Partial<ListenerFindings> = {}): ListenerFindings {
  return {
    pid: 4242,
    command: "bitterbot-gateway",
    isGateway: true,
    runsFrom: CLONE,
    reportedVersion: null,
    isSelf: false,
    underService: false,
    exePath: "/usr/bin/node",
    childPids: [],
    ...over,
  };
}

function service(over: Partial<ServiceFindings> = {}): ServiceFindings {
  return {
    label: "systemd user service",
    definition: CLONE_DEF,
    raw: CLONE_RAW,
    environmentFiles: ["/home/u/secrets.env"],
    runsFrom: CLONE,
    followsCurrent: false,
    pointsHere: false,
    running: true,
    pid: 4000,
    ...over,
  };
}

function findings(over: Partial<GatewaySwitchFindings> = {}): GatewaySwitchFindings {
  return {
    port: 19001,
    self: SELF,
    service: null,
    listener: null,
    remoteMode: false,
    serviceManager: false,
    ...over,
  };
}

type NewBehavior = "healthy" | "exits" | "slow" | "never";

/**
 * A fake machine with a clock: processes, one port, a service manager. The
 * old gateway (pid 4242) holds the port; a new gateway is pid 9000, a
 * restored old one pid 7000. Nothing real is touched.
 */
function fakeMachine(
  opts: {
    oldForeground?: boolean;
    oldUnderService?: boolean;
    /** The old gateway takes this long to exit after SIGTERM (ms). */
    oldExitMs?: number;
    /** The old gateway never exits. */
    oldSticks?: boolean;
    newBehavior?: NewBehavior;
    /** "slow": answers after this long (ms). */
    slowMs?: number;
    installFails?: boolean;
    oldChildren?: number[];
    childrenLinger?: boolean;
    newChildren?: number[];
    /** Readable start time of the old pid now (pid reuse). */
    startTimeNow?: string;
  } = {},
) {
  let clock = 0;
  const alive = new Set<number>();
  const deathAt = new Map<number, number>();
  let holder: number | null = null;
  let newServeAt: number | null = null;
  const children = new Map<number, number[]>();
  const state = {
    signals: [] as Array<[number, NodeJS.Signals]>,
    installs: [] as ServiceDefinition[],
    rawRestores: [] as Array<{ raw: RawServiceDefinition; start: boolean }>,
    uninstalls: 0,
    detached: [] as Array<{ argv: string[]; cwd?: string; env?: NodeJS.ProcessEnv }>,
    currentLink: null as string | null,
    snapshots: 0,
    restoredSnapshots: 0,
    holder: () => holder,
  };
  const kill = (pid: number) => {
    alive.delete(pid);
    if (holder === pid) {
      holder = null;
    }
    if (!opts.childrenLinger) {
      for (const c of children.get(pid) ?? []) {
        alive.delete(c);
      }
    }
  };
  const tick = () => {
    for (const [pid, at] of deathAt) {
      if (clock >= at) {
        deathAt.delete(pid);
        kill(pid);
      }
    }
    if (holder === null && alive.has(9000) && newServeAt !== null && clock >= newServeAt) {
      holder = 9000;
    }
  };
  if (opts.oldForeground || opts.oldUnderService) {
    alive.add(4242);
    holder = 4242;
    children.set(4242, opts.oldChildren ?? []);
    for (const c of opts.oldChildren ?? []) {
      alive.add(c);
    }
  }
  const stopOld = () => {
    if (opts.oldSticks || !alive.has(4242)) {
      return;
    }
    if (opts.oldExitMs) {
      if (!deathAt.has(4242)) {
        deathAt.set(4242, clock + opts.oldExitMs);
      }
    } else {
      kill(4242);
    }
  };
  const startNew = () => {
    alive.add(9000);
    children.set(9000, opts.newChildren ?? []);
    for (const c of opts.newChildren ?? []) {
      alive.add(c);
    }
    const behavior = opts.newBehavior ?? "healthy";
    if (behavior === "exits") {
      deathAt.set(9000, clock + 1_000);
      newServeAt = null;
    } else if (behavior === "never") {
      newServeAt = null;
    } else {
      newServeAt = clock + (behavior === "slow" ? (opts.slowMs ?? 400_000) : 1_000);
    }
    tick();
  };
  const startOldAgain = () => {
    alive.add(7000);
    if (holder === null) {
      holder = 7000;
    }
  };
  const deps: GatewaySwitchDeps = {
    stopService: vi.fn(async () => {
      if (opts.oldUnderService) {
        stopOld();
      }
      if (alive.has(9000)) {
        kill(9000);
      }
      if (holder === 7000) {
        kill(7000);
      }
    }),
    installService: vi.fn(async (def: ServiceDefinition) => {
      state.installs.push(def);
      if (opts.installFails && def === NEW_DEF) {
        throw new Error("systemctl enable failed");
      }
      if (def === NEW_DEF) {
        startNew();
      } else {
        startOldAgain();
      }
    }),
    uninstallService: vi.fn(async () => {
      state.uninstalls += 1;
      if (alive.has(9000)) {
        kill(9000);
      }
    }),
    restoreRawDefinition: vi.fn(async (raw: RawServiceDefinition, o: { start: boolean }) => {
      state.rawRestores.push({ raw, start: o.start });
      if (o.start) {
        startOldAgain();
      }
    }),
    serviceRunning: vi.fn(async () => {
      tick();
      return alive.has(9000);
    }),
    buildServiceDefinition: vi.fn(async () => NEW_DEF),
    startDetached: vi.fn((cmd) => {
      state.detached.push(cmd);
      if (cmd.argv[0] === NEW_LAUNCHER) {
        startNew();
        return { pid: 9000, logPath: "/home/u/.bitterbot/logs/gateway-switch.log" };
      }
      startOldAgain();
      return { pid: 7000, logPath: "/home/u/.bitterbot/logs/gateway-switch.log" };
    }),
    readCommandLine: vi.fn(async (pid: number) => {
      if (pid === 4242) {
        return "bitterbot-gateway";
      }
      if ([...(opts.oldChildren ?? []), ...(opts.newChildren ?? [])].includes(pid)) {
        return "/x/bitterbot-orchestrator --ipc-path /tmp/s";
      }
      return null;
    }),
    readStartTime: vi.fn(async (pid: number) =>
      pid === 4242 ? (opts.startTimeNow ?? "1000") : null,
    ),
    listChildren: vi.fn(async (pid: number) => children.get(pid) ?? []),
    isPidAlive: vi.fn((pid: number) => {
      tick();
      return alive.has(pid);
    }),
    signal: vi.fn((pid: number, sig: NodeJS.Signals) => {
      state.signals.push([pid, sig]);
      if (pid === 4242) {
        stopOld();
      } else if (sig === "SIGKILL" || !opts.childrenLinger || pid === 9000 || pid === 7000) {
        kill(pid);
      }
    }),
    isPortListening: vi.fn(async () => {
      tick();
      return holder !== null;
    }),
    probeGateway: vi.fn(async () => {
      tick();
      if (holder === 9000) {
        return { pid: 9000, version: "1.5.0", root: SELF.root, rpc: "ok" as const };
      }
      if (holder === null) {
        return { pid: null, version: null, root: null, rpc: "error" as const };
      }
      return { pid: holder, version: null, root: CLONE.root, rpc: "error" as const };
    }),
    swapCurrentLink: vi.fn((_appDir: string, version: string) => {
      state.currentLink = version;
    }),
    snapshot: vi.fn(async () => {
      state.snapshots += 1;
      return { dir: "/home/u/.bitterbot/snapshots/x" };
    }),
    restoreSnapshot: vi.fn(async () => {
      state.restoredSnapshots += 1;
      return ["/home/u/.bitterbot/memory/main.sqlite"];
    }),
    copyEnv: vi.fn(async (m) => ({ copied: m.keys, backup: `${m.target}.bak` })),
    sleep: vi.fn(async (ms: number) => {
      clock += ms;
      tick();
    }),
    now: () => clock,
  };
  return { deps, state, alive };
}

const FAST = {
  stopMs: 2_000,
  childrenMs: 1_000,
  healthyMs: 60_000,
  maxHealthyMs: 300_000,
  stableMs: 1_000,
  exitedGraceMs: 2_000,
  restoreMs: 10_000,
  progressMs: 30_000,
  pollMs: 100,
};

async function run(
  f: GatewaySwitchFindings,
  m: ReturnType<typeof fakeMachine>,
  extra: { env?: NodeJS.ProcessEnv; timeouts?: Partial<typeof FAST> } = {},
) {
  const progress: string[] = [];
  const outcome = await executeGatewaySwitch({
    findings: f,
    decision: decideGatewaySwitch(f),
    deps: m.deps,
    env: extra.env,
    timeouts: { ...FAST, ...extra.timeouts },
    onProgress: (line) => progress.push(line),
  });
  return { outcome, progress };
}

describe("isBitterbotGatewayCommand", () => {
  it("accepts the gateway process title and gateway command lines", () => {
    expect(isBitterbotGatewayCommand("bitterbot-gateway")).toBe(true);
    expect(isBitterbotGatewayCommand("bitterbot-gateway                ")).toBe(true);
    expect(
      isBitterbotGatewayCommand(
        '"C:\\Program Files\\nodejs\\node.exe" C:\\Users\\u\\bitterbot\\dist\\index.js gateway --port 19001',
      ),
    ).toBe(true);
    expect(
      isBitterbotGatewayCommand("/usr/bin/node /home/u/.bitterbot/app/1.4.0/dist/entry.js gateway"),
    ).toBe(true);
  });

  it("rejects other programs, the orchestrator, and non-gateway Bitterbot commands", () => {
    expect(isBitterbotGatewayCommand("python3 -m http.server 19001")).toBe(false);
    expect(
      isBitterbotGatewayCommand("/x/bitterbot-orchestrator --listen-addr /ip4/0.0.0.0/tcp/9100"),
    ).toBe(false);
    expect(isBitterbotGatewayCommand("bitterbot-onboard")).toBe(false);
    expect(
      isBitterbotGatewayCommand("/usr/bin/node /x/bitterbot/dist/index.js memory status"),
    ).toBe(false);
    expect(isBitterbotGatewayCommand(null)).toBe(false);
  });

  it("accepts a clone in a directory not named bitterbot only when its root resolved", () => {
    const cmd = "/usr/bin/node /home/u/code/bb/dist/index.js gateway --port 19001";
    expect(isBitterbotGatewayCommand(cmd)).toBe(false);
    expect(isBitterbotGatewayCommand(cmd, true)).toBe(true);
  });
});

describe("helpers", () => {
  it("recognises the stable tarball launcher and the port of a definition", () => {
    expect(definitionFollowsCurrent(NEW_DEF)).toBe(true);
    expect(definitionFollowsCurrent(CLONE_DEF)).toBe(false);
    expect(definitionPort(CLONE_DEF)).toBe(19001);
    expect(definitionPort({ programArguments: ["x", "gateway", "--port=19011"] })).toBe(19011);
    expect(
      definitionPort({
        programArguments: ["x", "gateway"],
        environment: { BITTERBOT_GATEWAY_PORT: "19021" },
      }),
    ).toBe(19021);
    expect(definitionPort({ programArguments: ["x", "gateway"] })).toBeNull();
    expect(formatElapsed(130_000)).toBe("2m10s");
  });

  it("names every difference in state dir, config, profile and port", () => {
    const ours: GatewayTarget = {
      stateDir: "/home/u/.bitterbot",
      configPath: "/home/u/.bitterbot/bitterbot.json",
      profile: null,
      port: 19001,
    };
    expect(targetMismatch(ours, { ...ours })).toBeNull();
    const text = targetMismatch(ours, {
      stateDir: "/srv/bb",
      configPath: "/srv/bb/bitterbot.json",
      profile: "work",
      port: 19011,
    });
    expect(text).toContain("state directory /srv/bb");
    expect(text).toContain("profile work");
    expect(text).toContain("port 19011");
  });
});

describe("decideGatewaySwitch", () => {
  it("fresh machine: nothing to do", () => {
    expect(decideGatewaySwitch(findings())).toEqual({ action: "none", reason: "fresh" });
  });

  it("this install already serves the port and owns the service: nothing to do", () => {
    const d = decideGatewaySwitch(
      findings({
        listener: listener({ isSelf: true, runsFrom: SELF, underService: true }),
        service: service({ pointsHere: true, runsFrom: SELF }),
      }),
    );
    expect(d).toEqual({ action: "none", reason: "already-current" });
  });

  it("a remote gateway is not something to switch (not an error)", () => {
    expect(decideGatewaySwitch(findings({ remoteMode: true }))).toEqual({
      action: "none",
      reason: "remote-mode",
    });
  });

  it("never touches a port owner that is not a Bitterbot gateway; refuses containers", () => {
    const d = decideGatewaySwitch(
      findings({ listener: listener({ isGateway: false, command: "python3 -m http.server" }) }),
    );
    expect(d.action === "blocked" && d.reason).toBe("foreign-listener");
    expect(decideGatewaySwitch(findings({ self: { ...SELF, kind: "container" } })).action).toBe(
      "blocked",
    );
  });

  it("git clone service running the old gateway: stop the service, re-point it", () => {
    const d = decideGatewaySwitch(
      findings({ listener: listener({ underService: true }), service: service() }),
    );
    expect(d).toEqual({
      action: "switch",
      from: CLONE,
      stopService: true,
      stopPid: 4242,
      installService: true,
      freshService: false,
      startDetached: false,
    });
  });

  it("foreground gateway, no service, a service manager exists: install a service", () => {
    const d = decideGatewaySwitch(findings({ listener: listener(), serviceManager: true }));
    expect(d).toMatchObject({
      action: "switch",
      stopPid: 4242,
      installService: true,
      freshService: true,
      startDetached: false,
    });
  });

  it("foreground gateway, no service manager (WSL without systemd): background start", () => {
    const d = decideGatewaySwitch(findings({ listener: listener(), serviceManager: false }));
    expect(d).toMatchObject({ installService: false, startDetached: true });
  });

  it("a stopped service pointing elsewhere is left stopped, with a note", () => {
    const d = decideGatewaySwitch(findings({ service: service({ running: false }) }));
    expect(d.action).toBe("none");
    expect(d.action === "none" && d.reason).toBe("service-stopped");
    expect(d.action === "none" && d.note).toContain("bitterbot gateway install --force");
    // Also while this install already runs in the foreground: never "switched" off it.
    const fg = decideGatewaySwitch(
      findings({
        service: service({ running: false }),
        listener: listener({ isSelf: true, runsFrom: SELF }),
      }),
    );
    expect(fg.action).toBe("none");
  });

  it("a running service elsewhere while this install runs in the foreground: stop the foreground one too", () => {
    const d = decideGatewaySwitch(
      findings({
        service: service({ running: true }),
        listener: listener({ isSelf: true, runsFrom: SELF }),
      }),
    );
    expect(d).toMatchObject({ action: "switch", stopService: true, stopPid: 4242 });
  });

  it("tarball service that follows current but still runs the old version: restart through the service", () => {
    const d = decideGatewaySwitch(
      findings({
        listener: listener({ runsFrom: OLD_TARBALL, underService: true }),
        service: service({ pointsHere: true, followsCurrent: true, runsFrom: SELF }),
      }),
    );
    expect(d).toMatchObject({ action: "switch", stopService: true, installService: true });
  });

  it("blocks when the old gateway uses another state dir, profile or port", () => {
    const target: GatewayTarget = {
      stateDir: "/home/u/.bitterbot",
      configPath: "/home/u/.bitterbot/bitterbot.json",
      profile: null,
      port: 19001,
    };
    const d = decideGatewaySwitch(
      findings({
        listener: listener({ underService: true }),
        service: service(),
        target,
        oldTarget: { ...target, stateDir: "/srv/bb", configPath: "/srv/bb/bitterbot.json" },
      }),
    );
    expect(d.action === "blocked" && d.reason).toBe("target-mismatch");
    expect(d.action === "blocked" && d.message).toContain("/srv/bb");
    const port = decideGatewaySwitch(
      findings({ listener: listener(), target, oldTarget: { ...target, port: 19011 } }),
    );
    expect(port.action === "blocked" && port.reason).toBe("target-mismatch");
  });

  it("cannot-restore cases are left alone", () => {
    const fg = decideGatewaySwitch(
      findings({ listener: listener({ runsFrom: null, exePath: null }) }),
    );
    expect(fg.action === "blocked" && fg.reason).toBe("cannot-restore");
    const svc = decideGatewaySwitch(
      findings({
        listener: listener({ underService: true }),
        service: service({ definition: null, raw: null, runsFrom: null, pointsHere: true }),
      }),
    );
    expect(svc.action === "blocked" && svc.reason).toBe("cannot-restore");
    const unknown = decideGatewaySwitch(findings({ listener: listener({ pid: null }) }));
    expect(unknown.action === "blocked" && unknown.reason).toBe("unidentified-listener");
  });
});

describe("restart and restore plans", () => {
  it("restarts an old clone with its node and bitterbot.mjs, an old tarball with its own launcher", () => {
    expect(
      restartCommandFor(
        findings({ listener: listener(), extraGatewayArgs: ["--allow-unconfigured"] }),
      ),
    ).toEqual({
      argv: [
        "/usr/bin/node",
        "/home/u/bitterbot-desktop/bitterbot.mjs",
        "gateway",
        "--port",
        "19001",
        "--allow-unconfigured",
      ],
      cwd: "/home/u/bitterbot-desktop",
    });
    expect(
      restartCommandFor(findings({ listener: listener({ runsFrom: OLD_TARBALL }) }))?.argv,
    ).toEqual(["/home/u/.bitterbot/app/1.4.0/bin/bitterbot", "gateway", "--port", "19001"]);
  });

  it("restores `current` for a tarball-to-tarball switch in the same app dir only; keeps the raw file", () => {
    const tarball = buildRestorePlan(
      findings({ listener: listener({ runsFrom: OLD_TARBALL, exePath: null }) }),
    );
    expect(tarball.currentLink).toEqual({ appDir: "/home/u/.bitterbot/app", version: "1.4.0" });
    expect(buildRestorePlan(findings({ listener: listener() })).currentLink).toBeNull();
    expect(buildRestorePlan(findings({ service: service() })).rawDefinition).toBe(CLONE_RAW);
  });
});

describe("executeGatewaySwitch", () => {
  it("git clone service: snapshot first, stop, re-point, healthy only once 1.5.0 stays up", async () => {
    const f = findings({ listener: listener({ underService: true }), service: service() });
    const m = fakeMachine({ oldUnderService: true });
    const { outcome } = await run(f, m);
    expect(outcome.status).toBe("switched");
    expect(m.state.snapshots).toBe(1);
    expect(m.state.installs).toEqual([NEW_DEF]);
    expect(m.state.holder()).toBe(9000);
    expect(m.state.signals).toEqual([]);
    expect(outcome.steps.map((s) => s.step)).toEqual([
      "snapshot",
      "stop-service",
      "wait-stopped",
      "install-service",
      "wait-healthy",
    ]);
  });

  it("a failed snapshot changes nothing", async () => {
    const f = findings({ listener: listener({ underService: true }), service: service() });
    const m = fakeMachine({ oldUnderService: true });
    vi.mocked(m.deps.snapshot).mockRejectedValue(new Error("not enough free disk space"));
    const { outcome } = await run(f, m);
    expect(outcome.status).toBe("failed");
    expect(outcome.error).toContain("Nothing was changed");
    expect(m.deps.stopService).not.toHaveBeenCalled();
  });

  it("copies the clone's .env keys after the old gateway stopped, before the new one starts", async () => {
    const f = findings({
      listener: listener(),
      envMigration: {
        source: "/home/u/bitterbot-desktop/.env",
        target: "/home/u/.bitterbot/.env",
        keys: ["OPENAI_API_KEY", "CDP_API_KEY_ID"],
        skipped: [],
      },
    });
    const m = fakeMachine({ oldForeground: true });
    const { outcome } = await run(f, m);
    expect(outcome.status).toBe("switched");
    expect(outcome.envCopied).toEqual(["OPENAI_API_KEY", "CDP_API_KEY_ID"]);
    const order = outcome.steps.map((s) => s.step);
    expect(order.indexOf("copy-env")).toBeGreaterThan(order.indexOf("wait-stopped"));
    expect(order.indexOf("copy-env")).toBeLessThan(order.indexOf("start-gateway"));
  });

  it("foreground gateway on a machine with a service manager: a fresh service, uninstalled on rollback", async () => {
    const f = findings({ listener: listener(), serviceManager: true });
    const ok = fakeMachine({ oldForeground: true });
    expect((await run(f, ok)).outcome.status).toBe("switched");
    expect(ok.state.installs).toEqual([NEW_DEF]);
    expect(ok.state.detached).toEqual([]);

    const bad = fakeMachine({ oldForeground: true, newBehavior: "exits" });
    const { outcome } = await run(f, bad);
    expect(outcome.status).toBe("rolled-back");
    expect(bad.state.uninstalls).toBe(1);
    expect(bad.state.detached[0]?.argv[1]).toBe("/home/u/bitterbot-desktop/bitterbot.mjs");
    expect(outcome.rollback).toMatchObject({ ok: true, restored: "process" });
  });

  it("does not signal a pid that was reused by another process (start time changed)", async () => {
    const f = findings({ listener: listener({ startTime: "1000" }) });
    const m = fakeMachine({ oldForeground: true, startTimeNow: "2000" });
    const { outcome } = await run(f, m);
    expect(outcome.status).toBe("failed");
    expect(m.state.signals).toEqual([]);
  });

  it("does not signal a pid that stopped being a gateway", async () => {
    const f = findings({ listener: listener() });
    const m = fakeMachine({ oldForeground: true });
    vi.mocked(m.deps.readCommandLine).mockResolvedValue("vim notes.txt");
    const { outcome } = await run(f, m);
    expect(outcome.status).toBe("failed");
    expect(m.state.signals).toEqual([]);
  });

  it("a lingering orchestrator gets SIGTERM, then SIGKILL; one that survives means rollback", async () => {
    const f = findings({ listener: listener({ childPids: [5000] }) });
    const m = fakeMachine({ oldForeground: true, oldChildren: [5000], childrenLinger: true });
    vi.mocked(m.deps.signal).mockImplementation((pid, sig) => {
      m.state.signals.push([pid, sig]);
      if (pid === 4242 || sig === "SIGKILL") {
        m.alive.delete(pid);
      }
    });
    vi.mocked(m.deps.isPortListening).mockImplementation(async () => m.alive.has(4242));
    const { outcome } = await run(f, m);
    expect(m.state.signals.slice(0, 3)).toEqual([
      [4242, "SIGTERM"],
      [5000, "SIGTERM"],
      [5000, "SIGKILL"],
    ]);
    expect(outcome.steps.find((s) => s.step === "stop-children")?.ok).toBe(true);

    const stuck = fakeMachine({ oldForeground: true, oldChildren: [5000], childrenLinger: true });
    vi.mocked(stuck.deps.signal).mockImplementation((pid, sig) => {
      stuck.state.signals.push([pid, sig]);
      if (pid === 4242) {
        stuck.alive.delete(4242);
      }
    });
    vi.mocked(stuck.deps.isPortListening).mockImplementation(async () => stuck.alive.has(4242));
    const res = await run(f, stuck);
    expect(res.outcome.status).toBe("rolled-back");
    expect(res.outcome.error).toContain("orchestrator did not exit");
  });

  it("new service never answers: restores the old unit file byte for byte, started", async () => {
    const f = findings({ listener: listener({ underService: true }), service: service() });
    const m = fakeMachine({ oldUnderService: true, newBehavior: "never" });
    const { outcome } = await run(f, m, { timeouts: { maxHealthyMs: 120_000 } });
    expect(outcome.status).toBe("rolled-back");
    expect(m.state.rawRestores).toEqual([{ raw: CLONE_RAW, start: true }]);
    expect(m.state.restoredSnapshots).toBe(1);
    expect(outcome.rollback).toMatchObject({ ok: true, restored: "service" });
    expect(outcome.rollback?.dataRestored).toEqual(["/home/u/.bitterbot/memory/main.sqlite"]);
  });

  it("service install fails: puts the old unit back", async () => {
    const f = findings({ listener: listener({ underService: true }), service: service() });
    const m = fakeMachine({ oldUnderService: true, installFails: true });
    const { outcome } = await run(f, m);
    expect(outcome.status).toBe("rolled-back");
    expect(outcome.error).toContain("systemctl enable failed");
    expect(m.state.rawRestores).toHaveLength(1);
    expect(m.state.holder()).toBe(7000);
  });

  it("slow but alive: keeps waiting past the healthy wait with progress lines (non-interactive)", async () => {
    const f = findings({ listener: listener({ underService: true }), service: service() });
    const m = fakeMachine({ oldUnderService: true, newBehavior: "slow", slowMs: 150_000 });
    const { outcome, progress } = await run(f, m);
    expect(outcome.status).toBe("switched");
    expect(progress.some((l) => l.includes("Still starting (") && l.includes("memory"))).toBe(true);
    expect(m.state.rawRestores).toEqual([]);
  });

  it("slow but alive, interactive: asks before giving up; a no rolls back", async () => {
    const f = findings({ listener: listener({ underService: true }), service: service() });
    const yes = fakeMachine({ oldUnderService: true, newBehavior: "slow", slowMs: 90_000 });
    yes.deps.askKeepWaiting = vi.fn(async () => true);
    expect((await run(f, yes)).outcome.status).toBe("switched");
    expect(yes.deps.askKeepWaiting).toHaveBeenCalledTimes(1);

    const no = fakeMachine({ oldUnderService: true, newBehavior: "slow", slowMs: 90_000 });
    no.deps.askKeepWaiting = vi.fn(async () => false);
    expect((await run(f, no)).outcome.status).toBe("rolled-back");
  });

  it("gives up at the cap when it never answers (non-interactive)", async () => {
    const f = findings({ listener: listener({ underService: true }), service: service() });
    const m = fakeMachine({ oldUnderService: true, newBehavior: "never" });
    const { outcome } = await run(f, m, { timeouts: { maxHealthyMs: 200_000 } });
    expect(outcome.status).toBe("rolled-back");
    expect(outcome.error).toContain("did not become healthy within");
  });

  it("new gateway exits at boot: rolls back at once, with `current` back for a tarball switch", async () => {
    const f = findings({
      listener: listener({
        runsFrom: OLD_TARBALL,
        exePath: "/home/u/.bitterbot/app/1.4.0/runtime/node/bin/node",
      }),
      extraGatewayArgs: ["--allow-unconfigured"],
    });
    const m = fakeMachine({ oldForeground: true, newBehavior: "exits" });
    const { outcome } = await run(f, m, {
      env: {
        BITTERBOT_INSTALL_KIND: "tarball",
        BITTERBOT_INSTALL_ROOT: SELF.root ?? "",
        HOME: "/home/u",
      },
    });
    expect(outcome.status).toBe("rolled-back");
    expect(outcome.error).toBe("The new gateway exited during startup.");
    expect(m.state.currentLink).toBe("1.4.0");
    const restart = m.state.detached.at(-1);
    expect(restart?.argv).toEqual([
      "/home/u/.bitterbot/app/1.4.0/bin/bitterbot",
      "gateway",
      "--port",
      "19001",
      "--allow-unconfigured",
    ]);
    expect(restart?.env?.BITTERBOT_INSTALL_ROOT).toBeUndefined();
    expect(outcome.rollback).toMatchObject({ ok: true, restored: "process" });
  });

  it("a service that crash-loops the new gateway counts as exited, not as slow", async () => {
    const f = findings({ listener: listener({ underService: true }), service: service() });
    const m = fakeMachine({ oldUnderService: true, newBehavior: "never" });
    let n = 0;
    vi.mocked(m.deps.serviceRunning).mockImplementation(async () => n++ % 2 === 0);
    const { outcome } = await run(f, m);
    expect(outcome.status).toBe("rolled-back");
    expect(outcome.error).toBe("The new gateway exited during startup.");
  });

  it("rollback waits for the new gateway's children (orchestrator) before restarting the old one", async () => {
    const f = findings({ listener: listener() });
    const m = fakeMachine({ oldForeground: true, newBehavior: "exits", newChildren: [9100] });
    vi.mocked(m.deps.listChildren).mockImplementation(async (pid) => (pid === 9000 ? [9100] : []));
    const { outcome } = await run(f, m);
    expect(outcome.status).toBe("rolled-back");
    expect(m.deps.listChildren).toHaveBeenCalledWith(9000);
    expect(m.alive.has(9100)).toBe(false);
    expect(outcome.rollback?.ok).toBe(true);
  });

  it("an old foreground gateway still shutting down is never counted as restored", async () => {
    const f = findings({ listener: listener() });
    // It takes longer to exit than the switch waits: the switch gives up,
    // and the rollback restarts it only after it exited, counting the new
    // pid (7000), never the dying 4242.
    const m = fakeMachine({ oldForeground: true, oldExitMs: 3_000 });
    const { outcome } = await run(f, m);
    expect(outcome.status).toBe("rolled-back");
    expect(outcome.error).toContain("did not stop");
    expect(m.state.detached.map((d) => d.argv[1])).toEqual([
      "/home/u/bitterbot-desktop/bitterbot.mjs",
    ]);
    expect(m.state.holder()).toBe(7000);
    expect(outcome.rollback?.ok).toBe(true);

    const sticky = fakeMachine({ oldForeground: true, oldSticks: true });
    const res = await run(f, sticky);
    expect(res.outcome.status).toBe("rolled-back");
    expect(sticky.state.detached).toEqual([]);
    expect(res.outcome.rollback?.ok).toBe(false);
    expect(res.outcome.rollback?.manual).toContain("still shutting down");
  });

  it("returns blocked and none decisions without touching anything", async () => {
    const m = fakeMachine({});
    const blocked = findings({ listener: listener({ isGateway: false }) });
    expect((await run(blocked, m)).outcome.status).toBe("blocked");
    expect((await run(findings(), m)).outcome.status).toBe("nothing-to-do");
    expect(m.deps.snapshot).not.toHaveBeenCalled();
    expect(m.deps.stopService).not.toHaveBeenCalled();
    expect(m.deps.signal).not.toHaveBeenCalled();
  });
});
