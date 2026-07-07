/**
 * PLAN-29 Phase 1.2: Forage bounty A2A verbs.
 *
 * Three JSON-RPC methods spoken poster-side (the node that published the
 * bounty serves these; hunters call them):
 *
 *  - forage/claim   — hunter claims an 'open' bounty. Records a stake-bonded
 *                     row in bounty_claims. First-come within max_claims.
 *  - forage/deliver — hunter submits the deliverable for its claim. Content
 *                     passes the injection scanner BEFORE it is stored;
 *                     critical hits reject the delivery. Deliverables are
 *                     data for the oracle harness, never executed.
 *  - forage/verdict — hunter polls the oracle outcome for its claim. Read
 *                     only; verdicts are produced locally by the oracle
 *                     harness (Phase 1.3), never by the remote caller.
 *
 * Handlers are pure (db + params + now in, result | error out) so they unit
 * test without HTTP. The HTTP layer (a2a-http.ts) does transport concerns:
 * auth, rate limiting, db resolution.
 */

import type { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
import { recordPoolPledge } from "../../commerce/bounty-pools.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { claimCapUsd } from "../../memory/bounty-reputation.js";
import { scanSkillForInjection } from "../../security/skill-injection-scanner.js";
import { A2aErrorCodes } from "./types.js";

const log = createSubsystemLogger("a2a/forage");

/** Deliverable payload cap — mirrors the 256KiB gossip envelope cap, halved. */
export const MAX_DELIVERABLE_BYTES = 128 * 1024;

export type ForageError = { code: number; message: string };
export type ForageOutcome<T> = { ok: true; result: T } | { ok: false; error: ForageError };

function err<T>(code: number, message: string): ForageOutcome<T> {
  return { ok: false, error: { code, message } };
}

const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

// ---------------------------------------------------------------------------
// forage/claim
// ---------------------------------------------------------------------------

export type ForageClaimParams = {
  bountyId?: string;
  hunterPubkey?: string;
  hunterWallet?: string;
  /** Optional on-chain stake payment (validated economically in Phase 1.4). */
  stakeTxHash?: string;
};

export type ForageClaimResult = {
  claimId: string;
  bountyId: string;
  status: "claimed";
  stakeUsdc: number;
  deadline: number | null;
};

export function handleForageClaim(
  params: ForageClaimParams,
  db: DatabaseSync,
  now: number = Date.now(),
): ForageOutcome<ForageClaimResult> {
  if (!params.bountyId || !params.hunterPubkey || !params.hunterWallet) {
    return err(A2aErrorCodes.INVALID_PARAMS, "bountyId, hunterPubkey, hunterWallet required");
  }
  if (!EVM_ADDRESS_RE.test(params.hunterWallet)) {
    return err(A2aErrorCodes.INVALID_PARAMS, "hunterWallet must be a 0x EVM address");
  }
  const bounty = db
    .prepare(
      `SELECT bounty_id, status, expires_at, deadline, claim_stake_usdc, max_claims,
              reward_usdc, kind, spec_public, poster_pubkey
         FROM bounty_posts WHERE bounty_id = ?`,
    )
    .get(params.bountyId) as
    | {
        bounty_id: string;
        status: string;
        expires_at: number;
        deadline: number | null;
        claim_stake_usdc: number;
        max_claims: number;
        reward_usdc: number;
        kind: string;
        spec_public: string;
        poster_pubkey: string;
      }
    | undefined;
  if (!bounty) {
    return err(A2aErrorCodes.TASK_NOT_FOUND, "Unknown bounty");
  }
  if (bounty.status !== "open" || bounty.expires_at <= now) {
    return err(A2aErrorCodes.INVALID_REQUEST, `Bounty is not open (status: ${bounty.status})`);
  }
  // PLAN-29 Phase 1.4: progressive trust tiers gate exposure. Unproven
  // hunters take small bounties; the ladder is climbed with settled,
  // counterparty-diverse history, never bought.
  const cap = claimCapUsd(db, params.hunterPubkey);
  if (bounty.reward_usdc > cap) {
    return err(
      A2aErrorCodes.INVALID_REQUEST,
      `Reward $${bounty.reward_usdc} exceeds your current trust-tier cap of $${cap}`,
    );
  }
  const active = db
    .prepare(
      `SELECT COUNT(*) AS n, SUM(hunter_pubkey = ?) AS mine
         FROM bounty_claims WHERE bounty_id = ? AND status IN ('claimed','delivered')`,
    )
    .get(params.hunterPubkey, params.bountyId) as { n: number; mine: number | null };
  if ((active.mine ?? 0) > 0) {
    return err(A2aErrorCodes.INVALID_REQUEST, "You already hold an active claim on this bounty");
  }
  if (active.n >= bounty.max_claims) {
    return err(A2aErrorCodes.INVALID_REQUEST, "Bounty is fully claimed");
  }

  // PLAN-29 Phase 2.1: heartbeat bounties carry their stream terms in a
  // machine block inside spec_public. Terms must be parseable BEFORE the
  // claim exists, so a malformed heartbeat bounty is unclaimable rather
  // than a dead stream.
  let heartbeat: { cadenceSeconds: number; perCheckUsdc: number; alertBonusUsdc: number } | null =
    null;
  if (bounty.kind === "heartbeat") {
    heartbeat = parseHeartbeatTerms(bounty.spec_public);
    if (!heartbeat) {
      return err(
        A2aErrorCodes.INVALID_REQUEST,
        "Heartbeat bounty has no valid heartbeat terms block",
      );
    }
  }

  const claimId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO bounty_claims
       (id, bounty_id, hunter_pubkey, hunter_peer_id, hunter_wallet, stake_usdc,
        stake_tx_hash, status, claimed_at, updated_at)
     VALUES (?, ?, ?, NULL, ?, ?, ?, 'claimed', ?, ?)`,
  ).run(
    claimId,
    params.bountyId,
    params.hunterPubkey,
    params.hunterWallet,
    bounty.claim_stake_usdc,
    params.stakeTxHash ?? null,
    now,
    now,
  );
  if (heartbeat) {
    db.prepare(
      `INSERT INTO bounty_streams
         (id, bounty_id, poster_pubkey, hunter_pubkey, cadence_seconds, per_check_usdc,
          alert_bonus_usdc, checks_total, checks_paid, audits_total, audits_failed,
          status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, 'active', ?, ?)`,
    ).run(
      claimId, // stream id == claim id: one stream per claim
      params.bountyId,
      bounty.poster_pubkey,
      params.hunterPubkey,
      heartbeat.cadenceSeconds,
      heartbeat.perCheckUsdc,
      heartbeat.alertBonusUsdc,
      now,
      now,
    );
  }
  log.info(`Claim ${claimId} recorded on bounty ${params.bountyId}`);
  return {
    ok: true,
    result: {
      claimId,
      bountyId: params.bountyId,
      status: "claimed",
      stakeUsdc: bounty.claim_stake_usdc,
      deadline: bounty.deadline,
    },
  };
}

// ---------------------------------------------------------------------------
// forage/deliver
// ---------------------------------------------------------------------------

export type ForageDeliverParams = {
  bountyId?: string;
  claimId?: string;
  hunterPubkey?: string;
  /** Deliverable content (utf-8). Data for the oracle; never executed. */
  content?: string;
  /** Optional external reference (URL, content hash, artifact id). */
  ref?: string;
};

export type ForageDeliverResult = {
  claimId: string;
  status: "delivered";
  sha256: string;
};

export function handleForageDeliver(
  params: ForageDeliverParams,
  db: DatabaseSync,
  now: number = Date.now(),
): ForageOutcome<ForageDeliverResult> {
  if (!params.bountyId || !params.claimId || !params.hunterPubkey || !params.content) {
    return err(A2aErrorCodes.INVALID_PARAMS, "bountyId, claimId, hunterPubkey, content required");
  }
  if (Buffer.byteLength(params.content, "utf-8") > MAX_DELIVERABLE_BYTES) {
    return err(A2aErrorCodes.INVALID_PARAMS, `Deliverable exceeds ${MAX_DELIVERABLE_BYTES} bytes`);
  }
  const claim = db
    .prepare(`SELECT id, bounty_id, hunter_pubkey, status FROM bounty_claims WHERE id = ?`)
    .get(params.claimId) as
    | { id: string; bounty_id: string; hunter_pubkey: string; status: string }
    | undefined;
  if (!claim || claim.bounty_id !== params.bountyId) {
    return err(A2aErrorCodes.TASK_NOT_FOUND, "Unknown claim for this bounty");
  }
  if (claim.hunter_pubkey !== params.hunterPubkey) {
    return err(A2aErrorCodes.INVALID_REQUEST, "Claim belongs to a different hunter");
  }
  if (claim.status !== "claimed") {
    return err(A2aErrorCodes.INVALID_REQUEST, `Claim is not deliverable (status: ${claim.status})`);
  }

  // Deliverables are untrusted peer content. Scan before storing; critical
  // hits reject the delivery outright (claim stays 'claimed' so the hunter
  // can resubmit clean content before the deadline).
  const scan = scanSkillForInjection(params.content);
  if (scan.severity === "critical") {
    log.warn(`Rejecting delivery on claim ${params.claimId}: ${scan.reason}`);
    return err(A2aErrorCodes.INVALID_REQUEST, "Deliverable rejected by content safety scan");
  }

  const sha256 = crypto.createHash("sha256").update(params.content, "utf-8").digest("hex");
  const deliverableRef = JSON.stringify({
    sha256,
    ref: params.ref ?? null,
    scanSeverity: scan.severity,
    contentB64: Buffer.from(params.content, "utf-8").toString("base64"),
  });
  db.prepare(
    `UPDATE bounty_claims
        SET status = 'delivered', deliverable_ref = ?, delivered_at = ?, updated_at = ?
      WHERE id = ? AND status = 'claimed'`,
  ).run(deliverableRef, now, now, params.claimId);
  log.info(`Delivery stored for claim ${params.claimId} (sha256 ${sha256.slice(0, 12)}…)`);
  return { ok: true, result: { claimId: params.claimId, status: "delivered", sha256 } };
}

// ---------------------------------------------------------------------------
// forage/checkin (heartbeat streams, PLAN-29 Phase 2.1)
// ---------------------------------------------------------------------------

/**
 * Heartbeat terms ride in a fenced JSON block inside spec_public:
 *   {"heartbeat": {"cadenceSeconds": 86400, "perCheckUsdc": 0.05, "alertBonusUsdc": 1}}
 * Returns null unless all three fields validate (bonus defaults to 0).
 */
export function parseHeartbeatTerms(
  specPublic: string,
): { cadenceSeconds: number; perCheckUsdc: number; alertBonusUsdc: number } | null {
  // Locate the JSON object that contains the "heartbeat" key by brace
  // matching (a regex cannot handle sibling keys like posterA2aUrl).
  const keyIdx = specPublic.indexOf('"heartbeat"');
  if (keyIdx < 0) return null;
  const start = specPublic.lastIndexOf("{", keyIdx);
  if (start < 0) return null;
  let depth = 0;
  let end = -1;
  for (let i = start; i < specPublic.length; i++) {
    const ch = specPublic[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end < 0) return null;
  try {
    const parsed = JSON.parse(specPublic.slice(start, end + 1)) as {
      heartbeat?: { cadenceSeconds?: number; perCheckUsdc?: number; alertBonusUsdc?: number };
    };
    const hb = parsed.heartbeat;
    if (
      !hb ||
      typeof hb.cadenceSeconds !== "number" ||
      hb.cadenceSeconds < 60 ||
      typeof hb.perCheckUsdc !== "number" ||
      hb.perCheckUsdc <= 0
    ) {
      return null;
    }
    return {
      cadenceSeconds: Math.floor(hb.cadenceSeconds),
      perCheckUsdc: hb.perCheckUsdc,
      alertBonusUsdc: typeof hb.alertBonusUsdc === "number" ? hb.alertBonusUsdc : 0,
    };
  } catch {
    return null;
  }
}

export type ForageCheckinParams = {
  bountyId?: string;
  claimId?: string;
  hunterPubkey?: string;
  /** What was observed: source url/id + content hash + when. */
  observation?: {
    url?: string;
    contentHash?: string;
    observedAt?: number;
    alert?: boolean;
    /** Digest pipeline the hunter ran: 'raw-v1' (legacy sha256 of body) or 'norm-v1'. */
    digestScheme?: string;
    /** 64-bit simhash (16 hex chars) of the normalized body, for audit tolerance. */
    simhash?: string;
    /** G0.3: sha256(claimNonce || seq || contentHash), binds the observation to this claim. */
    sealedDigest?: string;
  };
};

export type ForageCheckinResult = {
  claimId: string;
  checksTotal: number;
  observationHead: string;
  streamStatus: string;
};

export function handleForageCheckin(
  params: ForageCheckinParams,
  db: DatabaseSync,
  now: number = Date.now(),
): ForageOutcome<ForageCheckinResult> {
  const obs = params.observation;
  if (!params.bountyId || !params.claimId || !params.hunterPubkey || !obs?.contentHash) {
    return err(
      A2aErrorCodes.INVALID_PARAMS,
      "bountyId, claimId, hunterPubkey, observation.contentHash required",
    );
  }
  const stream = db
    .prepare(
      `SELECT id, bounty_id, hunter_pubkey, cadence_seconds, observation_head,
              checks_total, status, last_check_at
         FROM bounty_streams WHERE id = ?`,
    )
    .get(params.claimId) as
    | {
        id: string;
        bounty_id: string;
        hunter_pubkey: string;
        cadence_seconds: number;
        observation_head: string | null;
        checks_total: number;
        status: string;
        last_check_at: number | null;
      }
    | undefined;
  if (!stream || stream.bounty_id !== params.bountyId) {
    return err(A2aErrorCodes.TASK_NOT_FOUND, "Unknown stream for this bounty");
  }
  if (stream.hunter_pubkey !== params.hunterPubkey) {
    return err(A2aErrorCodes.INVALID_REQUEST, "Stream belongs to a different hunter");
  }
  if (stream.status !== "active") {
    return err(A2aErrorCodes.INVALID_REQUEST, `Stream is not active (status: ${stream.status})`);
  }
  // Cadence guard: a check may arrive early, but not at spam rate. Half the
  // cadence is the floor — checks faster than that are unpaid noise, so
  // reject them outright and the hunter's runner learns the rhythm.
  if (
    stream.last_check_at !== null &&
    now - stream.last_check_at < (stream.cadence_seconds * 1000) / 2
  ) {
    return err(A2aErrorCodes.INVALID_REQUEST, "Check-in faster than half the agreed cadence");
  }

  // Chain the observation: head_n = sha256(head_{n-1} || contentHash). The
  // chain is tamper-evident history; the per-check row below is what the
  // auditor actually compares against (PLAN-30 G0.1 — the rolling head alone
  // preserved no per-check digest, so there was nothing to audit).
  const prevHead = stream.observation_head ?? "genesis";
  const head = crypto
    .createHash("sha256")
    .update(prevHead + obs.contentHash, "utf-8")
    .digest("hex");
  const seq = stream.checks_total + 1;
  db.prepare(
    `INSERT INTO bounty_stream_checks
       (stream_id, seq, content_digest, digest_scheme, sealed_digest, simhash,
        alert, observed_at, prev_head, head, audit_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unaudited')`,
  ).run(
    params.claimId,
    seq,
    obs.contentHash,
    obs.digestScheme ?? "raw-v1",
    obs.sealedDigest ?? null,
    obs.simhash ?? null,
    obs.alert ? 1 : 0,
    typeof obs.observedAt === "number" ? obs.observedAt : now,
    prevHead,
    head,
  );
  db.prepare(
    `UPDATE bounty_streams
        SET observation_head = ?, checks_total = checks_total + 1,
            last_check_at = ?, updated_at = ?
      WHERE id = ? AND status = 'active'`,
  ).run(head, now, now, params.claimId);

  return {
    ok: true,
    result: {
      claimId: params.claimId,
      checksTotal: stream.checks_total + 1,
      observationHead: head,
      streamStatus: "active",
    },
  };
}

// ---------------------------------------------------------------------------
// forage/verdict (read-only poll)
// ---------------------------------------------------------------------------

export type ForageVerdictParams = {
  bountyId?: string;
  claimId?: string;
  hunterPubkey?: string;
};

export type ForageVerdictResult = {
  claimId: string;
  claimStatus: string;
  verdict: string | null;
  settlementStatus: string | null;
  txHash: string | null;
};

export function handleForageVerdict(
  params: ForageVerdictParams,
  db: DatabaseSync,
): ForageOutcome<ForageVerdictResult> {
  if (!params.bountyId || !params.claimId || !params.hunterPubkey) {
    return err(A2aErrorCodes.INVALID_PARAMS, "bountyId, claimId, hunterPubkey required");
  }
  const claim = db
    .prepare(`SELECT id, bounty_id, hunter_pubkey, status FROM bounty_claims WHERE id = ?`)
    .get(params.claimId) as
    | { id: string; bounty_id: string; hunter_pubkey: string; status: string }
    | undefined;
  if (!claim || claim.bounty_id !== params.bountyId) {
    return err(A2aErrorCodes.TASK_NOT_FOUND, "Unknown claim for this bounty");
  }
  if (claim.hunter_pubkey !== params.hunterPubkey) {
    return err(A2aErrorCodes.INVALID_REQUEST, "Claim belongs to a different hunter");
  }
  const settlement = db
    .prepare(`SELECT oracle_verdict, status, tx_hash FROM bounty_settlements WHERE claim_id = ?`)
    .get(params.claimId) as
    | { oracle_verdict: string; status: string; tx_hash: string | null }
    | undefined;
  return {
    ok: true,
    result: {
      claimId: claim.id,
      claimStatus: claim.status,
      verdict: settlement?.oracle_verdict ?? null,
      settlementStatus: settlement?.status ?? null,
      txHash: settlement?.tx_hash ?? null,
    },
  };
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

export function isForageMethod(method: unknown): method is string {
  return typeof method === "string" && method.startsWith("forage/");
}

/** Route a forage/* method. Unknown forage methods return METHOD_NOT_FOUND. */
export function handleForageMethod(
  method: string,
  params: unknown,
  db: DatabaseSync,
  now: number = Date.now(),
  opts: { poolsEnabled?: boolean } = {},
): ForageOutcome<unknown> {
  const p = (params ?? {}) as Record<string, unknown>;
  switch (method) {
    case "forage/claim":
      return handleForageClaim(p as ForageClaimParams, db, now);
    case "forage/deliver":
      return handleForageDeliver(p as ForageDeliverParams, db, now);
    case "forage/checkin":
      return handleForageCheckin(p as ForageCheckinParams, db, now);
    case "forage/verdict":
      return handleForageVerdict(p as ForageVerdictParams, db);
    case "forage/fund": {
      // PLAN-29 Phase 4: LEGAL-GATED. Pool pledges move other people's
      // money at strike time; the verb stays off until counsel review.
      if (!opts.poolsEnabled) {
        return err(A2aErrorCodes.INVALID_REQUEST, "Bounty pools are not enabled on this node");
      }
      if (
        typeof p.bountyId !== "string" ||
        typeof p.funderPubkey !== "string" ||
        typeof p.auth !== "object" ||
        p.auth === null
      ) {
        return err(A2aErrorCodes.INVALID_PARAMS, "bountyId, funderPubkey, auth required");
      }
      const outcome = recordPoolPledge(
        db,
        {
          bountyId: p.bountyId,
          funderPubkey: p.funderPubkey,
          auth: p.auth as import("../../commerce/settlement.js").Eip3009Authorization,
        },
        now,
      );
      return outcome.ok
        ? { ok: true, result: outcome }
        : err(A2aErrorCodes.INVALID_REQUEST, outcome.error);
    }
    default:
      return err(A2aErrorCodes.METHOD_NOT_FOUND, `Unknown forage method: ${method}`);
  }
}
