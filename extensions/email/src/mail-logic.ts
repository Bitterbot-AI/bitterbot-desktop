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
  /** Raw header values, lower-cased names. */
  headers: Record<string, string>;
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

/**
 * Whether the receiving server vouched for the sender's domain. A From header
 * is trivial to forge; Authentication-Results, added by the owner's own mail
 * server, says whether DMARC passed or DKIM passed for that domain.
 */
export function senderAuthenticated(mail: InboundMail): boolean {
  const results = (mail.headers["authentication-results"] ?? "").toLowerCase();
  if (!results) return false;
  if (/\bdmarc=pass\b/.test(results)) return true;
  const domain = normalizeAddress(mail.from).split("@")[1] ?? "";
  if (!domain) return false;
  for (const m of results.matchAll(/\bdkim=pass\b[^;]*?header\.(?:d|i)=@?([a-z0-9.-]+)/g)) {
    const signer = m[1];
    if (signer === domain || domain.endsWith(`.${signer}`)) return true;
  }
  return false;
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
