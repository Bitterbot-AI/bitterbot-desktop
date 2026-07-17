import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useCirclesStore } from "../../stores/circles-store";
import { CirclesView } from "./CirclesView";
import { sectionSlot } from "./StudyGuideCard";

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
              slices: [],
            },
            {
              cardId: "d1",
              cardType: "decision",
              title: "When do we review?",
              text: "Thu\nFri",
              authorPubkey: "ed25519:maya",
              updatedAt: Date.now(),
              slices: [
                {
                  slot: "vote",
                  value: "Thu",
                  note: "after 6",
                  authorPubkey: "ed25519:maya",
                  updatedAt: Date.now(),
                },
              ],
            },
            {
              cardId: "sg1",
              cardType: "study",
              title: "Midterm 2 guide",
              text: "Glycolysis\nKrebs cycle",
              authorPubkey: "ed25519:maya",
              updatedAt: Date.now(),
              slices: [
                {
                  slot: sectionSlot("Glycolysis"),
                  value: "glucose → 2 pyruvate, net 2 ATP + 2 NADH",
                  note: "lecture 12",
                  authorPubkey: "ed25519:maya",
                  updatedAt: Date.now(),
                },
              ],
            },
          ],
        });
      case "circles.canvas.put":
        return Promise.resolve({ delivered: ["ed25519:maya"], failed: [], cardId: "new" });
      case "circles.canvas.slice":
        return Promise.resolve({ delivered: ["ed25519:maya"], failed: [] });
      case "circles.drafts.list":
        return Promise.resolve({
          drafts: [
            {
              draftId: "dr1",
              circleId: "c1",
              summonEnvelopeId: "env-summon",
              summonAuthorPubkey: "ed25519:maya",
              content: "Thursday at 6 works for us.",
              createdAt: Date.now(),
            },
          ],
        });
      case "circles.drafts.publish":
        return Promise.resolve({ delivered: ["ed25519:maya"], failed: [] });
      case "circles.drafts.discard":
        return Promise.resolve({ ok: true });
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
    cardsByCircle: {},
    draftsByCircle: {},
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

  it("renders a Decision Card and publishes a vote via circles.canvas.slice", async () => {
    stubRpcs();
    render(<CirclesView />);
    await userEvent.click(await screen.findByRole("button", { name: /^Canvas/ }));
    // The decision renders with its question and options.
    expect(await screen.findByText("When do we review?")).toBeTruthy();
    // Pick the "Fri" option, then publish my vote.
    await userEvent.click(screen.getByText("Fri"));
    await userEvent.click(screen.getByRole("button", { name: /Publish my vote/i }));
    await waitFor(() =>
      expect(requestMock).toHaveBeenCalledWith(
        "circles.canvas.slice",
        expect.objectContaining({ cardId: "d1", slot: "vote", value: "Fri" }),
      ),
    );
  });

  it("assembles the study guide (C3): sections, contributions, gaps — and publishes mine", async () => {
    stubRpcs();
    render(<CirclesView />);
    await userEvent.click(await screen.findByRole("button", { name: /^Canvas/ }));
    // The guide renders its coverage, Maya's contribution, and the gap section.
    expect(await screen.findByText("Midterm 2 guide")).toBeTruthy();
    expect(screen.getByText(/1 of 2 sections covered/i)).toBeTruthy();
    expect(screen.getByText("glucose → 2 pyruvate, net 2 ATP + 2 NADH")).toBeTruthy();
    expect(screen.getByText("gap")).toBeTruthy(); // Krebs cycle has no contribution yet
    // Contribute my piece to the gap section and publish it.
    const addButtons = screen.getAllByRole("button", { name: /Add yours/i });
    await userEvent.click(addButtons[addButtons.length - 1]);
    await userEvent.type(screen.getByPlaceholderText(/Krebs cycle/), "8 steps, 2 turns");
    await userEvent.click(screen.getByRole("button", { name: /Publish my contribution/i }));
    await waitFor(() =>
      expect(requestMock).toHaveBeenCalledWith(
        "circles.canvas.slice",
        expect.objectContaining({
          cardId: "sg1",
          slot: sectionSlot("Krebs cycle"),
          value: "8 steps, 2 turns",
        }),
      ),
    );
  });

  it("Phase B: shows the agent draft privately and publishes the EDITED text on consent", async () => {
    stubRpcs();
    render(<CirclesView />);
    // The consent card renders above the composer, marked private.
    expect(await screen.findByText(/Your agent drafted a reply/i)).toBeTruthy();
    expect(screen.getByText(/only you can see this/i)).toBeTruthy();
    const box = screen.getByDisplayValue("Thursday at 6 works for us.");
    // The human edits before approving — what they approved is what ships.
    await userEvent.clear(box);
    await userEvent.type(box, "Thursday at 7 works better.");
    await userEvent.click(screen.getByRole("button", { name: /Publish to circle/i }));
    await waitFor(() =>
      expect(requestMock).toHaveBeenCalledWith("circles.drafts.publish", {
        draftId: "dr1",
        text: "Thursday at 7 works better.",
      }),
    );
  });

  it("Phase B: discarding the draft never sends anything", async () => {
    stubRpcs();
    render(<CirclesView />);
    await screen.findByText(/Your agent drafted a reply/i);
    await userEvent.click(screen.getByRole("button", { name: /^Discard$/ }));
    await waitFor(() =>
      expect(requestMock).toHaveBeenCalledWith("circles.drafts.discard", { draftId: "dr1" }),
    );
    expect(requestMock).not.toHaveBeenCalledWith("circles.drafts.publish", expect.anything());
    expect(requestMock).not.toHaveBeenCalledWith("circles.send", expect.anything());
  });

  it("starts a study guide from the composer via circles.canvas.put", async () => {
    stubRpcs();
    render(<CirclesView />);
    await userEvent.click(await screen.findByRole("button", { name: /^Canvas/ }));
    await userEvent.click(await screen.findByRole("button", { name: /Guide/ }));
    await userEvent.type(screen.getByPlaceholderText(/Study guide title/i), "CHEM final");
    await userEvent.type(screen.getByPlaceholderText(/Sections, one per line/i), "Acids\nBases");
    await userEvent.click(screen.getByRole("button", { name: /Start guide/i }));
    await waitFor(() =>
      expect(requestMock).toHaveBeenCalledWith(
        "circles.canvas.put",
        expect.objectContaining({
          circleId: "c1",
          cardType: "study",
          title: "CHEM final",
          text: "Acids\nBases",
        }),
      ),
    );
  });
});
