/**
 * PLAN-56 Phase 3a: a release-tarball install has no in-place updater yet,
 * so update.run refuses with the installer one-liner (mirroring the
 * container refusal), and update.check follows the GitHub release that
 * carries this platform's tarball instead of npm.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TARBALL_UPDATE_COMMAND, TARBALL_UPDATE_REFUSAL } from "../../infra/install-kind.js";
import { checkUpdateStatus, fetchLatestGithubRelease } from "../../infra/update-check.js";
import { runGatewayUpdate } from "../../infra/update-runner.js";
import { updateHandlers } from "./update.js";

vi.mock("../../config/config.js", () => ({ loadConfig: vi.fn(() => ({})) }));
vi.mock("../../infra/bitterbot-root.js", () => ({
  resolveBitterbotPackageRoot: vi.fn(async () => "/home/u/.bitterbot/app/1.4.0"),
}));
vi.mock("../../infra/update-runner.js", () => ({ runGatewayUpdate: vi.fn() }));
vi.mock("../../infra/update-check.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../infra/update-check.js")>();
  return {
    ...actual,
    checkUpdateStatus: vi.fn(),
    fetchLatestGithubRelease: vi.fn(),
    resolveNpmChannelTag: vi.fn(),
  };
});

function capture() {
  const calls: Array<{ ok: boolean; payload?: unknown; error?: { message?: string } }> = [];
  const respond = (ok: boolean, payload?: unknown, error?: { message?: string }) =>
    calls.push({ ok, payload, error });
  return { calls, respond };
}

describe("update RPCs for a release-tarball install", () => {
  beforeEach(() => {
    vi.mocked(checkUpdateStatus).mockResolvedValue({
      root: "/home/u/.bitterbot/app/1.4.0",
      installKind: "tarball",
      packageManager: "pnpm",
    });
    vi.mocked(runGatewayUpdate).mockReset();
  });

  it("update.run refuses and names the installer, without running an update", async () => {
    const { calls, respond } = capture();
    await updateHandlers["update.run"]!({ params: {}, respond } as never);
    expect(calls[0]?.ok).toBe(false);
    expect(calls[0]?.error?.message).toBe(TARBALL_UPDATE_REFUSAL);
    expect(runGatewayUpdate).not.toHaveBeenCalled();
  });

  it("update.check asks GitHub for this platform's tarball and returns the installer command", async () => {
    vi.mocked(fetchLatestGithubRelease).mockResolvedValue({
      latestVersion: "999.0.0",
      source: "github-releases",
    });
    const { calls, respond } = capture();
    await updateHandlers["update.check"]!({ params: { fetch: true }, respond } as never);
    expect(calls[0]?.ok).toBe(true);
    const payload = calls[0]?.payload as {
      registryLatest: string | null;
      updateCommand: string | null;
      staleness: { stale: boolean; reason: string };
    };
    expect(payload.registryLatest).toBe("999.0.0");
    expect(payload.updateCommand).toBe(TARBALL_UPDATE_COMMAND);
    expect(payload.staleness).toMatchObject({ stale: true, reason: "package-version" });
    const call = vi.mocked(fetchLatestGithubRelease).mock.calls[0]?.[0];
    if (
      process.platform === "linux" ||
      (process.platform === "darwin" && process.arch === "arm64")
    ) {
      expect(call?.target).toEqual({
        kind: "tarball",
        platformId: `${process.platform}-${process.arch}`,
      });
    }
  });
});
