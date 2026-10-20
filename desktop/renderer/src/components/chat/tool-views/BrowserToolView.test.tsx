import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActiveToolCall } from "../../../stores/chat-store";
import { BrowserToolView } from "./BrowserToolView";

const live = vi.hoisted(() => ({
  value: { state: "off", frame: null } as {
    state: string;
    url?: string;
    title?: string;
    frame: { src: string; seq: number; deviceWidth: number; deviceHeight: number } | null;
  },
  activeArgs: [] as boolean[],
}));
const setPanelMode = vi.hoisted(() => vi.fn());

vi.mock("../../../hooks/useBrowserLive", () => ({
  useBrowserLive: (active: boolean) => {
    live.activeArgs.push(active);
    return live.value;
  },
}));

vi.mock("../../../stores/artifact-store", () => ({
  useArtifactStore: (selector: (s: { setPanelMode: typeof setPanelMode }) => unknown) =>
    selector({ setPanelMode }),
}));

const call = (over: Partial<ActiveToolCall>): ActiveToolCall =>
  ({
    id: "call-1",
    name: "browser",
    status: "running",
    args: { action: "navigate", targetUrl: "https://example.com/pricing" },
    ...over,
  }) as ActiveToolCall;

beforeEach(() => {
  live.value = { state: "off", frame: null };
  live.activeArgs = [];
  setPanelMode.mockReset();
});

describe("BrowserToolView", () => {
  it("shows the URL the browser tool was given", () => {
    // The tool's parameter is `targetUrl`. The view used to read `url` and
    // showed about:blank for every real call.
    render(<BrowserToolView toolCall={call({})} />);

    expect(screen.getAllByText("https://example.com/pricing").length).toBeGreaterThan(0);
    expect(screen.queryByText("about:blank")).toBeNull();
  });

  it("shows the real page while the call is running", () => {
    live.value = {
      state: "streaming",
      url: "https://example.com/pricing#plans",
      title: "Pricing",
      frame: { src: "data:image/jpeg;base64,QUJD", seq: 3, deviceWidth: 1280, deviceHeight: 800 },
    };

    render(<BrowserToolView toolCall={call({})} />);

    expect(live.activeArgs.at(-1)).toBe(true);
    expect((screen.getByRole("img") as HTMLImageElement).getAttribute("src")).toBe(
      "data:image/jpeg;base64,QUJD",
    );
    // The address bar follows the page, not the argument the call started with.
    expect(screen.getByText("https://example.com/pricing#plans")).toBeTruthy();
  });

  it("stops watching once the call has finished and offers the live tab", async () => {
    live.value = {
      state: "streaming",
      frame: { src: "data:image/jpeg;base64,QUJD", seq: 3, deviceWidth: 1280, deviceHeight: 800 },
    };

    render(<BrowserToolView toolCall={call({ status: "completed" })} />);

    expect(live.activeArgs.at(-1)).toBe(false);
    // A finished call must not present a later page as its own result.
    expect(screen.queryByRole("img")).toBeNull();
    await userEvent.setup().click(screen.getByText("Watch the browser live"));
    expect(setPanelMode).toHaveBeenCalledWith("browser");
  });
});
