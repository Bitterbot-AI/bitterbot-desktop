/**
 * PLAN-43 Phase 3 (§3.7): the A2A client records every outbound outcome in
 * the commerce ledger and refuses to spend on a quarantined peer.
 */

import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CommerceReputationLedger } from "../memory/commerce-reputation.js";
import { A2aClient, classifyOutcome } from "./a2a-client.js";

describe("A2aClient commerce standing", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("records dial failures and answers, then refuses a quarantined peer without dialing", async () => {
    const db = new DatabaseSync(":memory:");
    const client = new A2aClient({ taskTimeoutMs: 1000 }, db);
    let dials = 0;
    globalThis.fetch = (async () => {
      dials += 1;
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    for (let i = 0; i < 5; i += 1) {
      const r = await client.executeTask({ agentUrl: "https://down.example", message: "hi" });
      expect(r.success).toBe(false);
      expect(r.error).toContain("A2A request failed");
    }
    expect(dials).toBe(5);
    const ledger = new CommerceReputationLedger(db);
    const standing = ledger.getPeer("https://down.example")!;
    expect(standing.attempts).toBe(5);
    expect(standing.dialFailures).toBe(5);
    expect(standing.uptime).toBe(0);
    expect(ledger.quarantineFor("https://down.example")).not.toBeNull();

    // Quarantined: refused before any network call.
    const refused = await client.executeTask({ agentUrl: "https://down.example", message: "hi" });
    expect(refused.success).toBe(false);
    expect(refused.error).toContain("commerce-quarantined");
    expect(dials).toBe(5);
  });

  it("never scores our own refusals or HTTP 4xx against the peer", () => {
    expect(
      classifyOutcome({ success: false, error: "Price $2 exceeds per-task max $0.5" }),
    ).toBeNull();
    expect(
      classifyOutcome({
        success: false,
        error: "Daily A2A spend limit reached ($2.00/$2.00). Remaining: $0.00",
      }),
    ).toBeNull();
    expect(classifyOutcome({ success: false, error: "Payment failed: no funds" })).toBeNull();
    expect(classifyOutcome({ success: false, error: "A2A request failed: 402" })).toBeNull();
    expect(classifyOutcome({ success: false, error: "A2A request failed: 503" })).toBe(
      "dial_failure",
    );
    expect(
      classifyOutcome({ success: false, error: "A2A request failed: TypeError: fetch failed" }),
    ).toBe("dial_failure");
    expect(classifyOutcome({ success: false, error: "task failed" })).toBe("failed");
    expect(classifyOutcome({ success: true })).toBe("answered");
  });

  it("counts an answered task", async () => {
    const db = new DatabaseSync(":memory:");
    const client = new A2aClient({ taskTimeoutMs: 1000 }, db);
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        jsonrpc: "2.0",
        id: "1",
        result: {
          id: "task-1",
          status: { state: "completed" },
          artifacts: [{ name: "answer", parts: [{ kind: "text", text: "42" }] }],
        },
      }),
    })) as unknown as typeof fetch;
    const r = await client.executeTask({ agentUrl: "https://up.example", message: "hi" });
    expect(r.success).toBe(true);
    const standing = new CommerceReputationLedger(db).getPeer("https://up.example")!;
    expect(standing.answered).toBe(1);
    expect(standing.answerRate).toBe(1);
  });
});
