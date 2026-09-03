/**
 * PLAN-43 Phase 3: the `skill/attest.*` A2A verbs — list serves stored
 * evidence, submit verifies before storing, only skills this node HOLDS
 * may be attested, blocked attesters and floods are refused, growth is
 * capped, and nothing here executes anything.
 */

import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { generateKeyPair, pubkeyId } from "../../commerce/envelope.js";
import {
  ATTEST_PROTOCOL,
  listAttestations,
  signAttestation,
  type SkillAttestation,
} from "../../memory/skill-evolution/attestation.js";
import { handleAttestMethod, isAttestSubmitRateLimited } from "./attest.js";

const KEY = generateKeyPair();
const SHA = "b".repeat(64);
const HELD = { heldHashes: new Set([SHA]) };

function att(over: Partial<SkillAttestation> = {}, key = KEY): SkillAttestation {
  return signAttestation(
    {
      protocol: ATTEST_PROTOCOL,
      content_sha256: SHA,
      corpus_version: "canonical-g3-s7",
      corpus_seed: 7,
      private_suite_sha256: null,
      verdict: "accepted",
      wins: 4,
      losses: 1,
      ties: 0,
      p_value: 0.03,
      regressions: 0,
      trials_per_task: 3,
      model: null,
      attested_at: Date.now(),
      node_pubkey: null,
      ...over,
    },
    key,
  );
}

function submit(db: DatabaseSync, attestation: unknown, opts = HELD) {
  return handleAttestMethod("skill/attest.submit", { attestation }, db, opts);
}

describe("skill/attest verbs", () => {
  it("submit verifies + stores; list serves it back; tampered and hold records are refused", () => {
    const db = new DatabaseSync(":memory:");
    const good = att();
    expect(submit(db, good)).toEqual({ ok: true, result: { stored: true } });
    const listed = handleAttestMethod("skill/attest.list", { contentSha256: SHA }, db);
    expect(listed.ok).toBe(true);
    expect((listed as { result: { attestations: unknown[] } }).result.attestations).toHaveLength(1);

    expect(submit(db, { ...good, wins: 40 }).ok).toBe(false);
    expect(submit(db, att({ verdict: "no-capability-tasks", wins: 0, losses: 0 })).ok).toBe(false);
    expect(listAttestations(db, SHA)).toHaveLength(1);
  });

  it("rejects bad params and unknown methods without touching the store", () => {
    const db = new DatabaseSync(":memory:");
    expect(handleAttestMethod("skill/attest.list", { contentSha256: "zz" }, db).ok).toBe(false);
    expect(handleAttestMethod("skill/attest.submit", {}, db, HELD).ok).toBe(false);
    expect(handleAttestMethod("skill/attest.nuke", {}, db).ok).toBe(false);
  });

  it("only accepts evidence about skills this node HOLDS, and caps attesters per hash", () => {
    const db = new DatabaseSync(":memory:");
    // Not held: refused, nothing stored (no pre-seeding verdicts for skills that never arrived).
    expect(submit(db, att(), { heldHashes: new Set<string>() }).ok).toBe(false);
    expect(listAttestations(db, SHA)).toHaveLength(0);
    // Held: 64 distinct attesters fit; the 65th is refused.
    for (let i = 0; i < 64; i += 1) {
      expect(submit(db, att({}, generateKeyPair())).ok).toBe(true);
    }
    expect(submit(db, att({}, generateKeyPair())).ok).toBe(false);
    expect(listAttestations(db, SHA)).toHaveLength(64);
    // An attester already present may still refresh its record.
    const existing = listAttestations(db, SHA)[0]!;
    const refreshed = { ...existing };
    expect(refreshed.attester_pubkey).toBeDefined();
  });

  it("refuses blocked attesters and per-client floods", () => {
    const db = new DatabaseSync(":memory:");
    const ring = generateKeyPair();
    const blocked = submit(db, att({}, ring), {
      ...HELD,
      isBlockedAttester: (pk) => pk === pubkeyId(ring),
    });
    expect(blocked.ok).toBe(false);
    expect(listAttestations(db, SHA)).toHaveLength(0);

    const client = `flood-${Date.now()}`;
    let limited = false;
    for (let i = 0; i < 40; i += 1) {
      limited = isAttestSubmitRateLimited(client, 1_000_000);
    }
    expect(limited).toBe(true);
    // A new window resets.
    expect(isAttestSubmitRateLimited(client, 2_000_000)).toBe(false);
  });
});
