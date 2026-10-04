import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayRequestHandlerOptions } from "./types.js";

const svc = vi.hoisted(() => ({
  list: vi.fn(),
  get: vi.fn(),
  resolve: vi.fn(),
  pendingCount: vi.fn(() => 1),
}));

vi.mock("../../review/runtime.js", () => ({ getReviewService: () => svc }));

import { reviewHandlers } from "./review.js";

const action = {
  id: "rv-00000001",
  createdAt: 1,
  expiresAt: 2,
  status: "pending",
  cls: "spend",
  tool: "wallet",
  params: { action: "send_usdc", address: "0xabc", amount: 5 },
  fingerprint: "fp",
  preview: "Send 5 USDC to 0xabc",
  sessionKey: "agent:main:main",
  agentId: "main",
  runId: null,
  decidedAt: null,
  decidedBy: null,
  decidedVia: null,
  note: null,
  resultSummary: null,
  executedAt: null,
};

async function call(
  method: keyof typeof reviewHandlers,
  params: Record<string, unknown>,
  client: unknown = null,
) {
  const respond = vi.fn();
  await reviewHandlers[method]({
    params,
    respond,
    client,
    context: {},
  } as unknown as GatewayRequestHandlerOptions);
  return respond.mock.calls[0] as [boolean, unknown, unknown];
}

beforeEach(() => {
  svc.list.mockReset().mockReturnValue([action]);
  svc.get.mockReset().mockReturnValue(action);
  svc.resolve
    .mockReset()
    .mockResolvedValue({ ...action, status: "executed", resultSummary: "tx 0x1" });
});

describe("review.list", () => {
  it("lists pending actions by default, without the fingerprint", async () => {
    const [ok, payload] = await call("review.list", {});

    expect(ok).toBe(true);
    expect(svc.list).toHaveBeenCalledWith({ status: "pending", limit: undefined });
    expect(payload).toMatchObject({
      pending: 1,
      actions: [{ id: "rv-00000001", preview: "Send 5 USDC to 0xabc" }],
    });
    expect(JSON.stringify(payload)).not.toContain('"fingerprint"');
  });

  it("accepts a status filter and ignores a bad one", async () => {
    await call("review.list", { status: "executed", limit: 5 });
    expect(svc.list).toHaveBeenLastCalledWith({ status: "executed", limit: 5 });

    await call("review.list", { status: "bogus" });
    expect(svc.list).toHaveBeenLastCalledWith({ status: "pending", limit: undefined });
  });
});

describe("review.resolve", () => {
  it("approves with the caller's identity and returns what happened", async () => {
    const [ok, payload] = await call(
      "review.resolve",
      { id: "rv-00000001", decision: "approve" },
      {
        connect: { client: { id: "control-ui", displayName: "Control UI" } },
      },
    );

    expect(ok).toBe(true);
    expect(svc.resolve).toHaveBeenCalledWith("rv-00000001", "approve", {
      decidedBy: "Control UI",
      decidedVia: "control-ui",
      note: undefined,
    });
    expect(payload).toMatchObject({ status: "executed", resultSummary: "tx 0x1" });
  });

  it("passes through the chat surface and the person who decided", async () => {
    await call("review.resolve", {
      id: "rv-00000001",
      decision: "deny",
      decidedBy: "telegram:42",
      via: "chat",
    });

    expect(svc.resolve).toHaveBeenCalledWith("rv-00000001", "deny", {
      decidedBy: "telegram:42",
      decidedVia: "chat",
      note: undefined,
    });
  });

  it("rejects a missing id or an unknown decision", async () => {
    expect((await call("review.resolve", { id: "rv-00000001", decision: "maybe" }))[0]).toBe(false);
    expect((await call("review.resolve", { decision: "approve" }))[0]).toBe(false);
    expect(svc.resolve).not.toHaveBeenCalled();
  });

  it("reports an unknown or already decided id", async () => {
    svc.resolve.mockResolvedValue(null);

    const [ok, , error] = await call("review.resolve", { id: "rv-00000001", decision: "approve" });

    expect(ok).toBe(false);
    expect(JSON.stringify(error)).toContain("already decided");
  });
});

describe("review.get", () => {
  it("returns one action, and an error for an unknown id", async () => {
    expect((await call("review.get", { id: "rv-00000001" }))[1]).toMatchObject({
      id: "rv-00000001",
    });
    svc.get.mockReturnValue(null);
    expect((await call("review.get", { id: "rv-nope" }))[0]).toBe(false);
  });
});
