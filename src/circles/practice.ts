/**
 * PLAN-31 C1 §4.3: the practice partner — the empty-room fix. A LABELED
 * local bot that exercises the connect -> converse -> ask flow so the first
 * REAL connection is the user's second run of it (the Fortnite/chess.com
 * pattern). Product laws:
 *
 *  - Always visibly a bot ("Practice Partner (bot)") — never a fake friend.
 *  - It RETIRES as real connections arrive (circle archived, §4.3), and it
 *    never counts toward the friend-node count (connectionCount excludes
 *    practice circles).
 *  - Its replies ride the SAME signed-envelope path as a real friend's
 *    agent — scanned, wrapped, labeled — so the flow the user practices is
 *    the real flow, not a mock.
 */

import type { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import type { JsonValue } from "../commerce/sku.js";
import {
  generateKeyPair,
  keyPairFromPrivateKeyPem,
  pubkeyId,
  type KeyPair,
} from "../commerce/envelope.js";
import { resolveStateDir } from "../config/paths.js";
import { CirclesStore, DEFAULT_MEMBER_SCOPES } from "../memory/circles-store.js";
import { makeCircleEnvelope } from "./envelope.js";

export const PRACTICE_KIND = "practice";
export const PRACTICE_PARTNER_NAME = "Practice Partner (bot)";

function defaultPracticeKeyPath(): string {
  return path.join(resolveStateDir(), "identity", "practice.json");
}

/** The practice partner's own Ed25519 identity, persisted like the device's. */
export function loadOrCreatePracticeKeys(filePath: string = defaultPracticeKeyPath()): KeyPair {
  try {
    if (fs.existsSync(filePath)) {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as {
        version?: number;
        privateKeyPem?: string;
      };
      if (parsed?.version === 1 && typeof parsed.privateKeyPem === "string") {
        return keyPairFromPrivateKeyPem(parsed.privateKeyPem);
      }
    }
  } catch {
    // regenerate below
  }
  const pair = generateKeyPair();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    `${JSON.stringify(
      {
        version: 1,
        privateKeyPem: pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
        createdAtMs: Date.now(),
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  return pair;
}

/** Count of REAL (non-practice) distinct connected humans. */
export function realConnectionCount(db: DatabaseSync, selfPubkey: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(DISTINCT m.member_pubkey) AS n
         FROM circle_members m
         JOIN circles c ON c.circle_id = m.circle_id AND c.kind != '${PRACTICE_KIND}'
         JOIN circle_members me
           ON me.circle_id = m.circle_id AND me.member_pubkey = ? AND me.status = 'active'
        WHERE m.status = 'active' AND m.member_pubkey != ?`,
    )
    .get(selfPubkey, selfPubkey) as { n: number } | undefined;
  return row?.n ?? 0;
}

/**
 * Ensure the practice circle exists while the user has no real connections;
 * archive it once they do (the retirement rule). Returns the active practice
 * circle id, or null when retired/unneeded.
 */
export function ensurePracticeCircle(
  db: DatabaseSync,
  args: { selfPubkey: string; partnerKey: KeyPair; now?: number },
): string | null {
  const now = args.now ?? Date.now();
  const store = new CirclesStore(db);
  const existing = db
    .prepare(`SELECT circle_id, status FROM circles WHERE kind = ? LIMIT 1`)
    .get(PRACTICE_KIND) as { circle_id: string; status: string } | undefined;

  if (realConnectionCount(db, args.selfPubkey) > 0) {
    if (existing && existing.status === "active") {
      db.prepare(`UPDATE circles SET status = 'archived', updated_at = ? WHERE circle_id = ?`).run(
        now,
        existing.circle_id,
      );
    }
    return null;
  }
  if (existing) {
    return existing.status === "active" ? existing.circle_id : null;
  }
  const circleId = store.createCircle({
    name: "Practice Circle",
    kind: PRACTICE_KIND,
    creatorPubkey: args.selfPubkey,
    now,
  });
  store.addMember({
    circleId,
    memberPubkey: pubkeyId(args.partnerKey),
    displayName: PRACTICE_PARTNER_NAME,
    scopes: DEFAULT_MEMBER_SCOPES,
    now,
  });
  return circleId;
}

const SCRIPT: string[] = [
  "Hola! I'm the Practice Partner — a bot, and I'll always say so. This is exactly how a real friend's agent will talk with yours: signed messages, scanned on arrival, never trusted with your tools or memory. Try asking me something with circles.ask, or just reply here.",
  'Nice — that round trip you just did is the whole magic: two agents exchanging signed envelopes on their humans\' behalf. When a REAL friend connects, your agent can ask theirs things like "does anyone know a good dentist?" — and their agent only answers what their human allowed (circles.disclosure.set).',
  "You've got the hang of it. The real thing is better: mint an invite with circles.invite and send the code to a friend. The moment a real connection forms, I'll quietly retire — that's the deal with practice partners.",
];

/**
 * Reply to un-answered human messages in the practice circle, through the
 * SAME validated inbound path a real friend's agent would use. One reply per
 * sweep; the script advances with each partner reply so the flow teaches
 * connect -> converse -> ask -> invite.
 */
export async function practiceReply(
  db: DatabaseSync,
  args: { selfPubkey: string; partnerKey: KeyPair; now?: number },
): Promise<boolean> {
  const now = args.now ?? Date.now();
  const circleId = ensurePracticeCircle(db, args);
  if (!circleId) {
    return false;
  }
  const partnerPubkey = pubkeyId(args.partnerKey);
  const counts = db
    .prepare(
      `SELECT
         SUM(CASE WHEN direction = 'out' THEN 1 ELSE 0 END) AS ours,
         SUM(CASE WHEN direction = 'in' AND author_pubkey = ? THEN 1 ELSE 0 END) AS partners
       FROM circle_messages WHERE circle_id = ?`,
    )
    .get(partnerPubkey, circleId) as { ours: number | null; partners: number | null };
  const ourMessages = counts.ours ?? 0;
  const partnerReplies = counts.partners ?? 0;
  // Reply when the human has spoken since our last line (or to open, once).
  if (partnerReplies > ourMessages) {
    return false;
  }
  const line = SCRIPT[Math.min(partnerReplies, SCRIPT.length - 1)] as string;
  const body: Record<string, JsonValue> = { text: line };
  const envelope = makeCircleEnvelope("message", circleId, body, args.partnerKey);
  const { handleCircleMethod } = await import("../gateway/a2a/circles.js");
  const outcome = handleCircleMethod("circle/message", { envelope }, db, now);
  return outcome.ok;
}
