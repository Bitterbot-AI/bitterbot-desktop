/**
 * The parts of the email channel that decide things, kept free of network
 * code so they can be tested on their own (PLAN-53 F4).
 */

export type InboundMail = {
  uid: number;
  from: string;
  fromName?: string;
  subject: string;
  text: string;
  messageId?: string;
  references: string[];
  date?: Date;
  /** Raw header values, lower-cased names (repeated headers joined). */
  headers: Record<string, string>;
  /** Every Authentication-Results header, top (newest, added by the receiving server) first. */
  authResults: string[];
};

export function normalizeAddress(value: string): string {
  const m = value.match(/<([^>]+)>/);
  return (m ? m[1] : value).trim().toLowerCase();
}

/** "alice@x.com" matches itself; "@x.com" matches anyone at that domain; "*" matches all. */
export function senderAllowed(from: string, allowFrom: string[]): boolean {
  const addr = normalizeAddress(from);
  const domain = addr.split("@")[1] ?? "";
  return allowFrom.some((raw) => {
    const entry = raw.trim().toLowerCase();
    if (entry === "*") return true;
    if (entry.startsWith("@")) return domain === entry.slice(1);
    return entry === addr;
  });
}

/** Mail no person wrote: vacation replies, bounces, lists, bulk. Never answered. */
export function isAutomated(mail: InboundMail): boolean {
  const h = mail.headers;
  const auto = (h["auto-submitted"] ?? "").toLowerCase();
  if (auto && auto !== "no") return true;
  if (h["list-id"] || h["list-unsubscribe"]) return true;
  if (/^(bulk|junk|list|auto_reply)$/i.test((h["precedence"] ?? "").trim())) return true;
  if (h["x-autoreply"] || h["x-autorespond"]) return true;
  return /^(mailer-daemon|postmaster|no-?reply|do-?not-?reply)@/i.test(normalizeAddress(mail.from));
}

type AuthResult = { method: string; result: string; props: Record<string, string> };

/** Parse one Authentication-Results value (RFC 8601): authserv-id, then results. */
export function parseAuthResults(value: string): { authservId: string; results: AuthResult[] } {
  // Comments carry free text (and some servers echo the envelope sender);
  // nothing inside them counts.
  let clean = value.toLowerCase();
  for (let i = 0; i < 5 && /\([^()]*\)/.test(clean); i++) {
    clean = clean.replace(/\([^()]*\)/g, " ");
  }
  const [head = "", ...rest] = clean.split(";");
  const results: AuthResult[] = [];
  for (const part of rest) {
    const tokens = part.trim().split(/\s+/).filter(Boolean);
    const first = tokens.shift();
    const m = first?.match(/^([a-z0-9-]+)=([a-z]+)$/);
    if (!m) continue;
    const props: Record<string, string> = {};
    for (const t of tokens) {
      const kv = t.match(/^([a-z0-9-]+\.[a-z0-9-]+)=(.+)$/);
      if (kv) props[kv[1]] = kv[2].replace(/^"|"$/g, "");
    }
    results.push({ method: m[1], result: m[2], props });
  }
  return { authservId: head.trim().split(/\s+/)[0] ?? "", results };
}

/**
 * Whether the receiving server vouched for the sender's domain. A From header
 * is trivial to forge, and so is an Authentication-Results header inside the
 * message, so only the topmost one counts: the receiving server adds it last.
 * With `authservId` set, that header must also come from the named server and
 * be the only one claiming that name.
 */
export function senderAuthenticated(mail: InboundMail, authservId?: string): boolean {
  const domain = normalizeAddress(mail.from).split("@")[1] ?? "";
  if (!domain) return false;
  const parsed = mail.authResults.map(parseAuthResults);
  let trusted = parsed[0];
  if (authservId) {
    const id = authservId.toLowerCase();
    const mine = parsed.filter((p) => p.authservId === id);
    if (mine.length !== 1 || parsed[0]?.authservId !== id) return false;
    trusted = mine[0];
  }
  if (!trusted) return false;
  const aligned = (d: string | undefined) =>
    Boolean(d) && (d === domain || domain.endsWith(`.${d}`));
  return trusted.results.some(
    (r) =>
      r.result === "pass" &&
      ((r.method === "dmarc" && r.props["header.from"] === domain) ||
        (r.method === "dkim" && aligned(r.props["header.d"]))),
  );
}

/** The new part of a reply: quoted history and signatures cut off. */
export function stripQuoted(text: string, maxChars = 20_000): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  for (const line of lines) {
    if (/^On .+wrote:\s*$/.test(line.trim())) break;
    if (/^-{2,}\s*Original Message\s*-{2,}/i.test(line.trim())) break;
    if (/^From: .+/.test(line) && out.length > 0 && out.at(-1)?.trim() === "") break;
    // The signature separator is "-- " (some clients drop the space).
    if (line.replace(/\s+$/, "") === "--") break;
    if (line.startsWith(">")) continue;
    out.push(line);
  }
  const body = out.join("\n").trim();
  return body.length > maxChars ? `${body.slice(0, maxChars)}\n[truncated]` : body;
}

export function replySubject(subject: string): string {
  const s = subject.trim() || "(no subject)";
  return /^re:/i.test(s) ? s : `Re: ${s}`;
}

/** Threading headers for a reply to `mail`. */
export function replyHeaders(mail: Pick<InboundMail, "messageId" | "references">): {
  inReplyTo?: string;
  references?: string[];
} {
  if (!mail.messageId) return {};
  return {
    inReplyTo: mail.messageId,
    references: [...mail.references.filter((r) => r !== mail.messageId), mail.messageId].slice(-20),
  };
}
