import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { BitterbotConfig } from "../../config/config.js";
import { listPendingOutbound } from "../../circles/pending-outbound.js";
import { CirclesService } from "../../circles/service.js";
import { keyPairFromPrivateKeyPem, pubkeyId } from "../../commerce/envelope.js";
import { loadOrCreateDeviceIdentity } from "../../infra/device-identity.js";
import { CirclesStore, DEFAULT_MEMBER_SCOPES } from "../../memory/circles-store.js";
import { ensureMemoryIndexSchema } from "../../memory/memory-schema.js";
import { runMigrations } from "../../memory/migrations.js";
import { createCirclesTool } from "./circles-tool.js";

// PLAN-31: the conversational circles tool. Read actions run against a real
// in-memory circles db; write actions are two-phase (preview then confirm).
// The tool builds its own CirclesService from the node's device identity, so
// we pin BITTERBOT_STATE_DIR to a throwaway dir and seed the circle under the
// node's own pubkey.

let db: DatabaseSync;
let stateDir: string;
let selfPubkey: string;
const FRIEND = "ed25519:" + "b".repeat(64);

vi.mock("../../memory/index.js", () => ({
  getMemorySearchManager: async () => ({
    manager: { getMarketplaceEconomics: () => ({ getDb: () => db }) },
  }),
}));

const cfg = (enabled: boolean): BitterbotConfig =>
  ({
    gateway: { hostId: "test" },
    circles: enabled ? { enabled: true, a2aPublicUrl: "https://self.test" } : undefined,
  }) as BitterbotConfig;

function openDb(): DatabaseSync {
  const fresh = new DatabaseSync(":memory:");
  ensureMemoryIndexSchema({
    db: fresh,
    embeddingCacheTable: "embedding_cache",
    ftsTable: "chunks_fts",
    ftsEnabled: false,
  });
  runMigrations(fresh);
  return fresh;
}

async function run(action: string, params: Record<string, unknown> = {}) {
  const tool = createCirclesTool({ config: cfg(true), agentSessionKey: "agent:default" });
  if (!tool) throw new Error("tool not created");
  const res = await tool.execute("call", { action, ...params });
  return (res as { details: Record<string, unknown> }).details;
}

