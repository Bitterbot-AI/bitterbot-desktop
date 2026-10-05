import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * What the agent is told when a browser request fails. Every failure used to
 * read "Can't reach the Bitterbot browser control service ... Restart the
 * Bitterbot gateway", including ordinary error responses. On 2026-10-02 that
 * sent a person to restart a healthy gateway when Chrome could not launch.
 */

const dispatch = vi.hoisted(() => vi.fn());

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return { ...actual, loadConfig: () => ({ gateway: { auth: { token: "t" } } }) };
});

vi.mock("./control-service.js", () => ({
  createBrowserControlContext: vi.fn(() => ({})),
  startBrowserControlServiceFromConfig: vi.fn(async () => ({ ok: true })),
}));

vi.mock("./routes/dispatcher.js", () => ({
  createBrowserRouteDispatcher: vi.fn(() => ({ dispatch })),
}));

import { BrowserResponseError, fetchBrowserJson } from "./client-fetch.js";
import { resetBrowserLaunchActivityForTest, trackBrowserLaunch } from "./launch-activity.js";

const failure = async (run: Promise<unknown>): Promise<Error> => {
  try {
    await run;
  } catch (err) {
    return err as Error;
  }
  throw new Error("expected the request to fail");
};

beforeEach(() => {
  dispatch.mockReset();
  resetBrowserLaunchActivityForTest();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("browser request errors: the in-process control service", () => {
  it("passes on the service's own error as it is", async () => {
    dispatch.mockResolvedValue({
      status: 500,
      body: {
        error:
          'Failed to start Chrome CDP on port 19012 for profile "bitterbot". The browser process exited (code 1) before opening its debugging port.',
      },
    });

    const err = await failure(fetchBrowserJson("/tabs/open", { method: "POST" }));

    expect(err).toBeInstanceOf(BrowserResponseError);
    expect((err as BrowserResponseError).status).toBe(500);
    expect(err.message).toMatch(/^Failed to start Chrome CDP on port 19012/);
    expect(err.message).not.toMatch(/Can't reach|restart/i);
  });

  it("does not dress up a take-over refusal as an outage", async () => {
    const refusal =
      "A person has taken control of this browser in the live view, so this action was not performed.";
    dispatch.mockResolvedValue({ status: 409, body: { error: refusal } });

    const err = await failure(fetchBrowserJson("/act", { method: "POST" }));

    expect(err.message).toBe(refusal);
  });

  it("calls a timeout a timeout, and does not blame the gateway", async () => {
    vi.useFakeTimers();
    dispatch.mockReturnValue(new Promise(() => {}));

    const pending = failure(fetchBrowserJson("/tabs/open", { method: "POST", timeoutMs: 15_000 }));
    await vi.advanceTimersByTimeAsync(15_000);
    const err = await pending;

    expect(err.message).toContain("The browser did not respond within 15000ms");
    expect(err.message).toContain("browser status");
    // The service runs inside the gateway: if this code ran, it is up.
    expect(err.message).not.toMatch(/Can't reach|restart/i);
    // Still told not to loop on it.
    expect(err.message).toContain("Do NOT retry the browser tool");
  });

  it("says a cold start is a cold start, and allows one more try", async () => {
    vi.useFakeTimers();
    dispatch.mockReturnValue(new Promise(() => {}));
    // A launch that is still running when the call gives up.
    let finishLaunch = () => {};
    const launch = trackBrowserLaunch(() => new Promise<void>((r) => (finishLaunch = r)));

    const pending = failure(fetchBrowserJson("/tabs/open", { method: "POST", timeoutMs: 15_000 }));
    await vi.advanceTimersByTimeAsync(15_000);
    const err = await pending;
    finishLaunch();
    await launch;

    expect(err.message).toContain("still starting");
    expect(err.message).toContain("ONE more time");
    expect(err.message).not.toContain("Do NOT retry the browser tool");
  });

  it("reports an internal failure without inventing an outage", async () => {
    dispatch.mockRejectedValue(new Error("profile store is locked"));

    const err = await failure(fetchBrowserJson("/tabs"));

    expect(err.message).toContain("The browser request failed: profile store is locked");
    expect(err.message).not.toMatch(/Can't reach|restart/i);
  });
});

describe("browser request errors: a control server over HTTP", () => {
  it("passes on an error response, showing the message and not the JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "tab not found" }), { status: 404 })),
    );

    const err = await failure(fetchBrowserJson("http://127.0.0.1:18791/tabs/focus"));

    expect(err).toBeInstanceOf(BrowserResponseError);
    expect(err.message).toBe("tab not found");
  });

  it("still says it cannot reach a server that is not there", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );

    const err = await failure(fetchBrowserJson("http://127.0.0.1:18791/tabs"));

    expect(err.message).toContain("Can't reach the Bitterbot browser control service");
    expect(err.message).not.toMatch(/restart the bitterbot gateway/i);
  });
});
