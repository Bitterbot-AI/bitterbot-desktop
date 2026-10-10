import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { P2pEnabledSwitch } from "./P2pEnabledSwitch";

const requestMock = vi.fn();
vi.mock("../../stores/gateway-store", () => ({
  useGatewayStore: (selector: (state: unknown) => unknown) =>
    selector({ request: requestMock, status: "connected" }),
}));

describe("P2pEnabledSwitch (PLAN-56 Phase 1)", () => {
  beforeEach(() => {
    requestMock.mockReset();
  });

  it("renders ON when p2p.enabled is unset (the load-time default) and patches OFF", async () => {
    requestMock.mockImplementation((method: string) =>
      method === "config.get"
        ? Promise.resolve({ baseHash: "h1", config: {} })
        : Promise.resolve({}),
    );
    render(<P2pEnabledSwitch />);
    const sw = await screen.findByRole("switch", { name: "P2P Mesh Enabled" });
    expect(sw.getAttribute("aria-checked")).toBe("true");
    await userEvent.click(sw);
    await waitFor(() =>
      expect(requestMock).toHaveBeenCalledWith("config.patch", {
        raw: JSON.stringify({ p2p: { enabled: false } }),
        baseHash: "h1",
      }),
    );
    expect(await screen.findByText(/restart the gateway to apply/)).toBeTruthy();
  });

  it("renders OFF when the config sets p2p.enabled=false", async () => {
    requestMock.mockImplementation((method: string) =>
      method === "config.get"
        ? Promise.resolve({ baseHash: "h1", config: { p2p: { enabled: false } } })
        : Promise.resolve({}),
    );
    render(<P2pEnabledSwitch />);
    const sw = await screen.findByRole("switch", { name: "P2P Mesh Enabled" });
    expect(sw.getAttribute("aria-checked")).toBe("false");
  });

  it("renders nothing when config.get is unavailable", async () => {
    requestMock.mockImplementation(() => Promise.reject(new Error("nope")));
    render(<P2pEnabledSwitch />);
    await waitFor(() => expect(requestMock).toHaveBeenCalled());
    expect(screen.queryByRole("switch")).toBeNull();
  });
});
