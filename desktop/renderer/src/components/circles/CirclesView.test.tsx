import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useCirclesStore } from "../../stores/circles-store";
import { CirclesView } from "./CirclesView";

// PLAN-36 Phase A: the Circles chat shell renders circles + messages + presence
// from the circles.* RPCs, and the composer sends via circles.send.

const requestMock = vi.fn();
const gwState = { request: requestMock, status: "connected", subscribe: () => () => {} };

vi.mock("../../stores/gateway-store", () => ({
  useGatewayStore: Object.assign((selector: (s: unknown) => unknown) => selector(gwState), {
    getState: () => gwState,
  }),
}));

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
    {
      memberPubkey: "ed25519:maya",
      displayName: "Maya",
      role: "member",
      isSelf: false,
      lastSeenAt: Date.now(),
      lastStatus: "online",
    },
  ],
};

function stubRpcs(enabled = true) {
  requestMock.mockImplementation((method: string) => {
    switch (method) {
      case "circles.status":
        return Promise.resolve({ enabled, pubkey: "ed25519:self" });
      case "circles.list":
        return Promise.resolve({ circles: [CIRCLE] });
      case "circles.messages":
        return Promise.resolve({
          messages: [
            {
              messageId: "m1",
              authorPubkey: "ed25519:maya",
              direction: "in",
              kind: "message",
              content: "hi from Maya",
              createdAt: Date.now(),
            },
          ],
        });
      case "circles.canvas.list":
        return Promise.resolve({
          cards: [
            {
              cardId: "card1",
              cardType: "note",
              title: "Study plan",
              text: "cover Krebs first",
              authorPubkey: "ed25519:maya",
              updatedAt: Date.now(),
            },
          ],
        });
      case "circles.send":
        return Promise.resolve({ delivered: ["ed25519:maya"], failed: [] });
      case "circles.markRead":
        return Promise.resolve({ ok: true });
      default:
        return Promise.resolve({});
    }
  });
}

beforeEach(() => {
  requestMock.mockReset();
  useCirclesStore.setState({
    status: null,
    circles: [],
    activeCircleId: null,
    messagesByCircle: {},
    loading: true,
    notice: null,
  });
});

describe("CirclesView", () => {
  it("renders the circle, its conversation, and its members", async () => {
    stubRpcs();
    render(<CirclesView />);
    // Circle name appears in the chat header AND presence shows the peer.
    await waitFor(() => expect(screen.getAllByText("Bio 204").length).toBeGreaterThan(0));
    expect(await screen.findByText("hi from Maya")).toBeTruthy();
    // "Maya" appears as both the message author and in the presence roster.
    expect(screen.getAllByText("Maya").length).toBeGreaterThan(0);
  });

  it("sends a message through circles.send", async () => {
    stubRpcs();
    render(<CirclesView />);
    const box = await screen.findByPlaceholderText("Message the circle…");
    await userEvent.type(box, "hello everyone{Enter}");
    await waitFor(() =>
      expect(requestMock).toHaveBeenCalledWith("circles.send", {
        circleId: "c1",
        text: "hello everyone",
      }),
    );
  });

  it("shows the explainer when circles are disabled", async () => {
    stubRpcs(false);
    render(<CirclesView />);
    expect(await screen.findByText(/Circles are off on this node/i)).toBeTruthy();
  });

  it("badges unread on other circles and marks the open one read", async () => {
    requestMock.mockImplementation((method: string) => {
      switch (method) {
        case "circles.status":
          return Promise.resolve({ enabled: true, pubkey: "ed25519:self" });
        case "circles.list":
          return Promise.resolve({
            circles: [
              { ...CIRCLE }, // c1: auto-selected, no unread
              {
                circleId: "c2",
                name: "Trip",
                kind: "connection",
                status: "active",
                unread: 3,
                members: CIRCLE.members,
              },
            ],
          });
        case "circles.messages":
          return Promise.resolve({ messages: [] });
        case "circles.markRead":
          return Promise.resolve({ ok: true });
        default:
          return Promise.resolve({});
      }
    });
    render(<CirclesView />);
    // The open circle is marked read…
    await waitFor(() =>
      expect(requestMock).toHaveBeenCalledWith("circles.markRead", { circleId: "c1" }),
    );
    // …while the other circle badges its unread count.
    expect(await screen.findByText("3")).toBeTruthy();
  });

  it("shows the group canvas cards on the Canvas tab", async () => {
    stubRpcs();
    render(<CirclesView />);
    // Right pane defaults to Members; switch to the Canvas tab.
    const canvasTab = await screen.findByRole("button", { name: /^Canvas/ });
    await userEvent.click(canvasTab);
    expect(await screen.findByText("Study plan")).toBeTruthy();
    expect(screen.getByText("cover Krebs first")).toBeTruthy();
  });
});
