import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { describeBrowserLaunchFailure, watchBrowserLaunch } from "./chrome.js";

function fakeProcess() {
  const proc = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
  return proc as typeof proc & ChildProcess;
}

const base = {
  port: 19012,
  profile: "bitterbot",
  executable: "/usr/bin/chromium-browser",
  waitedMs: 12_000,
};

describe("watchBrowserLaunch", () => {
  it("reports nothing while the browser is still running", () => {
    const watch = watchBrowserLaunch(fakeProcess());

    expect(watch.ended()).toBeNull();
    expect(watch.outputTail()).toBe("");
  });

  it("records the exit and what the browser said last", () => {
    const proc = fakeProcess();
    const watch = watchBrowserLaunch(proc);

    proc.stderr.write(
      "Command '/usr/bin/chromium-browser' requires the chromium snap to be installed.\n",
    );
    proc.emit("exit", 1, null);

    expect(watch.ended()).toMatchObject({ code: 1, signal: null });
    expect(watch.outputTail()).toContain("requires the chromium snap");
  });

  it("records a spawn error, such as a missing executable", () => {
    const proc = fakeProcess();
    const watch = watchBrowserLaunch(proc);

    proc.emit("error", new Error("spawn /nope ENOENT"));

    expect(watch.ended()).toMatchObject({ error: "spawn /nope ENOENT" });
  });

  it("keeps reading output so a chatty browser cannot fill the pipe and stall", () => {
    const proc = fakeProcess();
    const watch = watchBrowserLaunch(proc);

    // Far more than a pipe buffer. With no reader, write() would report backpressure.
    let accepted = true;
    for (let i = 0; i < 400; i++) {
      accepted =
        proc.stderr.write(`[ERROR:dbus/bus.cc:405] Failed to connect to the bus ${i}\n`) &&
        accepted;
    }

    expect(accepted).toBe(true);
    expect(watch.outputTail().length).toBeLessThanOrEqual(1500);
    expect(watch.outputTail()).toContain("399");
  });
});

describe("describeBrowserLaunchFailure", () => {
  it("says the process exited and quotes its reason", () => {
    const message = describeBrowserLaunchFailure({
      ...base,
      ended: { at: 0, code: 1, signal: null },
      output: "Command '/usr/bin/chromium-browser' requires the chromium snap to be installed.",
    });

    expect(message).toContain('Failed to start Chrome CDP on port 19012 for profile "bitterbot".');
    expect(message).toContain("exited (code 1) before opening its debugging port");
    expect(message).toContain("requires the chromium snap to be installed");
    expect(message).toContain("Executable: /usr/bin/chromium-browser.");
    expect(message).toContain("browser.executablePath");
  });

  it("names the signal when the browser crashed", () => {
    // What a profile from an incompatible Chrome build does: SIGTRAP on startup.
    const message = describeBrowserLaunchFailure({
      ...base,
      ended: { at: 0, code: null, signal: "SIGTRAP" },
      output: "[ERROR:disk_cache.cc:272] Unable to create cache",
    });

    expect(message).toContain("exited (signal SIGTRAP)");
    expect(message).toContain("Unable to create cache");
    expect(message).toContain("reset-profile");
  });

  it("says it timed out when the browser is running but never opened the port", () => {
    const message = describeBrowserLaunchFailure({ ...base, ended: null, output: "" });

    expect(message).toContain("did not open its debugging port within 12s");
    expect(message).not.toContain("It said:");
  });

  it("leaves out the D-Bus noise every Linux launch prints", () => {
    const message = describeBrowserLaunchFailure({
      ...base,
      ended: { at: 0, code: 1, signal: null },
      output:
        "[1:2:ERROR:dbus/bus.cc:405] Failed to connect to the bus: no such file\n" +
        "[1:2:ERROR:something.cc:9] the real reason",
    });

    expect(message).toContain("the real reason");
    expect(message).not.toContain("Failed to connect to the bus");
  });

  it("never tells anyone to restart the gateway", () => {
    for (const ended of [
      null,
      { at: 0, code: 1, signal: null },
      { at: 0, code: null, signal: null, error: "ENOENT" },
    ]) {
      expect(describeBrowserLaunchFailure({ ...base, ended, output: "" })).not.toMatch(/restart/i);
    }
  });
});
