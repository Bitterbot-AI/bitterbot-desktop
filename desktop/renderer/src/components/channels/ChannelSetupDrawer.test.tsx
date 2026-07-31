import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChannelSetupDrawer } from "./ChannelSetupDrawer";

const requestMock = vi.fn();

vi.mock("../../stores/gateway-store", () => ({
  useGatewayStore: Object.assign(
    (selector: (state: unknown) => unknown) =>
      selector({
        request: requestMock,
        status: "connected",
        hello: { features: { methods: undefined } },
      }),
    { getState: () => ({ request: requestMock }) },
  ),
}));

describe("ChannelSetupDrawer", () => {
  beforeEach(() => {
    requestMock.mockReset();
    requestMock.mockImplementation((method: string) => {
      if (method === "channels.validate")
        return Promise.resolve({ result: { ok: true }, probed: true });
      if (method === "channels.configure")
        return Promise.resolve({ ok: true, runtime: "started", probe: { ok: true } });
      if (method === "channels.update") return Promise.resolve({ ok: true });
      if (method === "web.login.start")
        return Promise.resolve({ qrDataUrl: "data:image/png;base64,abc", message: "Scan it" });
      if (method === "web.login.wait")
        return Promise.resolve({ connected: true, message: "Linked" });
      return Promise.resolve({ ok: true });
    });
  });

  it("validates a draft telegram token without persisting", async () => {
    const user = userEvent.setup();
    render(
      <ChannelSetupDrawer open onOpenChange={() => {}} channelId="telegram" label="Telegram" />,
    );

    await user.type(screen.getByLabelText(/Bot token/), "123456:abc");
    await user.click(screen.getByRole("button", { name: "Validate" }));

    await waitFor(() => {
      expect(requestMock).toHaveBeenCalledWith(
        "channels.validate",
        expect.objectContaining({ channel: "telegram", input: { botToken: "123456:abc" } }),
        expect.anything(),
      );
      expect(screen.getByText(/Connected\./)).toBeTruthy();
    });
    expect(requestMock).not.toHaveBeenCalledWith(
      "channels.configure",
      expect.anything(),
      expect.anything(),
    );
  });

  it("saves via channels.configure and enables the account", async () => {
    const user = userEvent.setup();
    const onSaved = vi.fn();
    render(
      <ChannelSetupDrawer
        open
        onOpenChange={() => {}}
        channelId="telegram"
        label="Telegram"
        onSaved={onSaved}
      />,
    );

    await user.type(screen.getByLabelText(/Bot token/), "123456:abc");
    await user.click(screen.getByRole("button", { name: /Save & Enable/ }));

    await waitFor(() => {
      expect(requestMock).toHaveBeenCalledWith(
        "channels.configure",
        expect.objectContaining({ channel: "telegram", input: { botToken: "123456:abc" } }),
        expect.anything(),
      );
      expect(requestMock).toHaveBeenCalledWith("channels.update", {
        channel: "telegram",
        accountId: undefined,
        enabled: true,
      });
      expect(onSaved).toHaveBeenCalled();
    });
  });

  it("shows the QR pairing path for QR channels and renders the QR", async () => {
    const user = userEvent.setup();
    render(
      <ChannelSetupDrawer open onOpenChange={() => {}} channelId="whatsapp" label="WhatsApp" />,
    );

    await user.click(screen.getByRole("button", { name: /Link device via QR/ }));
    await waitFor(() => {
      expect(requestMock).toHaveBeenCalledWith(
        "web.login.start",
        { channel: "whatsapp" },
        expect.anything(),
      );
      expect(screen.getByAltText(/WhatsApp pairing QR code/)).toBeTruthy();
    });
    await waitFor(() => {
      expect(requestMock).toHaveBeenCalledWith(
        "web.login.wait",
        expect.objectContaining({ channel: "whatsapp" }),
        expect.anything(),
      );
    });
  });

  it("falls back honestly for channels without guided setup", () => {
    render(<ChannelSetupDrawer open onOpenChange={() => {}} channelId="mystery" label="Mystery" />);
    expect(screen.getByText(/Guided setup is not available/)).toBeTruthy();
  });
});
