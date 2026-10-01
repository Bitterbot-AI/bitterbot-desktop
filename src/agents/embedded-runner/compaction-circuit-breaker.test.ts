import { afterEach, describe, expect, it } from "vitest";
import {
  __compactionBreakerConsts,
  __resetCompactionBreakerForTest,
  checkCompactionBreaker,
  getCompactionBreakerSnapshot,
  listCompactionBreakers,
  recordCompactionFailure,
  recordCompactionSuccess,
} from "./compaction-circuit-breaker.js";

const KEY = "agent-a:session-1";
const { FAILURE_THRESHOLD, INITIAL_COOLDOWN_MS, MAX_COOLDOWN_MS } = __compactionBreakerConsts;

afterEach(() => {
  __resetCompactionBreakerForTest();
});

describe("compaction circuit breaker — initial state", () => {
  it("allows when never used", () => {
    expect(checkCompactionBreaker(KEY)).toEqual({ allow: true, state: "closed" });
  });

  it("returns null snapshot when never used", () => {
    expect(getCompactionBreakerSnapshot("never-touched")).toBeNull();
  });
});

describe("breaker stays closed under N-1 failures", () => {
  it("does not open at threshold-1", () => {
    for (let i = 0; i < FAILURE_THRESHOLD - 1; i++) {
      const r = recordCompactionFailure(KEY, "summary_failed");
      expect(r.opened).toBe(false);
      expect(r.state).toBe("closed");
    }
    expect(checkCompactionBreaker(KEY).allow).toBe(true);
  });
});

describe("breaker opens after N consecutive breaking failures", () => {
  it("opens at exactly FAILURE_THRESHOLD", () => {
    let last;
    for (let i = 0; i < FAILURE_THRESHOLD; i++) {
      last = recordCompactionFailure(KEY, "summary_failed");
    }
    expect(last!.opened).toBe(true);
    expect(last!.state).toBe("open");

    const check = checkCompactionBreaker(KEY);
    expect(check.allow).toBe(false);
    if (!check.allow) {
      expect(check.state).toBe("open");
      expect(check.cooldownRemainingMs).toBeGreaterThan(0);
    }
  });

  it("classifies non-breaking reasons as not counting", () => {
    for (let i = 0; i < FAILURE_THRESHOLD * 2; i++) {
      recordCompactionFailure(KEY, "below_threshold");
      recordCompactionFailure(KEY, "no_compactable_entries");
      recordCompactionFailure(KEY, "already_compacted_recently");
      recordCompactionFailure(KEY, "guard_blocked");
    }
    expect(checkCompactionBreaker(KEY).allow).toBe(true);
  });

  it("resets the counter when a non-breaking reason interleaves", () => {
    recordCompactionFailure(KEY, "summary_failed");
    recordCompactionFailure(KEY, "summary_failed");
    recordCompactionFailure(KEY, "below_threshold"); // resets
    recordCompactionFailure(KEY, "summary_failed");
    expect(checkCompactionBreaker(KEY).allow).toBe(true);
  });

  it("a successful compaction in between also resets", () => {
    recordCompactionFailure(KEY, "summary_failed");
    recordCompactionFailure(KEY, "summary_failed");
    recordCompactionSuccess(KEY);
    recordCompactionFailure(KEY, "summary_failed");
    expect(checkCompactionBreaker(KEY).allow).toBe(true);
  });
});

describe("open → half-open transition after cooldown", () => {
  it("transitions to half-open exactly once when cooldown elapses", () => {
    const t0 = 1_000_000;
    for (let i = 0; i < FAILURE_THRESHOLD; i++) {
      recordCompactionFailure(KEY, "summary_failed", t0);
    }
    // Just before cooldown: still blocked.
    expect(checkCompactionBreaker(KEY, t0 + INITIAL_COOLDOWN_MS - 1).allow).toBe(false);

    // Just after cooldown: allowed, state half-open.
    const c = checkCompactionBreaker(KEY, t0 + INITIAL_COOLDOWN_MS + 1);
    expect(c.allow).toBe(true);
    if (c.allow) expect(c.state).toBe("half-open");

    // A second concurrent check while half-open is blocked (trial in flight).
    expect(checkCompactionBreaker(KEY, t0 + INITIAL_COOLDOWN_MS + 2).allow).toBe(false);
  });
});

describe("half-open trial outcomes", () => {
  it("success closes the breaker and resets cooldown", () => {
    const t0 = 1_000_000;
    for (let i = 0; i < FAILURE_THRESHOLD; i++) {
      recordCompactionFailure(KEY, "summary_failed", t0);
    }
    checkCompactionBreaker(KEY, t0 + INITIAL_COOLDOWN_MS + 1); // → half-open
    recordCompactionSuccess(KEY);

    const snap = getCompactionBreakerSnapshot(KEY)!;
    expect(snap.state).toBe("closed");
    expect(snap.consecutiveFailures).toBe(0);
    expect(snap.cooldownMs).toBe(INITIAL_COOLDOWN_MS);
  });

  it("failure re-opens with doubled cooldown", () => {
    const t0 = 1_000_000;
    for (let i = 0; i < FAILURE_THRESHOLD; i++) {
      recordCompactionFailure(KEY, "summary_failed", t0);
    }
    checkCompactionBreaker(KEY, t0 + INITIAL_COOLDOWN_MS + 1); // → half-open

    const t1 = t0 + INITIAL_COOLDOWN_MS + 2;
    const r = recordCompactionFailure(KEY, "summary_failed", t1);
    expect(r.opened).toBe(true);
    expect(r.state).toBe("open");

    const snap = getCompactionBreakerSnapshot(KEY)!;
    expect(snap.cooldownMs).toBe(INITIAL_COOLDOWN_MS * 2);
    expect(snap.cooldownUntil).toBe(t1 + INITIAL_COOLDOWN_MS * 2);
  });

  it("caps cooldown at MAX_COOLDOWN_MS", () => {
    const t0 = 1_000_000;
    let now = t0;
    for (let i = 0; i < FAILURE_THRESHOLD; i++) {
      recordCompactionFailure(KEY, "summary_failed", now);
    }
    // Repeatedly trial→fail to grow cooldown until it caps.
    for (let i = 0; i < 20; i++) {
      const snap = getCompactionBreakerSnapshot(KEY)!;
      now = snap.cooldownUntil + 1;
      checkCompactionBreaker(KEY, now); // → half-open
      recordCompactionFailure(KEY, "summary_failed", now);
    }
    const snap = getCompactionBreakerSnapshot(KEY)!;
    expect(snap.cooldownMs).toBe(MAX_COOLDOWN_MS);
  });
});

describe("listCompactionBreakers", () => {
  it("returns nothing initially", () => {
    expect(listCompactionBreakers()).toEqual([]);
  });

  it("returns one entry per touched session", () => {
    recordCompactionFailure("a:1", "summary_failed");
    recordCompactionFailure("b:2", "timeout");
    const list = listCompactionBreakers();
    expect(list.map((e) => e.sessionKey).toSorted()).toEqual(["a:1", "b:2"]);
  });
});

describe("constants exported", () => {
  it("matches the documented values", () => {
    expect(FAILURE_THRESHOLD).toBe(3);
    expect(INITIAL_COOLDOWN_MS).toBe(10 * 60 * 1000);
    expect(MAX_COOLDOWN_MS).toBe(60 * 60 * 1000);
  });
});
