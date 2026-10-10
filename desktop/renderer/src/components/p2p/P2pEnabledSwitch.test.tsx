import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { P2pEnabledSwitch } from "./P2pEnabledSwitch";

const requestMock = vi.fn();
vi.mock("../../stores/gateway-store", () => ({
  useGatewayStore: (selector: (state: unknown) => unknown) =>
    selector({ request: requestMock, status: "connected" }),
}));

const configGets = () => requestMock.mock.calls.filter(([m]) => m === "config.get");

describe("P2pEnabledSwitch (PLAN-56 Phase 1)", () => {
  beforeEach(() => {
    requestMock.mockReset();
  });

  it("renders ON when p2p.enabled is unset, patches OFF and shows the gateway restart", async () => {
    requestMock.mockImplementation((method: string) =>
      method === "config.get"
        ? Promise.resolve({ baseHash: "h1", config: {} })
        : Promise.resolve({
            ok: true,
            restart: { scheduled: true, delayMs: 2000 },
            restartReasons: ["p2p"],
          }),
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
    expect(await screen.findByText(/gateway restarting/)).toBeTruthy();
    // No re-read races the restart: config.get ran exactly once (on mount).
    expect(configGets()).toHaveLength(1);
    expect((sw as HTMLButtonElement).disabled).toBe(true);
    expect(sw.getAttribute("aria-checked")).toBe("false");
  });

  it("re-reads the config when the patch did not schedule a restart", async () => {
    requestMock.mockImplementation((method: string) =>
      method === "config.get"
        ? Promise.resolve({ baseHash: "h1", config: { p2p: { enabled: false } } })
        : Promise.resolve({ ok: true, restart: null, reload: { mode: "none" } }),
    );
    render(<P2pEnabledSwitch />);
    const sw = await screen.findByRole("switch", { name: "P2P Mesh Enabled" });
    expect(sw.getAttribute("aria-checked")).toBe("false");
    await userEvent.click(sw);
    await waitFor(() => expect(configGets()).toHaveLength(2));
    expect(screen.queryByText(/gateway restarting/)).toBeNull();
  });

  it("renders the error when config.get fails", async () => {
    requestMock.mockImplementation(() => Promise.reject(new Error("gateway unreachable")));
    render(<P2pEnabledSwitch />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("gateway unreachable");
    expect(screen.queryByRole("switch")).toBeNull();
  });
});
