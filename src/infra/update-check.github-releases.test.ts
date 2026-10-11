/**
 * PLAN-56 Phase 2 (D6): container installs learn about new images from the
 * GitHub releases API, never npm.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  checkUpdateStatus,
  fetchLatestGithubRelease,
  GITHUB_LATEST_RELEASE_URL,
  peekLatestGithubRelease,
  resetGithubReleaseCacheForTests,
} from "./update-check.js";
import { computeUpdateStaleness } from "./update-staleness.js";

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

describe("fetchLatestGithubRelease", () => {
  beforeEach(() => {
    resetGithubReleaseCacheForTests();
  });

  it("returns the release version from tag_name, unauthenticated, with no identifying data", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ tag_name: "v1.5.0" }));
    const res = await fetchLatestGithubRelease({ fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(res).toEqual({ latestVersion: "1.5.0", source: "github-releases" });
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(GITHUB_LATEST_RELEASE_URL);
    const headers = init.headers as Record<string, string>;
    expect(Object.keys(headers).map((h) => h.toLowerCase())).not.toContain("authorization");
    expect(headers["User-Agent"]).toBe("bitterbot-update-check");
  });

  it("maps a 403 with an exhausted quota (and a 429) to rate-limited", async () => {
    const limited = vi.fn(
      async () => new Response("{}", { status: 403, headers: { "x-ratelimit-remaining": "0" } }),
    );
    expect(
      await fetchLatestGithubRelease({ fetchImpl: limited as unknown as typeof fetch }),
    ).toMatchObject({ latestVersion: null, error: "rate-limited" });
    resetGithubReleaseCacheForTests();
    const tooMany = vi.fn(async () => new Response("{}", { status: 429 }));
    expect(
      await fetchLatestGithubRelease({ fetchImpl: tooMany as unknown as typeof fetch }),
    ).toMatchObject({ latestVersion: null, error: "rate-limited" });
  });

  it("treats a malformed body, a non-app tag or a prerelease as unknown", async () => {
    for (const body of [
      { nope: true },
      { tag_name: "orchestrator-v0.2.3" },
      { tag_name: "v1.5.0", prerelease: true },
      "not json at all",
    ]) {
      resetGithubReleaseCacheForTests();
      const fetchImpl = vi.fn(async () =>
        typeof body === "string" ? new Response(body, { status: 200 }) : jsonResponse(body),
      );
      const res = await fetchLatestGithubRelease({
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      expect(res.latestVersion).toBeNull();
      expect(res.error).toBeTruthy();
    }
  });

  it("maps network errors to unknown instead of throwing", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("getaddrinfo ENOTFOUND api.github.com");
    });
    const res = await fetchLatestGithubRelease({ fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(res.latestVersion).toBeNull();
    expect(res.error).toContain("ENOTFOUND");
  });

  it("caches answers (30 min) and failures (15 min) so the API is never hammered", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ tag_name: "v1.5.0" }));
    const f = fetchImpl as unknown as typeof fetch;
    const t0 = 1_000_000;
    await fetchLatestGithubRelease({ fetchImpl: f, now: t0 });
    await fetchLatestGithubRelease({ fetchImpl: f, now: t0 + 29 * 60_000 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await fetchLatestGithubRelease({ fetchImpl: f, now: t0 + 31 * 60_000 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    // The no-network peek sees the fresh answer, and nothing once it is stale.
    expect(peekLatestGithubRelease(t0 + 32 * 60_000)?.latestVersion).toBe("1.5.0");
    expect(peekLatestGithubRelease(t0 + 62 * 60_000)).toBeNull();

    resetGithubReleaseCacheForTests();
    const failing = vi.fn(async () => new Response("{}", { status: 500 }));
    const g = failing as unknown as typeof fetch;
    await fetchLatestGithubRelease({ fetchImpl: g, now: t0 });
    await fetchLatestGithubRelease({ fetchImpl: g, now: t0 + 14 * 60_000 });
    expect(failing).toHaveBeenCalledTimes(1);
    await fetchLatestGithubRelease({ fetchImpl: g, now: t0 + 16 * 60_000 });
    expect(failing).toHaveBeenCalledTimes(2);
  });
});

describe("checkUpdateStatus for a container install", () => {
  beforeEach(() => {
    resetGithubReleaseCacheForTests();
  });

  it("reports installKind container and asks GitHub releases, never npm", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "bb-container-root-"));
    const urls: string[] = [];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      urls.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      return jsonResponse({ tag_name: "v99.0.0" });
    });
    try {
      const res = await checkUpdateStatus({
        root,
        includeRegistry: true,
        containerProbe: {
          env: { BITTERBOT_INSTALL_KIND: "container" } as NodeJS.ProcessEnv,
          existsSync: () => false,
          readFileSync: () => "0::/\n",
        },
      });
      expect(res.installKind).toBe("container");
      expect(res.git).toBeUndefined();
      expect(res.deps).toBeUndefined();
      expect(res.registry).toEqual({ latestVersion: "99.0.0", source: "github-releases" });
      expect(urls).toEqual([GITHUB_LATEST_RELEASE_URL]);
      expect(urls.some((u) => u.includes("registry.npmjs.org"))).toBe(false);

      // Newer release => stale with the image-specific reason; same => fresh.
      const stale = computeUpdateStaleness(res, undefined, { channelVersion: "99.0.0" });
      expect(stale).toMatchObject({ stale: true, reason: "image-version" });
      const { VERSION } = await import("../version.js");
      const fresh = computeUpdateStaleness(res, undefined, { channelVersion: VERSION });
      expect(fresh).toMatchObject({ stale: false, reason: "fresh" });
      // Rate-limited / offline: no version from anywhere => no prompt.
      const unknown = computeUpdateStaleness(
        {
          ...res,
          registry: { latestVersion: null, source: "github-releases", error: "rate-limited" },
        },
        undefined,
        { channelVersion: null },
      );
      expect(unknown).toMatchObject({ stale: false, reason: "unknown" });
    } finally {
      fetchSpy.mockRestore();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
