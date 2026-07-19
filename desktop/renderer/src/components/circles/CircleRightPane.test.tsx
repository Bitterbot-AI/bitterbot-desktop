import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import type { Circle } from "../../stores/circles-store";
import { CircleRightPane } from "./CircleRightPane";

// The right pane is resizable and persists its width. These pin the default
// (90% wider than the old 300px), the persisted read, and double-click reset —
// the drag itself (window mousemove) isn't meaningfully exercisable in happy-dom.

const CIRCLE = {
  circleId: "c1",
  name: "Bio 204",
  kind: "connection",
  status: "active",
  members: [
    {
      memberPubkey: "ed25519:self",
      displayName: "Me",
      role: "creator",
      isSelf: true,
      lastSeenAt: Date.now(),
      lastStatus: "online",
    },
  ],
} as unknown as Circle;

function pane() {
  return screen.getByRole("complementary");
}

afterEach(() => localStorage.clear());

describe("CircleRightPane width", () => {
  it("defaults to 570px (90% wider than the original 300)", () => {
    render(<CircleRightPane circle={CIRCLE} selfPubkey="ed25519:self" cardCount={0} />);
    expect(pane().style.width).toBe("570px");
  });

  it("restores a persisted width within bounds", () => {
    localStorage.setItem("circles.rightPaneWidth", "480");
    render(<CircleRightPane circle={CIRCLE} selfPubkey="ed25519:self" cardCount={0} />);
    expect(pane().style.width).toBe("480px");
  });

  it("ignores an out-of-bounds persisted width and uses the default", () => {
    localStorage.setItem("circles.rightPaneWidth", "99999");
    render(<CircleRightPane circle={CIRCLE} selfPubkey="ed25519:self" cardCount={0} />);
    expect(pane().style.width).toBe("570px");
  });

  it("double-clicking the handle resets to the default and persists it", async () => {
    localStorage.setItem("circles.rightPaneWidth", "480");
    render(<CircleRightPane circle={CIRCLE} selfPubkey="ed25519:self" cardCount={0} />);
    expect(pane().style.width).toBe("480px");
    await userEvent.dblClick(screen.getByRole("separator", { name: /resize/i }));
    expect(pane().style.width).toBe("570px");
    expect(localStorage.getItem("circles.rightPaneWidth")).toBe("570");
  });
});
