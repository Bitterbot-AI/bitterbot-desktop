/**
 * runApp: argv and environment reach the app, signals are forwarded (but a
 * terminal's own Ctrl-C is not sent twice), and the exit status comes back.
 */
import { EventEmitter } from "node:events";
import os from "node:os";
import { describe, expect, it, vi } from "vitest";
import { appEnvironment, runApp } from "./run.js";

type FakeChild = EventEmitter & { kill: ReturnType<typeof vi.fn> };

function setup(opts: { tty?: boolean } = {}) {
  const proc = new EventEmitter() as EventEmitter & {
    kill: ReturnType<typeof vi.fn>;
    pid: number;
    stdin: { isTTY?: boolean };
  };
  proc.kill = vi.fn();
  proc.pid = 4242;
  proc.stdin = { isTTY: opts.tty };
  const child = new EventEmitter() as FakeChild;
  child.kill = vi.fn(() => true);
  const spawn = vi.fn(() => child as never);
  return { proc, child, spawn };
}

describe("runApp", () => {
  it("passes argv and a clean environment, and returns the exit code", async () => {
    const { proc, child, spawn } = setup();
    const done = runApp(
      "/app/current/bin/bitterbot",
      ["doctor", "--non-interactive"],
      { HOME: "/h", BITTERBOT_INSTALL_KIND: "package" },
      { spawn, proc: proc as never },
    );
    child.emit("exit", 7, null);
    expect(await done).toBe(7);
    expect(spawn).toHaveBeenCalledWith(
      "/app/current/bin/bitterbot",
      ["doctor", "--non-interactive"],
      expect.objectContaining({ stdio: "inherit", env: { HOME: "/h" } }),
    );
    expect(proc.listenerCount("SIGTERM")).toBe(0);
  });

  it("forwards SIGTERM and SIGHUP from a service manager", async () => {
    const { proc, child, spawn } = setup();
    const done = runApp("/bin/x", [], {}, { spawn, proc: proc as never });
    proc.emit("SIGTERM");
    proc.emit("SIGHUP");
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(child.kill).toHaveBeenCalledWith("SIGHUP");
    child.emit("exit", 0, null);
    await done;
  });

  it("does not resend a terminal Ctrl-C the app already received, but forwards it without a TTY", async () => {
    const tty = setup({ tty: true });
    const doneTty = runApp("/bin/x", [], {}, { spawn: tty.spawn, proc: tty.proc as never });
    tty.proc.emit("SIGINT");
    expect(tty.child.kill).not.toHaveBeenCalled();
    tty.child.emit("exit", 130, null);
    expect(await doneTty).toBe(130);

    const pipe = setup({ tty: false });
    const donePipe = runApp("/bin/x", [], {}, { spawn: pipe.spawn, proc: pipe.proc as never });
    pipe.proc.emit("SIGINT");
    expect(pipe.child.kill).toHaveBeenCalledWith("SIGINT");
    pipe.child.emit("exit", 0, null);
    await donePipe;
  });

  it("dies of the same signal as the app", async () => {
    const { proc, child, spawn } = setup();
    const done = runApp("/bin/x", [], {}, { spawn, proc: proc as never });
    child.emit("exit", null, "SIGTERM");
    expect(await done).toBe(128 + os.constants.signals.SIGTERM);
    expect(proc.kill).toHaveBeenCalledWith(4242, "SIGTERM");
  });

  it("reports a launch failure without a stack trace", async () => {
    const { proc, child, spawn } = setup();
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const done = runApp("/missing/bitterbot", [], {}, { spawn, proc: proc as never });
      child.emit(
        "error",
        Object.assign(new Error("spawn /missing/bitterbot ENOENT"), { code: "ENOENT" }),
      );
      expect(await done).toBe(1);
      expect(String(write.mock.calls[0]?.[0])).toBe(
        "bitterbot: could not start /missing/bitterbot: spawn /missing/bitterbot ENOENT\n",
      );
    } finally {
      write.mockRestore();
    }
  });
});

describe("appEnvironment", () => {
  it("drops the install-kind variables the tarball's bin/bitterbot sets itself", () => {
    expect(
      appEnvironment({
        A: "1",
        BITTERBOT_INSTALL_KIND: "package",
        BITTERBOT_INSTALL_ROOT: "/x",
        BITTERBOT_NODE_OPTIONS_READY: "1",
      }),
    ).toEqual({ A: "1" });
  });
});
