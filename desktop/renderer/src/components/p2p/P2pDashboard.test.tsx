import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useP2pStore } from "../../stores/p2p-store";
import { P2pDashboard } from "./P2pDashboard";

// The P2P dashboard serves two audiences from one component: every node sees
// its own connectivity stats, but the census/growth panels and the
// lifetime/routing metrics row are fleet-operator surfaces — visible ONLY when
// the local orchestrator reports census enabled (--bootnode-mode). Edge nodes
// (enabled:false, or a 404 from older released binaries that predate the
// endpoint) must get a clean dashboard with no error banner.

const requestMock = vi.fn();
const gwState = { request: requestMock, status: "connected", subscribe: () => () => {} };

vi.mock("../../stores/gateway-store", () => ({
  useGatewayStore: Object.assign((selector: (s: unknown) => unknown) => selector(gwState), {
    getState: () => gwState,
  }),
}));

const STATS = {
  peer_id: "12D3KooWEdge",
  connected_peers: 885,
  skills_published: 0,
  skills_received: 0,
  uptime_secs: 120,
  peak_concurrent_peers: 0,
  routing_table_size: 0,
};

const CENSUS = {
  enabled: true,
  lifetime_unique_peers: 42,
  active_last_24h: 40,
  active_last_7d: 41,
  by_tier: { standard: 42 },
  by_address_type: { public: 42 },
  generated_at: 1_700_000_000,
};

function stubFetch(census: { status: number; body?: unknown }) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (String(url).endsWith("/api/stats")) {
        return { ok: true, status: 200, json: async () => STATS } as Response;
      }
      if (String(url).endsWith("/api/contributions")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ skills_published: 0, skills_verified: 0, score: 13.4 }),
        } as unknown as Response;
      }
      if (String(url).endsWith("/api/bootstrap/census")) {
        return {
          ok: census.status === 200,
          status: census.status,
          json: async () => census.body,
        } as unknown as Response;
      }
      throw new Error(`unexpected fetch ${url}`);
    }),
  );
}

function stubGateway(opts: { management: boolean }) {
  requestMock.mockImplementation((method: string) =>
    method === "management.health"
      ? opts.management
        ? Promise.resolve({ networkHealthScore: 0.9 })
        : Promise.reject(new Error("management node service not available"))
      : Promise.resolve({ networkCensus: null, rows: [], count: 0 }),
  );
}

describe("P2pDashboard", () => {
  beforeEach(() => {
    useP2pStore.setState({
      stats: null,
      contributions: null,
      bootstrapCensus: null,
      networkCensus: null,
      censusHistory: [],
      error: null,
      connected: false,
      loading: false,
    });
    stubGateway({ management: false });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("edge node: census 404 shows no error banner and hides operator panels", async () => {
    stubFetch({ status: 404 });
    render(<P2pDashboard />);
    await waitFor(() => expect(screen.getByText("885")).toBeTruthy());

    // The 404 from the missing census endpoint is "not a census node", not an
    // error — the banner must stay clear while stats render fine.
    expect(screen.queryByText(/HTTP 404/)).toBeNull();
    expect(screen.getByText("Connected")).toBeTruthy();

    // Fleet-operator surfaces are hidden on edge nodes.
    expect(screen.queryByText("Network Census")).toBeNull();
    expect(screen.queryByText("Network Growth")).toBeNull();
    expect(screen.queryByText("Peak Concurrent Peers")).toBeNull();
    expect(screen.queryByText("Routing Table Size")).toBeNull();
    expect(screen.queryByText(/Peer IDs \(this session\)/)).toBeNull();
  });

  it("edge node: census enabled:false also hides operator panels", async () => {
    stubFetch({ status: 200, body: { ...CENSUS, enabled: false } });
    render(<P2pDashboard />);
    await waitFor(() => expect(screen.getByText("885")).toBeTruthy());
    expect(screen.queryByText("Network Census")).toBeNull();
    expect(screen.queryByText("Peak Concurrent Peers")).toBeNull();
  });

  it("management node: panels render even when the local orchestrator has no census", async () => {
    // A management node's own orchestrator may not run --bootnode-mode (or,
    // on an old binary, lacks the census endpoint entirely) — the operator
    // still sees the network surfaces, fed by the gossip-pushed snapshot.
    stubGateway({ management: true });
    stubFetch({ status: 404 });
    render(<P2pDashboard />);
    await waitFor(() => expect(screen.getByText("Peak Concurrent Peers")).toBeTruthy());
    expect(screen.getByText("Routing Table Size")).toBeTruthy();
    // No census data yet, so the panel shows its empty state.
    expect(screen.getByText("Network Census")).toBeTruthy();
    expect(screen.getByText("Network Growth")).toBeTruthy();
    expect(screen.queryByText(/HTTP 404/)).toBeNull();
  });

  it("census node: operator panels and lifetime metrics render", async () => {
    stubFetch({ status: 200, body: CENSUS });
    render(<P2pDashboard />);
    await waitFor(() => expect(screen.getByText("Network Peers (lifetime)")).toBeTruthy());
    expect(screen.getAllByText("42").length).toBeGreaterThan(0);
    expect(screen.getByText("Peak Concurrent Peers")).toBeTruthy();
    expect(screen.getByText("Routing Table Size")).toBeTruthy();
    // With data the census panel renders its distribution headings.
    expect(screen.getByText("By node tier")).toBeTruthy();
    expect(screen.getByText("By address type")).toBeTruthy();
    expect(screen.getByText("Network Growth")).toBeTruthy();
  });
});