describe("circles agent tool", () => {
  beforeAll(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "circles-tool-"));
    process.env.BITTERBOT_STATE_DIR = stateDir;
    // The pubkey the tool's CirclesService will use, from the pinned identity.
    selfPubkey = pubkeyId(keyPairFromPrivateKeyPem(loadOrCreateDeviceIdentity().privateKeyPem));
  });
  afterAll(() => {
    delete process.env.BITTERBOT_STATE_DIR;
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    db = openDb();
    const store = new CirclesStore(db);
    const circleId = store.createCircle({
      name: "Roomies",
      kind: "expense",
      creatorPubkey: selfPubkey,
    });
    store.addMember({
      circleId,
      memberPubkey: FRIEND,
      displayName: "Bob",
      scopes: DEFAULT_MEMBER_SCOPES,
    });
  });

  it("is dark when circles are disabled (no tool registered)", () => {
    expect(createCirclesTool({ config: cfg(false) })).toBeNull();
    expect(createCirclesTool({ config: undefined })).toBeNull();
  });

  it("reads status and connections", async () => {
    const status = await run("status");
    expect(status.available).toBe(true);
    expect(status.connectionCount).toBe(1); // Bob
    const conns = await run("connections");
    const circles = conns.circles as Array<{ name: string; members: Array<{ name: string }> }>;
    expect(circles[0]?.name).toBe("Roomies");
    expect(circles[0]?.members.some((m) => m.name === "Bob")).toBe(true);
  });

  const outCount = () =>
    (
      db.prepare(`SELECT COUNT(*) n FROM circle_messages WHERE direction='out'`).get() as {
        n: number;
      }
    ).n;

  it("send only QUEUES for the human — the agent cannot execute, period (§5.3)", async () => {
    const res = await run("send", { text: "movie night?" });
    expect(res.queued).toBe(true);
    expect((res.preview as { text: string }).text).toBe("movie night?");
    expect(res.confirm_token).toBeUndefined(); // no token exists to steal
    expect(outCount()).toBe(0); // nothing left the node

    // A prompt-injected agent throwing confirm flags / forged tokens at the
    // tool changes nothing: every call queues, none executes.
    const forced = await run("send", { text: "sneaky", confirm: true, confirm_token: "forged" });
    expect(forced.queued).toBe(true);
    expect(forced.sent).toBeUndefined();
    expect(outCount()).toBe(0);
    expect(listPendingOutbound(db).length).toBe(2); // both await the human
  });

  it("the human's approval executes the STORED params; reject executes nothing", async () => {
    await run("send", { text: "movie night?" });
    await run("send", { text: "second thought" });
    const [first, second] = listPendingOutbound(db);
    const svc = new CirclesService({ db, config: cfg(true) });

    // Approve the first: the server executes exactly what was stored.
    await svc.approvePendingOutbound(first?.id ?? "");
    expect(outCount()).toBe(1);
    const sent = db.prepare(`SELECT content FROM circle_messages WHERE direction='out'`).get() as {
      content: string;
    };
    expect(sent.content).toBe("movie night?");

    // Reject the second: nothing more leaves; both are resolved.
    svc.rejectPendingOutbound(second?.id ?? "");
    expect(outCount()).toBe(1);
    expect(listPendingOutbound(db)).toHaveLength(0);

    // Racing double-approve is atomic: the replay throws, no second send.
    await expect(svc.approvePendingOutbound(first?.id ?? "")).rejects.toThrow(/not awaiting/);
    expect(outCount()).toBe(1);
  });

  it("a failed approval hands the card back for retry (review F3)", async () => {
    await run("send", { text: "hello" });
    const [pending] = listPendingOutbound(db);
    // The circle freezes between queue and approve — execution throws…
    new CirclesStore(db).freezeCircle(pending?.circleId ?? "");
    const svc = new CirclesService({ db, config: cfg(true) });
    await expect(svc.approvePendingOutbound(pending?.id ?? "")).rejects.toThrow(/not active/);
    // …and the card is back in the queue instead of silently vanishing.
    expect(listPendingOutbound(db)).toHaveLength(1);
    expect(outCount()).toBe(0);
  });

  it("log_expense queues; approval lands it on the tab (no money)", async () => {
    const res = await run("log_expense", { memo: "pizza", amount: 42 });
    expect(res.queued).toBe(true);
    // The preview NAMES the split (review F1) — a count could hide a crafted
    // participants list; the human must see who owes.
    const splitAmong = (res.preview as { splitAmong: string[] }).splitAmong;
    expect(splitAmong).toHaveLength(2); // self + Bob
    expect(splitAmong).toContain("Bob");
    expect((db.prepare(`SELECT COUNT(*) n FROM circle_events`).get() as { n: number }).n).toBe(0);

    const svc = new CirclesService({ db, config: cfg(true) });
    await svc.approvePendingOutbound(listPendingOutbound(db)[0]?.id ?? "");
    const tab = await run("tab");
    expect(tab.expenses).toBe(1);
    expect(tab.totalCents).toBe(4200);
  });

  it("ask queues with its category; approval sends it", async () => {
    const res = await run("ask", {
      question: "know a dentist?",
      category: "recommendations.dentist",
    });
    expect(res.queued).toBe(true);
    expect((res.preview as { category: string }).category).toBe("recommendations.dentist");
    const svc = new CirclesService({ db, config: cfg(true) });
    await svc.approvePendingOutbound(listPendingOutbound(db)[0]?.id ?? "");
    const asks = db
      .prepare(`SELECT kind FROM circle_messages WHERE direction='out'`)
      .all() as unknown as Array<{ kind: string }>;
    expect(asks.some((a) => a.kind === "ask")).toBe(true);
  });
});
