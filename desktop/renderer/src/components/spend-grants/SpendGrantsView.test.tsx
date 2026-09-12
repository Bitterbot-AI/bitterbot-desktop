import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSpendGrantsStore } from "../../stores/spend-grants-store";
import { SpendGrantsView } from "./SpendGrantsView";

const requestMock = vi.fn();
const { passkeyCeremony } = vi.hoisted(() => ({ passkeyCeremony: vi.fn(async () => true) }));

vi.mock("../../stores/gateway-store", () => ({
  useGatewayStore: (selector: (state: unknown) => unknown) =>
    selector({ request: requestMock, status: "connected" }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("../../lib/step-up", () => ({ passkeyCeremony }));

/** Configure the gateway RPC mock with a given approval + step-up threshold. */
function setupGateway(opts: { approvals?: (typeof approval)[]; stepUpThresholdUsd?: number }) {
  requestMock.mockImplementation((method: string) => {
    if (method === "spendGrant.list") return Promise.resolve({ grants: [grantRow] });
    if (method === "spendGrant.approvals")
      return Promise.resolve({ approvals: opts.approvals ?? [approval] });
    if (method === "config.get") {
      return Promise.resolve({
        config: {
          a2a: {
            payment: {
              consent: { grantsRequired: true },
              ...(opts.stepUpThresholdUsd !== undefined
                ? { escalation: { stepUpThresholdUsd: opts.stepUpThresholdUsd } }
                : {}),
            },
          },
        },
      });
    }
    return Promise.resolve({ ok: true });
  });
}

const PAYEE = "0x00000000000000000000000000000000000000aa";
const grantRow = {
  grant_id: "grant:abc",
  owner_pubkey: "ed25519:00",
  scope: { allowed_payees: [PAYEE] },
  allowance: { amount: "5", currency: "USDC" },
  period_seconds: 86_400,
  iat: 1,
  exp: 9_999_999_999,
  revokedAt: null,
};
const approval = {
  approvalId: "approval:xyz",
  payee: PAYEE,
  amountUsd: 0.5,
  reason: "A2A task at https://peer.example",
  status: "pending" as const,
  createdAt: Date.now(),
  resolvedAt: null,
  grantId: null,
};

const bigApproval = { ...approval, approvalId: "approval:big", amountUsd: 2.0 };

beforeEach(() => {
  requestMock.mockReset();
  passkeyCeremony.mockReset();
  passkeyCeremony.mockResolvedValue(true);
  useSpendGrantsStore.setState({
    grants: [],
    approvals: [],
    grantsRequired: false,
    stepUpThresholdUsd: null,
    loading: false,
    error: null,
  });
  requestMock.mockImplementation((method: string) => {
    if (method === "spendGrant.list") return Promise.resolve({ grants: [grantRow] });
    if (method === "spendGrant.approvals") return Promise.resolve({ approvals: [approval] });
    if (method === "config.get") {
      return Promise.resolve({
        config: { a2a: { payment: { consent: { grantsRequired: true } } } },
      });
    }
    return Promise.resolve({ ok: true });
  });
});

describe("SpendGrantsView", () => {
  it("shows pending approvals and one-tap approve calls spendGrant.approve", async () => {
    const user = userEvent.setup();
    render(<SpendGrantsView />);
    await waitFor(() => expect(screen.getByText(/Awaiting your approval/i)).toBeTruthy());
    expect(screen.getByText("$0.50")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: /approve/i }));
    await waitFor(() =>
      expect(requestMock).toHaveBeenCalledWith("spendGrant.approve", {
        approvalId: "approval:xyz",
      }),
    );
  });

  it("lists active grants and revoke calls spendGrant.revoke", async () => {
    const user = userEvent.setup();
    render(<SpendGrantsView />);
    await waitFor(() => expect(screen.getByText(/\$5\.00/)).toBeTruthy());
    await user.click(screen.getByRole("button", { name: /revoke/i }));
    await waitFor(() =>
      expect(requestMock).toHaveBeenCalledWith("spendGrant.revoke", { grantId: "grant:abc" }),
    );
  });

  it("reflects the grantsRequired flag from config", async () => {
    render(<SpendGrantsView />);
    await waitFor(() => expect(screen.getByText(/Grants required/i)).toBeTruthy());
  });

  it("requires a passkey step-up for an approval at/above the threshold", async () => {
    const user = userEvent.setup();
    setupGateway({ approvals: [bigApproval], stepUpThresholdUsd: 1 });
    passkeyCeremony.mockResolvedValue(true);
    render(<SpendGrantsView />);
    await waitFor(() => expect(screen.getByText("$2.00")).toBeTruthy());

    await user.click(screen.getByRole("button", { name: /approve/i }));
    // The passkey ceremony runs, then approve fires with the recorded method.
    await waitFor(() => expect(passkeyCeremony).toHaveBeenCalled());
    await waitFor(() =>
      expect(requestMock).toHaveBeenCalledWith("spendGrant.approve", {
        approvalId: "approval:big",
        confirmation: "passkey",
      }),
    );
  });

  it("falls back to a typed confirmation when no passkey is available", async () => {
    const user = userEvent.setup();
    setupGateway({ approvals: [bigApproval], stepUpThresholdUsd: 1 });
    passkeyCeremony.mockResolvedValue(false);
    render(<SpendGrantsView />);
    await waitFor(() => expect(screen.getByText("$2.00")).toBeTruthy());

    await user.click(screen.getByRole("button", { name: /approve/i }));
    // Passkey failed => typed fallback appears.
    const input = await screen.findByPlaceholderText("APPROVE");
    await user.type(input, "APPROVE");
    await user.click(screen.getByRole("button", { name: /confirm/i }));
    await waitFor(() =>
      expect(requestMock).toHaveBeenCalledWith("spendGrant.approve", {
        approvalId: "approval:big",
        confirmation: "typed",
      }),
    );
  });

  it("does not require step-up below the threshold (one-tap)", async () => {
    const user = userEvent.setup();
    setupGateway({ approvals: [approval], stepUpThresholdUsd: 1 }); // amount 0.5 < 1
    render(<SpendGrantsView />);
    await waitFor(() => expect(screen.getByText("$0.50")).toBeTruthy());

    await user.click(screen.getByRole("button", { name: /approve/i }));
    await waitFor(() =>
      expect(requestMock).toHaveBeenCalledWith("spendGrant.approve", {
        approvalId: "approval:xyz",
      }),
    );
    expect(passkeyCeremony).not.toHaveBeenCalled();
  });

  it("cancelling the step-up does not approve", async () => {
    const user = userEvent.setup();
    setupGateway({ approvals: [bigApproval], stepUpThresholdUsd: 1 });
    passkeyCeremony.mockResolvedValue(false);
    render(<SpendGrantsView />);
    await waitFor(() => expect(screen.getByText("$2.00")).toBeTruthy());

    await user.click(screen.getByRole("button", { name: /approve/i }));
    await screen.findByPlaceholderText("APPROVE"); // modal open (typed phase)
    await user.click(screen.getByRole("button", { name: /cancel/i }));
    // No approve RPC was sent.
    expect(requestMock.mock.calls.find((c) => c[0] === "spendGrant.approve")).toBeUndefined();
  });

  it("creates a grant with parsed params", async () => {
    render(<SpendGrantsView />);
    const input = await screen.findByPlaceholderText(/5\.00/);
    fireEvent.change(input, { target: { value: "10" } });
    fireEvent.submit(input.closest("form")!);

    await waitFor(() => {
      const call = requestMock.mock.calls.find((c) => c[0] === "spendGrant.set");
      expect(call).toBeTruthy();
      const params = call![1] as { allowanceUsd: number; payees: string[]; periodSeconds: number };
      expect(params.allowanceUsd).toBe(10);
      expect(params.payees).toEqual(["*"]); // blank payees => any
      expect(params.periodSeconds).toBe(86_400);
    });
  });
});
