import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  checkUpdateStatus,
  detectPackageInstallLayout,
  resolveNpmChannelTag,
} from "./update-check.js";

describe("resolveNpmChannelTag", () => {
  let versionByTag: Record<string, string | null>;

  beforeEach(() => {
    versionByTag = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        const tag = decodeURIComponent(url.split("/").pop() ?? "");
        const version = versionByTag[tag] ?? null;
        return {
          ok: version != null,
          status: version != null ? 200 : 404,
          json: async () => ({ version }),
        } as Response;
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("falls back to latest when beta is older", async () => {
    versionByTag.beta = "1.0.0-beta.1";
    versionByTag.latest = "1.0.1-1";

    const resolved = await resolveNpmChannelTag({ channel: "beta", timeoutMs: 1000 });

    expect(resolved).toEqual({ tag: "latest", version: "1.0.1-1" });
  });

  it("keeps beta when beta is not older", async () => {
    versionByTag.beta = "1.0.2-beta.1";
    versionByTag.latest = "1.0.1-1";

    const resolved = await resolveNpmChannelTag({ channel: "beta", timeoutMs: 1000 });

    expect(resolved).toEqual({ tag: "beta", version: "1.0.2-beta.1" });
  });
});

describe("compareSemverStrings (PLAN-41 D-A CalVer guard)", async () => {
  const { compareSemverStrings } = await import("./update-check.js");

  it("a CalVer-era version is OLDER than any SemVer release", () => {
    expect(compareSemverStrings("2026.2.15", "1.0.0")).toBe(-1);
    expect(compareSemverStrings("1.0.0", "2026.2.15")).toBe(1);
  });

  it("plain SemVer still orders normally", () => {
    expect(compareSemverStrings("1.0.0", "1.1.0")).toBe(-1);
    expect(compareSemverStrings("2.0.0", "2.0.0")).toBe(0);
  });

  it("a pre-release is behind the release it precedes (beta node sees the stable build)", () => {
    expect(compareSemverStrings("1.11.0-beta.1", "1.11.0")).toBe(-1);
    expect(compareSemverStrings("1.11.0", "1.11.0-beta.1")).toBe(1);
    expect(compareSemverStrings("v1.11.0-beta.1", "v1.11.0")).toBe(-1);
    expect(compareSemverStrings("1.11.0-beta.1", "1.10.1")).toBe(1);
    expect(compareSemverStrings("1.12.0", "1.11.0-beta.1")).toBe(1);
  });

  it("orders pre-releases by identifier, numerically where both are numbers", () => {
    expect(compareSemverStrings("1.11.0-beta.1", "1.11.0-beta.2")).toBe(-1);
    expect(compareSemverStrings("1.11.0-beta.10", "1.11.0-beta.9")).toBe(1);
    expect(compareSemverStrings("1.11.0-beta.1", "1.11.0-beta.1")).toBe(0);
    expect(compareSemverStrings("1.11.0-alpha.1", "1.11.0-beta.1")).toBe(-1);
    expect(compareSemverStrings("1.11.0-beta", "1.11.0-beta.1")).toBe(-1);
  });
});

describe("fetchNpmTagVersion not-published mapping (D-J)", () => {
  it("maps a 404 to the durable not-published error", async () => {
    const { fetchNpmTagVersion } = await import("./update-check.js");
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 404 }) as unknown as Response);
    try {
      const res = await fetchNpmTagVersion({ tag: "latest" });
      expect(res.error).toBe("not-published");
      expect(res.version).toBeNull();
    } finally {
      fetchMock.mockRestore();
    }
  });
});

describe("package install manager", () => {
  it("reads the installing tool from the install path, not the packageManager field", () => {
    expect(detectPackageInstallLayout(["/usr/local/lib/node_modules/bitterbot"])).toBe("npm");
    expect(
      detectPackageInstallLayout(["C:\\Users\\v\\AppData\\Roaming\\npm\\node_modules\\bitterbot"]),
    ).toBe("npm");
    expect(
      detectPackageInstallLayout([
        "/home/v/.local/share/pnpm/global/5/node_modules/bitterbot",
        "/home/v/.local/share/pnpm/global/5/.pnpm/bitterbot@1.6.0/node_modules/bitterbot",
      ]),
    ).toBe("pnpm");
    expect(detectPackageInstallLayout(["/home/v/.bun/install/global/node_modules/bitterbot"])).toBe(
      "bun",
    );
    expect(detectPackageInstallLayout(["/home/v/bitterbot-desktop", null])).toBeNull();
  });

  it("reports a global npm install as npm even though package.json names pnpm", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bb-npm-global-"));
    try {
      const root = path.join(tmp, "lib", "node_modules", "bitterbot");
      fs.mkdirSync(root, { recursive: true });
      fs.writeFileSync(
        path.join(root, "package.json"),
        JSON.stringify({ name: "bitterbot", version: "1.6.0", packageManager: "pnpm@10.23.0" }),
      );
      const status = await checkUpdateStatus({
        root,
        includeRegistry: false,
        containerProbe: {
          env: {},
          existsSync: () => false,
          readFileSync: () => {
            throw new Error("no cgroup");
          },
        },
      });
      expect(status.installKind).toBe("package");
      expect(status.packageManager).toBe("npm");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
