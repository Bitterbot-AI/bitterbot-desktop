import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchSessionToken,
  LS_TOKEN_KEY,
  LS_URL_KEY,
  readStoredGatewayToken,
  resolveGatewayHttpOrigin,
  resolveGatewayToken,
  resolveGatewayWsUrl,
} from "./gateway-origin";

const loc = (href: string): Location => new URL(href) as unknown as Location;

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("gateway WS URL resolution", () => {
  it("derives from the page origin when the gateway served the page", () => {
    expect(resolveGatewayWsUrl({ location: loc("http://127.0.0.1:19001/"), isDev: false })).toBe(
      "ws://127.0.0.1:19001",
    );
  });

  it("upgrades to wss for an https origin", () => {
    expect(resolveGatewayWsUrl({ location: loc("https://box.ts.net/"), isDev: false })).toBe(
      "wss://box.ts.net",
    );
  });

  it("prefers a stored override over derivation, for a remote gateway", () => {
    localStorage.setItem(LS_URL_KEY, "ws://192.168.1.50:19001");
    expect(resolveGatewayWsUrl({ location: loc("http://127.0.0.1:19001/"), isDev: false })).toBe(
      "ws://192.168.1.50:19001",
    );
  });

  it("keeps the dev flow working from the Vite origin", () => {
    // The precedence that matters: under `pnpm dev:all` the page origin is 5173,
    // a perfectly real origin, so deriving from it would produce ws://localhost:5173
    // where no gateway listens. The dev branch must sit ABOVE derivation.
    const url = resolveGatewayWsUrl({ location: loc("http://localhost:5173/"), isDev: true });
    expect(url).not.toBe("ws://localhost:5173");
  });

  it("falls back to loopback for non-http origins such as tauri:// and file://", () => {
    // The Tauri shell loads the same bundle from disk, so there is no http origin
    // to derive from and the hardcoded loopback is the right answer.
    for (const href of ["tauri://localhost/", "file:///app/index.html"]) {
      expect(resolveGatewayWsUrl({ location: loc(href), isDev: false }), href).toBe(
        "ws://127.0.0.1:19001",
      );
    }
  });

  it("maps the ws URL to an http origin", () => {
    expect(
      resolveGatewayHttpOrigin({ location: loc("http://127.0.0.1:19001/"), isDev: false }),
    ).toBe("http://127.0.0.1:19001");
    expect(resolveGatewayHttpOrigin({ location: loc("https://box.ts.net/"), isDev: false })).toBe(
      "https://box.ts.net",
    );
  });
});

describe("token resolution", () => {
  it("reads a stored token", () => {
    localStorage.setItem(LS_TOKEN_KEY, "  stored-token  ");
    expect(readStoredGatewayToken()).toBe("stored-token");
  });

  it("returns null when nothing is stored", () => {
    expect(readStoredGatewayToken()).toBeNull();
  });

  it("fetches the token from the same-origin handoff endpoint", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({ token: "handed-over" }),
    })) as unknown as typeof fetch;
    await expect(fetchSessionToken({ origin: "http://127.0.0.1:19001", fetchImpl })).resolves.toBe(
      "handed-over",
    );
  });

  it("returns null when the endpoint refuses (403)", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      json: async () => ({ error: "forbidden" }),
    })) as unknown as typeof fetch;
    await expect(
      fetchSessionToken({ origin: "http://127.0.0.1:19001", fetchImpl }),
    ).resolves.toBeNull();
  });

  it("returns null when the gateway reports no configured auth", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({ token: null }),
    })) as unknown as typeof fetch;
    await expect(
      fetchSessionToken({ origin: "http://127.0.0.1:19001", fetchImpl }),
    ).resolves.toBeNull();
  });

  it("never throws when the request fails outright", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    await expect(
      fetchSessionToken({ origin: "http://127.0.0.1:19001", fetchImpl }),
    ).resolves.toBeNull();
  });

  it("prefers a stored token over the handoff endpoint", async () => {
    localStorage.setItem(LS_TOKEN_KEY, "stored-wins");
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    await expect(resolveGatewayToken({ fetchImpl })).resolves.toBe("stored-wins");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("falls back to the handoff endpoint with nothing stored", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({ token: "from-gateway" }),
    })) as unknown as typeof fetch;
    await expect(
      resolveGatewayToken({ origin: "http://127.0.0.1:19001", fetchImpl }),
    ).resolves.toBe("from-gateway");
  });
});
