/**
 * Cross-agent evidence cards (pure core; skill-cards-runtime.ts owns the I/O).
 *
 * A card bundle is one node's verified outcome counts, per context cell and
 * per skill CONTENT HASH, signed with the node key. It carries no skill
 * names and no text: a record is evidence about one exact SKILL.md, and a
 * recipient can use it only for a skill whose bytes it already holds.
 *
 * A recipient never sums what peers claim. It applies the two defences the
 * cross-agent studies measured (benchmarks/skill-prior, "Cross-agent
 * evidence cards"):
 *
 *   guard    a peer whose records keep contradicting outcomes the recipient
 *            verified itself is dropped, and the recipient's own record
 *            speaks for any skill it has tried
 *   quorum   one vote per peer per skill; a verdict is shown only when at
 *            least `quorum` distinct peers agree and outnumber the dissent
 *
 * The studies tested each defence on its own. The runtime applies both,
 * which shows less and never more than either alone.
 */

import type { KeyPair } from "../../commerce/envelope.js";
import { signRecord, verifyRecord } from "./collective/signatures.js";
import type { SkillEvidence } from "./skill-prior.js";

/** skill id -> counts. The id is a skill name in the benchmark and a content hash at runtime. */
export type Records = Record<string, SkillEvidence>;
/** context cell -> records */
export type CellRecords = Record<string, Records>;

export const QUORUM = 2;
/** A donor is dropped at this many contradictions, when they are this share of the checks. */
export const TRUST_MIN_CONTRADICTIONS = 3;
export const TRUST_MAX_RATE = 0.25;

/** Sum counts across sources; `agents` is how many contributed at least one run. */
export function poolRecords(sources: readonly Records[]): { records: Records; agents: number } {
  const records: Records = {};
  let agents = 0;
  for (const src of sources) {
    let any = false;
    for (const [skill, e] of Object.entries(src)) {
      if (e.runs > 0) {
        any = true;
        const t = (records[skill] ??= { passed: 0, runs: 0 });
        t.passed += e.passed;
        t.runs += e.runs;
      }
    }
    agents += any ? 1 : 0;
  }
  return { records, agents };
}

const verdictOf = (e: SkillEvidence | undefined): "accepted" | "rejected" | null =>
  !e || e.runs === 0 ? null : e.passed === e.runs ? "accepted" : e.passed === 0 ? "rejected" : null;

export interface DonorTrust {
  /** (cell, skill) pairs where both sides hold a unanimous record. */
  checks: number;
  contradictions: number;
  trusted: boolean;
}

/** Score a donor only against outcomes the recipient verified itself. */
export function donorTrust(own: CellRecords, donor: CellRecords): DonorTrust {
  let checks = 0;
  let contradictions = 0;
  for (const [cell, recs] of Object.entries(donor)) {
    for (const [skill, e] of Object.entries(recs)) {
      const mine = verdictOf(own[cell]?.[skill]);
      const theirs = verdictOf(e);
      if (mine && theirs) {
        checks++;
        contradictions += mine === theirs ? 0 : 1;
      }
    }
  }
  const trusted = !(
    contradictions >= TRUST_MIN_CONTRADICTIONS && contradictions / checks >= TRUST_MAX_RATE
  );
  return { checks, contradictions, trusted };
}

/**
 * Pool by votes instead of counts. Each donor casts at most one vote per
 * variant; the verdict shown is the side with at least `quorum` votes and
 * strictly more than the other side. Anything else is left out, so the
 * variant reads "not tried yet" and no single signer can move a line.
 */
