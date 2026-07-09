import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { BitterbotConfig } from "../../config/config.js";
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

  it("send is two-phase: preview does NOT send; confirm sends", async () => {
    const preview = await run("send", { text: "movie night?" });
    expect(preview.pending).toBe(true);
    expect((preview.preview as { text: string }).text).toBe("movie night?");
    // Nothing left the node.
    expect(
      (
        db.prepare(`SELECT COUNT(*) n FROM circle_messages WHERE direction='out'`).get() as {
          n: number;
        }
      ).n,
    ).toBe(0);

    const sent = await run("send", { text: "movie night?", confirm: true });
    expect(sent.sent).toBe(true);
    expect(
      (
        db.prepare(`SELECT COUNT(*) n FROM circle_messages WHERE direction='out'`).get() as {
          n: number;
        }
      ).n,
    ).toBe(1);
  });

  it("log_expense is two-phase and lands on the tab (no money)", async () => {
    const preview = await run("log_expense", { memo: "pizza", amount: 42 });
    expect(preview.pending).toBe(true);
    expect((preview.preview as { splitAmong: number }).splitAmong).toBe(2); // self + Bob
    expect((db.prepare(`SELECT COUNT(*) n FROM circle_events`).get() as { n: number }).n).toBe(0);

    const logged = await run("log_expense", { memo: "pizza", amount: 42, confirm: true });
    expect(logged.logged).toBe(true);
    const tab = await run("tab");
    expect(tab.expenses).toBe(1);
    expect(tab.totalCents).toBe(4200);
  });

  it("ask is two-phase and carries its category", async () => {
    const preview = await run("ask", {
      question: "know a dentist?",
      category: "recommendations.dentist",
    });
    expect(preview.pending).toBe(true);
    expect((preview.preview as { category: string }).category).toBe("recommendations.dentist");
    const asked = await run("ask", {
      question: "know a dentist?",
      category: "recommendations.dentist",
      confirm: true,
    });
    expect(asked.asked).toBe(true);
    expect(asked.category).toBe("recommendations.dentist");
  });
});
