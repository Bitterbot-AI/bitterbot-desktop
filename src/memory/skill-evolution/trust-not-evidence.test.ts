/**
 * PLAN-45 I5: reputation never changes an activation decision, only
 * evaluation order.
 */
import { describe, expect, it } from "vitest";
import { generateKeyPair, pubkeyId } from "../../commerce/envelope.js";
import { SkillVersionResolver } from "../skill-version-resolver.js";
import { decideAttestationDemotion } from "./attestation-actions.js";
import { ATTEST_PROTOCOL, signAttestation, type SkillAttestation } from "./attestation.js";
import { makeAttesterWeight } from "./attester-weight.js";
import { transferDirection } from "./transfer-direction.js";

function att(key = generateKeyPair(), over: Partial<SkillAttestation> = {}): SkillAttestation {
  return signAttestation(
    {
      protocol: ATTEST_PROTOCOL,
      content_sha256: "ab".repeat(32),
      corpus_version: "canonical-g5-s1",
      corpus_seed: 1,
      private_suite_sha256: "cd".repeat(32),
      verdict: "regression",
      wins: 0,
      losses: 5,
      ties: 0,
      p_value: 0.01,
      regressions: 2,
      trials_per_task: 1,
      model: "m",
      attested_at: Date.now(),
      node_pubkey: null,
      ...over,
    },
    key,
  );
}

describe("I5: trust is not evidence", () => {
  it("the activation score ignores peer trust entirely; priority is where reputation lives", () => {
    const base = { executionSuccessRate: 0.4, executionCount: 10, ageMs: 1000 };
    const lo = SkillVersionResolver.fitness({ ...base, peerTrust: 0 });
    const hi = SkillVersionResolver.fitness({ ...base, peerTrust: 1 });
    expect(hi).toBe(lo);
    expect(SkillVersionResolver.evaluationPriority({ peerTrust: 1 })).toBe(1);
    expect(SkillVersionResolver.evaluationPriority({ peerTrust: -3 })).toBe(0);
    expect(SkillVersionResolver.evaluationPriority({ peerTrust: Number.NaN })).toBe(0.5);
  });

  it("demotion counts only the node's own verdict and trusted attesters, never reputation or unknown keys", () => {
    const own = generateKeyPair();
    const trustedA = generateKeyPair();
    const trustedB = generateKeyPair();
    const unknown1 = generateKeyPair();
    const unknown2 = generateKeyPair();
    const weightOf = makeAttesterWeight({
      ownAttesterPubkey: pubkeyId(own),
      trustedAttesters: [pubkeyId(trustedA), pubkeyId(trustedB)],
    });
    const now = Date.now();
    const corpusPrefix = "canonical-g5-";
    // Two unknown regressions: never enough, however many.
    expect(
      decideAttestationDemotion({
        attestations: [att(unknown1), att(unknown2)],
        weightOf,
        ownAttesterPubkey: pubkeyId(own),
        now,
        corpusPrefix,
      }).demote,
    ).toBe(false);
    // One trusted regression: not enough.
    expect(
      decideAttestationDemotion({
        attestations: [att(trustedA), att(unknown1)],
        weightOf,
        ownAttesterPubkey: pubkeyId(own),
        now,
        corpusPrefix,
      }).demote,
    ).toBe(false);
    // Two trusted: demote.
    const two = decideAttestationDemotion({
      attestations: [att(trustedA), att(trustedB)],
      weightOf,
      ownAttesterPubkey: pubkeyId(own),
      now,
      corpusPrefix,
    });
    expect(two).toMatchObject({ demote: true, trustedRegressions: 2, ownRegression: false });
    // Our own regression alone: demote.
    expect(
      decideAttestationDemotion({
        attestations: [att(own)],
        weightOf,
        ownAttesterPubkey: pubkeyId(own),
        now,
        corpusPrefix,
      }),
    ).toMatchObject({ demote: true, ownRegression: true });
    // Superseded by a newer accepted verdict from the same attester: no regression.
    expect(
      decideAttestationDemotion({
        attestations: [
          att(own, { attested_at: now - 1000 }),
          att(own, { verdict: "accepted", regressions: 0, wins: 5, losses: 0, attested_at: now }),
        ],
        weightOf,
        ownAttesterPubkey: pubkeyId(own),
        now,
        corpusPrefix,
      }).demote,
    ).toBe(false);
    // Stale (91 days) or previous corpus generation: ignored.
    expect(
      decideAttestationDemotion({
        attestations: [
          att(trustedA, { attested_at: now - 91 * 24 * 3600 * 1000 }),
          att(trustedB, { corpus_version: "canonical-g4-s1" }),
        ],
        weightOf,
        ownAttesterPubkey: pubkeyId(own),
        now,
        corpusPrefix,
      }).demote,
    ).toBe(false);
  });

  it("transfer direction orders by featured tier and fails to the cautious branch", () => {
    expect(transferDirection("anthropic/claude-haiku-4-5", "anthropic/claude-opus-5")).toBe(
      "weaker-to-stronger",
    );
    expect(transferDirection("anthropic/claude-opus-5", "anthropic/claude-haiku-4-5")).toBe(
      "stronger-to-weaker",
    );
    expect(transferDirection("anthropic/claude-opus-5", "anthropic/claude-opus-5")).toBe(
      "peer-to-peer",
    );
    expect(transferDirection("selfhosted/mystery-7b", "anthropic/claude-opus-5")).toBe("unknown");
    expect(transferDirection(undefined, "anthropic/claude-opus-5")).toBe("unknown");
  });
});