export function quorumRecords(
  sources: readonly Records[],
  quorum = QUORUM,
): { records: Records; agents: number } {
  const votes = new Map<string, { accept: number; reject: number }>();
  let agents = 0;
  for (const src of sources) {
    let any = false;
    for (const [skill, e] of Object.entries(src)) {
      if (e.runs === 0) {
        continue;
      }
      any = true;
      const v = votes.get(skill) ?? { accept: 0, reject: 0 };
      if (e.passed > 0) {
        v.accept++;
      } else {
        v.reject++;
      }
      votes.set(skill, v);
    }
    agents += any ? 1 : 0;
  }
  const records: Records = {};
  for (const [skill, v] of votes) {
    if (v.accept >= quorum && v.accept > v.reject) {
      records[skill] = { passed: v.accept, runs: v.accept };
    } else if (v.reject >= quorum && v.reject > v.accept) {
      records[skill] = { passed: 0, runs: v.reject };
    }
  }
  return { records, agents };
}

/** Pool the trusted donors, leaving out any variant the recipient has tried itself. */
export function guardedPool(
  own: Records,
  donors: readonly Records[],
  trusted: readonly (boolean | undefined)[],
): { records: Records; agents: number } {
  const kept = donors
    .filter((_, i) => trusted[i] !== false)
    .map((d) => Object.fromEntries(Object.entries(d).filter(([s]) => !(own[s]?.runs ?? 0))));
  return poolRecords(kept);
}

// ------------------------------------------------------------ runtime bundle

export const SKILL_CARDS_PROTOCOL = "bitterbot/skill-cards/2";

export const SKILL_CARD_LIMITS = {
  /** Serialized bundle size; fits one mesh announcement with its wrapper. */
  maxBytes: 15_000,
  maxCells: 16,
  maxRecords: 140,
  /** Counts above this are clamped on export and refused on import. */
  maxRuns: 1_000,
  ttlMs: 30 * 86_400_000,
  /** Accepted clock skew for `issuedAt`. */
  skewMs: 10 * 60_000,
} as const;

export interface SkillCardBundle {
  protocol: typeof SKILL_CARDS_PROTOCOL;
  /** `ed25519:<hex public key>` of the node that verified the outcomes. */
  origin: string;
  issuedAt: number;
  expiresAt: number;
  /** cell -> skill content hash (sha256 hex) -> verified counts */
  cells: CellRecords;
  signature: string;
}

const HASH_RE = /^[a-f0-9]{64}$/;
const CELL_RE = /^[\w.:@/-]{1,120}$/;

const isCount = (e: unknown): e is SkillEvidence => {
  const x = e as Partial<SkillEvidence> | null;
  return (
    !!x &&
    typeof x === "object" &&
    Number.isSafeInteger(x.passed) &&
    Number.isSafeInteger(x.runs) &&
    x.passed! >= 0 &&
    x.runs! >= x.passed! &&
    x.runs! > 0 &&
    x.runs! <= SKILL_CARD_LIMITS.maxRuns
  );
};

/**
 * Sign this node's verified counts. Records are taken most-used first until
 * a limit is reached, so a large ledger still yields a bundle that fits one
 * announcement. Returns null when there is nothing verified to share.
 */
