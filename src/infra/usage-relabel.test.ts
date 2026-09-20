import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HEARTBEAT_PROMPT, HEARTBEAT_PROMPT_PREFIX } from "../auto-reply/heartbeat.js";
import { resetModelPricingMemoForTest } from "./model-pricing.js";
import { UsageLedger, resolveUsageEvent } from "./usage-ledger.js";
import { RECONCILE_GRACE_MS, reconcileTranscripts } from "./usage-reconcile.js";
import { collectHeartbeatDedupeKeys, relabelHeartbeatsV3 } from "./usage-relabel.js";
import {
  HeartbeatTurnTracker,
  isHeartbeatAckText,
  isHeartbeatPromptText,
  resolveHeartbeatPromptSet,
} from "./usage-transcript-classify.js";

const CUSTOM_PROMPT = "Check the queue. Reply HEARTBEAT_OK when idle.";

function userLine(ts: number, text: string): string {
  return (
    JSON.stringify({
      type: "message",
      timestamp: new Date(ts).toISOString(),
      message: { role: "user", content: [{ type: "text", text }], timestamp: ts },
    }) + "\n"
  );
}

function assistantLine(
  ts: number,
  text: string,
  usage: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number },
  provider = "anthropic",
  model = "claude-opus-4-8",
): string {
  return (
    JSON.stringify({
      type: "message",
      timestamp: new Date(ts).toISOString(),
      message: {
        role: "assistant",
        provider,
        model,
        content: [{ type: "text", text }],
        usage: { ...usage, cost: { total: 0.3 } },
        timestamp: ts,
        stopReason: "stop",
      },
    }) + "\n"
  );
}

function toolResultLine(ts: number): string {
  return (
    JSON.stringify({
      type: "message",
      timestamp: new Date(ts).toISOString(),
      message: { role: "toolResult", content: [{ type: "text", text: "# HEARTBEAT.md" }] },
    }) + "\n"
  );
}

const T0 = Date.UTC(2026, 8, 1, 10);
const HB = `${HEARTBEAT_PROMPT}\nCurrent time: Tuesday, September 1st, 2026 — 6:00 AM (America/Toronto)`;
const HB_USAGE = { input: 2, output: 13, cacheRead: 0, cacheWrite: 50_000 };
const CHAT_USAGE = { input: 40, output: 300, cacheRead: 48_000, cacheWrite: 900 };

/** A main-session transcript: two heartbeats, a real chat turn, a heartbeat with a tool loop. */
function mainTranscript(): string {
  return (
    userLine(T0, HB) +
    assistantLine(T0 + 1_000, "HEARTBEAT_OK", HB_USAGE) +
    userLine(T0 + 60_000, "hey, what did we decide about the relay fleet?") +
    assistantLine(T0 + 61_000, "We kept three droplets...", CHAT_USAGE) +
    userLine(T0 + 120_000, HB) +
    assistantLine(T0 + 121_000, "Reading HEARTBEAT.md", {
      input: 2,
      output: 40,
      cacheWrite: 50_000,
    }) +
    toolResultLine(T0 + 121_500) +
    assistantLine(T0 + 122_000, "**HEARTBEAT_OK**", { input: 2, output: 13, cacheRead: 50_000 }) +
    userLine(T0 + 180_000, "ok") +
    assistantLine(T0 + 181_000, "OK", { input: 2, output: 3, cacheRead: 0, cacheWrite: 50_000 })
  );
}

describe("transcript heartbeat classification", () => {
  it("recognises the default prompt, configured overrides and the ack token", () => {
    const prompts = resolveHeartbeatPromptSet({
      agents: {
        defaults: { heartbeat: { prompt: CUSTOM_PROMPT } },
        list: [{ id: "b", heartbeat: { prompt: "Agent B pulse" } }],
      },
    } as never);
    expect(prompts).toEqual([HEARTBEAT_PROMPT_PREFIX, CUSTOM_PROMPT, "Agent B pulse"]);
    expect(isHeartbeatPromptText(HB, prompts)).toBe(true);
    expect(isHeartbeatPromptText(`${CUSTOM_PROMPT}\nCurrent time: now`, prompts)).toBe(true);
    expect(isHeartbeatPromptText("Read HEARTBEAT.md please, I edited it", prompts)).toBe(false);
    expect(isHeartbeatAckText("HEARTBEAT_OK")).toBe(true);
    expect(isHeartbeatAckText(" <b>HEARTBEAT_OK</b> ")).toBe(true);
    expect(isHeartbeatAckText("HEARTBEAT_OK, and one more thing")).toBe(false);
  });

  it("attributes every assistant message of a heartbeat turn, tool loops included", () => {
    const tracker = new HeartbeatTurnTracker([HEARTBEAT_PROMPT]);
    tracker.noteEntry({ message: { role: "user", content: HB } });
    expect(tracker.isHeartbeatAssistant({ content: "Reading HEARTBEAT.md" })).toBe(true);
    tracker.noteEntry({ message: { role: "toolResult", content: "..." } });
    expect(tracker.isHeartbeatAssistant({ content: "HEARTBEAT_OK" })).toBe(true);
    tracker.noteEntry({ message: { role: "user", content: "real question" } });
    expect(tracker.isHeartbeatAssistant({ content: "a real answer" })).toBe(false);
    // Ack-only replies count even when the prompt was not seen (cursor resumed mid-turn).
    expect(tracker.isHeartbeatAssistant({ content: "HEARTBEAT_OK" })).toBe(true);
  });
});

