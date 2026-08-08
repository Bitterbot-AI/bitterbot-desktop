import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  circlesAttention,
  resetUnsupportedMethodsForTests,
  useCirclesStore,
} from "../../stores/circles-store";
import { CirclesView } from "./CirclesView";

// PLAN-36 Phase B (identity & lifecycle): creation-before-invite, invite
// reuse, paste-to-join trust parity, and archive-actually-hides. Split from
// CirclesView.test.tsx (file-size cap).

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
      agentPosture: "summon-only",
    },
    {
      memberPubkey: "ed25519:maya",
      displayName: "Maya",
      role: "member",
      isSelf: false,
      lastSeenAt: Date.now(),
      lastStatus: "online",
      agentPosture: "summon-only",
    },
  ],
};

function stubRpcs() {
  requestMock.mockImplementation((method: string) => {
    switch (method) {
      case "circles.status":
        return Promise.resolve({ enabled: true, pubkey: "ed25519:self", displayName: "Me" });
      case "circles.list":
        return Promise.resolve({ circles: [CIRCLE] });
      case "circles.messages":
        return Promise.resolve({ annotations: { reactions: {}, pins: [] }, messages: [] });
      case "circles.canvas.list":
        return Promise.resolve({ cards: [] });
      case "circles.invite":
        return Promise.resolve({ code: "bbc1.xyz", link: "https://join…/xyz", qrPngBase64: "" });
      default:
        return Promise.resolve({});
    }
  });
}

beforeEach(() => {
  resetUnsupportedMethodsForTests();
  requestMock.mockReset();
  useCirclesStore.setState({
    status: null,
    circles: [],
    activeCircleId: null,
    messagesByCircle: {},
    annotationsByCircle: {},
    readFrontierByCircle: {},
    historyExhaustedByCircle: {},
    cardsByCircle: {},
    removedByCircle: {},
    sandboxByCircle: {},
    draftsByCircle: {},
    studyByCard: {},
    outboundByCircle: {},
    loading: true,
    notice: null,
    focusCardId: null,
  });
});

