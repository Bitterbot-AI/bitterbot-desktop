import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IncomingPanel } from "./IncomingPanel";

const requestMock = vi.fn();
const subscribeMock = vi.fn(() => () => {});

vi.mock("../../stores/gateway-store", () => ({
  useGatewayStore: (selector: (state: unknown) => unknown) =>
    selector({
      request: requestMock,
      status: "connected",
      subscribe: subscribeMock,
    }),
}));

const incoming = [
  {
    name: "candidate-skill",
    author_peer_id: "12D3KooWAbCdEfGhIjKlMnOpQrSt",
    timestamp: 1_700_000_000_000,
    description: "An incoming candidate from a peer",
    signatureValid: true,
    injectionScan: { severity: "low", matches: 0 },
  },
];

describe("IncomingPanel", () => {
  beforeEach(() => {
    requestMock.mockReset();
    subscribeMock.mockClear();
    requestMock.mockImplementation((method: string) => {
      if (method === "skills.incoming.list") return Promise.resolve({ skills: incoming });
      return Promise.resolve({ ok: true });
    });
  });

  it("lists pending incoming skills", async () => {
    render(<IncomingPanel onCountChange={() => {}} />);
    await waitFor(() => {
      expect(screen.getByText(/candidate-skill/i)).toBeTruthy();
    });
  });

  it("calls skills.incoming.accept on Accept", async () => {
    const onCountChange = vi.fn();
    render(<IncomingPanel onCountChange={onCountChange} />);
    await waitFor(() => screen.getByText(/candidate-skill/i));
    const user = userEvent.setup();
    await user.click(screen.getAllByRole("button", { name: /accept/i })[0]!);
    await waitFor(() => {
      const call = requestMock.mock.calls.find((c) => c[0] === "skills.incoming.accept");
      expect(call).toBeTruthy();
      expect(call?.[1]).toEqual({ skillName: "candidate-skill" });
    });
  });
});
