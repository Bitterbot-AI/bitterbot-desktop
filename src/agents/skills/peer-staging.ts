/**
 * PLAN-45 4.2 (PLAN-44 D-8): the receiver re-gate.
 *
 * A peer skill the operator accepted (or a trusted peer's skill under
 * ingestPolicy "auto") does NOT go live. It lands in staging with
 * `.evolution-meta.json.origin = "peer"` and the full signed envelope in
 * `.provenance.json`, and the validation gate measures it on this node's
 * own task suite before it serves (canary -> stable). The sender's trailer
 * is carried for display; the gate never reads it as evidence.
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { EvolutionProvenanceRecord } from "../../memory/skill-evolution/provenance-trailer.js";
import type { EvolutionMeta } from "../../memory/skill-evolution/validation-gate.js";
import { atomicWriteJson } from "../../memory/skill-evolution/fs-atomic.js";
import { hashProposalContent } from "../../memory/skill-evolution/proposal-apply.js";
import {
  resolveStorageRoots,
  type SkillStorageRoots,
  stageSkill,
  stagingSkillDir,
  updateStagingGateStatus,
} from "./skill-storage.js";

export const PEER_ORIGIN = "peer";

export interface PeerStageParams {
  name: string;
  content: string;
  /** The envelope (plus ingest annotations) that becomes the live `.provenance.json` on promotion. */
  provenance: Record<string, unknown> & {
    author_pubkey: string;
    author_peer_id: string;
    content_hash: string;
    timestamp: number;
  };
  trailer: EvolutionProvenanceRecord | null;
  reason: string;
  roots?: SkillStorageRoots;
  now?: number;
}

export function isPeerMeta(meta: EvolutionMeta | null | undefined): boolean {
  return meta?.origin === PEER_ORIGIN;
}

/** Why a peer stage may not take the name right now, or null. */
export async function peerStageCollision(
  roots: SkillStorageRoots | undefined,
  name: string,
  authorPubkey: string,
): Promise<string | null> {
  const r = resolveStorageRoots(roots ?? {});
  const dir = stagingSkillDir(r, name);
  try {
    await fs.access(path.join(dir, "SKILL.md"));
  } catch {
    return null;
  }
  let meta: EvolutionMeta | null = null;
  try {
    meta = JSON.parse(await fs.readFile(path.join(dir, ".evolution-meta.json"), "utf-8"));
  } catch {
    meta = null;
  }
  if (!meta) {
    return `name "${name}" has a pending local edit in staging`;
  }
  if (meta.origin !== PEER_ORIGIN) {
    return `name "${name}" has a pending proposal of this node's own in staging`;
  }
  if (meta.peer?.authorPubkey !== authorPubkey) {
    return `name "${name}" is already staged from another author's key`;
  }
  return null;
}

/**
 * Stage a peer skill for the local gate. Replaces a pending stage of the
 * same name from the SAME author only (adversarial 4-2).
 */
export async function stagePeerSkill(params: PeerStageParams): Promise<{ stagingPath: string }> {
  const roots = resolveStorageRoots(params.roots ?? {});
  const now = params.now ?? Date.now();
  const collision = await peerStageCollision(
    params.roots,
    params.name,
    params.provenance.author_pubkey,
  );
  if (collision) {
    throw new Error(collision);
  }
  await stageSkill(roots, {
    name: params.name,
    content: params.content,
    reason: params.reason,
    author: PEER_ORIGIN,
    overwrite: true,
    timestamp: now,
  });
  const dir = stagingSkillDir(roots, params.name);
  const meta: EvolutionMeta = {
    origin: PEER_ORIGIN,
    stagedAt: now,
    iteration: null,
    contentHash: hashProposalContent(params.content),
    ladder: { state: "staged", at: now, by: "pipeline", reason: params.reason },
    peer: {
      authorPubkey: params.provenance.author_pubkey,
      authorPeerId: params.provenance.author_peer_id,
      contentHash: params.provenance.content_hash,
      timestamp: params.provenance.timestamp,
      receivedAt: now,
      trailer: params.trailer,
    },
  };
  // stageSkill strips sidecars for non-evolution authors; write them after.
  await atomicWriteJson(path.join(dir, ".evolution-meta.json"), meta);
  await atomicWriteJson(path.join(dir, ".provenance.json"), {
    ...params.provenance,
    staged_at: now,
  });
  // The static checks (signature, hash, structure, injection scan, routing)
  // ran at ingest; the staging gate's job is done. The validation gate is
  // what decides.
  await updateStagingGateStatus(roots, params.name, "passed");
  return { stagingPath: path.join(dir, "SKILL.md") };
}

export const PEER_ATTEMPTS_FILENAME = "peer-attempts.json";

function peerAttemptsPath(roots?: SkillStorageRoots): string {
  const r = resolveStorageRoots(roots ?? {});
  return path.join(path.dirname(r.stagingRoot), "skill-wiki", PEER_ATTEMPTS_FILENAME);
}

export function peerAttemptKey(authorPubkey: string, name: string): string {
  return `${authorPubkey}:${name}`;
}

/**
 * PLAN-45 4.2 (adversarial 4-3): gate attempts a peer lineage (author key +
 * name) has consumed, persisted across restages and restarts so a peer
 * cannot buy unlimited validations by republishing.
 */
export async function readPeerAttempts(
  authorPubkey: string,
  name: string,
  roots?: SkillStorageRoots,
): Promise<number> {
  try {
    const parsed = JSON.parse(await fs.readFile(peerAttemptsPath(roots), "utf-8")) as Record<
      string,
      unknown
    >;
    const n = parsed[peerAttemptKey(authorPubkey, name)];
    return typeof n === "number" && Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

export async function bumpPeerAttempts(
  authorPubkey: string,
  name: string,
  roots?: SkillStorageRoots,
): Promise<number> {
  const file = peerAttemptsPath(roots);
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(await fs.readFile(file, "utf-8")) as Record<string, unknown>;
  } catch {
    parsed = {};
  }
  const key = peerAttemptKey(authorPubkey, name);
  const next = (typeof parsed[key] === "number" ? (parsed[key] as number) : 0) + 1;
  await fs.mkdir(path.dirname(file), { recursive: true });
  await atomicWriteJson(file, { ...parsed, [key]: next });
  return next;
}

/** The staged envelope, for the memory chunk written at promotion. */
export async function readStagedPeerProvenance(
  liveOrStagingDir: string,
): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await fs.readFile(path.join(liveOrStagingDir, ".provenance.json"), "utf-8"));
  } catch {
    return null;
  }
}
