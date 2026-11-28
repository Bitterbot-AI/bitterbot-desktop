import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useChatStore } from "../../stores/chat-store";
import { useGatewayStore } from "../../stores/gateway-store";
import { useSessionsStore } from "../../stores/sessions-store";
import { useUIStore } from "../../stores/ui-store";
import { Sidebar } from "./Sidebar";

const request = vi.fn();
const now = Date.now();

beforeEach(() => {
  localStorage.clear();
  request.mockReset();
  // management.health is the feature probe; refuse it so Management stays hidden.
  request.mockImplementation((method: string) =>
    method === "management.health" ? Promise.reject(new Error("no")) : Promise.resolve({}),
  );
  useGatewayStore.setState({ status: "connected", request, error: null } as never);
  useSessionsStore.setState({
    sessions: [
      { key: "s1", derivedTitle: "Pilot handoff", updatedAt: now },
      { key: "s2", label: "Compare intake templates", updatedAt: now - 3 * 86_400_000 },
    ],
  });
  useChatStore.setState({ sessionKey: "s1" });
  useUIStore.setState({ activeTab: "chat", sidebarOpen: true, paletteOpen: false });
});

describe("Sidebar", () => {
  it("lists the person's work and keeps operator views out", () => {
    render(<Sidebar />);
    const primary = screen.getByRole("navigation", { name: "Primary" });
    for (const label of ["New chat", "Search", "Memory", "Automations", "Files", "Circles"]) {
      expect(within(primary).getByRole("button", { name: new RegExp(`^${label}`) })).toBeTruthy();
    }
    expect(screen.getByRole("button", { name: /Control Center/ })).toBeTruthy();
    for (const label of ["Overview", "Usage", "Skills", "Wallet", "Logs"]) {
      expect(screen.queryByRole("button", { name: label })).toBeNull();
    }
  });

  it("groups conversations by recency and marks the open one", () => {
    render(<Sidebar />);
    const today = screen.getByRole("region", { name: "Today" });
    expect(
      within(today).getByRole("button", { name: "Pilot handoff" }).getAttribute("aria-current"),
    ).toBe("page");
    const week = screen.getByRole("region", { name: "Previous 7 days" });
    expect(within(week).getByRole("button", { name: "Compare intake templates" })).toBeTruthy();
  });

  it("shows no conversation section on a clean profile", () => {
    useSessionsStore.setState({ sessions: [] });
    render(<Sidebar />);
    expect(screen.queryByRole("region", { name: "Today" })).toBeNull();
  });

  it("opens a conversation and the Control Center's last view", async () => {
    const user = userEvent.setup();
    useUIStore.setState({ controlTab: "skills" });
    render(<Sidebar />);

    await user.click(screen.getByRole("button", { name: /Control Center/ }));
    expect(useUIStore.getState().activeTab).toBe("skills");

    await user.click(screen.getByRole("button", { name: "Compare intake templates" }));
    expect(useUIStore.getState().activeTab).toBe("chat");
    expect(useChatStore.getState().sessionKey).toBe("s2");
  });

  it("renames a conversation from its menu", async () => {
    const user = userEvent.setup();
    render(<Sidebar />);

    await user.click(screen.getByRole("button", { name: "Actions for Pilot handoff" }));
    await user.click(await screen.findByRole("menuitem", { name: "Rename" }));
    const field = await screen.findByRole("textbox", { name: "Conversation title" });
    await user.clear(field);
    await user.type(field, "Handoff review{Enter}");

    expect(request).toHaveBeenCalledWith("sessions.patch", { key: "s1", label: "Handoff review" });
    expect(await screen.findByRole("button", { name: "Handoff review" })).toBeTruthy();
  });

  it("asks before deleting, by name, and deletes only on confirm", async () => {
    const user = userEvent.setup();
    render(<Sidebar />);

    await user.click(screen.getByRole("button", { name: "Actions for Compare intake templates" }));
    await user.click(await screen.findByRole("menuitem", { name: "Delete" }));
    expect(await screen.findByText(/"Compare intake templates" will be deleted/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(request).not.toHaveBeenCalledWith("sessions.delete", expect.anything());

    await user.click(screen.getByRole("button", { name: "Actions for Compare intake templates" }));
    await user.click(await screen.findByRole("menuitem", { name: "Delete" }));
    await user.click(await screen.findByRole("button", { name: "Delete chat" }));
    expect(request).toHaveBeenCalledWith("sessions.delete", { key: "s2" });
  });

  it("closes, and says the connection state in words", async () => {
    const user = userEvent.setup();
    useGatewayStore.setState({ status: "connecting" } as never);
    render(<Sidebar />);
    expect(screen.getByRole("status").textContent).toContain("Reconnecting");

    await user.click(screen.getByRole("button", { name: "Close sidebar" }));
    expect(useUIStore.getState().sidebarOpen).toBe(false);
    expect(localStorage.getItem("bitterbot-sidebar-open")).toBe("0");
  });
});
