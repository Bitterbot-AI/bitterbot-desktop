/**
 * Regression test for the wakeup-killing schema drift: the params that
 * cron-fired isolated agent turns send MUST validate against the gateway's
 * agent RPC schema. The original inputProvenance shape ({kind:"cron", jobId,
 * sessionKey}) failed validation, so every task wakeup bounced with
 * INVALID_REQUEST and tasks sat in waiting_external forever.
 */
import { describe, it, expect } from "vitest";
import { validateAgentParams } from "../gateway/protocol/index.js";
import { normalizeInputProvenance } from "../sessions/input-provenance.js";
import { buildIsolatedAgentTurnParams } from "./isolated-agent.js";

describe("isolated agent turn params", () => {
  it("validate against the gateway agent RPC schema", () => {
    const params = buildIsolatedAgentTurnParams({
      message: "[long-horizon wakeup] Resume task task-abc.",
      sessionKey: "cron:isolated:job-1",
      agentId: "main",
      idempotencyKey: "11111111-1111-4111-8111-111111111111",
    });
    const valid = validateAgentParams(params);
    if (!valid) {
      throw new Error(`schema rejection: ${JSON.stringify(validateAgentParams.errors)}`);
    }
    expect(valid).toBe(true);
  });

  it("carry provenance the normalizer keeps (not silently dropped)", () => {
    // model is intentionally NOT forwarded (no schema field on the agent
    // RPC); thinking is. Both set here to prove the built params stay valid.
    const params = buildIsolatedAgentTurnParams({
      message: "m",
      sessionKey: "cron:isolated:job-2",
      agentId: "main",
      idempotencyKey: "22222222-2222-4222-8222-222222222222",
      model: "anthropic/claude-opus-4-8",
      thinking: "low",
    });
    expect(params.model).toBeUndefined();
    expect(params.thinking).toBe("low");
    const provenance = normalizeInputProvenance(
      (params as { inputProvenance?: unknown }).inputProvenance,
    );
    expect(provenance).toBeDefined();
    expect(provenance?.kind).toBe("internal_system");
    expect(provenance?.sourceChannel).toBe("cron");
    expect(provenance?.sourceSessionKey).toBe("cron:isolated:job-2");
    expect(validateAgentParams(params)).toBe(true);
  });
});
