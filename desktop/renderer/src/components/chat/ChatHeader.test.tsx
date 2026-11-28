import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useChatStore } from "../../stores/chat-store";
import { useGatewayStore } from "../../stores/gateway-store";
import { useSessionsStore } from "../../stores/sessions-store";
import { useUIStore } from "../../stores/ui-store";
import { ChatHeader } from "./ChatHeader";

vi.mock("../usage/UsageStatusStrip", () => ({ UsageStatusStrip: () => null }));

const request = vi.fn(() => Promise.resolve({}));

beforeEach(() => {
  request.mockClear();
  useGatewayStore.setState({ status: "connected", request } as never);
  useSessionsStore.setState({
    sessions: [{ key: "s1", derivedTitle: "Pilot handoff", updatedAt: Date.now() }],
  });
  useChatStore.setState({ sessionKey: "s1" });
  useUIStore.setState({ sidebarOpen: true, toolPanelOpen: false });
});

describe("chat header", () => {
  it("names a conversation that has not been saved yet New chat", () => {
    useChatStore.setState({ sessionKey: "chat-new" });
    render(<ChatHeader />);
    expect(screen.getByRole("heading", { name: "New chat" })).toBeTruthy();
  });

  it("renames the conversation from its title", async () => {
    const user = userEvent.setup();
    render(<ChatHeader />);
    await user.click(screen.getByRole("button", { name: "Pilot handoff" }));
    const input = screen.getByRole("textbox", { name: "Conversation name" });
    await user.clear(input);
    await user.type(input, "Pilot handoff v2{Enter}");
    expect(request).toHaveBeenCalledWith("sessions.patch", {
      key: "s1",
      label: "Pilot handoff v2",
    });
  });

  it("leaves the name alone on Escape", async () => {
    const user = userEvent.setup();
    render(<ChatHeader />);
    await user.click(screen.getByRole("button", { name: "Pilot handoff" }));
    await user.type(screen.getByRole("textbox", { name: "Conversation name" }), "x{Escape}");
    expect(request).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Pilot handoff" })).toBeTruthy();
  });

  it("opens and closes the Computer pane", async () => {
    const user = userEvent.setup();
    render(<ChatHeader />);
    const toggle = screen.getByRole("button", { name: /Computer/ });
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    await user.click(toggle);
    expect(useUIStore.getState().toolPanelOpen).toBe(true);
  });

  it("offers the way back only while the sidebar is closed", async () => {
    const { rerender } = render(<ChatHeader />);
    expect(screen.queryByRole("button", { name: "Open sidebar" })).toBeNull();
    useUIStore.setState({ sidebarOpen: false });
    rerender(<ChatHeader />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Open sidebar" }));
    expect(useUIStore.getState().sidebarOpen).toBe(true);
  });
});
