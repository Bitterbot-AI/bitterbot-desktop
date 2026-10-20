/**
 * PLAN-43 Phase 3: attestation exchange client — pushes our local
 * evidence, pulls verified peer evidence, ignores forgeries, blocked
 * attesters, and unreachable peers, all within its bounds.
 */

import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { generateKeyPair, pubkeyId } from "../commerce/envelope.js";
import {
  ATTEST_PROTOCOL,
  listAttestations,
  signAttestation,
  storeAttestation,
  type SkillAttestation,
} from "../memory/skill-evolution/attestation.js";
import { syncAttestations, type FetchLike } from "./attestation-client.js";

const ME = generateKeyPair();
const PEER = generateKeyPair();
const SHA = "c".repeat(64);

function att(key = ME, over: Partial<SkillAttestation> = {}): SkillAttestation {
  return signAttestation(
    {
      protocol: ATTEST_PROTOCOL,
      content_sha256: SHA,
      corpus_version: "canonical-g3-s1",
      corpus_seed: 1,
      private_suite_sha256: null,
      verdict: "accepted",
      wins: 3,
      losses: 0,
      ties: 1,
      p_value: 0.1,
      regressions: 0,
      trials_per_task: 1,
      model: null,
      attested_at: Date.now(),
      node_pubkey: null,
      ...over,
    },
    key,
  );
}

/** A fake peer: records submits, serves a fixed list. */
function fakePeer(served: unknown[]) {
  const submitted: unknown[] = [];
  const fetchFn: FetchLike = async (_url, init) => {
    const body = JSON.parse(init.body) as { method: string; params: Record<string, unknown> };
    let result: unknown;
    if (body.method === "skill/attest.submit") {
      submitted.push(body.params.attestation);
      result = { stored: true };
    } else if (body.method === "skill/attest.list") {
      result = { contentSha256: body.params.contentSha256, attestations: served };
    }
    return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", result, id: 1 }) };
  };
  return { fetchFn, submitted };
}

describe("syncAttestations", () => {
  it("pushes our evidence and pulls only VERIFIED, non-blocked peer evidence", async () => {
    const db = new DatabaseSync(":memory:");
    storeAttestation(db, att(ME), "local");
    const forged = { ...att(PEER), wins: 99 };
    const blockedKey = generateKeyPair();
    const peer = fakePeer([
      att(PEER),
      forged,
      att(blockedKey),
      att(ME, { wins: 2, attested_at: Date.now() + 1000 }),
    ]);
    const r = await syncAttestations({
      db,
      peers: ["http://peer.example"],
      contentSha256s: [SHA],
      ownAttesterPubkey: pubkeyId(ME),
      fetchFn: peer.fetchFn,
      isBlockedAttester: (pk) => pk === pubkeyId(blockedKey),
    });
    expect(r).toEqual({ pushed: 1, pulled: 1, peersFailed: 0 });
    expect(peer.submitted).toHaveLength(1);
    const stored = listAttestations(db, SHA);
    expect(stored.map((a) => a.attester_pubkey).toSorted()).toEqual(
      [pubkeyId(ME), pubkeyId(PEER)].toSorted(),
    );
    // Our own record is never overwritten by a peer's copy of "us".
    expect(stored.find((a) => a.attester_pubkey === pubkeyId(ME))?.wins).toBe(3);
  });

  it("counts unreachable peers and keeps going; bounds peers and hashes", async () => {
    const db = new DatabaseSync(":memory:");
    const down: FetchLike = async () => ({ ok: false, status: 503, json: async () => ({}) });
    const r = await syncAttestations({
      db,
      peers: Array.from({ length: 12 }, (_, i) => `http://p${i}`),
      contentSha256s: Array.from({ length: 30 }, (_, i) => i.toString(16).padStart(64, "0")),
      ownAttesterPubkey: pubkeyId(ME),
      fetchFn: down,
    });
    expect(r).toEqual({ pushed: 0, pulled: 0, peersFailed: 8 });
  });
});
