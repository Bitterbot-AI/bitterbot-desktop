/**
 * PLAN-43 Phase 3 (§3.4): attestation exchange client — pull peers'
 * verdicts for the skills we hold and push ours. Every received record is
 * signature-verified before it is stored (as source "peer"); nothing a
 * peer sends can bypass that. Peers are the operator-configured
 * `a2a.attestation.peers` URLs (the reachability limits of §3.7 apply;
 * mesh transport is a follow-up once the orchestrator exposes signing).
 */

import type { DatabaseSync } from "node:sqlite";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  listAttestations,
  storeAttestation,
  verifyAttestation,
  type SkillAttestation,
} from "../memory/skill-evolution/attestation.js";

const log = createSubsystemLogger("services/attestation-client");

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  text?: () => Promise<string>;
}>;

const MAX_PEERS_PER_SYNC = 8;
const MAX_SHAS_PER_SYNC = 20;
const REQUEST_TIMEOUT_MS = 15_000;
/** A hostile peer's response body is read at most this far (3c adversarial F8). */
export const MAX_RESPONSE_BYTES = 256 * 1024;
/** Attestations examined per list response; the verb itself caps at 50. */
const MAX_LIST_PER_RESPONSE = 50;
/** Wall clock per peer per sync, so eight slow peers cannot own housekeeping. */
const PEER_DEADLINE_MS = 60_000;

async function rpc(
  fetchFn: FetchLike,
  agentUrl: string,
  method: string,
  params: unknown,
): Promise<unknown> {
  const res = await fetchFn(`${agentUrl.replace(/\/+$/, "")}/a2a`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method, params, id: crypto.randomUUID() }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  let body: { result?: unknown; error?: { message?: string } };
  if (res.text) {
    const raw = await res.text();
    if (Buffer.byteLength(raw, "utf8") > MAX_RESPONSE_BYTES) {
      throw new Error("response too large");
    }
    body = JSON.parse(raw) as typeof body;
  } else {
    body = (await res.json()) as typeof body;
  }
  if (body.error) {
    throw new Error(body.error.message ?? "rpc error");
  }
  return body.result;
}

/** Pull a peer's attestations for one content hash; only verified records are returned. */
export async function fetchPeerAttestations(
  agentUrl: string,
  contentSha256: string,
  fetchFn: FetchLike = fetch as unknown as FetchLike,
): Promise<SkillAttestation[]> {
  const result = (await rpc(fetchFn, agentUrl, "skill/attest.list", { contentSha256 })) as {
    attestations?: unknown[];
  };
  const out: SkillAttestation[] = [];
  const list = Array.isArray(result?.attestations)
    ? result.attestations.slice(0, MAX_LIST_PER_RESPONSE)
    : [];
  for (const raw of list) {
    if (verifyAttestation(raw) && raw.content_sha256 === contentSha256) {
      out.push(raw);
    }
  }
  return out;
}

export async function submitAttestation(
  agentUrl: string,
  attestation: SkillAttestation,
  fetchFn: FetchLike = fetch as unknown as FetchLike,
): Promise<boolean> {
  const result = (await rpc(fetchFn, agentUrl, "skill/attest.submit", { attestation })) as {
    stored?: boolean;
  };
  return result?.stored === true;
}

/**
 * Best-effort sync with configured peers: push our LOCAL attestations for
 * the given content hashes, pull theirs. Bounded; failures are logged per
 * peer and never thrown. Returns counts.
 */
export async function syncAttestations(params: {
  db: DatabaseSync;
  peers: string[];
  contentSha256s: string[];
  ownAttesterPubkey: string;
  fetchFn?: FetchLike;
  isBlockedAttester?: (attesterPubkey: string) => boolean;
}): Promise<{ pushed: number; pulled: number; peersFailed: number }> {
  const fetchFn = params.fetchFn ?? (fetch as unknown as FetchLike);
  const peers = params.peers.slice(0, MAX_PEERS_PER_SYNC);
  const shas = [...new Set(params.contentSha256s)].slice(0, MAX_SHAS_PER_SYNC);
  let pushed = 0;
  let pulled = 0;
  let peersFailed = 0;
  for (const peer of peers) {
    const deadline = Date.now() + PEER_DEADLINE_MS;
    try {
      for (const sha of shas) {
        if (Date.now() > deadline) {
          throw new Error("peer deadline exceeded");
        }
        const mine = listAttestations(params.db, sha).filter(
          (a) => a.attester_pubkey === params.ownAttesterPubkey,
        );
        for (const att of mine) {
          if (await submitAttestation(peer, att, fetchFn)) {
            pushed += 1;
          }
        }
        for (const att of await fetchPeerAttestations(peer, sha, fetchFn)) {
          if (att.attester_pubkey === params.ownAttesterPubkey) {
            continue;
          }
          if (params.isBlockedAttester?.(att.attester_pubkey)) {
            continue;
          }
          if (storeAttestation(params.db, att, "peer")) {
            pulled += 1;
          }
        }
      }
    } catch (err) {
      peersFailed += 1;
      log.debug(`attestation sync with ${peer} failed: ${String(err)}`);
    }
  }
  return { pushed, pulled, peersFailed };
}
