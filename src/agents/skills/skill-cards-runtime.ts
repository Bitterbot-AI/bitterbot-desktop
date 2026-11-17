/**
 * I/O for cross-agent evidence cards (skill-cards.ts is pure): the file of
 * card bundles received from peers, this node's own signed bundle, and the
 * peer half of the evidence lines on the skills index.
 *
 * Reading is on by default and does nothing until a bundle has been
 * received. Bundles arrive and leave only over the public package mesh,
 * which is opt-in (`skills.collective.enabled` and `publicMesh`).
 */

import fsSync from "node:fs";
import path from "node:path";
import { type KeyPair, keyPairFromPrivateKeyPem } from "../../commerce/envelope.js";
import type { BitterbotConfig } from "../../config/config.js";
import { loadOrCreateDeviceIdentity } from "../../infra/device-identity.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { CONFIG_DIR } from "../../utils.js";
import {
  QUORUM,
  type CellRecords,
  type PeerEvidence,
  type SkillCardBundle,
  exportSkillCards,
  importSkillCards,
  ownEvidenceText,
  peerEvidenceFor,
  peerEvidenceText,
} from "./skill-cards.js";
import {
  type SkillEvidence,
  type SkillEvidenceStyle,
  type SkillPriorLedger,
  formatSkillEvidence,
  resolveSkillPriorPeerEvidence,
  verbalRecord,
} from "./skill-prior.js";

const log = createSubsystemLogger("skills/cards");

/** Origins kept; the oldest bundle is evicted first. */
export const MAX_PEER_ORIGINS = 64;
/** A stored origin is not rewritten more often than this. */
export const MIN_REPLACE_INTERVAL_MS = 10 * 60_000;
/** New origins admitted per window, per process. */
export const MAX_NEW_ORIGINS_PER_WINDOW = 16;
export const NEW_ORIGIN_WINDOW_MS = 60 * 60_000;
/** At capacity, only a bundle at least this old makes room for a new origin. */
export const EVICTABLE_AFTER_MS = 7 * 86_400_000;
let admissions: number[] = [];

interface PeerFile {
  version: 1;
  /** origin -> its latest bundle */
  bundles: Record<string, SkillCardBundle>;
}

export function skillCardPeersPath(cfg: BitterbotConfig | undefined): string {
  return cfg?.skills?.prior?.peersPath ?? path.join(CONFIG_DIR, "skill-cards-peers.json");
}

let peerCache: { path: string; mtimeMs: number; file: PeerFile } | null = null;

function readPeerFile(file: string): PeerFile {
  let mtimeMs: number;
  try {
    mtimeMs = fsSync.statSync(file).mtimeMs;
  } catch {
    return { version: 1, bundles: {} };
  }
  if (peerCache && peerCache.path === file && peerCache.mtimeMs === mtimeMs) {
    return peerCache.file;
  }
  try {
    const parsed = JSON.parse(fsSync.readFileSync(file, "utf-8")) as Partial<PeerFile>;
    if (parsed.version !== 1 || !parsed.bundles || typeof parsed.bundles !== "object") {
      throw new Error("unsupported or malformed peer card file");
    }
    const value: PeerFile = { version: 1, bundles: parsed.bundles };
    peerCache = { path: file, mtimeMs, file: value };
    return value;
  } catch (err) {
    log.warn(`peer skill cards unreadable at ${file}: ${String(err)}; ignoring them`);
    return { version: 1, bundles: {} };
  }
}

let verifiedCache: { file: PeerFile; bundles: SkillCardBundle[] } | null = null;

/** Current bundles from peers. A stored bundle is re-checked in full, signature included, once per file change. */
export function loadPeerSkillCards(
  cfg: BitterbotConfig | undefined,
  now: number,
): SkillCardBundle[] {
  const file = readPeerFile(skillCardPeersPath(cfg));
  if (verifiedCache?.file !== file) {
    const bundles: SkillCardBundle[] = [];
    for (const [origin, bundle] of Object.entries(file.bundles)) {
      const res = importSkillCards(bundle, { now });
      if (res.ok && res.bundle.origin === origin) {
        bundles.push(res.bundle);
      }
    }
    verifiedCache = { file, bundles };
  }
  return verifiedCache.bundles.filter((b) => b.expiresAt > now);
}

export type StoreResult = { stored: true; origin: string } | { stored: false; reason: string };

/**
 * Keep a bundle received from a peer. One bundle per origin: a newer one
 * replaces the older, an older or too-frequent one is refused, and the
 * oldest origin is evicted at capacity.
 */
