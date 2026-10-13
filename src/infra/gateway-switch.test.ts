import { describe, expect, it, vi } from "vitest";
import {
  buildRestorePlan,
  decideGatewaySwitch,
  definitionFollowsCurrent,
  definitionPort,
  executeGatewaySwitch,
  isBitterbotGatewayCommand,
  restartCommandFor,
  type GatewaySwitchDeps,
  type GatewaySwitchFindings,
  type InstallRef,
  type ListenerFindings,
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
    ...over,
  };
}

/**
 * A fake machine: one port, a set of live pids, a service that runs either
 * the old or the new definition. Nothing real is touched.
 */
function fakeMachine(opts: {
  oldPid?: number | null;
  service?: boolean;
  newGatewayHealthy?: boolean;
  /** The old gateway ignores SIGTERM / service stop. */
  oldSticks?: boolean;
  installFails?: boolean;
  children?: number[];
  childrenIgnoreGatewayExit?: boolean;
}) {
  const alive = new Set<number>();
  if (opts.oldPid) {
    alive.add(opts.oldPid);
  }
  for (const c of opts.children ?? []) {
    alive.add(c);
  }
  const state: {
    serving: "old" | "new" | null;
    serviceDef: ServiceDefinition | null;
    signals: Array<[number, NodeJS.Signals]>;
    installs: ServiceDefinition[];
    detached: Array<{ argv: string[]; env?: NodeJS.ProcessEnv }>;
    currentLink: string | null;
    stops: number;
  } = {
    serving: opts.oldPid || opts.service ? "old" : null,
    serviceDef: opts.service ? CLONE_DEF : null,
    signals: [],
    installs: [],
    detached: [],
    currentLink: null,
    stops: 0,
  };
  const stopOld = () => {
    if (opts.oldSticks) {
      return;
    }
    if (opts.oldPid) {
      alive.delete(opts.oldPid);
    }
    if (!opts.childrenIgnoreGatewayExit) {
      for (const c of opts.children ?? []) {
        alive.delete(c);
      }
    }
    state.serving = null;
  };
  let clock = 0;
  const NEW_DEF: ServiceDefinition = {
    programArguments: [
      "/home/u/.bitterbot/app/current/bin/bitterbot",
      "gateway",
      "--port",
      "19001",
    ],
  };
  const deps: GatewaySwitchDeps = {
    stopService: vi.fn(async () => {
      state.stops += 1;
      if (state.serving === "old") {
        stopOld();
      } else if (state.serving === "new") {
        state.serving = null;
      }
    }),
    installService: vi.fn(async (def: ServiceDefinition) => {
      state.installs.push(def);
      if (opts.installFails && def === NEW_DEF) {
        throw new Error("systemctl enable failed");
      }
      state.serviceDef = def;
      if (def === NEW_DEF) {
        state.serving = opts.newGatewayHealthy === false ? null : "new";
      } else {
        state.serving = "old";
      }
    }),
    buildServiceDefinition: vi.fn(async () => NEW_DEF),
    startDetached: vi.fn((cmd) => {
      state.detached.push(cmd);
      if (cmd.argv[0] === NEW_DEF.programArguments[0]) {
        state.serving = opts.newGatewayHealthy === false ? null : "new";
        if (opts.newGatewayHealthy !== false) {
          alive.add(9999);
        }
        return { pid: 9999, logPath: "/tmp/x.log" };
      }
      state.serving = "old";
      return { pid: 7777, logPath: "/tmp/y.log" };
    }),
    readCommandLine: vi.fn(async (pid: number) => {
      if (pid === opts.oldPid) {
        return "bitterbot-gateway";
      }
      if ((opts.children ?? []).includes(pid)) {
        return "/home/u/bitterbot-desktop/orchestrator/target/release/bitterbot-orchestrator --ipc-path /tmp/s";
      }
      return null;
    }),
    isPidAlive: vi.fn((pid: number) => alive.has(pid)),
    signal: vi.fn((pid: number, sig: NodeJS.Signals) => {
      state.signals.push([pid, sig]);
      if (pid === opts.oldPid) {
        stopOld();
      } else {
        alive.delete(pid);
        if (pid === 9999 && state.serving === "new") {
          state.serving = null;
        }
      }
    }),
    isPortListening: vi.fn(async () => state.serving !== null),
    probeGateway: vi.fn(async () =>
      state.serving === "new"
        ? { version: "1.5.0", root: SELF.root }
        : state.serving === "old"
          ? { version: null, root: CLONE.root }
          : { version: null, root: null },
    ),
    swapCurrentLink: vi.fn((_appDir: string, version: string) => {
      state.currentLink = version;
    }),
    sleep: vi.fn(async (ms: number) => {
      clock += ms;
    }),
    now: () => clock,
  };
  return { deps, state, NEW_DEF };
}

const FAST = { stopMs: 2_000, childrenMs: 1_000, healthyMs: 4_000, restoreMs: 2_000, pollMs: 100 };

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
    expect(isBitterbotGatewayCommand("nginx: master process")).toBe(false);
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

