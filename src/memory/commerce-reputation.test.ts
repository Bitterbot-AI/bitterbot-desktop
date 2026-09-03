/**
 * PLAN-43 Phase 3 (§3.7): commerce reputation is built from THIS node's
 * outbound outcomes, and a peer that stops answering is quarantined.
 */

import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  COMMERCE_QUARANTINE_MS,
  CommerceReputationLedger,
  commercePeerKey,
} from "./commerce-reputation.js";

describe("CommerceReputationLedger", () => {
  it("keys peers by URL origin and computes answer rate, uptime, latency", () => {
    const ledger = new CommerceReputationLedger(new DatabaseSync(":memory:"));
    expect(commercePeerKey("https://Peer.Example:8443/a2a/")).toBe("https://peer.example:8443");
    ledger.recordOutcome({
      agentUrl: "https://peer.example/a2a",
      outcome: "answered",
      latencyMs: 100,
    });
    ledger.recordOutcome({
      agentUrl: "https://peer.example/",
      outcome: "answered",
      latencyMs: 300,
    });
    ledger.recordOutcome({ agentUrl: "https://peer.example", outcome: "dial_failure" });
    ledger.recordOutcome({ agentUrl: "https://peer.example", outcome: "failed" });
    const p = ledger.getPeer("https://peer.example")!;
    expect(p.attempts).toBe(4);
    expect(p.answerRate).toBeCloseTo(0.5);
    expect(p.uptime).toBeCloseTo(0.75);
    expect(p.avgLatencyMs).toBe(200);
    expect(p.quarantinedUntil).toBeNull();
    expect(ledger.listPeers()).toHaveLength(1);
  });

  it("auto-quarantines after 5+ attempts under a 50% answer rate; the window expires", () => {
    const ledger = new CommerceReputationLedger(new DatabaseSync(":memory:"));
    const t0 = 1_000_000;
    for (let i = 0; i < 4; i += 1) {
      ledger.recordOutcome({ agentUrl: "https://flaky", outcome: "dial_failure", now: t0 + i });
    }
    expect(ledger.quarantineFor("https://flaky", t0 + 10)).toBeNull();
    ledger.recordOutcome({ agentUrl: "https://flaky", outcome: "answered", now: t0 + 5 });
    const q = ledger.quarantineFor("https://flaky", t0 + 10);
    expect(q?.reason).toContain("answer rate 20%");
    expect(q?.until).toBe(t0 + 5 + COMMERCE_QUARANTINE_MS);
    expect(ledger.quarantineFor("https://flaky", t0 + 5 + COMMERCE_QUARANTINE_MS + 1)).toBeNull();
    ledger.clearQuarantine("https://flaky");
    expect(ledger.quarantineFor("https://flaky", t0 + 10)).toBeNull();
  });

  it("judges on the window since the last quarantine, so a recovered peer earns its way back", () => {
    const ledger = new CommerceReputationLedger(new DatabaseSync(":memory:"));
    const t0 = 1_000_000;
    for (let i = 0; i < 5; i += 1) {
      ledger.recordOutcome({
        agentUrl: "https://recovering",
        outcome: "dial_failure",
        now: t0 + i,
      });
    }
    const after = t0 + COMMERCE_QUARANTINE_MS + 10;
    expect(ledger.quarantineFor("https://recovering", after)).toBeNull();
    // Lifetime is 0/5; the window restarted at quarantine. One answer must NOT re-quarantine.
    const s = ledger.recordOutcome({
      agentUrl: "https://recovering",
      outcome: "answered",
      now: after,
    });
    expect(s.windowAttempts).toBe(1);
    expect(s.quarantinedUntil).toBeLessThan(after);
    expect(ledger.quarantineFor("https://recovering", after + 1)).toBeNull();
    expect(s.answerRate).toBeCloseTo(1 / 6);
  });

  it("a seller-pubkey quarantine blocks the seller's endpoint once the pubkey is known", () => {
    const ledger = new CommerceReputationLedger(new DatabaseSync(":memory:"));
    ledger.quarantine("peer:PK-SELLER", 9_999_999, "fraud");
    expect(ledger.quarantineFor("https://seller.example", 1, "pk-seller")?.reason).toBe("fraud");
    expect(ledger.quarantineFor("https://seller.example", 1)).toBeNull();
    ledger.recordOutcome({
      agentUrl: "https://seller.example",
      outcome: "answered",
      peerPubkey: "pk-seller",
    });
    expect(ledger.quarantineFor("https://seller.example", 1)?.reason).toBe("fraud");
  });
});
