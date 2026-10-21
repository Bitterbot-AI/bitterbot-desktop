import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { MeshPanel } from "./MeshPanel";
const fake = vi.hoisted(() => ({ status: "connected", request: vi.fn() }));
vi.mock("../../stores/gateway-store", () => ({
  useGatewayStore: (select: (s: typeof fake) => unknown) => select(fake),
}));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
const peer = "12D3KooW" + "A".repeat(44);
const snapshot = {
  ready: true,
  hosting: true,
  pools: ["circle"],
  projects: ["science"],
  peers: [
    {
      peerId: peer,
      accepting: true,
      cpuSlots: 1,
      gpuSlots: 0,
      memoryMib: 256,
      models: [],
      admitted: false,
    },
  ],
  batches: [],
  activity: [],
};
it("keeps approvals explicit and retries the same batch without accessing a wallet", async () => {
  fake.request.mockImplementation(async (method: string) => {
    if (method === "soapbox.mesh.submit") throw Error("response lost");
    return snapshot;
  });
  render(<MeshPanel />);
  await screen.findByText("Discovery active");
  expect(fake.request.mock.calls.every(([method]) => method === "soapbox.mesh.status")).toBe(true);
  fireEvent.click(screen.getByText("Run a distributed batch"));
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.change(screen.getByLabelText("Batch inputs, one per line"), {
    target: { value: "one\ntwo" },
  });
  const button = screen.getByRole("button", { name: "Run distributed batch" });
  fireEvent.click(button);
  await screen.findByRole("alert");
  await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(button);
  await waitFor(() =>
    expect(
      fake.request.mock.calls.filter(([method]) => method === "soapbox.mesh.submit"),
    ).toHaveLength(2),
  );
  const calls = fake.request.mock.calls.filter(([method]) => method === "soapbox.mesh.submit");
  expect(calls[0][1]).toEqual(calls[1][1]);
  expect(calls[0][1]).toMatchObject({
    mode: "private",
    scope: "circle",
    inputs: ["one", "two"],
    peers: [peer],
  });
  expect(
    fake.request.mock.calls.some(
      ([method]) => method.includes("wallet") || method.includes("payment"),
    ),
  ).toBe(false);
});
it("grants only the selected operator scope and shows incoming work", async () => {
  fake.request.mockResolvedValue({
    ...snapshot,
    activity: [{ at: Date.now(), peer, kind: "incoming_succeeded", items: 2 }],
  });
  render(<MeshPanel />);
  await screen.findByText("Discovery active");
  fireEvent.click(screen.getByText("Peers and operator access"));
  fireEvent.change(screen.getByLabelText("Scope to share"), {
    target: { value: "collective:science" },
  });
  fireEvent.click(screen.getByText("Grant selected scope"));
  await waitFor(() =>
    expect(fake.request).toHaveBeenCalledWith("soapbox.mesh.grant", {
      peerId: peer,
      pools: [],
      projects: ["science"],
    }),
  );
  fireEvent.click(screen.getByText("Recent mesh activity"));
  expect(screen.getByText(/incoming succeeded/)).toBeTruthy();
});

it("shows remote cancellation pending without promising resubmission or requesting approval", async () => {
  fake.request.mockResolvedValue({
    ...snapshot,
    batches: [
      {
        id: "cancel",
        kind: "sha256",
        items: 1,
        status: "cancelling",
        shards: [{ status: "queued", peerId: peer, error: "offline" }],
      },
    ],
  });
  render(<MeshPanel />);
  await screen.findByText(/Waiting for the operator to confirm/);
  expect(screen.queryByText(/Retrying the same shard safely/)).toBeNull();
  expect(screen.queryByRole("button", { name: "Cancel batch" })).toBeNull();
  expect(fake.request.mock.calls.every(([method]) => method === "soapbox.mesh.status")).toBe(true);
});

it("does not display a stale retry hint on a cancelled batch and discloses completed work", async () => {
  fake.request.mockResolvedValue({
    ...snapshot,
    batches: [
      {
        id: "cancel",
        kind: "sha256",
        items: 1,
        status: "cancelled",
        shards: [
          {
            status: "cancelled",
            cancelledRemoteStatus: "succeeded",
            peerId: peer,
            error: "old error",
          },
        ],
      },
    ],
  });
  render(<MeshPanel />);
  await screen.findByText(/Some work completed before cancellation/);
  expect(screen.queryByText(/Retrying the same shard safely/)).toBeNull();
  expect(screen.queryByText(/Waiting for the operator to confirm/)).toBeNull();
});
