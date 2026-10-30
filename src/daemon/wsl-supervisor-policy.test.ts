import { describe, expect, it } from "vitest";
import {
  computeBackoffMs,
  decideAdoptionPoll,
  decideAfterExit,
  decideAfterHandoffGrace,
  formatExitLogLine,
  initialSupervisorState,
  isSupervisorLockStale,
  parsePortFromProgramArguments,
  parseSupervisorLockPayload,
  selectLogFilesToPrune,
  SUPERVISOR_EXIT0_GRACE_MS,
  SUPERVISOR_HEALTHY_UPTIME_MS,
  supervisorLogFileName,
} from "./wsl-supervisor-policy.js";

describe("wsl supervisor backoff", () => {
  it("starts at 5s, doubles, caps at 60s", () => {
    expect([1, 2, 3, 4, 5, 9].map(computeBackoffMs)).toEqual([
      5_000, 10_000, 20_000, 40_000, 60_000, 60_000,
    ]);
  });
});

describe("decideAfterExit", () => {
  const fresh = initialSupervisorState();

  it.each([
    { name: "non-zero exit", exitCode: 1, signal: null, failures: 0, delay: 5_000 },
    { name: "signal", exitCode: null, signal: "SIGKILL", failures: 0, delay: 5_000 },
    { name: "third failure in a row", exitCode: 2, signal: null, failures: 2, delay: 20_000 },
    { name: "sixth failure stays capped", exitCode: 1, signal: null, failures: 5, delay: 60_000 },
  ])("relaunches with backoff: $name", ({ exitCode, signal, failures, delay }) => {
    const decision = decideAfterExit(
      { exitCode, signal, uptimeMs: 30_000 },
      { ...fresh, consecutiveFailures: failures },
    );
    expect(decision.action).toBe("relaunch");
    if (decision.action === "relaunch") {
      expect(decision.delayMs).toBe(delay);
      expect(decision.state.consecutiveFailures).toBe(failures + 1);
    }
  });

  it("resets the failure count after 10 minutes of healthy uptime", () => {
    const decision = decideAfterExit(
      { exitCode: 1, signal: null, uptimeMs: SUPERVISOR_HEALTHY_UPTIME_MS },
      { ...fresh, consecutiveFailures: 5, graceRelaunchUsed: true },
    );
    expect(decision.action).toBe("relaunch");
    if (decision.action === "relaunch") {
      expect(decision.delayMs).toBe(5_000);
      expect(decision.state.consecutiveFailures).toBe(1);
      expect(decision.state.graceRelaunchUsed).toBe(false);
    }
  });

  it("does not relaunch on exit 0: probes for a restart handoff after a grace period", () => {
    const decision = decideAfterExit({ exitCode: 0, signal: null, uptimeMs: 3_600_000 }, fresh);
    expect(decision.action).toBe("probe-handoff");
    if (decision.action === "probe-handoff") {
      expect(decision.graceMs).toBe(SUPERVISOR_EXIT0_GRACE_MS);
    }
  });

  it("never relaunches once the supervisor is stopping", () => {
    const decision = decideAfterExit(
      { exitCode: 1, signal: null, uptimeMs: 10 },
      { ...fresh, stopping: true },
    );
    expect(decision.action).toBe("stop");
    expect(decision.reason).toContain("supervisor stopping");
  });
});

describe("decideAfterHandoffGrace (exit 0 cases)", () => {
  const fresh = initialSupervisorState();

  it("adopts the SIGUSR1 restart child that took the lock", () => {
    const decision = decideAfterHandoffGrace({ lockHeld: true, portOpen: false }, fresh);
    expect(decision.action).toBe("wait-external");
    expect(decision.reason).toContain("restart handoff");
  });

  it("waits when something answers on the port even without the lock", () => {
    expect(decideAfterHandoffGrace({ lockHeld: false, portOpen: true }, fresh).action).toBe(
      "wait-external",
    );
  });

  it("relaunches once when nothing holds the lock and the port is closed, and says why", () => {
    const decision = decideAfterHandoffGrace({ lockHeld: false, portOpen: false }, fresh);
    expect(decision.action).toBe("relaunch");
    expect(decision.reason).toMatch(/no gateway holds the lock and the port is closed/);
    expect(decision.state.graceRelaunchUsed).toBe(true);
  });

  it("stops relaunching when the one grace relaunch was already used", () => {
    const decision = decideAfterHandoffGrace(
      { lockHeld: false, portOpen: false },
      { ...fresh, graceRelaunchUsed: true },
    );
    expect(decision.action).toBe("stop");
  });

  it("stops when the supervisor is stopping", () => {
    expect(
      decideAfterHandoffGrace({ lockHeld: true, portOpen: true }, { ...fresh, stopping: true })
        .action,
    ).toBe("stop");
  });
});