export function exportSkillCards(args: {
  cells: CellRecords;
  key: KeyPair;
  now: number;
}): SkillCardBundle | null {
  const flat: Array<{ cell: string; hash: string; e: SkillEvidence }> = [];
  for (const [cell, recs] of Object.entries(args.cells)) {
    if (!CELL_RE.test(cell)) {
      continue;
    }
    for (const [hash, e] of Object.entries(recs)) {
      if (!HASH_RE.test(hash) || !e || !Number.isSafeInteger(e.runs) || e.runs <= 0) {
        continue;
      }
      const runs = Math.min(e.runs, SKILL_CARD_LIMITS.maxRuns);
      // Clamp proportionally; a unanimous record stays unanimous and a mixed one stays mixed.
      const scaled = Math.round((e.passed / e.runs) * runs);
      const passed =
        e.runs === runs
          ? e.passed
          : e.passed === e.runs
            ? runs
            : e.passed === 0
              ? 0
              : Math.min(runs - 1, Math.max(1, scaled));
      flat.push({ cell, hash, e: { passed, runs } });
    }
  }
  const ranked = flat.toSorted(
    (a, b) => b.e.runs - a.e.runs || a.cell.localeCompare(b.cell) || a.hash.localeCompare(b.hash),
  );
  const cells: CellRecords = {};
  let records = 0;
  for (const r of ranked) {
    if (records >= SKILL_CARD_LIMITS.maxRecords) {
      break;
    }
    if (!cells[r.cell] && Object.keys(cells).length >= SKILL_CARD_LIMITS.maxCells) {
      continue;
    }
    (cells[r.cell] ??= {})[r.hash] = r.e;
    records++;
  }
  const sign = () =>
    signRecord<Omit<SkillCardBundle, "signature">>(
      SKILL_CARDS_PROTOCOL,
      {
        protocol: SKILL_CARDS_PROTOCOL,
        origin: `ed25519:${args.key.publicKeyHex}`,
        issuedAt: args.now,
        expiresAt: args.now + SKILL_CARD_LIMITS.ttlMs,
        cells,
      },
      args.key,
    );
  // Long cell names can push a full bundle over the size peers accept: shed the least-used records.
  for (let i = ranked.length - 1; i >= 0 && records > 0; i--) {
    if (JSON.stringify(sign()).length <= SKILL_CARD_LIMITS.maxBytes) {
      break;
    }
    const r = ranked[i]!;
    if (cells[r.cell]?.[r.hash]) {
      delete cells[r.cell]![r.hash];
      if (Object.keys(cells[r.cell]!).length === 0) {
        delete cells[r.cell];
      }
      records--;
    }
  }
  return records === 0 ? null : sign();
}

export type SkillCardImport = { ok: true; bundle: SkillCardBundle } | { ok: false; reason: string };

/**
 * The recipient's check. A bundle is kept only if it is well formed, inside
 * every limit, current, and signed by its stated origin. Nothing here says
 * the claims are true: a signature identifies the claimant, and the guard
 * and the quorum decide what is shown.
 */
export function importSkillCards(
  input: unknown,
  opts: { now: number; self?: string },
): SkillCardImport {
  const b = input as Partial<SkillCardBundle> | null;
  if (
    !b ||
    typeof b !== "object" ||
    b.protocol !== SKILL_CARDS_PROTOCOL ||
    typeof b.origin !== "string" ||
    typeof b.signature !== "string" ||
    !Number.isSafeInteger(b.issuedAt) ||
    !Number.isSafeInteger(b.expiresAt) ||
    !b.cells ||
    typeof b.cells !== "object" ||
    Array.isArray(b.cells) ||
    Object.keys(b).length !== 6
  ) {
    return { ok: false, reason: "malformed bundle" };
  }
  if (opts.self && b.origin === opts.self) {
    return { ok: false, reason: "own bundle" };
  }
  if (
    b.issuedAt! > opts.now + SKILL_CARD_LIMITS.skewMs ||
    b.expiresAt! <= opts.now ||
    b.expiresAt! - b.issuedAt! > SKILL_CARD_LIMITS.ttlMs ||
    b.expiresAt! <= b.issuedAt!
  ) {
    return { ok: false, reason: "expired or post-dated" };
  }
  const cellNames = Object.keys(b.cells);
  if (cellNames.length === 0 || cellNames.length > SKILL_CARD_LIMITS.maxCells) {
    return { ok: false, reason: "cell count out of range" };
  }
  let records = 0;
  for (const cell of cellNames) {
    const recs = b.cells[cell];
    if (!CELL_RE.test(cell) || !recs || typeof recs !== "object" || Array.isArray(recs)) {
      return { ok: false, reason: "malformed cell" };
    }
    for (const [hash, e] of Object.entries(recs)) {
      if (!HASH_RE.test(hash) || !isCount(e) || Object.keys(e).length !== 2) {
        return { ok: false, reason: "malformed record" };
      }
      records++;
    }
  }
  if (records === 0 || records > SKILL_CARD_LIMITS.maxRecords) {
    return { ok: false, reason: "record count out of range" };
  }
  if (JSON.stringify(b).length > SKILL_CARD_LIMITS.maxBytes) {
    return { ok: false, reason: "bundle too large" };
  }
  if (!verifyRecord(SKILL_CARDS_PROTOCOL, b as SkillCardBundle, b.origin)) {
    return { ok: false, reason: "bad signature" };
  }
  return { ok: true, bundle: b as SkillCardBundle };
}

