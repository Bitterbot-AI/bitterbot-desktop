import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  extractSignalLinkUri,
  resetSignalLinkForTest,
  startSignalLinkQr,
  waitForSignalLinkQr,
} from "./link-qr.js";

class FakeChild {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  killed = false;
  private readonly emitter = new EventEmitter();
  on(event: string, listener: (...args: unknown[]) => void) {
    this.emitter.on(event, listener);
    return this;
  }
  emitExit(code: number | null) {
    this.emitter.emit("exit", code);
  }
  emitError(err: Error) {
    this.emitter.emit("error", err);
  }
  kill() {
    this.killed = true;
    return true;
  }
}

afterEach(() => {
  resetSignalLinkForTest();
});

describe("extractSignalLinkUri", () => {
  it("finds modern sgnl:// URIs inside log noise", () => {
    expect(
      extractSignalLinkUri("INFO some prefix sgnl://linkdevice?uuid=abc&pub_key=xyz trailing"),
    ).toBe("sgnl://linkdevice?uuid=abc&pub_key=xyz");
  });

  it("finds legacy tsdevice:/ URIs", () => {
    expect(extractSignalLinkUri("tsdevice:/?uuid=abc&pub_key=xyz\n")).toBe(
      "tsdevice:/?uuid=abc&pub_key=xyz",
    );
  });

  it("returns null when no URI is present", () => {
    expect(extractSignalLinkUri("Waiting for device to link")).toBeNull();
  });
});

describe("startSignalLinkQr / waitForSignalLinkQr", () => {
  it("renders the URI as a QR data URL and resolves connected on exit 0", async () => {
    const child = new FakeChild();
    const spawnFn = vi.fn(() => child as never);

    const startPromise = startSignalLinkQr({
      accountId: "default",
      cliPath: "signal-cli",
      spawnFn,
    });
    child.stdout.emit("data", Buffer.from("sgnl://linkdevice?uuid=abc&pub_key=xyz\n"));
    const start = await startPromise;

    expect(spawnFn).toHaveBeenCalledWith("signal-cli", ["link", "-n", "Bitterbot"]);
    expect(start.qrDataUrl).toMatch(/^data:image\/png;base64,/);

    const waitPromise = waitForSignalLinkQr({ accountId: "default" });
    child.stdout.emit("data", Buffer.from("Associated with: +15551234567 (device 2)\n"));
    child.emitExit(0);
    const wait = await waitPromise;
    expect(wait.connected).toBe(true);
    expect(wait.message).toContain("+15551234567");
  });

  it("reports a failed link when signal-cli exits non-zero", async () => {
    const child = new FakeChild();
    const startPromise = startSignalLinkQr({
      accountId: "default",
      cliPath: "signal-cli",
      spawnFn: () => child as never,
    });
    child.stderr.emit("data", Buffer.from("tsdevice:/?uuid=abc\n"));
    await startPromise;

    const waitPromise = waitForSignalLinkQr({ accountId: "default" });
    child.stderr.emit("data", Buffer.from("Link request timed out\n"));
    child.emitExit(1);
    const wait = await waitPromise;
    expect(wait.connected).toBe(false);
    expect(wait.message).toContain("exited with code 1");
  });

  it("times out cleanly when no URI ever appears", async () => {
    const child = new FakeChild();
    const start = await startSignalLinkQr({
      accountId: "default",
      cliPath: "/opt/not-signal-cli",
      uriTimeoutMs: 20,
      spawnFn: () => child as never,
    });
    expect(start.qrDataUrl).toBeUndefined();
    expect(start.message).toContain("did not produce a linking URI");
    expect(child.killed).toBe(true);
  });

  it("wait without an active link explains what to do", async () => {
    const wait = await waitForSignalLinkQr({ accountId: "nope" });
    expect(wait.connected).toBe(false);
    expect(wait.message).toContain("Start one first");
  });

  it("reuses a fresh pending link's QR instead of respawning", async () => {
    const child = new FakeChild();
    const spawnFn = vi.fn(() => child as never);
    const first = startSignalLinkQr({ accountId: "default", cliPath: "signal-cli", spawnFn });
    child.stdout.emit("data", Buffer.from("sgnl://linkdevice?uuid=abc\n"));
    await first;

    const second = await startSignalLinkQr({
      accountId: "default",
      cliPath: "signal-cli",
      spawnFn,
    });
    expect(spawnFn).toHaveBeenCalledTimes(1);
    expect(second.qrDataUrl).toMatch(/^data:image\/png;base64,/);
  });
});
