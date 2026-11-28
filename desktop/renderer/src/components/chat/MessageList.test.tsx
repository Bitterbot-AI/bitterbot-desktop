import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useChatStore, type ChatMessage } from "../../stores/chat-store";
import { useDraftStore } from "../../stores/draft-store";
import { isNearBottom, MessageList } from "./MessageList";

const msg = (id: string, role: ChatMessage["role"], content: string): ChatMessage => ({
  id,
  role,
  content,
  timestamp: 0,
});

/** happy-dom lays nothing out, so give the transcript a size to scroll in. */
function size(el: HTMLElement, scrollHeight: number, clientHeight = 400) {
  Object.defineProperty(el, "scrollHeight", { configurable: true, value: scrollHeight });
  Object.defineProperty(el, "clientHeight", { configurable: true, value: clientHeight });
}

beforeEach(() => {
  useDraftStore.setState({ drafts: {}, scroll: {} });
  useChatStore.setState({
    sessionKey: "a",
    loading: false,
    activeRun: null,
    messages: [
      msg("1", "user", "Summarize the handoff requirements."),
      msg("2", "assistant", "The review owner signs off before the pilot starts."),
    ],
  });
});

describe("transcript", () => {
  it("counts as at the end only within 48px of it", () => {
    expect(isNearBottom({ scrollHeight: 2000, clientHeight: 400, scrollTop: 1552 })).toBe(true);
    expect(isNearBottom({ scrollHeight: 2000, clientHeight: 400, scrollTop: 1551 })).toBe(false);
  });

  it("sets replies on the canvas without avatars or role labels", () => {
    render(<MessageList />);
    expect(screen.getByText("The review owner signs off before the pilot starts.")).toBeTruthy();
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("offers Jump to latest once the reader scrolls up, and leaves them there", () => {
    render(<MessageList />);
    const el = screen.getByTestId("transcript");
    size(el, 2000);
    el.scrollTop = 300;
    fireEvent.scroll(el);
    expect(screen.getByRole("button", { name: /Jump to latest/ })).toBeTruthy();

    // A reply arriving does not pull the reader away.
    act(() =>
      useChatStore.setState((s) => ({ messages: [...s.messages, msg("3", "assistant", "More")] })),
    );
    expect(el.scrollTop).toBe(300);

    fireEvent.click(screen.getByRole("button", { name: /Jump to latest/ }));
    expect(el.scrollTop).toBe(2000);
    expect(screen.queryByRole("button", { name: /Jump to latest/ })).toBeNull();
  });

  it("brings the person's own new message into view even after scrolling up", () => {
    render(<MessageList />);
    const el = screen.getByTestId("transcript");
    size(el, 2000);
    el.scrollTop = 300;
    fireEvent.scroll(el);
    act(() =>
      useChatStore.setState((s) => ({ messages: [...s.messages, msg("3", "user", "Next")] })),
    );
    expect(el.scrollTop).toBe(2000);
  });

  it("remembers the reading position per conversation", () => {
    const { unmount } = render(<MessageList />);
    const el = screen.getByTestId("transcript");
    size(el, 2000);
    el.scrollTop = 640;
    fireEvent.scroll(el);
    unmount();
    expect(useDraftStore.getState().scroll.a).toBe(640);

    // The returning transcript needs a size before it mounts, or there is
    // nothing to scroll within.
    const proto = HTMLElement.prototype;
    Object.defineProperty(proto, "scrollHeight", { configurable: true, get: () => 2000 });
    Object.defineProperty(proto, "clientHeight", { configurable: true, get: () => 400 });
    try {
      render(<MessageList />);
      expect(screen.getByTestId("transcript").scrollTop).toBe(640);
    } finally {
      delete (proto as { scrollHeight?: number }).scrollHeight;
      delete (proto as { clientHeight?: number }).clientHeight;
    }
  });
});