export interface PeerVerdict {
  verdict: "accepted" | "rejected";
  /** Trusted peers on the winning side, and all trusted peers that voted on this skill. */
  agree: number;
  voters: number;
}

export interface PeerEvidence {
  /** skill id -> the verdict a quorum of trusted peers agrees on. */
  verdicts: Record<string, PeerVerdict>;
  /** Peers considered, and how many the guard dropped. */
  peers: number;
  dropped: number;
}

/** A peer's position on each skill: the side its record favours; an even split takes none. */
function positions(recs: Records): Records {
  const out: Records = {};
  for (const [skill, e] of Object.entries(recs)) {
    if (e.runs <= 0) {
      continue;
    }
    if (e.passed * 2 > e.runs) {
      out[skill] = { passed: 1, runs: 1 };
    } else if (e.passed * 2 < e.runs) {
      out[skill] = { passed: 0, runs: 1 };
    }
  }
  return out;
}

/**
 * What peers add to one cell. Each peer's records are first reduced to one
 * position per skill, and the guard and the vote both use that position, so
 * a peer cannot vote with records the guard is unable to check. Peers the
 * guard distrusts (scored over ALL cells against the recipient's own
 * verified outcomes) are dropped, skills the recipient has tried here are
 * left out, and the rest is read by quorum.
 */
export function peerEvidenceFor(args: {
  own: CellRecords;
  peers: readonly CellRecords[];
  cell: string;
  quorum?: number;
}): PeerEvidence {
  const quorum = Math.max(1, Math.floor(args.quorum ?? QUORUM));
  const ownHere = args.own[args.cell] ?? {};
  let dropped = 0;
  const votes = new Map<string, { accept: number; reject: number }>();
  for (const peer of args.peers) {
    const stance: CellRecords = Object.fromEntries(
      Object.entries(peer).map(([cell, recs]) => [cell, positions(recs)]),
    );
    if (!donorTrust(args.own, stance).trusted) {
      dropped++;
      continue;
    }
    for (const [skill, e] of Object.entries(stance[args.cell] ?? {})) {
      if ((ownHere[skill]?.runs ?? 0) > 0) {
        continue;
      }
      const v = votes.get(skill) ?? { accept: 0, reject: 0 };
      if (e.passed > 0) {
        v.accept++;
      } else {
        v.reject++;
      }
      votes.set(skill, v);
    }
  }
  const verdicts: Record<string, PeerVerdict> = {};
  for (const [skill, v] of votes) {
    const voters = v.accept + v.reject;
    if (v.accept >= quorum && v.accept > v.reject) {
      verdicts[skill] = { verdict: "accepted", agree: v.accept, voters };
    } else if (v.reject >= quorum && v.reject > v.accept) {
      verdicts[skill] = { verdict: "rejected", agree: v.reject, voters };
    }
  }
  return { verdicts, peers: args.peers.length, dropped };
}

/**
 * The peer half of an evidence line. It says what it is: how many other
 * agents that tried the skill report which outcome, dissent included. The
 * studies showed quorum verdicts in the own-record wording; this keeps
 * their verdict words and states the counts as agents, not uses.
 */
export function peerEvidenceText(v: PeerVerdict): string {
  const word = v.verdict === "accepted" ? "ACCEPTED" : "REJECTED";
  const who = v.voters === 1 ? "the 1 other agent" : `${v.agree} of ${v.voters} other agents`;
  return `Reports from other agents here: ${word} by ${who} that tried it.`;
}

/** The own half, used only when a peer half appears somewhere in the same index. */
export function ownEvidenceText(verbal: string): string {
  return `Your own runs here: ${verbal}.`;
}