export function storePeerSkillCards(
  cfg: BitterbotConfig | undefined,
  input: unknown,
  opts: { now: number; self?: string },
): StoreResult {
  const res = importSkillCards(input, opts);
  if (!res.ok) {
    return { stored: false, reason: res.reason };
  }
  const file = skillCardPeersPath(cfg);
  const current = readPeerFile(file);
  const bundles: Record<string, SkillCardBundle> = {};
  for (const [origin, b] of Object.entries(current.bundles)) {
    if (b && Number.isSafeInteger(b.expiresAt) && b.expiresAt > opts.now) {
      bundles[origin] = b;
    }
  }
  const prior = bundles[res.bundle.origin];
  if (prior) {
    if (res.bundle.issuedAt <= prior.issuedAt) {
      return { stored: false, reason: "not newer than the stored bundle" };
    }
    if (res.bundle.issuedAt - prior.issuedAt < MIN_REPLACE_INTERVAL_MS) {
      return { stored: false, reason: "replaced too recently" };
    }
  }
  if (!prior) {
    // New origins are admitted slowly and never push out a recent one, so a
    // burst of fresh keys can neither flush the store nor churn the disk.
    const recent = admissions.filter((at) => opts.now - at < NEW_ORIGIN_WINDOW_MS);
    if (recent.length >= MAX_NEW_ORIGINS_PER_WINDOW) {
      return { stored: false, reason: "too many new origins" };
    }
    const origins = Object.keys(bundles);
    if (origins.length >= MAX_PEER_ORIGINS) {
      const oldest = origins.reduce((a, b) =>
        bundles[a]!.issuedAt <= bundles[b]!.issuedAt ? a : b,
      );
      if (opts.now - bundles[oldest]!.issuedAt < EVICTABLE_AFTER_MS) {
        return { stored: false, reason: "peer store full" };
      }
      delete bundles[oldest];
    }
    admissions = [...recent, opts.now];
  }
  bundles[res.bundle.origin] = res.bundle;
  const next: PeerFile = { version: 1, bundles };
  fsSync.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fsSync.writeFileSync(tmp, JSON.stringify(next), { mode: 0o600 });
  fsSync.renameSync(tmp, file);
  peerCache = null;
  return { stored: true, origin: res.bundle.origin };
}

/** The node key that signs this node's cards (the device identity). */
export function skillCardKey(): KeyPair {
  return keyPairFromPrivateKeyPem(loadOrCreateDeviceIdentity().privateKeyPem);
}

/** This node's verified outcomes as a signed bundle; null when it has none. */
export function ownSkillCards(
  ledger: SkillPriorLedger,
  key: KeyPair,
  now: number,
): SkillCardBundle | null {
  return exportSkillCards({ cells: ledger.verifiedByHash(), key, now });
}

export interface PeerLines {
  /** skill name -> full evidence text; empty when peers add nothing to this index. */
  lines: Record<string, string>;
  /** Skill names that carry a peer verdict. */
  annotated: string[];
  summary: Pick<PeerEvidence, "agents" | "peers" | "dropped">;
}

/**
 * Evidence text for an index where peers have something to add. Skills the
 * node tried keep its own record (named as its own); untried skills a
 * quorum of trusted peers agrees on get the peer verdict. When no peer
 * verdict applies, `lines` is empty and the caller keeps today's own-only
 * annotation byte for byte.
 */
export function peerEvidenceLines(args: {
  config: BitterbotConfig | undefined;
  ledger: SkillPriorLedger;
  cell: string;
  names: readonly string[];
  hashes: Readonly<Record<string, string>>;
  ownEvidence: Readonly<Record<string, SkillEvidence>>;
  style: SkillEvidenceStyle;
  now?: number;
}): PeerLines {
  const empty: PeerLines = {
    lines: {},
    annotated: [],
    summary: { agents: 0, peers: 0, dropped: 0 },
  };
  if (!resolveSkillPriorPeerEvidence(args.config?.skills?.prior)) {
    return empty;
  }
  let bundles: SkillCardBundle[];
  try {
    bundles = loadPeerSkillCards(args.config, args.now ?? Date.now());
  } catch (err) {
    log.warn(`peer skill cards skipped: ${String(err)}`);
    return empty;
  }
  if (bundles.length === 0) {
    return empty;
  }
  const own: CellRecords = args.ledger.verifiedByHash();
  const peer = peerEvidenceFor({
    own,
    peers: bundles.map((b) => b.cells),
    cell: args.cell,
    quorum: args.config?.skills?.prior?.peerQuorum ?? QUORUM,
  });
  const summary = { agents: peer.agents, peers: peer.peers, dropped: peer.dropped };
  const annotated = args.names.filter((n) => {
    const hash = args.hashes[n];
    return !!hash && hash !== "unknown" && !!peer.records[hash] && !args.ownEvidence[n];
  });
  if (annotated.length === 0) {
    return { ...empty, summary };
  }
  const lines: Record<string, string> = {};
  for (const name of args.names) {
    const mine = args.ownEvidence[name];
    if (mine && mine.runs > 0) {
      lines[name] =
        args.style === "verbal"
          ? ownEvidenceText(verbalRecord(mine))
          : formatSkillEvidence(mine, args.style);
    } else if (annotated.includes(name)) {
      lines[name] = peerEvidenceText(verbalRecord(peer.records[args.hashes[name]!]!), peer.agents);
    }
  }
  return { lines, annotated, summary };
}

export function resetSkillCardCachesForTest(): void {
  peerCache = null;
  verifiedCache = null;
  admissions = [];
}
