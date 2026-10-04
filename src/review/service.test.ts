import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_REVIEW_POLICY,
  holdMessage,
  type ReviewOutcome,
  ReviewService,
  runAsApproved,
} from "./service.js";
import { ReviewStore } from "./store.js";

const SEND = { action: "send_usdc", address: "0xabc", amount: 5 };
const CTX = { sessionKey: "agent:main:main", agentId: "main" };

let dir: string;
let store: ReviewStore;
let executed: Array<{ tool: string; params: unknown }>;
let broadcasts: Array<{ event: string; payload: unknown }>;
let notes: Array<{ sessionKey: string; text: string }>;
let standing = false;
let executorFails: string | null = null;
let service: ReviewService;
let ids: number;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "bitterbot-review-svc-"));
  store = ReviewStore.open(path.join(dir, "review.sqlite"));
  executed = [];
  broadcasts = [];
  notes = [];
  standing = false;
  executorFails = null;
  ids = 0;
  service = new ReviewService({
    store,
    executors: new Map([
      [
        "wallet",
        async (action) => {
          executed.push({ tool: action.tool, params: action.params });
          if (executorFails) {
            throw new Error(executorFails);
          }
          return { ok: true, summary: "tx 0x123" };
        },
      ],
    ]),
    standingPermission: () => standing,
    broadcast: (event, payload) => broadcasts.push({ event, payload }),
    notifySession: (sessionKey, text) => notes.push({ sessionKey, text }),
    newId: () => `rv-${String(++ids).padStart(8, "0")}`,
  });
});

afterEach(async () => {
  store.close();
  await fs.rm(dir, { recursive: true, force: true });
});

const hold = (outcome: ReviewOutcome) => {
  if (outcome.kind !== "hold") {
    throw new Error(`expected a hold, got ${outcome.kind}`);
  }
  return outcome;
};

describe("ReviewService.consider", () => {
  it("lets unclassified calls through without touching the store", async () => {
    expect(await service.consider("exec", { command: "ls" }, CTX)).toEqual({
      kind: "pass",
      reason: "unclassified",
    });
    expect(store.list({ status: "all" })).toEqual([]);
  });

  it("holds a spend, tells the UI and the session, and tells the agent not to retry", async () => {
    const outcome = hold(await service.consider("wallet", SEND, CTX));

    expect(outcome.created).toBe(true);
    expect(outcome.action).toMatchObject({
      status: "pending",
      cls: "spend",
      preview: "Send 5 USDC to 0xabc",
    });
    expect(broadcasts).toEqual([
      { event: "review.requested", payload: expect.objectContaining({ id: "rv-00000001" }) },
    ]);
    expect(notes).toEqual([
      {
        sessionKey: "agent:main:main",
        text: expect.stringContaining("/approve rv-00000001 allow"),
      },
    ]);
    const message = holdMessage(outcome.action, outcome.created);
    expect(message).toContain("APPROVAL-REQUIRED (rv-00000001): Send 5 USDC to 0xabc");
    expect(message).toContain("Do NOT retry");
    expect(executed).toEqual([]);
  });

  it("does not ask twice when the agent retries the same call", async () => {
    await service.consider("wallet", SEND, CTX);
    const again = hold(await service.consider("wallet", SEND, CTX));

    expect(again.created).toBe(false);
    expect(again.action.id).toBe("rv-00000001");
    expect(broadcasts).toHaveLength(1);
    expect(notes).toHaveLength(1);
    expect(holdMessage(again.action, again.created)).toContain("APPROVAL-PENDING");
  });

  it("passes a spend the policy allows", async () => {
    expect(
      await service.consider("wallet", SEND, CTX, { ...DEFAULT_REVIEW_POLICY, spend: "allow" }),
    ).toEqual({
      kind: "pass",
      reason: "allowed",
    });
  });

  it("passes a spend a standing grant covers", async () => {
    standing = true;

    expect(await service.consider("wallet", SEND, CTX)).toEqual({ kind: "pass", reason: "grant" });
    expect(store.list({ status: "all" })).toEqual([]);
  });

  it("holds a public post too", async () => {
    const outcome = hold(
      await service.consider("message", { channel: "x", message: "hello" }, CTX),
    );

    expect(outcome.action).toMatchObject({ cls: "publish", preview: 'Post to X: "hello"' });
  });
});

