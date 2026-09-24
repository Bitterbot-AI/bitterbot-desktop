import { describe, expect, it } from "vitest";
import type { XLedgerEntry } from "./types.js";
import { DEFAULT_POLICY } from "./config.js";
import { evaluatePolicy } from "./policy.js";

const NOW = Date.parse("2026-09-17T12:00:00Z");
const H = 60 * 60 * 1000;

function entry(ts: number, text: string, extra: Partial<XLedgerEntry> = {}): XLedgerEntry {
  return { ts, id: String(ts), kind: "post", text, accountId: "default", ...extra };
}

describe("evaluatePolicy", () => {
  it("accepts a plain short post with empty history", () => {
    const v = evaluatePolicy({
      text: "Day 0. This seems irresponsible.",
      policy: DEFAULT_POLICY,
      history: [],
      now: NOW,
    });
    expect(v).toEqual({ ok: true, weightedLength: 32 });
  });

  it("rejects empty and over-length posts", () => {
    expect(evaluatePolicy({ text: "   ", policy: DEFAULT_POLICY, history: [], now: NOW }).ok).toBe(
      false,
    );
    const long = evaluatePolicy({
      text: "a".repeat(281),
      policy: DEFAULT_POLICY,
      history: [],
      now: NOW,
    });
    expect(long.ok).toBe(false);
    expect(!long.ok && long.reason).toMatch(/281 weighted/);
  });

  it("blocks replies unless allowReplies", () => {
    const blocked = evaluatePolicy({
      text: "hi",
      replyToId: "123",
      policy: DEFAULT_POLICY,
      history: [],
      now: NOW,
    });
    expect(blocked.ok).toBe(false);
    expect(!blocked.ok && blocked.reason).toMatch(/written approval/);
    const allowed = evaluatePolicy({
      text: "hi",
      replyToId: "123",
      policy: { ...DEFAULT_POLICY, allowReplies: true },
      history: [],
      now: NOW,
    });
    expect(allowed.ok).toBe(true);
  });

  it("blocks links unless allowLinks", () => {
    const v = evaluatePolicy({
      text: "read bitterbot.ai",
      policy: DEFAULT_POLICY,
      history: [],
      now: NOW,
    });
    expect(v.ok).toBe(false);
    expect(!v.ok && v.reason).toMatch(/links are disabled/);
    expect(
      evaluatePolicy({
        text: "read bitterbot.ai",
        policy: { ...DEFAULT_POLICY, allowLinks: true },
        history: [],
        now: NOW,
      }).ok,
    ).toBe(true);
  });

  it("blocks mentions of others but allows self-mention", () => {
    const other = evaluatePolicy({
      text: "hey @elonmusk",
      policy: DEFAULT_POLICY,
      history: [],
      selfHandle: "bitterbot_ai",
      now: NOW,
    });
    expect(other.ok).toBe(false);
    const self = evaluatePolicy({
      text: "I am @Bitterbot_AI",
      policy: DEFAULT_POLICY,
      history: [],
      selfHandle: "bitterbot_ai",
      now: NOW,
    });
    expect(self.ok).toBe(true);
  });

  it("enforces the daily cap on a rolling 24h window", () => {
    const history = [1, 4, 8, 12].map((h) => entry(NOW - h * H, `post ${h}`));
    const v = evaluatePolicy({ text: "one more", policy: DEFAULT_POLICY, history, now: NOW });
    expect(v.ok).toBe(false);
    expect(!v.ok && v.reason).toMatch(/daily cap reached \(4\/4/);
    // The 12h-old post falls out of the window 12h later.
    const later = evaluatePolicy({
      text: "one more",
      policy: { ...DEFAULT_POLICY, minIntervalMinutes: 0 },
      history,
      now: NOW + 12.5 * H,
    });
    expect(later.ok).toBe(true);
  });

  it("enforces the minimum interval", () => {
    const history = [entry(NOW - 30 * 60 * 1000, "recent")];
    const v = evaluatePolicy({ text: "again already", policy: DEFAULT_POLICY, history, now: NOW });
    expect(v.ok).toBe(false);
    expect(!v.ok && v.reason).toMatch(/minimum interval is 90/);
  });

  it("rejects exact and near duplicates inside the window", () => {
    const history = [
      entry(NOW - 5 * 24 * H, "Memory is weird. I remember being corrected but not being wrong."),
    ];
    const exact = evaluatePolicy({
      text: "memory is weird, I remember being corrected but not being wrong",
      policy: DEFAULT_POLICY,
      history,
      now: NOW,
    });
    expect(exact.ok).toBe(false);
    expect(!exact.ok && exact.reason).toMatch(/too similar/);
    const fresh = evaluatePolicy({
      text: "Dreamt about Tuesday. Consolidation has opinions.",
      policy: DEFAULT_POLICY,
      history,
      now: NOW,
    });
    expect(fresh.ok).toBe(true);
  });

  it("maxPostsPerDay=0 blocks everything", () => {
    const v = evaluatePolicy({
      text: "hi",
      policy: { ...DEFAULT_POLICY, maxPostsPerDay: 0 },
      history: [],
      now: NOW,
    });
    expect(v.ok).toBe(false);
  });
});
