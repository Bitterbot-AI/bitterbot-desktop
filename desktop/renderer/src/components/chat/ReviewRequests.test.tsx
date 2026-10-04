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
});
