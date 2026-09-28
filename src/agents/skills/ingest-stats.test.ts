import { beforeEach, describe, expect, it } from "vitest";
import {
  getIngestOutcomeStats,
  recordIngestOutcome,
  resetIngestOutcomeStatsForTest,
} from "./ingest-stats.js";

const env = (author: string, name: string) => ({ author_pubkey: author, name });

describe("ingest outcome stats", () => {
  beforeEach(() => resetIngestOutcomeStatsForTest());

  it("counts skills, not messages, and separates repeats from rejections", () => {
    // The 2026-09-28 pattern: one peer re-sending the same crystal many times.
    recordIngestOutcome(env("peerA", "e03d582d"), {
      action: "rejected",
      reason: "legacy unvalidated dream crystal",
    });
    for (let i = 0; i < 70; i++) {
      recordIngestOutcome(env("peerA", "e03d582d"), {
        action: "rejected",
        reason: "legacy dream crystal (repeat)",
      });
    }
    const s = getIngestOutcomeStats();
    expect(s.messages).toBe(71);
    expect(s.distinctSkills).toBe(1);
    expect(s.rejected).toBe(1);
    expect(s.repeatsIgnored).toBe(70);
    expect(s.rejectReasons).toEqual({ "legacy unvalidated dream crystal": 1 });
  });

  it("buckets accepted, held, retracted and errors", () => {
    recordIngestOutcome(env("a", "one"), { action: "accepted" });
    recordIngestOutcome(env("a", "two"), { action: "quarantined" });
    recordIngestOutcome(env("a", "three"), { action: "staged" });
    recordIngestOutcome(env("a", "four"), { action: "retracted" });
    recordIngestOutcome(env("b", "one"), null);
    const s = getIngestOutcomeStats();
    expect(s).toMatchObject({
      distinctSkills: 5,
      accepted: 1,
      heldForReview: 2,
      retracted: 1,
      rejected: 1,
      rejectReasons: { "ingest error": 1 },
    });
  });

  it("treats names case-insensitively per author", () => {
    recordIngestOutcome(env("a", "Curl-Guard"), { action: "quarantined" });
    recordIngestOutcome(env("a", "curl-guard"), {
      action: "rejected",
      reason: "duplicate content hash",
    });
    expect(getIngestOutcomeStats().distinctSkills).toBe(1);
  });
});

describe("ingest outcome stats: own echoes", () => {
  beforeEach(() => resetIngestOutcomeStatsForTest());

  it("keeps our own echoed skills out of every received count", () => {
    recordIngestOutcome(
      { author_pubkey: "me", name: "mine" },
      { action: "rejected", reason: "self-loopback (own published skill)" },
    );
    expect(getIngestOutcomeStats()).toMatchObject({
      ownEchoesIgnored: 1,
      messages: 0,
      distinctSkills: 0,
      rejected: 0,
    });
  });
});
