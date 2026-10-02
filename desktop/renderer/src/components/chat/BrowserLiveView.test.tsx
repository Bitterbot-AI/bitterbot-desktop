import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserLiveView } from "./BrowserLiveView";

type Live = {
  state: string;
  reason?: string;
  url?: string;
  title?: string;
  frame: { src: string; seq: number; deviceWidth: number; deviceHeight: number } | null;
  control?: "agent" | "user";
  mine: boolean;
};

const live = vi.hoisted(() => ({
  value: { state: "connecting", frame: null, mine: false } as Live,
  activeArgs: [] as boolean[],
}));
const actions = vi.hoisted(() => ({
  takeControl: vi.fn(async () => {}),
  handBack: vi.fn(async () => {}),
  sendInput: vi.fn(),
}));

vi.mock("../../hooks/useBrowserLive", () => ({
  useBrowserLive: (active: boolean) => {
    live.activeArgs.push(active);
    return live.value;
  },
}));

vi.mock("../../stores/browser-live-store", () => ({
  useBrowserLiveStore: (selector: (s: typeof actions) => unknown) => selector(actions),
}));

const FRAME = { src: "data:image/jpeg;base64,QUJD", seq: 1, deviceWidth: 1280, deviceHeight: 800 };
const streaming = (over: Partial<Live> = {}): Live => ({
  state: "streaming",
  url: "https://shop.example.com/cart",
  title: "Cart",
  frame: FRAME,
  control: "agent",
  mine: false,
  ...over,
});

beforeEach(() => {
  live.value = { state: "connecting", frame: null, mine: false };
  live.activeArgs = [];
  actions.takeControl.mockClear();
  actions.handBack.mockClear();
  actions.sendInput.mockClear();
  // The pane shows the 1280x800 page at half size, offset inside the window.
  vi.spyOn(HTMLImageElement.prototype, "getBoundingClientRect").mockReturnValue({
    left: 100,
    top: 50,
    width: 640,
    height: 400,
    right: 740,
    bottom: 450,
    x: 100,
    y: 50,
    toJSON: () => ({}),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("BrowserLiveView", () => {
  it("asks for the stream as soon as it is on screen", () => {
    render(<BrowserLiveView />);

    expect(live.activeArgs).toContain(true);
  });

  it("shows the agent's page and its address when streaming", () => {
    live.value = streaming();

    render(<BrowserLiveView />);

    const img = screen.getByRole("img") as HTMLImageElement;
    expect(img.getAttribute("src")).toBe("data:image/jpeg;base64,QUJD");
    expect(img.getAttribute("alt")).toBe("Agent's browser: Cart");
    expect(screen.getByTestId("browser-live-url").textContent).toBe(
      "https://shop.example.com/cart",
    );
    expect(screen.getByText("Live")).toBeTruthy();
  });

  it("says the browser is not open instead of showing an empty frame", () => {
    live.value = { state: "idle", frame: null, mine: false };

    render(<BrowserLiveView />);

    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByText("The browser is not open")).toBeTruthy();
    expect(screen.getByText("Not live")).toBeTruthy();
    expect(screen.queryByText("Take over")).toBeNull();
  });

  it("gives the reason when the live view cannot run", () => {
    live.value = {
      state: "unavailable",
      reason: "live view is turned off (browser.liveView.enabled)",
      frame: null,
      mine: false,
    };

    render(<BrowserLiveView />);

    expect(screen.getByText("Live view is not available")).toBeTruthy();
    expect(screen.getByText("live view is turned off (browser.liveView.enabled)")).toBeTruthy();
  });

  it("does not claim to be live before the first frame arrives", () => {
    live.value = { state: "streaming", url: "https://example.com", frame: null, mine: false };

    render(<BrowserLiveView />);

    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByText("Not live")).toBeTruthy();
    expect(screen.getByText("Waiting for the first frame.")).toBeTruthy();
  });
});

describe("BrowserLiveView: taking control", () => {
  it("only watches until the person takes over", async () => {
    live.value = streaming();
    render(<BrowserLiveView />);

    // Clicking the picture of the page must not click the page.
    fireEvent.mouseDown(screen.getByTestId("browser-live-surface"), { clientX: 420, clientY: 250 });
    fireEvent.keyDown(screen.getByTestId("browser-live-surface"), { key: "a", code: "KeyA" });
    expect(actions.sendInput).not.toHaveBeenCalled();

    await userEvent.setup().click(screen.getByText("Take over"));
    expect(actions.takeControl).toHaveBeenCalledTimes(1);
  });

  it("says plainly that the agent is held while the person has control", () => {
    live.value = streaming({ control: "user", mine: true });

    render(<BrowserLiveView />);

    expect(
      screen.getByText(
        "You are in control. The agent cannot act on this page until you hand it back.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText("Take over")).toBeNull();
  });

  it("clicks the page where the person clicked the image", () => {
    live.value = streaming({ control: "user", mine: true });
    render(<BrowserLiveView />);
    const surface = screen.getByTestId("browser-live-surface");

    // Middle of the half-size image is the middle of the page.
    fireEvent.mouseDown(surface, { clientX: 100 + 320, clientY: 50 + 200, button: 0, buttons: 1 });
    fireEvent.mouseUp(surface, { clientX: 100 + 320, clientY: 50 + 200, button: 0, buttons: 0 });

    expect(actions.sendInput).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ kind: "mouse", type: "down", x: 640, y: 400, button: "left" }),
    );
    expect(actions.sendInput).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ kind: "mouse", type: "up", x: 640, y: 400, button: "left" }),
    );
  });

  it("types into the page, and keeps shortcuts as shortcuts", () => {
    live.value = streaming({ control: "user", mine: true });
    render(<BrowserLiveView />);
    const surface = screen.getByTestId("browser-live-surface");

    fireEvent.keyDown(surface, { key: "h", code: "KeyH", keyCode: 72 });
    fireEvent.keyDown(surface, { key: "a", code: "KeyA", keyCode: 65, ctrlKey: true });

    expect(actions.sendInput).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ kind: "key", type: "down", key: "h", text: "h" }),
    );
    const selectAll = actions.sendInput.mock.calls[1][0];
    expect(selectAll).toMatchObject({ kind: "key", key: "a", modifiers: 2 });
    expect(selectAll).not.toHaveProperty("text");
  });

  it("pastes text as text", () => {
    live.value = streaming({ control: "user", mine: true });
    render(<BrowserLiveView />);

    fireEvent.paste(screen.getByTestId("browser-live-surface"), {
      clipboardData: { getData: () => "correct horse battery staple" },
    });

    expect(actions.sendInput).toHaveBeenCalledWith({
      kind: "text",
      text: "correct horse battery staple",
    });
  });

  it("hands the browser back", async () => {
    live.value = streaming({ control: "user", mine: true });
    render(<BrowserLiveView />);

    await userEvent.setup().click(screen.getByText("Hand back"));

    expect(actions.handBack).toHaveBeenCalledTimes(1);
  });

  it("does not send input from a window that is only watching someone else drive", () => {
    live.value = streaming({ control: "user", mine: false });
    render(<BrowserLiveView />);

    fireEvent.mouseDown(screen.getByTestId("browser-live-surface"), { clientX: 420, clientY: 250 });

    expect(actions.sendInput).not.toHaveBeenCalled();
    expect(
      screen.getByText("Another window has control of this browser. The agent is waiting."),
    ).toBeTruthy();
  });
});
