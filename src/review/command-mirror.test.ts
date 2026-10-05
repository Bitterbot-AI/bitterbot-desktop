import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mirrorCommandRequested,
  mirrorCommandSettled,
  resetCommandMirrorForTest,
} from "./command-mirror.js";
import { resetReviewServiceForTest } from "./runtime.js";
import { type CommandDecision, ReviewService } from "./service.js";
import { ReviewStore } from "./store.js";

/**
 * A shell-command approval has two front doors now: its own (chat, other
 * clients) and the review queue. Either way there is one answer and one row.
 */

let dir: string;
let store: ReviewStore;
let service: ReviewService;
let events: Array<{ event: string; status: string }>;
/** What the exec manager was told, and whether it still had the approval. */
let answered: Array<{ approvalId: string; decision: CommandDecision }>;
let managerHasIt = true;

const record = (id = "approval-1") => ({
  id,
  request: { command: "rm -rf build", cwd: "/repo", sessionKey: "agent:main:main" },
  createdAtMs: 1_000,
  expiresAtMs: 121_000,
});

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "bitterbot-cmd-mirror-"));
  store = ReviewStore.open(path.join(dir, "review.sqlite"));
  events = [];
  answered = [];
  managerHasIt = true;
  let n = 0;
  service = new ReviewService({
    store,
    executors: new Map(),
    broadcast: (event, payload) =>
      events.push({ event, status: (payload as { status: string }).status }),
    resolveCommand: (action, decision) => {
      const approvalId = (action.params as { approvalId: string }).approvalId;
      if (managerHasIt) {
        answered.push({ approvalId, decision });
      }
      return managerHasIt;
    },
    newId: () => `rv-0000020${++n}`,
  });
  resetReviewServiceForTest(service);
  resetCommandMirrorForTest();
});

afterEach(async () => {
  resetReviewServiceForTest(null);
  store.close();
  await fs.rm(dir, { recursive: true, force: true });
});

describe("shell-command approvals in the review queue", () => {
  it("puts a requested command in the queue with what will run and where", () => {
    mirrorCommandRequested(record());

    expect(service.list()).toMatchObject([
      {
        cls: "command",
        tool: "exec",
        status: "pending",
        preview: "Run: rm -rf build (in /repo)",
        sessionKey: "agent:main:main",
        params: { command: "rm -rf build", cwd: "/repo", approvalId: "approval-1" },
      },
    ]);
    expect(events).toEqual([{ event: "review.requested", status: "pending" }]);
  });

  it("answers the waiting exec tool when the queue is used", async () => {
    mirrorCommandRequested(record());
    const id = service.list()[0].id;

    const once = await service.resolve(id, "approve", {
      decidedBy: "owner",
      decidedVia: "control-ui",
    });

    expect(answered).toEqual([{ approvalId: "approval-1", decision: "allow-once" }]);
    expect(once).toMatchObject({ status: "executed", resultSummary: "Allowed once." });
    // The manager then reports the same answer back; the row does not change.
    mirrorCommandSettled("approval-1", "allow-once", "owner");
    expect(store.get(id)).toMatchObject({ status: "executed", decidedVia: "control-ui" });
  });

  it("passes on always-allow and deny", async () => {
    mirrorCommandRequested(record("a"));
    mirrorCommandRequested(record("b"));
    const [second, first] = service.list();

    await service.resolve(first.id, "approve", { decidedBy: "o", decidedVia: "ui", always: true });
    await service.resolve(second.id, "deny", { decidedBy: "o", decidedVia: "ui" });

    expect(answered.map((a) => a.decision).toSorted()).toEqual(["allow-always", "deny"]);
    expect(store.get(first.id)?.resultSummary).toContain("allowlist");
    expect(store.get(second.id)?.status).toBe("denied");
  });

  it("records an answer given the old way, from chat or another client", () => {
    mirrorCommandRequested(record());
    const id = service.list()[0].id;

    mirrorCommandSettled("approval-1", "deny", "telegram:owner");

    expect(store.get(id)).toMatchObject({
      status: "denied",
      decidedBy: "telegram:owner",
      decidedVia: "exec-approval",
    });
    expect(events.at(-1)).toEqual({ event: "review.resolved", status: "denied" });
  });

  it("closes the row when nobody answers", () => {
    mirrorCommandRequested(record());
    const id = service.list()[0].id;

    mirrorCommandSettled("approval-1", null);

    expect(store.get(id)?.status).toBe("expired");
    expect(service.pendingCount()).toBe(0);
  });

  it("does not pretend to approve a command the exec tool has stopped waiting for", async () => {
    mirrorCommandRequested(record());
    const id = service.list()[0].id;
    managerHasIt = false;

    expect(
      await service.resolve(id, "approve", { decidedBy: "owner", decidedVia: "control-ui" }),
    ).toBeNull();
    expect(store.get(id)?.status).toBe("expired");
  });
});