describe("service definition helpers", () => {
  it("recognises the stable tarball launcher and the --port argument", () => {
    expect(
      definitionFollowsCurrent({
        programArguments: ["/home/u/.bitterbot/app/current/bin/bitterbot", "gateway"],
      }),
    ).toBe(true);
    expect(definitionFollowsCurrent(CLONE_DEF)).toBe(false);
    expect(definitionPort(CLONE_DEF)).toBe(19001);
    expect(definitionPort({ programArguments: ["x", "gateway", "--port=19011"] })).toBe(19011);
    expect(definitionPort({ programArguments: ["x", "gateway"] })).toBeNull();
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

  it("never touches a port owner that is not a Bitterbot gateway", () => {
    const d = decideGatewaySwitch(
      findings({ listener: listener({ isGateway: false, command: "python3 -m http.server" }) }),
    );
    expect(d.action).toBe("blocked");
    expect(d.action === "blocked" && d.reason).toBe("foreign-listener");
  });

  it("refuses remote mode and containers", () => {
    expect(decideGatewaySwitch(findings({ remoteMode: true })).action).toBe("blocked");
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
      startDetached: false,
    });
  });

  it("foreground `pnpm start gateway` and no service: SIGTERM it and start this one in the background", () => {
    const d = decideGatewaySwitch(findings({ listener: listener() }));
    expect(d).toMatchObject({
      action: "switch",
      stopService: false,
      stopPid: 4242,
      installService: false,
      startDetached: true,
    });
  });

  it("a stopped service pointing elsewhere: re-point it only", () => {
    const d = decideGatewaySwitch(findings({ service: service({ running: false }) }));
    expect(d).toMatchObject({
      action: "switch",
      stopService: false,
      stopPid: null,
      installService: true,
      startDetached: false,
    });
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

  it("a foreground gateway it could not restart is left alone", () => {
    const d = decideGatewaySwitch(
      findings({ listener: listener({ runsFrom: null, exePath: null }) }),
    );
    expect(d.action === "blocked" && d.reason).toBe("cannot-restore");
  });

  it("a service whose definition cannot be read is never replaced (nothing to roll back to)", () => {
    const d = decideGatewaySwitch(
      findings({
        listener: listener({ underService: true }),
        service: service({ definition: null, runsFrom: null, pointsHere: true }),
      }),
    );
    expect(d.action === "blocked" && d.reason).toBe("cannot-restore");
  });

  it("a gateway whose pid could not be read is not stopped", () => {
    const d = decideGatewaySwitch(findings({ listener: listener({ pid: null }) }));
    expect(d.action === "blocked" && d.reason).toBe("unidentified-listener");
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

  it("restores `current` for a tarball-to-tarball switch in the same app dir only", () => {
    const tarball = buildRestorePlan(
      findings({ listener: listener({ runsFrom: OLD_TARBALL, exePath: null }) }),
    );
    expect(tarball.currentLink).toEqual({ appDir: "/home/u/.bitterbot/app", version: "1.4.0" });
    const clone = buildRestorePlan(findings({ listener: listener() }));
    expect(clone.currentLink).toBeNull();
  });
});

describe("executeGatewaySwitch", () => {
  it("git clone service: stops it, re-points it, waits until 1.5.0 answers", async () => {
    const f = findings({ listener: listener({ underService: true }), service: service() });
    const m = fakeMachine({ oldPid: 4242, service: true });
    const outcome = await executeGatewaySwitch({
      findings: f,
      decision: decideGatewaySwitch(f),
      deps: m.deps,
      timeouts: FAST,
    });
    expect(outcome.status).toBe("switched");
    expect(m.state.serviceDef).toBe(m.NEW_DEF);
    expect(m.state.serving).toBe("new");
    // The service stop stopped it: no signal needed.
    expect(m.state.signals).toEqual([]);
  });

  it("foreground gateway: SIGTERM after re-checking it is a gateway, children exit, new one detached", async () => {
    const f = findings({ listener: listener({ childPids: [5000] }) });
    const m = fakeMachine({ oldPid: 4242, children: [5000] });
    const outcome = await executeGatewaySwitch({
      findings: f,
      decision: decideGatewaySwitch(f),
      deps: m.deps,
      timeouts: FAST,
    });
    expect(outcome.status).toBe("switched");
    expect(m.state.signals).toEqual([[4242, "SIGTERM"]]);
    expect(m.deps.readCommandLine).toHaveBeenCalledWith(4242);
    expect(m.state.detached[0]?.argv[0]).toBe("/home/u/.bitterbot/app/current/bin/bitterbot");
    expect(m.state.installs).toEqual([]);
  });

  it("nudges a straggling orchestrator child, and only the orchestrator", async () => {
    const f = findings({ listener: listener({ childPids: [5000] }) });
    const m = fakeMachine({ oldPid: 4242, children: [5000], childrenIgnoreGatewayExit: true });
    await executeGatewaySwitch({
      findings: f,
      decision: decideGatewaySwitch(f),
      deps: m.deps,
      timeouts: FAST,
    });
    expect(m.state.signals).toEqual([
      [4242, "SIGTERM"],
      [5000, "SIGTERM"],
    ]);
  });

  it("does not signal a pid that stopped being a gateway (pid reuse)", async () => {
    const f = findings({ listener: listener() });
    const m = fakeMachine({ oldPid: 4242 });
    vi.mocked(m.deps.readCommandLine).mockResolvedValue("vim notes.txt");
    const outcome = await executeGatewaySwitch({
      findings: f,
      decision: decideGatewaySwitch(f),
      deps: m.deps,
      timeouts: FAST,
    });
    expect(outcome.status).toBe("failed");
    expect(m.state.signals).toEqual([]);
    expect(m.state.detached).toEqual([]);
  });

  it("new service never answers: restores the old service definition verbatim", async () => {
    const f = findings({ listener: listener({ underService: true }), service: service() });
    const m = fakeMachine({ oldPid: 4242, service: true, newGatewayHealthy: false });
    const outcome = await executeGatewaySwitch({
      findings: f,
      decision: decideGatewaySwitch(f),
      deps: m.deps,
      timeouts: FAST,
    });
    expect(outcome.status).toBe("rolled-back");
    expect(outcome.rollback).toMatchObject({ ok: true, restored: "service" });
    expect(m.state.installs.at(-1)).toBe(CLONE_DEF);
    expect(m.state.serving).toBe("old");
  });

  it("service install fails: puts the old definition back", async () => {
    const f = findings({ listener: listener({ underService: true }), service: service() });
    const m = fakeMachine({ oldPid: 4242, service: true, installFails: true });
    const outcome = await executeGatewaySwitch({
      findings: f,
      decision: decideGatewaySwitch(f),
      deps: m.deps,
      timeouts: FAST,
    });
    expect(outcome.status).toBe("rolled-back");
    expect(outcome.error).toContain("systemctl enable failed");
    expect(m.state.serviceDef).toBe(CLONE_DEF);
    expect(m.state.serving).toBe("old");
  });

  it("foreground tarball gateway, new one exits at boot: current goes back and the old one restarts", async () => {
    const f = findings({
      listener: listener({
        runsFrom: OLD_TARBALL,
        exePath: "/home/u/.bitterbot/app/1.4.0/runtime/node/bin/node",
      }),
      extraGatewayArgs: ["--allow-unconfigured"],
    });
    const m = fakeMachine({ oldPid: 4242, newGatewayHealthy: false });
    const outcome = await executeGatewaySwitch({
      findings: f,
      decision: decideGatewaySwitch(f),
      deps: m.deps,
      env: {
        BITTERBOT_INSTALL_KIND: "tarball",
        BITTERBOT_INSTALL_ROOT: SELF.root ?? "",
        HOME: "/home/u",
      },
      timeouts: { ...FAST, healthyMs: 60_000 },
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
    // The old install never inherits this install's launcher markers.
    expect(restart?.env?.BITTERBOT_INSTALL_ROOT).toBeUndefined();
    expect(restart?.env?.HOME).toBe("/home/u");
    expect(outcome.rollback).toMatchObject({ ok: true, restored: "process" });
  });

  it("old gateway that will not stop: aborts and restarts the service it stopped", async () => {
    const f = findings({ listener: listener({ underService: true }), service: service() });
    const m = fakeMachine({ oldPid: 4242, service: true, oldSticks: true });
    const outcome = await executeGatewaySwitch({
      findings: f,
      decision: decideGatewaySwitch(f),
      deps: m.deps,
      timeouts: FAST,
    });
    expect(outcome.status).toBe("rolled-back");
    expect(outcome.error).toContain("did not stop");
    expect(m.deps.buildServiceDefinition).not.toHaveBeenCalled();
  });

  it("a stopped service is restored stopped", async () => {
    const f = findings({ service: service({ running: false }) });
    const m = fakeMachine({ service: false, newGatewayHealthy: false });
    const outcome = await executeGatewaySwitch({
      findings: f,
      decision: decideGatewaySwitch(f),
      deps: m.deps,
      timeouts: FAST,
    });
    expect(outcome.status).toBe("rolled-back");
    expect(m.state.installs.at(-1)).toBe(CLONE_DEF);
    expect(m.state.serving).toBe(null);
    expect(outcome.rollback?.ok).toBe(true);
  });

  it("returns blocked and none decisions without touching anything", async () => {
    const m = fakeMachine({});
    const blocked = findings({ listener: listener({ isGateway: false }) });
    const outcome = await executeGatewaySwitch({
      findings: blocked,
      decision: decideGatewaySwitch(blocked),
      deps: m.deps,
    });
    expect(outcome.status).toBe("blocked");
    const none = await executeGatewaySwitch({
      findings: findings(),
      decision: decideGatewaySwitch(findings()),
      deps: m.deps,
    });
    expect(none.status).toBe("nothing-to-do");
    expect(m.deps.stopService).not.toHaveBeenCalled();
    expect(m.deps.signal).not.toHaveBeenCalled();
  });
});
