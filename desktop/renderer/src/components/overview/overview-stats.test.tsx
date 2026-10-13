import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayHelloOk } from "../../lib/gateway-client";
import { useGatewayStore } from "../../stores/gateway-store";
import { useOverviewStore } from "../../stores/overview-store";
import { formatPlatform, resolveOverviewStats } from "./overview-stats";

vi.mock("./GatewayControls", () => ({ GatewayControls: () => null }));
vi.mock("./GetStartedCard", () => ({ GetStartedCard: () => null }));
vi.mock("./RepairsCard", () => ({ RepairsCard: () => null }));
vi.mock("./SpendCard", () => ({ SpendCard: () => null }));
vi.mock("./UpdateCard", () => ({ UpdateCard: () => null }));

const { OverviewView } = await import("./OverviewView");

function hello(partial: Partial<GatewayHelloOk>): GatewayHelloOk {
  return { type: "hello-ok", protocol: 3, ...partial };
}

describe("resolveOverviewStats", () => {
  it("is all dashes when nothing was reported", () => {
    expect(resolveOverviewStats(null, null)).toEqual({
      version: "—",
      uptimeSeconds: null,
      platform: "—",
      platformSub: undefined,
      configPath: undefined,
      stateDir: undefined,
    });
  });

  it("prefers the status RPC runtime block", () => {
    const stats = resolveOverviewStats(
      {
        runtime: {
          version: "1.5.0",
          uptimeMs: 3_725_000,
          platform: "linux",
          arch: "x64",
          installKind: "tarball",
        },
      },
      hello({
        server: { version: "1.4.0" },
        snapshot: { uptimeMs: 1000, runtime: { version: "1.4.0", platform: "darwin" } },
      }),
    );
    expect(stats.version).toBe("1.5.0");
    expect(stats.uptimeSeconds).toBe(3725);
    expect(stats.platform).toBe("Linux x64");
    expect(stats.platformSub).toBe("installer (release tarball)");
  });

  it("falls back to the hello snapshot and server version", () => {
    const stats = resolveOverviewStats(
      { channelSummary: [] },
      hello({
        server: { version: "1.4.0", connId: "c1" },
        snapshot: { uptimeMs: 61_000, configPath: "/cfg.json", stateDir: "/state" },
      }),
    );
    expect(stats.version).toBe("1.4.0");
    expect(stats.uptimeSeconds).toBe(61);
    expect(stats.platform).toBe("—");
    expect(stats.configPath).toBe("/cfg.json");
    expect(stats.stateDir).toBe("/state");
  });

  it("names platforms", () => {
    expect(formatPlatform("darwin", "arm64")).toBe("macOS arm64");
    expect(formatPlatform("win32")).toBe("Windows");
    expect(formatPlatform("sunos", "x64")).toBe("sunos x64");
    expect(formatPlatform(undefined, "x64")).toBe("—");
  });
});

describe("OverviewView stat cards", () => {
  beforeEach(() => {
    useOverviewStore.setState({ health: null, status: null, loading: false, error: null });
  });

  it("shows version, uptime and platform from the gateway's status RPC", async () => {
    const request = vi.fn(async (method: string) =>
      method === "status"
        ? {
            channelSummary: [],
            runtime: {
              version: "1.5.0",
              uptimeMs: 7_200_000,
              platform: "linux",
              arch: "arm64",
              installKind: "container",
            },
          }
        : { ts: Date.now(), channels: {} },
    );
    useGatewayStore.setState({
      status: "connected",
      request,
      hello: hello({ server: { version: "1.5.0", connId: "c1" } }),
    } as never);
    render(<OverviewView />);
    await waitFor(() => expect(screen.getByText("Linux arm64")).toBeTruthy());
    expect(screen.getByText("1.5.0")).toBeTruthy();
    expect(screen.getByText("container image")).toBeTruthy();
    expect(request).toHaveBeenCalledWith("status", {});
    const uptimeCard = screen.getByText("Uptime").parentElement;
    expect(uptimeCard?.textContent).not.toContain("—");
  });
});
