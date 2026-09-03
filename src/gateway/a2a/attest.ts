/**
 * PLAN-43 Phase 3 (§3.4/§3.6): the `skill/attest` A2A verbs — the network
 * validation layer's exchange surface.
 *
 *   skill/attest.list   {contentSha256}  -> {attestations: SkillAttestation[]}
 *   skill/attest.submit {attestation}    -> {stored: boolean}
 *
 * Auth-exempt like forage/circle/mailbox verbs: attestations carry their
 * OWN Ed25519 signatures (verified on submit; served as stored), and
 * serving them to strangers is the point — a node's verdict about a
 * content hash is public evidence. Submits are rate-limited per client and
 * refused for blocked attesters. Nothing here executes anything.
 */

import type { DatabaseSync } from "node:sqlite";
import {
  attestationStoreHasRoom,
  listAttestations,
  skillContentSha256,
  storeAttestation,
  verifyAttestation,
  type SkillAttestation,
} from "../../memory/skill-evolution/attestation.js";
import { A2aErrorCodes } from "./types.js";

export type AttestOutcome<T> =
  | { ok: true; result: T }
  | { ok: false; error: { code: number; message: string } };

const SUBMIT_RATE_LIMIT = 30; // per client per minute
const SUBMIT_WINDOW_MS = 60_000;
const MAX_LIST = 50;
const submitTracker = new Map<string, { count: number; windowStart: number }>();

export function isAttestSubmitRateLimited(clientKey: string, now = Date.now()): boolean {
  if (submitTracker.size > 10_000) {
    for (const [k, v] of submitTracker) {
      if (now - v.windowStart > SUBMIT_WINDOW_MS) {
        submitTracker.delete(k);
      }
    }
  }
  const entry = submitTracker.get(clientKey);
  if (!entry || now - entry.windowStart > SUBMIT_WINDOW_MS) {
    submitTracker.set(clientKey, { count: 1, windowStart: now });
    return false;
  }
  entry.count += 1;
  return entry.count > SUBMIT_RATE_LIMIT;
}

/**
 * Content hashes of the skills this node HOLDS. A stranger may only file
 * evidence about skills we have (no pre-seeding verdicts for hashes that
 * have not arrived, no unbounded rows for made-up hashes). Cached on the
 * skill row count + max updated_at.
 */
let heldCache: { key: string; shas: Set<string> } | null = null;
export function heldSkillHashes(db: DatabaseSync): Set<string> {
  const stat = db
    .prepare(
      `SELECT COUNT(*) AS c, COALESCE(MAX(updated_at), 0) AS m FROM chunks
        WHERE semantic_type IN ('skill', 'task_pattern')`,
    )
    .get() as { c: number; m: number };
  const key = `${stat.c}:${stat.m}`;
  if (!heldCache || heldCache.key !== key) {
    const rows = db
      .prepare(`SELECT text FROM chunks WHERE semantic_type IN ('skill', 'task_pattern')`)
      .all() as Array<{ text: string }>;
    heldCache = { key, shas: new Set(rows.map((r) => skillContentSha256(r.text))) };
  }
  return heldCache.shas;
}

/** Test hook. */
export function resetHeldSkillHashCache(): void {
  heldCache = null;
}

function err<T>(code: number, message: string): AttestOutcome<T> {
  return { ok: false, error: { code, message } };
}

export function handleAttestMethod(
  method: string,
  params: unknown,
  db: DatabaseSync,
  opts: {
    clientKey?: string;
    isBlockedAttester?: (attesterPubkey: string) => boolean;
    now?: number;
    /** Override of the held-skill hash set (tests). */
    heldHashes?: Set<string>;
  } = {},
): AttestOutcome<unknown> {
  const p = (params ?? {}) as Record<string, unknown>;
  switch (method) {
    case "skill/attest.list": {
      const sha = p.contentSha256;
      if (typeof sha !== "string" || !/^[0-9a-f]{64}$/.test(sha)) {
        return err(A2aErrorCodes.INVALID_PARAMS, "contentSha256 (64 hex) required");
      }
      const attestations = listAttestations(db, sha).slice(0, MAX_LIST);
      return { ok: true, result: { contentSha256: sha, attestations } };
    }
    case "skill/attest.submit": {
      if (opts.clientKey && isAttestSubmitRateLimited(opts.clientKey, opts.now)) {
        return err(A2aErrorCodes.INTERNAL_ERROR, "Too many attestation submits; slow down");
      }
      const att = p.attestation;
      if (!verifyAttestation(att)) {
        return err(A2aErrorCodes.INVALID_PARAMS, "attestation failed verification");
      }
      const verified = att as SkillAttestation;
      if (opts.isBlockedAttester?.(verified.attester_pubkey)) {
        return err(A2aErrorCodes.INVALID_REQUEST, "attester is blocked on this node");
      }
      if (!(opts.heldHashes ?? heldSkillHashes(db)).has(verified.content_sha256)) {
        return err(A2aErrorCodes.INVALID_REQUEST, "this node does not hold that skill");
      }
      if (!attestationStoreHasRoom(db, verified)) {
        return err(A2aErrorCodes.INTERNAL_ERROR, "attestation store full for that skill");
      }
      const stored = storeAttestation(db, verified, "peer");
      return { ok: true, result: { stored } };
    }
    default:
      return err(A2aErrorCodes.METHOD_NOT_FOUND, `Unknown method: ${method}`);
  }
}
