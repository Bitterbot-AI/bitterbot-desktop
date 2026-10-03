import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { REVIEW_DEFAULT_TTL_MS, ReviewStore } from "./store.js";

let dir: string;
let now = 1_700_000_000_000;
let store: ReviewStore;

const request = (over: Partial<Parameters<ReviewStore["request"]>[0]> = {}) =>
  store.request({
    id: "rv-00000001",
    cls: "spend",
    tool: "wallet",
    params: { action: "send_usdc", address: "0xabc", amount: 5 },
    fingerprint: "fp-1",
    preview: "Send 5 USDC to 0xabc",
    sessionKey: "agent:main:main",
    agentId: "main",
    ...over,
  });

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "bitterbot-review-"));
  now = 1_700_000_000_000;
  store = ReviewStore.open(path.join(dir, "review.sqlite"), () => now);
});

afterEach(async () => {
  store.close();
  await fs.rm(dir, { recursive: true, force: true });
});

describe("ReviewStore", () => {
  it("records a request as pending with its deadline", () => {
    const { action, created } = request();

    expect(created).toBe(true);
    expect(action).toMatchObject({
      id: "rv-00000001",
      status: "pending",
      cls: "spend",
      tool: "wallet",
      params: { action: "send_usdc", address: "0xabc", amount: 5 },
      preview: "Send 5 USDC to 0xabc",
      sessionKey: "agent:main:main",
      expiresAt: now + REVIEW_DEFAULT_TTL_MS,
    });
  });

  it("returns the pending row again when the same call is asked for again", () => {
    // The agent retrying must not create a second request for the person.
    const first = request();
    const again = request({ id: "rv-00000002" });

    expect(again.created).toBe(false);
    expect(again.action.id).toBe(first.action.id);
    expect(store.pendingCount()).toBe(1);
  });

  it("keeps the same call in different sessions as different requests", () => {
    request();
    const other = request({ id: "rv-00000002", sessionKey: "agent:main:telegram:1" });

    expect(other.created).toBe(true);
    expect(store.pendingCount()).toBe(2);
  });

  it("lets exactly one decision through", () => {
    request();

    expect(
      store.decide("rv-00000001", "approved", { decidedBy: "victor", decidedVia: "control-ui" }),
    ).toBe(true);
    expect(
      store.decide("rv-00000001", "denied", { decidedBy: "someone", decidedVia: "chat" }),
    ).toBe(false);
    expect(store.get("rv-00000001")).toMatchObject({
      status: "approved",
      decidedBy: "victor",
      decidedVia: "control-ui",
      decidedAt: now,
    });
  });

  it("records what the execution did", () => {
    request();
    store.decide("rv-00000001", "approved", { decidedBy: "victor", decidedVia: "control-ui" });

    store.markExecution("rv-00000001", { ok: true, summary: "tx 0x123" });

    expect(store.get("rv-00000001")).toMatchObject({
      status: "executed",
      resultSummary: "tx 0x123",
    });
    expect(store.list({ status: "all" })).toHaveLength(1);
  });

  it("marks a failed execution as failed, not executed", () => {
    request();
    store.decide("rv-00000001", "approved", { decidedBy: "victor", decidedVia: "control-ui" });

    store.markExecution("rv-00000001", { ok: false, summary: "insufficient funds" });

    expect(store.get("rv-00000001")?.status).toBe("failed");
  });

  it("expires a request nobody decided on", () => {
    request();

    now += REVIEW_DEFAULT_TTL_MS;

    expect(store.list({ status: "pending" })).toEqual([]);
    expect(store.get("rv-00000001")?.status).toBe("expired");
    expect(store.decide("rv-00000001", "approved", { decidedBy: "late", decidedVia: "chat" })).toBe(
      false,
    );
  });

  it("asks again after the old request expired", () => {
    request();
    now += REVIEW_DEFAULT_TTL_MS;

    const again = request({ id: "rv-00000002" });

    expect(again.created).toBe(true);
    expect(again.action.id).toBe("rv-00000002");
  });

  it("lists newest first and honours the status filter", () => {
    request();
    now += 1000;
    request({ id: "rv-00000002", fingerprint: "fp-2", preview: "Post to X" });
    store.decide("rv-00000002", "denied", { decidedBy: "victor", decidedVia: "chat" });

    expect(store.list({ status: "pending" }).map((a) => a.id)).toEqual(["rv-00000001"]);
    expect(store.list({ status: "denied" }).map((a) => a.id)).toEqual(["rv-00000002"]);
    expect(store.list({ status: "all" }).map((a) => a.id)).toEqual(["rv-00000002", "rv-00000001"]);
  });
});