describe("ReviewService.resolve", () => {
  it("approve runs the stored call on the gateway and records the result", async () => {
    const { action } = hold(await service.consider("wallet", SEND, CTX));

    const resolved = await service.resolve(action.id, "approve", {
      decidedBy: "victor",
      decidedVia: "control-ui",
    });

    expect(executed).toEqual([{ tool: "wallet", params: SEND }]);
    expect(resolved).toMatchObject({
      status: "executed",
      resultSummary: "tx 0x123",
      decidedBy: "victor",
    });
    expect(broadcasts.at(-1)).toEqual({
      event: "review.resolved",
      payload: expect.objectContaining({ status: "executed" }),
    });
    expect(notes.at(-1)?.text).toContain("Approved and done (rv-00000001)");
  });

  it("lets the approved call through the stage while it runs, and only then", async () => {
    const { action } = hold(await service.consider("wallet", SEND, CTX));
    service = new ReviewService({
      store,
      executors: new Map([
        [
          "wallet",
          async (a) => {
            // The executor re-enters the review stage, as a hooked tool would.
            const inside = await service.consider("wallet", a.params, CTX);
            return {
              ok: inside.kind === "pass" && inside.reason === "approved",
              summary: inside.kind,
            };
          },
        ],
      ]),
      newId: () => "rv-ignored",
    });

    const resolved = await service.resolve(action.id, "approve", {
      decidedBy: "victor",
      decidedVia: "control-ui",
    });

    expect(resolved?.status).toBe("executed");
    // Outside the approved scope the same call is held again, not waved through.
    expect((await service.consider("wallet", SEND, CTX)).kind).toBe("hold");
  });

  it("deny records the decision, runs nothing, and tells the session", async () => {
    const { action } = hold(await service.consider("wallet", SEND, CTX));

    const resolved = await service.resolve(action.id, "deny", {
      decidedBy: "victor",
      decidedVia: "chat",
    });

    expect(resolved?.status).toBe("denied");
    expect(executed).toEqual([]);
    expect(notes.at(-1)?.text).toContain("Denied (rv-00000001)");
  });

  it("marks an approval whose execution threw as failed, with the reason", async () => {
    const { action } = hold(await service.consider("wallet", SEND, CTX));
    executorFails = "insufficient funds";

    const resolved = await service.resolve(action.id, "approve", {
      decidedBy: "victor",
      decidedVia: "control-ui",
    });

    expect(resolved).toMatchObject({ status: "failed", resultSummary: "insufficient funds" });
    expect(notes.at(-1)?.text).toContain("Approved, but it failed");
  });

  it("refuses to execute a tool with no executor", async () => {
    const { action } = hold(
      await service.consider("message", { channel: "x", message: "hi" }, CTX),
    );

    const resolved = await service.resolve(action.id, "approve", {
      decidedBy: "victor",
      decidedVia: "control-ui",
    });

    expect(resolved).toMatchObject({
      status: "failed",
      resultSummary: expect.stringContaining("no executor"),
    });
  });

  it("returns null for an unknown id or a second decision", async () => {
    const { action } = hold(await service.consider("wallet", SEND, CTX));

    expect(
      await service.resolve("rv-deadbeef", "approve", { decidedBy: "x", decidedVia: "chat" }),
    ).toBeNull();
    await service.resolve(action.id, "deny", { decidedBy: "victor", decidedVia: "chat" });
    expect(
      await service.resolve(action.id, "approve", { decidedBy: "victor", decidedVia: "chat" }),
    ).toBeNull();
    expect(executed).toEqual([]);
  });

  it("a stale fingerprint cannot ride on another action's approval", async () => {
    await expect(
      runAsApproved("fp-other", async () => (await service.consider("wallet", SEND, CTX)).kind),
    ).resolves.toBe("hold");
  });
});
