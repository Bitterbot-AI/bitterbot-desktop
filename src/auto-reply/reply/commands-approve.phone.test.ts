import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: Array<{ method: string; params: unknown }> = [];
vi.mock("../../gateway/call.js", () => ({
  callGateway: vi.fn(async (opts: { method: string; params: unknown }) => {
    calls.push({ method: opts.method, params: opts.params });
    return { status: "approved" };
  }),
}));

const { handleApproveCommand } = await import("./commands-approve.js");

const PHONE = ["operator.approvals", "operator.chat", "operator.notifications"];

function params(body: string, scopes: string[]) {
  return {
    ctx: { GatewayClientScopes: scopes },
    command: {
      commandBodyNormalized: body,
      isAuthorizedSender: true,
      channel: "webchat",
      senderId: "bitterbot-mobile",
    },
  } as never;
}

describe("/approve from a phone (PLAN-62)", () => {
  beforeEach(() => {
    calls.length = 0;
  });

  it("refuses allow-always from a phone without calling the gateway", async () => {
    const res = await handleApproveCommand(params("/approve abc123 always", PHONE), true);
    expect(res?.reply?.text).toMatch(/once/);
    expect(calls).toEqual([]);
  });

  it("relays the phone's scopes with a review decision, so the service can refuse money", async () => {
    await handleApproveCommand(params("/approve rv-00000001 allow", PHONE), true);
    expect(calls[0]?.method).toBe("review.resolve");
    expect(calls[0]?.params).toMatchObject({
      id: "rv-00000001",
      decision: "approve",
      originScopes: PHONE,
    });
  });

  it("leaves the desktop's /approve unchanged", async () => {
    await handleApproveCommand(params("/approve rv-00000001 allow", ["operator.admin"]), true);
    expect(calls[0]?.params).not.toHaveProperty("originScopes");
    await handleApproveCommand(params("/approve abc123 always", ["operator.admin"]), true);
    expect(calls[1]).toMatchObject({
      method: "exec.approval.resolve",
      params: { decision: "allow-always" },
    });
  });
});
