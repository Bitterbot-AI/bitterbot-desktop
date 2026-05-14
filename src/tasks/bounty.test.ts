import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getBids, listBiddableTasks, recordBid } from "./bounty.js";
import { getActiveTaskStore, startTaskStore, stopTaskStore } from "./store.js";

describe("P2P bounty plumbing (PLAN-16 Phase E.4)", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-bounty-"));
    startTaskStore({ dbPath: path.join(dir, "tasks.sqlite") });
  });

  afterEach(() => {
    stopTaskStore();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("lists only tasks with bounty > 0 and non-terminal", () => {
    const store = getActiveTaskStore()!;
    const a = store.create({ goal: "free", doneCriteria: "x" });
    const b = store.create({ goal: "paid", doneCriteria: "x", bounty: 500 });
    store.create({ goal: "expensive done", doneCriteria: "x", bounty: 10_000 });
    // Mark the third as completed.
    const list1 = store.list();
    const done = list1.find((t) => t.goal === "expensive done")!;
    store.update(done.id, { status: "completed", output: "out" });

    const biddable = listBiddableTasks();
    expect(biddable).toHaveLength(1);
    expect(biddable[0].taskId).toBe(b.id);
    expect(biddable[0].bounty).toBe(500);
    expect(biddable[0].bidCount).toBe(0);
    expect(a.id).toBeDefined(); // a has no bounty; appears nowhere
  });

  it("recordBid attaches a bid to the task and bumps bidCount", () => {
    const store = getActiveTaskStore()!;
    const t = store.create({ goal: "paid", doneCriteria: "x", bounty: 1000 });
    const r1 = recordBid({
      taskId: t.id,
      peerId: "peer-A",
      signedOffer: "ed25519:sig:fake",
      offerCents: 900,
    });
    expect(r1.ok).toBe(true);
    expect(r1.bidCount).toBe(1);
    const r2 = recordBid({
      taskId: t.id,
      peerId: "peer-B",
      signedOffer: "ed25519:sig:fake2",
      offerCents: 800,
    });
    expect(r2.bidCount).toBe(2);
    const bids = getBids(t.id);
    expect(bids.map((b) => b.peerId)).toEqual(["peer-A", "peer-B"]);
    expect(bids[0].offerCents).toBe(900);
  });

  it("recordBid refuses tasks without a bounty", () => {
    const store = getActiveTaskStore()!;
    const t = store.create({ goal: "free", doneCriteria: "x" });
    const r = recordBid({
      taskId: t.id,
      peerId: "peer-X",
      signedOffer: "sig",
      offerCents: 1,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no bounty/);
  });

  it("recordBid refuses unknown tasks", () => {
    const r = recordBid({
      taskId: "task-missing",
      peerId: "p",
      signedOffer: "s",
      offerCents: 1,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not found/);
  });

  it("recordBid refuses tasks already accepted by a peer", () => {
    const store = getActiveTaskStore()!;
    const t = store.create({ goal: "paid", doneCriteria: "x", bounty: 500 });
    store.update(t.id, { metadata: { acceptedPeer: "peer-A" } });
    const r = recordBid({
      taskId: t.id,
      peerId: "peer-B",
      signedOffer: "sig",
      offerCents: 400,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/already accepted/);
  });

  it("listBiddableTasks excludes tasks already accepted by a peer", () => {
    const store = getActiveTaskStore()!;
    const t = store.create({ goal: "paid", doneCriteria: "x", bounty: 500 });
    expect(listBiddableTasks()).toHaveLength(1);
    store.update(t.id, { metadata: { acceptedPeer: "peer-A" } });
    expect(listBiddableTasks()).toHaveLength(0);
  });
});
