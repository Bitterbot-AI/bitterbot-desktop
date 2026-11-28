import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useChatStore } from "../../stores/chat-store";
import { useGatewayStore } from "../../stores/gateway-store";
import { useSessionsStore } from "../../stores/sessions-store";
import { useUIStore } from "../../stores/ui-store";
import { CommandPalette, matchesAllWords } from "./CommandPalette";

// cmdk scrolls the selected row into view; happy-dom has no layout.
Element.prototype.scrollIntoView = vi.fn();

beforeEach(() => {
  localStorage.clear();
  const request = vi.fn(() => Promise.reject(new Error("no")));
  useGatewayStore.setState({ status: "connected", request } as never);
  useSessionsStore.setState({
    sessions: [
      { key: "s1", derivedTitle: "Pilot handoff" },
      { key: "s2", derivedTitle: "Compare intake templates" },
    ],
  });
  useChatStore.setState({ sessionKey: "s1" });
  useUIStore.setState({ activeTab: "chat", paletteOpen: false });
});

describe("CommandPalette", () => {
  it("opens on Ctrl+K and closes on the same keys", async () => {
    const user = userEvent.setup();
    render(<CommandPalette />);
    expect(screen.queryByPlaceholderText(/Search conversations/)).toBeNull();

    await user.keyboard("{Control>}k{/Control}");
    expect(await screen.findByPlaceholderText(/Search conversations/)).toBeTruthy();

    await user.keyboard("{Control>}k{/Control}");
    expect(useUIStore.getState().paletteOpen).toBe(false);
  });

  it("finds a conversation by title and opens it", async () => {
    const user = userEvent.setup();
    useUIStore.setState({ paletteOpen: true });
    render(<CommandPalette />);

    await user.type(await screen.findByPlaceholderText(/Search conversations/), "intake");
    expect(screen.queryByText("Pilot handoff")).toBeNull();
    await user.click(screen.getByText("Compare intake templates"));

    expect(useChatStore.getState().sessionKey).toBe("s2");
    expect(useUIStore.getState().paletteOpen).toBe(false);
  });

  it("goes to a view, and leaves out ones this gateway does not offer", async () => {
    const user = userEvent.setup();
    useUIStore.setState({ paletteOpen: true });
    render(<CommandPalette />);

    await user.type(await screen.findByPlaceholderText(/Search conversations/), "manag");
    expect(screen.queryByText("Management")).toBeNull();

    await user.clear(screen.getByPlaceholderText(/Search conversations/));
    await user.type(screen.getByPlaceholderText(/Search conversations/), "wallet");
    await user.click(screen.getByText("Wallet"));
    expect(useUIStore.getState().activeTab).toBe("wallet");
  });

  it("says plainly that contents are not searched yet", async () => {
    const user = userEvent.setup();
    useUIStore.setState({ paletteOpen: true });
    render(<CommandPalette />);
    await user.type(await screen.findByPlaceholderText(/Search conversations/), "zzzzqqq");
    expect(screen.getByText(/titles, not their contents yet/)).toBeTruthy();
  });
});

describe("palette matching", () => {
  it("needs every typed word, in any order, and is not fuzzy", () => {
    const item = ["Draft the release notes for 1.15"];
    expect(matchesAllWords("x", "release draft", item)).toBe(1);
    expect(matchesAllWords("x", "RELEASE", item)).toBe(1);
    expect(matchesAllWords("x", "clone", item)).toBe(0);
    expect(matchesAllWords("x", "release clone", item)).toBe(0);
    expect(matchesAllWords("x", "", item)).toBe(1);
  });

  it("never matches on the hidden id", () => {
    expect(matchesAllWords("session chat-demo-2", "chat", ["Pilot handoff"])).toBe(0);
  });
});
