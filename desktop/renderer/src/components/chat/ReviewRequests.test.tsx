import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ReviewRequests } from "./ReviewRequests";

const state = vi.hoisted(() => ({
  pending: [] as Array<Record<string, unknown>>,
  busy: new Set<string>(),
  resolve: vi.fn(async () => null),
  listen: vi.fn(() => () => {}),
}));

const ui = vi.hoisted(() => ({
  setToolPanelOpen: vi.fn(),
  setPanelMode: vi.fn(),
  requestTakeover: vi.fn(),
}));

vi.mock("../../stores/ui-store", () => ({
  useUIStore: { getState: () => ({ setToolPanelOpen: ui.setToolPanelOpen }) },
}));
vi.mock("../../stores/artifact-store", () => ({
  useArtifactStore: { getState: () => ({ setPanelMode: ui.setPanelMode }) },
}));
vi.mock("../../stores/browser-live-store", () => ({
  useBrowserLiveStore: { getState: () => ({ requestTakeover: ui.requestTakeover }) },
}));

vi.mock("../../stores/review-store", () => ({
  useReviewStore: (selector: (s: typeof state) => unknown) => selector(state),
}));

const spend = {
  id: "rv-00000001",
  status: "pending",
  cls: "spend",
  tool: "wallet",
  preview: "Send 5 USDC to 0xabc",
  createdAt: 1,
};
const handoff = {
  ...spend,
  id: "rv-00000003",
  cls: "handoff",
  tool: "browser",
  preview: "Take over the browser: Log in to the shop",
  params: {
    action: "handoff",
    reason: "Log in to the shop",
    profile: "bitterbot",
    url: "https://shop.test/login?next=/cart",
  },
};
const post = { ...spend, id: "rv-00000002", cls: "publish", preview: 'Post to X: "hello"' };

beforeEach(() => {
  state.pending = [];
  state.busy = new Set();
  state.resolve.mockClear();
  state.listen.mockClear();
});

describe("ReviewRequests", () => {
  it("renders nothing when nothing is waiting, but still listens", () => {
    const { container } = render(<ReviewRequests />);

    expect(container.querySelector('[data-testid="review-requests"]')).toBeNull();
    expect(state.listen).toHaveBeenCalled();
  });

  it("asks twice before sending money", async () => {
    state.pending = [spend];
    render(<ReviewRequests />);
    const user = userEvent.setup();

    expect(screen.getByText("Spending needs your approval")).toBeTruthy();
    await user.click(screen.getByText("Approve"));
    expect(state.resolve).not.toHaveBeenCalled();

    await user.click(screen.getByText("Yes, send it"));
    expect(state.resolve).toHaveBeenCalledWith("rv-00000001", "approve");
  });

  it("lets the person back out of the second step", async () => {
    state.pending = [spend];
    render(<ReviewRequests />);
    const user = userEvent.setup();

    await user.click(screen.getByText("Approve"));
    await user.click(screen.getByText("Not yet"));

    expect(screen.getByText("Approve")).toBeTruthy();
    expect(state.resolve).not.toHaveBeenCalled();
  });

  it("approves a post in one step and denies in one step", async () => {
    state.pending = [post];
    render(<ReviewRequests />);
    const user = userEvent.setup();

    expect(screen.getByText("A public post needs your approval")).toBeTruthy();
    await user.click(screen.getByText("Approve"));
    expect(state.resolve).toHaveBeenCalledWith("rv-00000002", "approve");

    await user.click(screen.getByText("Deny"));
    expect(state.resolve).toHaveBeenCalledWith("rv-00000002", "deny");
  });

  it("disables the buttons while a decision is in flight", () => {
    state.pending = [spend];
    state.busy = new Set(["rv-00000001"]);
    render(<ReviewRequests />);

    expect((screen.getByText("Approve").closest("button") as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect((screen.getByText("Deny").closest("button") as HTMLButtonElement).disabled).toBe(true);
  });

  it("opens the live browser and takes control from a handoff card", async () => {
    state.pending = [handoff];
    render(<ReviewRequests />);
    const user = userEvent.setup();

    expect(screen.getByText("Log in to the shop")).toBeTruthy();
    // The site comes from the page, not from the agent's wording.
    expect(screen.getByText("shop.test")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /take over/i }));

    expect(ui.setToolPanelOpen).toHaveBeenCalledWith(true);
    expect(ui.setPanelMode).toHaveBeenCalledWith("browser");
    expect(ui.requestTakeover).toHaveBeenCalled();
    // Taking control accepts the request; the card does not approve it itself.
    expect(state.resolve).not.toHaveBeenCalled();
  });

  it("declines a handoff with Not now", async () => {
    state.pending = [handoff];
    render(<ReviewRequests />);

    await userEvent.setup().click(screen.getByRole("button", { name: /not now/i }));

    expect(state.resolve).toHaveBeenCalledWith("rv-00000003", "deny");
  });

  it("says a first message to someone new is what is waiting", async () => {
    state.pending = [
      { ...post, id: "rv-00000004", cls: "contact", preview: 'Message telegram 999: "hello"' },
    ];
    render(<ReviewRequests />);

    expect(screen.getByText("A message to someone new needs your approval")).toBeTruthy();
    await userEvent.setup().click(screen.getByRole("button", { name: /approve/i }));
    // Only money asks twice.
    expect(state.resolve).toHaveBeenCalledWith("rv-00000004", "approve");
  });

  it("answers a shell command once, always, or not at all", async () => {
    state.pending = [
      {
        ...spend,
        id: "rv-00000005",
        cls: "command",
        tool: "exec",
        preview: "Run: rm -rf build (in /repo)",
        params: { command: "rm -rf build", cwd: "/repo", approvalId: "a1" },
      },
    ];
    render(<ReviewRequests />);
    const user = userEvent.setup();

    expect(screen.getByText("rm -rf build")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /allow once/i }));
    expect(state.resolve).toHaveBeenLastCalledWith("rv-00000005", "approve");
    await user.click(screen.getByRole("button", { name: /always allow/i }));
    expect(state.resolve).toHaveBeenLastCalledWith("rv-00000005", "approve", { always: true });
    await user.click(screen.getByRole("button", { name: /deny/i }));
    expect(state.resolve).toHaveBeenLastCalledWith("rv-00000005", "deny");
  });
});