describe("decideAdoptionPoll", () => {
  it("keeps waiting while an external gateway holds the lock or the port", () => {
    const state = initialSupervisorState();
    expect(decideAdoptionPoll({ lockHeld: true, portOpen: true }, state).action).toBe(
      "keep-waiting",
    );
    expect(decideAdoptionPoll({ lockHeld: false, portOpen: true }, state).action).toBe(
      "keep-waiting",
    );
  });

  it("takes over once the lock is released and the port closed", () => {
    const decision = decideAdoptionPoll(
      { lockHeld: false, portOpen: false },
      { ...initialSupervisorState(), graceRelaunchUsed: true },
    );
    expect(decision.action).toBe("take-over");
    if (decision.action === "take-over") {
      expect(decision.state.graceRelaunchUsed).toBe(false);
    }
  });
});

describe("exit log line", () => {
  it("has ISO time, pid, exit code, uptime seconds and the decision", () => {
    const line = formatExitLogLine({
      time: new Date("2026-10-29T13:02:00.000Z"),
      pid: 13753,
      exitCode: 1,
      signal: null,
      uptimeMs: 42_400,
      decision: "exit 1 after 42s; relaunch in 5s (failure 1)",
    });
    expect(line).toBe(
      "2026-10-29T13:02:00.000Z pid=13753 exit=1 uptime=42s decision=exit 1 after 42s; relaunch in 5s (failure 1)",
    );
  });

  it("names the signal instead of an exit code", () => {
    const line = formatExitLogLine({
      time: new Date("2026-10-29T13:02:00.000Z"),
      pid: 7,
      exitCode: null,
      signal: "SIGKILL",
      uptimeMs: 999,
      decision: "d",
    });
    expect(line).toContain(" pid=7 signal=SIGKILL uptime=1s decision=d");
  });
});

describe("daily log files", () => {
  it("names the file after the local calendar day", () => {
    expect(supervisorLogFileName(new Date(2026, 9, 29, 23, 59))).toBe("gateway-20261029.log");
    expect(supervisorLogFileName(new Date(2026, 0, 5))).toBe("gateway-20260105.log");
  });

  it("prunes beyond the newest 14 and ignores other files", () => {
    const names = Array.from(
      { length: 16 },
      (_, i) => `gateway-202610${String(i + 1).padStart(2, "0")}.log`,
    );
    const stale = selectLogFilesToPrune([
      ...names,
      "gateway-exits.log",
      "vite-20260812-1838.log",
      "gateway.log",
    ]);
    expect(stale).toEqual(["gateway-20261001.log", "gateway-20261002.log"]);
    expect(selectLogFilesToPrune(names.slice(0, 14))).toEqual([]);
  });
});

describe("supervisor lock", () => {
  it("parses the payload and treats unreadable, dead or self pids as stale", () => {
    expect(parseSupervisorLockPayload("garbage")).toBeNull();
    const payload = parseSupervisorLockPayload('{"pid":4242,"createdAt":"2026-10-29T00:00:00Z"}');
    expect(payload?.pid).toBe(4242);
    expect(isSupervisorLockStale({ payload: null, isPidAlive: () => true, selfPid: 1 })).toBe(true);
    expect(isSupervisorLockStale({ payload, isPidAlive: () => false, selfPid: 1 })).toBe(true);
    expect(isSupervisorLockStale({ payload, isPidAlive: () => true, selfPid: 4242 })).toBe(true);
    expect(isSupervisorLockStale({ payload, isPidAlive: () => true, selfPid: 1 })).toBe(false);
  });
});

describe("parsePortFromProgramArguments", () => {
  it("reads --port and --port=", () => {
    expect(parsePortFromProgramArguments(["/bin/bitterbot", "gateway", "--port", "19001"])).toBe(
      19001,
    );
    expect(parsePortFromProgramArguments(["node", "entry.js", "gateway", "--port=18789"])).toBe(
      18789,
    );
    expect(parsePortFromProgramArguments(["/bin/bitterbot", "gateway"])).toBeNull();
    expect(parsePortFromProgramArguments(undefined)).toBeNull();
  });
});
