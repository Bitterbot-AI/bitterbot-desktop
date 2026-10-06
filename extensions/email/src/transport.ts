/**
 * IMAP and SMTP behind two small interfaces, so the channel's logic is tested
 * with fakes and the mail libraries load only when the channel runs.
 */

import type { ResolvedEmail } from "./config.js";
import type { InboundMail } from "./mail-logic.js";

export type Mailbox = {
  /** Unseen messages, oldest first. */
  fetchUnseen(): Promise<InboundMail[]>;
  markSeen(uid: number): Promise<void>;
  /** Called when the server reports new mail (IMAP IDLE). */
  onNewMail(cb: () => void): void;
  /** Resolves when the connection closes for any reason. */
  closed: Promise<void>;
  close(): Promise<void>;
};

export type OutboundMail = {
  to: string;
  subject: string;
  text: string;
  inReplyTo?: string;
  references?: string[];
};

export type MailSender = { send(mail: OutboundMail): Promise<{ messageId?: string }> };

type Header = { key?: string; line?: string; value?: unknown };
type Parsed = {
  from?: { value?: Array<{ address?: string; name?: string }> };
  subject?: string;
  text?: string;
  messageId?: string;
  references?: string | string[];
  date?: Date;
  headerLines?: Header[];
};
type ImapMessage = { uid: number; source?: Buffer };
type ImapClient = {
  connect(): Promise<void>;
  getMailboxLock(path: string): Promise<{ release(): void }>;
  search(q: Record<string, unknown>, o: { uid: boolean }): Promise<number[] | false>;
  fetchOne(
    uid: string,
    q: Record<string, unknown>,
    o: { uid: boolean },
  ): Promise<ImapMessage | false>;
  messageFlagsAdd(range: string, flags: string[], o: { uid: boolean }): Promise<boolean>;
  on(event: string, cb: (...args: unknown[]) => void): void;
  logout(): Promise<void>;
};

// Specifiers in variables: the libraries resolve at run time only.
const IMAPFLOW = "imapflow";
const MAILPARSER = "mailparser";
const NODEMAILER = "nodemailer";

function headerMap(lines: Header[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of lines ?? []) {
    const key = h.key?.toLowerCase();
    if (!key) continue;
    const value = (h.line ?? "").replace(/^[^:]*:\s*/, "").replace(/\r?\n\s+/g, " ");
    out[key] = out[key] ? `${out[key]}; ${value}` : value;
  }
  return out;
}

export async function parseMail(uid: number, source: Buffer): Promise<InboundMail> {
  const { simpleParser } = (await import(MAILPARSER)) as {
    simpleParser: (s: Buffer) => Promise<Parsed>;
  };
  const p = await simpleParser(source);
  const sender = p.from?.value?.[0];
  const refs = Array.isArray(p.references) ? p.references : p.references ? [p.references] : [];
  return {
    uid,
    from: sender?.address ?? "",
    fromName: sender?.name || undefined,
    subject: p.subject ?? "",
    text: p.text ?? "",
    messageId: p.messageId,
    references: refs,
    date: p.date,
    headers: headerMap(p.headerLines),
  };
}

export async function openMailbox(e: ResolvedEmail): Promise<Mailbox> {
  const { ImapFlow } = (await import(IMAPFLOW)) as {
    ImapFlow: new (o: Record<string, unknown>) => ImapClient;
  };
  const client = new ImapFlow({
    host: e.imap.host,
    port: e.imap.port,
    secure: e.imap.secure,
    auth: { user: e.imap.user, pass: e.imap.password },
    logger: false,
  });
  let resolveClosed: () => void = () => {};
  const closed = new Promise<void>((r) => (resolveClosed = r));
  client.on("close", () => resolveClosed());
  client.on("error", () => resolveClosed());
  await client.connect();
  // Held for the session: the mailbox stays selected and imapflow idles on it.
  await client.getMailboxLock(e.mailbox);
  return {
    async fetchUnseen() {
      const uids = (await client.search({ seen: false }, { uid: true })) || [];
      const out: InboundMail[] = [];
      for (const uid of uids.toSorted((a, b) => a - b)) {
        const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
        if (msg && msg.source) out.push(await parseMail(uid, msg.source));
      }
      return out;
    },
    async markSeen(uid) {
      await client.messageFlagsAdd(String(uid), ["\\Seen"], { uid: true });
    },
    onNewMail(cb) {
      client.on("exists", () => cb());
    },
    closed,
    async close() {
      await client.logout().catch(() => {});
      resolveClosed();
    },
  };
}

export async function createSender(e: ResolvedEmail): Promise<MailSender> {
  const nodemailer = (await import(NODEMAILER)) as {
    createTransport: (o: Record<string, unknown>) => {
      sendMail: (m: Record<string, unknown>) => Promise<{ messageId?: string }>;
    };
  };
  const transport = nodemailer.createTransport({
    host: e.smtp.host,
    port: e.smtp.port,
    secure: e.smtp.secure,
    auth: { user: e.smtp.user, pass: e.smtp.password },
  });
  return {
    async send(mail) {
      const info = await transport.sendMail({
        from: e.address,
        to: mail.to,
        subject: mail.subject,
        text: mail.text,
        ...(mail.inReplyTo ? { inReplyTo: mail.inReplyTo } : {}),
        ...(mail.references?.length ? { references: mail.references } : {}),
        headers: { "Auto-Submitted": "auto-replied" },
      });
      return { messageId: info.messageId };
    },
  };
}
