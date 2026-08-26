import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayControls } from "./GatewayControls";

const requestMock = vi.fn();
let storeStatus = "connected";
let helloMethods: string[] | undefined;

vi.mock("../../stores/gateway-store", () => ({
  useGatewayStore: (selector: (state: unknown) => unknown) =>
    selector({
      request: requestMock,
      status: storeStatus,
      hello: { features: { methods: helloMethods } },
    }),
}));

describe("GatewayControls", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    requestMock.mockReset();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    storeStatus = "connected";
    helloMethods = ["system.restart", "system.shutdown"];
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("disables Start while connected, Restart/Shutdown while disconnected", () => {
    render(<GatewayControls />);
    expect(
      (screen.getByText("Start gateway").closest("button") as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByText("Restart gateway").closest("button") as HTMLButtonElement).disabled,
    ).toBe(false);

    storeStatus = "connecting";
    render(<GatewayControls />);
    const [, startAgain] = screen.getAllByText("Start gateway");
    const [, restartAgain] = screen.getAllByText("Restart gateway");
    expect((startAgain.closest("button") as HTMLButtonElement).disabled).toBe(false);
    expect((restartAgain.closest("button") as HTMLButtonElement).disabled).toBe(true);
  });

  it("posts to the dev-server endpoint with the token and shows the starting banner", async () => {
    storeStatus = "connecting";
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ok: true, state: "started", pid: 123 }),
    });
    render(<GatewayControls />);
    await userEvent.setup().click(screen.getByText("Start gateway"));

    // The baked VITE_GATEWAY_TOKEN is gone (PLAN-39 Phase 3), so the header is
    // sent only when a token has actually been stored. The call itself is
    // same-origin to the dev server's own middleware.
    expect(fetchMock).toHaveBeenCalledWith(
      "/__gateway/start",
      expect.objectContaining({ method: "POST" }),
    );
    await waitFor(() => expect(screen.getByText(/Starting…/)).toBeTruthy());
  });

  it("sends a stored token when the user has one", async () => {
    // Start is only enabled while disconnected/connecting.
    storeStatus = "connecting";
    localStorage.setItem("bitterbot-gateway-token", "stored-abc");
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ok: true, state: "started", pid: 123 }),
    });
    render(<GatewayControls />);
    await userEvent.setup().click(screen.getByText("Start gateway"));
    expect(fetchMock).toHaveBeenCalledWith(
      "/__gateway/start",
      expect.objectContaining({
        headers: expect.objectContaining({ "x-bitterbot-token": "stored-abc" }),
      }),
    );
    localStorage.clear();
  });

  it("falls back to terminal guidance when the endpoint is unavailable", async () => {
    storeStatus = "connecting";
    fetchMock.mockResolvedValue({
      ok: false,
      status: 404,
      json: () => Promise.reject(new Error("not json")),
    });
    render(<GatewayControls />);
    await userEvent.setup().click(screen.getByText("Start gateway"));
    await waitFor(() => expect(screen.getByText(/pnpm start gateway/)).toBeTruthy());
  });
});