describe("reconciler labels heartbeats by content", () => {
  let dir: string;
  let ledger: UsageLedger;
  let sessionsDir: string;
  beforeEach(() => {
    resetModelPricingMemoForTest();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-usage-relabel-"));
    sessionsDir = path.join(dir, "agents", "main", "sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });
    ledger = UsageLedger.openInMemory();
  });
  afterEach(() => {
    ledger.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("backfills main-session heartbeats as agent/heartbeat with channel heartbeat and a TTL", async () => {
    fs.writeFileSync(path.join(sessionsDir, "s-main.jsonl"), mainTranscript());
    const res = await reconcileTranscripts({ ledger, stateDir: dir, nowMs: T0 + 3_600_000 });
    expect(res.rows).toBe(5);
    const heartbeats = ledger.rows({ feature: "agent/heartbeat" });
    expect(heartbeats.map((r) => r.ts)).toEqual([T0 + 1_000, T0 + 121_000, T0 + 122_000]);
    expect(heartbeats.every((r) => r.channel === "heartbeat")).toBe(true);
    expect(heartbeats.every((r) => r.cacheTtl === "5m")).toBe(true);
    const turns = ledger.rows({ feature: "agent/turn" });
    expect(turns.map((r) => r.ts)).toEqual([T0 + 61_000, T0 + 181_000]);
    expect(turns[0]?.channel).toBeNull();
  });

  it("uses a configured custom heartbeat prompt", async () => {
    const custom = `${CUSTOM_PROMPT}\nCurrent time: later`;
    fs.writeFileSync(
      path.join(sessionsDir, "s-custom.jsonl"),
      userLine(T0, custom) + assistantLine(T0 + 1_000, "Nothing in the queue.", HB_USAGE),
    );
    const cfg = { agents: { defaults: { heartbeat: { prompt: CUSTOM_PROMPT } } } } as never;
    await reconcileTranscripts({ ledger, cfg, stateDir: dir, nowMs: T0 + 3_600_000 });
    expect(ledger.rows({})[0]?.feature).toBe("agent/heartbeat");
  });

  it("defers transcript lines younger than the grace window so live rows land first", async () => {
    const now = T0 + 10 * 60_000;
    const file = path.join(sessionsDir, "s-race.jsonl");
    const young = now - RECONCILE_GRACE_MS / 2;
    fs.writeFileSync(
      file,
      userLine(T0, "old question") +
        assistantLine(T0 + 1_000, "old answer", CHAT_USAGE) +
        userLine(young - 500, "fresh question") +
        assistantLine(young, "fresh answer", CHAT_USAGE),
    );
    const first = await reconcileTranscripts({ ledger, stateDir: dir, nowMs: now });
    expect(first.rows).toBe(1);
    expect(ledger.count()).toBe(1);
    // Unchanged file, still inside the grace: the deferred cursor makes the pass look again.
    expect((await reconcileTranscripts({ ledger, stateDir: dir, nowMs: now + 1_000 })).rows).toBe(
      0,
    );
    // The live hook lands first with the richer attribution.
    const live = await resolveUsageEvent({
      ts: young,
      kind: "chat",
      feature: "agent/turn",
      provider: "anthropic",
      model: "claude-opus-4-8",
      sessionKey: "agent:main:main",
      runId: "run-1",
      usage: CHAT_USAGE,
      cost: { total: 0.3 },
      cacheState: "hit",
      cacheTtl: "5m",
    });
    expect(ledger.insert({ ...live!, dedupeKey: `s-race:${young}` })).not.toBeNull();
    const later = await reconcileTranscripts({
      ledger,
      stateDir: dir,
      nowMs: now + RECONCILE_GRACE_MS + 1_000,
    });
    expect(later.rows).toBe(0);
    expect(ledger.count()).toBe(2);
    const fresh = ledger.rows({ runId: "run-1" });
    expect(fresh).toHaveLength(1);
    expect(fresh[0]?.source).toBe("live");
  });

  it("lets a live row adopt a reconciled row that slipped in first", async () => {
    const reconciled = await resolveUsageEvent({
      ts: T0,
      kind: "chat",
      feature: "agent/turn",
      provider: "anthropic",
      model: "claude-opus-4-8",
      usage: HB_USAGE,
      cost: { total: 0.3 },
      source: "reconcile",
    });
    expect(ledger.insert({ ...reconciled!, dedupeKey: "s:1" })).not.toBeNull();
    const live = await resolveUsageEvent({
      ts: T0,
      kind: "chat",
      feature: "agent/heartbeat",
      provider: "anthropic",
      model: "claude-opus-4-8",
      sessionKey: "agent:main:main",
      channel: "heartbeat",
      runId: "run-hb",
      usage: HB_USAGE,
      cost: { total: 0.3 },
      cacheState: "write",
      cacheTtl: "5m",
    });
    expect(ledger.insert({ ...live!, dedupeKey: "s:1" })).toBeNull();
    const row = ledger.rows({})[0]!;
    expect(row).toMatchObject({
      feature: "agent/heartbeat",
      sessionKey: "agent:main:main",
      channel: "heartbeat",
      runId: "run-hb",
      cacheState: "write",
      cacheTtl: "5m",
      source: "live",
    });
    expect(ledger.count()).toBe(1);
  });
});

describe("relabel:v3 migration", () => {
  let dir: string;
  let ledger: UsageLedger;
  let sessionsDir: string;
  beforeEach(() => {
    resetModelPricingMemoForTest();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-usage-relabel3-"));
    sessionsDir = path.join(dir, "agents", "main", "sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });
    ledger = UsageLedger.openInMemory();
  });
  afterEach(() => {
    ledger.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function seedLegacy(
    sessionId: string,
    ts: number,
    usage: typeof HB_USAGE,
    feature = "agent/turn",
    source: "live" | "reconcile" = "reconcile",
  ) {
    const evt = await resolveUsageEvent({
      ts,
      kind: "chat",
      feature,
      provider: "anthropic",
      model: "claude-opus-4-8",
      agentId: "main",
      sessionId,
      usage,
      cost: { total: 0.3 },
      source,
    });
    ledger.insert({ ...evt!, dedupeKey: `${sessionId}:${ts}` });
  }

  it("collects dedupe keys of heartbeat turns from a transcript", async () => {
    const file = path.join(sessionsDir, "s-main.jsonl");
    fs.writeFileSync(file, mainTranscript());
    const keys = await collectHeartbeatDedupeKeys(file, "s-main", [HEARTBEAT_PROMPT]);
    expect(keys).toEqual([
      `s-main:${T0 + 1_000}`,
      `s-main:${T0 + 121_000}`,
      `s-main:${T0 + 122_000}`,
    ]);
  });

  it("relabels legacy rows by transcript, falls back to the signature, leaves live rows alone, runs once", async () => {
    fs.writeFileSync(path.join(sessionsDir, "s-main.jsonl"), mainTranscript());
    // Legacy backfill of the transcript above: everything landed as agent/turn.
    for (const ts of [T0 + 1_000, T0 + 121_000, T0 + 122_000]) {
      await seedLegacy("s-main", ts, HB_USAGE);
    }
    await seedLegacy("s-main", T0 + 61_000, CHAT_USAGE);
    await seedLegacy("s-main", T0 + 181_000, {
      input: 2,
      output: 3,
      cacheRead: 0,
      cacheWrite: 50_000,
    });
    // A pruned transcript: one heartbeat-shaped row and one real turn.
    await seedLegacy("s-gone", T0 + 5_000, HB_USAGE);
    await seedLegacy("s-gone", T0 + 6_000, CHAT_USAGE);
    // Live rows, already right, must not be touched.
    await seedLegacy("s-live", T0 + 7_000, HB_USAGE, "agent/heartbeat", "live");
    await seedLegacy("s-live", T0 + 8_000, HB_USAGE, "agent/turn", "live");

    const before = ledger.aggregate({})[0]!;
    const res = await relabelHeartbeatsV3({
      ledger,
      agentId: "main",
      sessionsDir,
      heartbeatPrompts: [HEARTBEAT_PROMPT],
    });
    expect(res).toMatchObject({ ran: true, files: 1, byTranscript: 3, bySignature: 1 });
    expect(ledger.getMeta("relabel:v3:main")).toBe("4");

    const hb = ledger.rows({ feature: "agent/heartbeat" });
    expect(hb.map((r) => `${r.sessionId}:${r.ts}`).toSorted()).toEqual(
      [
        `s-gone:${T0 + 5_000}`,
        `s-live:${T0 + 7_000}`,
        `s-main:${T0 + 1_000}`,
        `s-main:${T0 + 121_000}`,
        `s-main:${T0 + 122_000}`,
      ].toSorted(),
    );
    expect(hb.filter((r) => r.source === "reconcile").every((r) => r.channel === "heartbeat")).toBe(
      true,
    );
    const turns = ledger.rows({ feature: "agent/turn" });
    // The tiny "OK" reply in a transcript that still exists is judged by content, not signature.
    expect(turns.map((r) => `${r.sessionId}:${r.ts}`).toSorted()).toEqual(
      [
        `s-main:${T0 + 61_000}`,
        `s-main:${T0 + 181_000}`,
        `s-gone:${T0 + 6_000}`,
        `s-live:${T0 + 8_000}`,
      ].toSorted(),
    );
    // Totals and cost are untouched by a relabel.
    const after = ledger.aggregate({})[0]!;
    expect(after.total).toBe(before.total);
    expect(after.cost_total).toBeCloseTo(before.cost_total, 9);

    // Idempotent: the key exists, nothing runs.
    const again = await relabelHeartbeatsV3({
      ledger,
      agentId: "main",
      sessionsDir,
      heartbeatPrompts: [HEARTBEAT_PROMPT],
    });
    expect(again.ran).toBe(false);
    // reconcileTranscripts drives it and the freshly imported rows are already right.
    fs.writeFileSync(
      path.join(sessionsDir, "s-new.jsonl"),
      userLine(T0, HB) + assistantLine(T0 + 9_000, "HEARTBEAT_OK", HB_USAGE),
    );
    await reconcileTranscripts({ ledger, stateDir: dir, nowMs: T0 + 3_600_000 });
    expect(ledger.rows({ feature: "agent/heartbeat" })).toHaveLength(6);
  });
});

describe("provider-reported cost honours the cache TTL", () => {
  beforeEach(() => resetModelPricingMemoForTest());
  const base = {
    kind: "chat" as const,
    feature: "agent/heartbeat",
    provider: "anthropic",
    model: "claude-opus-4-8",
    usage: { input: 2, output: 13, cacheRead: 0, cacheWrite: 50_000 },
    // pi-ai prices the write at the 5-minute rate (1.25x input = $6.25/MTok on Opus).
    cost: { input: 0.00001, output: 0.000325, cacheRead: 0, cacheWrite: 0.3125, total: 0.312835 },
  };

  it("keeps a 5m row at the library's 1.25x figure with no frozen price", async () => {
    const row = await resolveUsageEvent({ ...base, cacheTtl: "5m" });
    expect(row?.costSource).toBe("provider");
    expect(row?.cost.cacheWrite).toBeCloseTo(0.3125, 9);
    expect(row?.cost.total).toBeCloseTo(0.312835, 9);
    expect(row?.price).toBeNull();
  });

  it("rescales a 1h row to 2x input (1.6x the library figure) and freezes the price used", async () => {
    const row = await resolveUsageEvent({ ...base, cacheTtl: "1h" });
    expect(row?.costSource).toBe("provider");
    expect(row?.cost.cacheWrite).toBeCloseTo(0.5, 9);
    expect(row?.cost.total).toBeCloseTo(0.00001 + 0.000325 + 0.5, 9);
    expect(row?.price?.cacheWrite).toBeCloseTo(10, 6);
    expect(row?.price?.input).toBeCloseTo(5, 6);
    // Computed cost from our own table agrees with the rescaled reported cost.
    expect(row?.costComputed).toBeCloseTo(row!.cost.total, 4);
    // Non-Anthropic providers and 5m rows are never rescaled.
    const other = await resolveUsageEvent({
      ...base,
      provider: "openai",
      model: "gpt-5",
      cacheTtl: "1h",
    });
    expect(other?.cost.cacheWrite).toBeCloseTo(0.3125, 9);
  });
});
