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
/** At capacity, only an origin not heard from for this long makes room for a new one. */
export const EVICTABLE_AFTER_MS = 7 * 86_400_000;
let admissions: number[] = [];

interface PeerFile {
  version: 1;
  /** origin -> its latest bundle */
  bundles: Record<string, SkillCardBundle>;
  /** origin -> when this node last stored a bundle from it (local clock). */
  receivedAt: Record<string, number>;
}
const emptyFile = (): PeerFile => ({ version: 1, bundles: {}, receivedAt: {} });

export function skillCardPeersPath(cfg: BitterbotConfig | undefined): string {
  return cfg?.skills?.prior?.peersPath ?? path.join(CONFIG_DIR, "skill-cards-peers.json");
}

let peerCache: { path: string; mtimeMs: number; file: PeerFile } | null = null;

function readPeerFile(file: string): PeerFile {
  let mtimeMs: number;
  try {
    mtimeMs = fsSync.statSync(file).mtimeMs;
  } catch {
    return emptyFile();
  }
  if (peerCache && peerCache.path === file && peerCache.mtimeMs === mtimeMs) {
    return peerCache.file;
  }
  try {
    const parsed = JSON.parse(fsSync.readFileSync(file, "utf-8")) as Partial<PeerFile>;
    if (parsed.version !== 1 || !parsed.bundles || typeof parsed.bundles !== "object") {
      throw new Error("unsupported or malformed peer card file");
    }
    const value: PeerFile = {
      version: 1,
      bundles: parsed.bundles,
      receivedAt:
        parsed.receivedAt && typeof parsed.receivedAt === "object" ? parsed.receivedAt : {},
    };
    peerCache = { path: file, mtimeMs, file: value };
    return value;
  } catch (err) {
    log.warn(`peer skill cards unreadable at ${file}: ${String(err)}; ignoring them`);
    // Remember the failure for this version of the file, so it is reported once.
    const value = emptyFile();
    peerCache = { path: file, mtimeMs, file: value };
    return value;
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
  const receivedAt: Record<string, number> = {};
  for (const [origin, b] of Object.entries(current.bundles)) {
    if (b && Number.isSafeInteger(b.expiresAt) && b.expiresAt > opts.now) {
      bundles[origin] = b;
      const at = current.receivedAt[origin];
      receivedAt[origin] = Number.isFinite(at) ? Math.min(at!, opts.now) : opts.now;
    }
  }
  const origin = res.bundle.origin;
  const prior = bundles[origin];
  if (prior) {
    if (res.bundle.issuedAt <= prior.issuedAt) {
      return { stored: false, reason: "not newer than the stored bundle" };
    }
    // Throttled on this node's clock: the signer's dates cannot buy rewrites.
    if (opts.now - receivedAt[origin]! < MIN_REPLACE_INTERVAL_MS) {
      return { stored: false, reason: "replaced too recently" };
    }
  } else {
    // New origins are admitted slowly and never push out a recently heard
    // one, so a burst of fresh keys can neither flush the store nor churn
    // the disk.
    const recent = admissions.filter((at) => opts.now - at < NEW_ORIGIN_WINDOW_MS);
    if (recent.length >= MAX_NEW_ORIGINS_PER_WINDOW) {
      return { stored: false, reason: "too many new origins" };
    }
    const origins = Object.keys(bundles);
    if (origins.length >= MAX_PEER_ORIGINS) {
      const oldest = origins.reduce((a, b) => (receivedAt[a]! <= receivedAt[b]! ? a : b));
      if (opts.now - receivedAt[oldest]! < EVICTABLE_AFTER_MS) {
        return { stored: false, reason: "peer store full" };
      }
      delete bundles[oldest];
      delete receivedAt[oldest];
    }
    admissions = [...recent, opts.now];
  }
  bundles[origin] = res.bundle;
  receivedAt[origin] = opts.now;
  const next: PeerFile = { version: 1, bundles, receivedAt };
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
  summary: Pick<PeerEvidence, "peers" | "dropped">;
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
    summary: { peers: 0, dropped: 0 },
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
  const summary = { peers: peer.peers, dropped: peer.dropped };
  const annotated = args.names.filter((n) => {
    const hash = args.hashes[n];
    return !!hash && hash !== "unknown" && !!peer.verdicts[hash] && !args.ownEvidence[n];
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
      lines[name] = peerEvidenceText(peer.verdicts[args.hashes[name]!]!);
    }
  }
  return { lines, annotated, summary };
}

export function resetSkillCardCachesForTest(): void {
  peerCache = null;
  verifiedCache = null;
  admissions = [];
}
