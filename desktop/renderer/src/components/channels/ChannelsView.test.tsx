import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useChannelsStore } from "../../stores/channels-store";
import { ChannelsView } from "./ChannelsView";

const requestMock = vi.fn();
let helloMethods: string[] | undefined;

vi.mock("../../stores/gateway-store", () => ({
  useGatewayStore: Object.assign(
    (selector: (state: unknown) => unknown) =>
      selector({
        request: requestMock,
        status: "connected",
        hello: { features: { methods: helloMethods } },
      }),
    { getState: () => ({ request: requestMock }) },
  ),
}));

const statusPayload = {
  channelOrder: ["telegram", "imessage"],
  channelLabels: { telegram: "Telegram", imessage: "iMessage" },
  channelAccounts: {
    telegram: [{ accountId: "default", configured: true, enabled: true, connected: true }],
    imessage: [{ accountId: "default", configured: false }],
  },
  channelCapabilities: {
    telegram: { supported: true },
    imessage: {
      supported: false,
      reason: "Requires a darwin gateway host (this gateway runs on linux).",
      platforms: ["darwin"],
    },
  },
  channels: {},
};

describe("ChannelsView", () => {
  beforeEach(() => {
    requestMock.mockReset();
    helloMethods = ["channels.status", "channels.update", "channels.logout"];
    useChannelsStore.setState({ loading: false });
    requestMock.mockImplementation((method: string) => {
      if (method === "channels.status") return Promise.resolve(statusPayload);
      if (method === "channels.update") return Promise.resolve({ ok: true });
      return Promise.resolve({ ok: true });
    });
  });

  it("greys unsupported channels with the host reason instead of hiding them", async () => {
    render(<ChannelsView />);
    await waitFor(() => expect(screen.getByText("iMessage")).toBeTruthy());
    expect(screen.getByText("unavailable on this host")).toBeTruthy();

    // Expanding shows the full reason copy.
    const user = userEvent.setup();
    await user.click(screen.getByText("iMessage"));
    await waitFor(() => expect(screen.getByText(/Requires a darwin gateway host/)).toBeTruthy());
  });

  it("toggles an account off via channels.update", async () => {
    const user = userEvent.setup();
    render(<ChannelsView />);
    await waitFor(() => expect(screen.getByText("Telegram")).toBeTruthy());

    await user.click(screen.getByText("Telegram"));
    const toggle = await screen.findByRole("switch", { name: /Disable Telegram default/ });
    await user.click(toggle);

    await waitFor(() => {
      expect(requestMock).toHaveBeenCalledWith("channels.update", {
        channel: "telegram",
        accountId: "default",
        enabled: false,
      });
    });
  });

  it("hides the toggles when the gateway lacks channels.update", async () => {
    helloMethods = ["channels.status", "channels.logout"];
    const user = userEvent.setup();
    render(<ChannelsView />);
    await waitFor(() => expect(screen.getByText("Telegram")).toBeTruthy());
    await user.click(screen.getByText("Telegram"));
    expect(screen.queryByRole("switch")).toBeNull();
  });
});
