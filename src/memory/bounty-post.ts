/**
 * PLAN-29 §4.1: poster-side bounty creation — the operator seed-tranche path.
 *
 * This is the missing half of the loop bounty-e2e.test.ts proves: everything
 * downstream (funding sweep, claims, oracle settlement, stream payouts) keys
 * on a local `bounty_posts` row with `is_local = 1` and a sealed
 * `oracle_spec_private`, but until now only tests ever wrote one. This module
 * writes that row and gossips the matching BountyEnvelope v2 through the
 * orchestrator in one atomic step: if the gossip publish fails, the local row
 * is rolled back so a poster never carries a bounty the mesh cannot see.
 *
 * Identity convention: `posterPubkey` is the node's wallet address, matching
 * Night Shift's hunter identity (manager.ts 11g), so DPSV self-loop exclusion
 * (poster == hunter) holds even against our own hunting.
 */

import type { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
import { parseHeartbeatTerms } from "../gateway/a2a/forage.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { commitOracleSpec, type OracleSpec } from "./bounty-oracle.js";

const log = createSubsystemLogger("memory/bounty-post");

export type PostBountyInput = {
  kind: "oneshot" | "heartbeat";
  category: string;
  /** Human description; heartbeat bounties must embed the machine block
   *  ({"heartbeat": {...}, "posterA2aUrl": "https://...", "url": "..."}). */
  specPublic: string;
  /** Sealed acceptance criteria. Stays local; only its hash is gossiped. */
  oracleSpec: OracleSpec;
  rewardUsdc: number;
  claimStakeUsdc?: number;
  maxClaims?: number;
  /** Epoch ms; 0 = no deadline. */
  deadline?: number;
  /** Epoch ms. */
  expiresAt: number;
};

export type PublishBountyFn = (bounty: {
  bounty_id: string;
  target_type: string;
  description: string;
  priority: number;
  reward_multiplier: number;
  expires_at: number;
  version: number;
  poster_wallet_address: string;
  kind: "oneshot" | "heartbeat" | "pool" | "standing";
  category: string;
  oracle_commitment: string;
  reward_usdc: number;
  funding_proof: string;
  claim_stake_usdc: number;
  deadline: number;
  max_claims: number;
}) => Promise<unknown>;

export type PostBountyResult =
  | { ok: true; bountyId: string; oracleCommitment: string; fundingProof: string }
  | { ok: false; error: string };

function validate(input: PostBountyInput, now: number): string | null {
  if (!(input.rewardUsdc > 0)) return "rewardUsdc must be positive";
  if (!(input.expiresAt > now)) return "expiresAt must be in the future";
  if (!input.category.trim()) return "category is required";
  if (!input.specPublic.trim()) return "specPublic is required";
  if (input.deadline !== undefined && input.deadline !== 0 && input.deadline <= now) {
    return "deadline must be in the future (or 0 for none)";
  }
  if (input.kind === "heartbeat") {
    if (!parseHeartbeatTerms(input.specPublic)) {
      return (
        "heartbeat bounty needs a machine block in specPublic: " +
        '{"heartbeat": {"cadenceSeconds": >=60, "perCheckUsdc": >0}}'
      );
    }
    if (!/"posterA2aUrl"\s*:\s*"https?:\/\//.test(input.specPublic)) {
      return (
        "heartbeat bounty needs posterA2aUrl in specPublic so hunters can " +
        "check in (set a2a.url and include it in the machine block)"
      );
    }
  }
  return null;
}

/**
 * Post a Forage bounty from this node: insert the poster-local row (sealed
 * oracle spec included) and gossip the funded v2 envelope. The row lands as
 * 'unverified' — the next funding sweep (manager.ts 11d) promotes it to
 * 'open' once the poster wallet demonstrably covers the reward, exactly as
 * it would for a bounty ingested from a stranger. We deliberately do NOT
 * fast-path our own bounties to 'open': the funding check is the spam gate,
 * and the operator's bounties must clear the same bar.
 */
export async function postForageBounty(opts: {
  db: DatabaseSync;
  publish: PublishBountyFn;
  /** Wallet address (Night Shift identity convention). */
  posterPubkey: string;
  posterPeerId?: string;
  posterWallet: string;
  input: PostBountyInput;
  now?: number;
}): Promise<PostBountyResult> {
  const now = opts.now ?? Date.now();
  const invalid = validate(opts.input, now);
  if (invalid) return { ok: false, error: invalid };

  const bountyId = crypto.randomUUID();
  const specJson = JSON.stringify(opts.input.oracleSpec);
  const oracleCommitment = commitOracleSpec(specJson);
  const oracleType = opts.input.oracleSpec.type === "judge" ? "judge" : "mechanical";
  // "attest": poster asserts solvency; the funding sweep verifies it against
  // the live USDC balance. The suffix is diagnostic only.
  const fundingProof = `attest:${opts.posterWallet.toLowerCase()}`;
  const deadline = opts.input.deadline ?? 0;
  const maxClaims = opts.input.maxClaims ?? 1;
  const claimStake = opts.input.claimStakeUsdc ?? 0;

  opts.db
    .prepare(
      `INSERT INTO bounty_posts
         (bounty_id, poster_pubkey, poster_peer_id, poster_wallet, kind, category,
          spec_public, oracle_commitment, oracle_spec_private, oracle_type,
          reward_usdc, funding_proof, claim_stake_usdc, max_claims, is_local,
          status, deadline, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'unverified', ?, ?, ?, ?)`,
    )
    .run(
      bountyId,
      opts.posterPubkey,
      opts.posterPeerId ?? null,
      opts.posterWallet,
      opts.input.kind,
      opts.input.category,
      opts.input.specPublic,
      oracleCommitment,
      specJson,
      oracleType,
      opts.input.rewardUsdc,
      fundingProof,
      claimStake,
      maxClaims,
      deadline,
      opts.input.expiresAt,
      now,
      now,
    );

  let publishError: string | null = null;
  try {
    const result = (await opts.publish({
      bounty_id: bountyId,
      target_type: opts.input.category,
      description: opts.input.specPublic,
      priority: 5,
      reward_multiplier: 1,
      expires_at: opts.input.expiresAt,
      version: 2,
      poster_wallet_address: opts.posterWallet,
      kind: opts.input.kind,
      category: opts.input.category,
      oracle_commitment: oracleCommitment,
      reward_usdc: opts.input.rewardUsdc,
      funding_proof: fundingProof,
      claim_stake_usdc: claimStake,
      deadline,
      max_claims: maxClaims,
    })) as { ok?: boolean; error?: string } | null | undefined;
    if (result && result.ok === false) {
      publishError = result.error ?? "orchestrator refused publish";
    }
  } catch (err) {
    publishError = String(err);
  }

  if (publishError) {
    // Roll back: a bounty the mesh never saw must not sit in our directory
    // looking like live demand.
    opts.db.prepare(`DELETE FROM bounty_posts WHERE bounty_id = ?`).run(bountyId);
    log.warn(`bounty post rolled back (publish failed): ${publishError}`);
    return { ok: false, error: `publish failed: ${publishError}` };
  }

  log.info(
    `Forage bounty posted: ${bountyId} (${opts.input.kind}/${opts.input.category}, ` +
      `$${opts.input.rewardUsdc}, expires ${new Date(opts.input.expiresAt).toISOString()})`,
  );
  return { ok: true, bountyId, oracleCommitment, fundingProof };
}