describe("circle lifecycle (Phase B)", () => {
  it("names a new circle up front and reuses it across invite mints", async () => {
    stubRpcs();
    const base = requestMock.getMockImplementation()!;
    requestMock.mockImplementation((method: string, params?: unknown) => {
      if (method === "circles.invite") {
        const p = params as { circleId?: string };
        return Promise.resolve({
          code: p.circleId ? "bbc1.second" : "bbc1.first",
          link: "https://join…/x",
          qrPngBase64: "",
          circleId: p.circleId ?? "c9",
        });
      }
      return base(method, params);
    });
    render(<CirclesView />);
    await userEvent.click(await screen.findByRole("button", { name: /New circle/i }));
    await userEvent.type(screen.getByLabelText("Circle name"), "Tahoe trip");
    await userEvent.click(screen.getByRole("button", { name: /Create invite/i }));
    // The name travels with the FIRST mint — the circle is named before it exists.
    await waitFor(() =>
      expect(requestMock).toHaveBeenCalledWith("circles.invite", { name: "Tahoe trip" }),
    );
    // Every further mint reuses the created circle: no accidental duplicates.
    await userEvent.click(await screen.findByRole("button", { name: /New invite code/i }));
    await waitFor(() =>
      expect(requestMock).toHaveBeenCalledWith("circles.invite", { circleId: "c9" }),
    );
  });

  it("creates a circle without inviting (explicit circles.create path)", async () => {
    stubRpcs();
    const base = requestMock.getMockImplementation()!;
    requestMock.mockImplementation((method: string, params?: unknown) => {
      if (method === "circles.create") return Promise.resolve({ circleId: "c9" });
      return base(method, params);
    });
    render(<CirclesView />);
    await userEvent.click(await screen.findByRole("button", { name: /New circle/i }));
    await userEvent.type(screen.getByLabelText("Circle name"), "Study group");
    await userEvent.click(screen.getByRole("button", { name: /Create without inviting/i }));
    await waitFor(() =>
      expect(requestMock).toHaveBeenCalledWith("circles.create", { name: "Study group" }),
    );
  });

  it("paste-to-join verifies the code's signer before joining (join parity)", async () => {
    stubRpcs();
    const CODE = "bbc1." + "B".repeat(40);
    const base = requestMock.getMockImplementation()!;
    requestMock.mockImplementation((method: string, params?: unknown) => {
      if (method === "circles.inviteInfo") {
        return Promise.resolve({
          circleName: "Trip crew",
          inviterName: "Maya",
          inviterPubkey: "ed25519:" + "b".repeat(64),
          knownAs: null,
        });
      }
      if (method === "circles.join") {
        return Promise.resolve({ circleName: "Trip crew", inviterName: "Maya" });
      }
      return base(method, params);
    });
    render(<CirclesView />);
    await userEvent.click(await screen.findByRole("button", { name: /New circle/i }));
    await userEvent.type(screen.getByPlaceholderText("bbc1.…"), CODE);
    // Pasting is not joining: the code is verified and the signer shown first.
    await userEvent.click(screen.getByRole("button", { name: /Check invite/i }));
    expect(await screen.findByText(/signed by someone you don't know/)).toBeTruthy();
    expect(requestMock).not.toHaveBeenCalledWith("circles.join", expect.anything());
    await userEvent.click(screen.getByRole("button", { name: /^Join$/ }));
    await waitFor(() => expect(requestMock).toHaveBeenCalledWith("circles.join", { code: CODE }));
  });

  it("never auto-selects an archived circle: all-archived shows the empty state", async () => {
    stubRpcs();
    const base = requestMock.getMockImplementation()!;
    requestMock.mockImplementation((method: string, params?: unknown) => {
      if (method === "circles.list") {
        return Promise.resolve({
          circles: [{ ...CIRCLE, circleId: "c-old", name: "Old crew", status: "archived" }],
        });
      }
      return base(method, params);
    });
    render(<CirclesView />);
    // The only circle is archived → nothing auto-selected, no hidden-tile
    // dead-end; the empty state (with its CTA) shows instead.
    expect(await screen.findByText(/No circles yet/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Old crew" })).toBeNull();
  });

  it("shows pending approvals as an amber rail badge (Phase C)", async () => {
    stubRpcs();
    const base = requestMock.getMockImplementation()!;
    requestMock.mockImplementation((method: string, params?: unknown) => {
      if (method === "circles.list") {
        return Promise.resolve({ circles: [{ ...CIRCLE, pendingApprovals: 2, unread: 0 }] });
      }
      return base(method, params);
    });
    render(<CirclesView />);
    expect(await screen.findByTitle(/2 agent actions need your approval/)).toBeTruthy();
  });

  it("posture chip is real and toggles the drafts switch (Phase C)", async () => {
    stubRpcs();
    const base = requestMock.getMockImplementation()!;
    requestMock.mockImplementation((method: string, params?: unknown) => {
      if (method === "circles.agentDrafts.set") {
        return Promise.resolve({ enabled: false, posture: "off" });
      }
      return base(method, params);
    });
    render(<CirclesView />);
    // Chip reads the roster's self row (agentPosture: "summon-only").
    const chip = await screen.findByRole("button", { name: /Agents: summon-only/ });
    await userEvent.click(chip);
    await waitFor(() =>
      expect(requestMock).toHaveBeenCalledWith("circles.agentDrafts.set", { enabled: false }),
    );
  });

  it("disables canvas participation with the reason when generation is off (Phase C)", async () => {
    stubRpcs();
    const base = requestMock.getMockImplementation()!;
    requestMock.mockImplementation((method: string, params?: unknown) => {
      if (method === "circles.sandbox.state") {
        return Promise.resolve({
          generationEnabled: false,
          practicePubkey: null,
          participation: null,
          thinkingCardIds: [],
          sessions: [],
        });
      }
      return base(method, params);
    });
    render(<CirclesView />);
    // Ticking the box would be a silent no-op — it must say so and disable.
    expect(await screen.findByText(/Agent generation is off on this node/)).toBeTruthy();
    const checkbox = screen.getByRole("checkbox");
    expect((checkbox as HTMLInputElement).disabled).toBe(true);
  });

  it("errors render as errors, tips as tips (Phase D notice split)", async () => {
    stubRpcs();
    const base = requestMock.getMockImplementation()!;
    requestMock.mockImplementation((method: string, params?: unknown) => {
      if (method === "circles.send") return Promise.reject(new Error("fan-out failed"));
      return base(method, params);
    });
    render(<CirclesView />);
    const composer = await screen.findByPlaceholderText(/Message the circle/);
    await userEvent.type(composer, "hello{Enter}");
    // A failed send wears the destructive treatment, not the friendly blue.
    const bar = await screen.findByRole("alert");
    expect(bar.textContent).toContain("fan-out failed");
    // Info notices keep the status role.
    useCirclesStore.getState().setNotice("just a tip");
    expect(await screen.findByRole("status")).toBeTruthy();
  });

  it("a pin tap jumps to its message (Phase D clickable pins)", async () => {
    stubRpcs();
    const base = requestMock.getMockImplementation()!;
    requestMock.mockImplementation((method: string, params?: unknown) => {
      if (method === "circles.messages") {
        return Promise.resolve({
          annotations: { reactions: {}, pins: ["env-p1"] },
          messages: [
            {
              messageId: "p1",
              envelopeId: "env-p1",
              authorPubkey: "ed25519:maya",
              direction: "in",
              kind: "message",
              content: "the pinned plan",
              createdAt: Date.now(),
            },
          ],
        });
      }
      return base(method, params);
    });
    render(<CirclesView />);
    await userEvent.click(await screen.findByText(/1 pinned message/));
    await userEvent.click(await screen.findByTitle("Jump to this message"));
    // The row briefly highlights (scrolled + flashed).
    await waitFor(() => {
      const row = document.querySelector('[data-envelope="env-p1"]');
      expect(row?.className).toContain("bg-circle-you-soft");
    });
  });

  it("circlesAttention sums unread + approvals, excluding archived", () => {
    const attention = circlesAttention([
      { ...CIRCLE, unread: 3, pendingApprovals: 1 },
      { ...CIRCLE, circleId: "c2", unread: 2, pendingApprovals: 0 },
      { ...CIRCLE, circleId: "c3", status: "archived", unread: 50, pendingApprovals: 9 },
    ]);
    expect(attention).toEqual({ unread: 5, approvals: 1 });
  });

  it("hides archived circles behind the rail's archive toggle", async () => {
    stubRpcs();
    const base = requestMock.getMockImplementation()!;
    requestMock.mockImplementation((method: string, params?: unknown) => {
      if (method === "circles.list") {
        return Promise.resolve({
          circles: [
            CIRCLE,
            {
              circleId: "c-old",
              name: "Old crew",
              kind: "connection",
              status: "archived",
              members: [],
            },
          ],
        });
      }
      return base(method, params);
    });
    render(<CirclesView />);
    await waitFor(() => expect(screen.getAllByText("Bio 204").length).toBeGreaterThan(0));
    // Archived = actually hidden (the confirm's promise), until the toggle.
    expect(screen.queryByRole("button", { name: "Old crew" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /Show 1 archived circle/ }));
    expect(await screen.findByRole("button", { name: "Old crew" })).toBeTruthy();
  });
});
