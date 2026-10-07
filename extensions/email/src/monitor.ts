/**
 * The inbox loop: on start and whenever the server reports new mail, take the
 * unseen messages, drop what the agent must not answer, and hand the rest to
 * the agent with a way to reply on the same thread.
 */

import type { ResolvedEmail } from "./config.js";
import {
  type InboundMail,
  isAutomated,
  normalizeAddress,
  replyHeaders,
  replySubject,
  senderAllowed,
  senderAuthenticated,
  stripQuoted,
} from "./mail-logic.js";
import type { Mailbox, MailSender } from "./transport.js";

export type EmailLog = { info(msg: string): void; warn(msg: string): void };

export type Dispatch = (params: {
  mail: InboundMail;
  body: string;
  reply: (text: string) => Promise<void>;
}) => Promise<void>;

export type MonitorDeps = {
  openMailbox: (e: ResolvedEmail) => Promise<Mailbox>;
  createSender: (e: ResolvedEmail) => Promise<MailSender>;
  dispatch: Dispatch;
  log: EmailLog;
  /** Backoff before reconnecting, by attempt. */
  backoffMs?: (attempt: number) => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
};

/** Last thread per sender, so a later message to them continues it. */
export const lastThreadBySender = new Map<string, InboundMail>();

/** Reply times per sender, for the hourly cap that stops mail loops. */
const repliesBySender = new Map<string, number[]>();

export function underReplyCap(sender: string, cap: number, now = Date.now()): boolean {
  const recent = (repliesBySender.get(sender) ?? []).filter((t) => now - t < 60 * 60 * 1000);
  repliesBySender.set(sender, recent);
  return recent.length < cap;
}

/** Why a message is not given to the agent, or null when it is. */
export function rejectReason(mail: InboundMail, e: ResolvedEmail): string | null {
  const from = normalizeAddress(mail.from);
  if (!from) return "no sender";
  if (from === e.address) return "sent by this mailbox";
  if (!senderAllowed(from, e.allowFrom)) return "sender not in allowFrom";
  if (isAutomated(mail)) return "automated mail";
  if (e.requireAuthenticated && !senderAuthenticated(mail, e.authservId)) {
    return "sender not verified by the mail server (no DMARC or DKIM pass)";
  }
  return null;
}

export async function processInbox(
  mailbox: Mailbox,
  sender: MailSender,
  e: ResolvedEmail,
  deps: Pick<MonitorDeps, "dispatch" | "log">,
): Promise<number> {
  let handled = 0;
  for (const mail of await mailbox.fetchUnseen()) {
    // Seen first: a message that breaks dispatch must not be retried forever.
    await mailbox.markSeen(mail.uid);
    const reason = rejectReason(mail, e);
    if (reason) {
      deps.log.info(
        `email: skipped uid=${mail.uid} from=${normalizeAddress(mail.from)}: ${reason}`,
      );
      continue;
    }
    const body = stripQuoted(mail.text, e.maxBodyChars);
    if (!body) continue;
    const fromAddr = normalizeAddress(mail.from);
    if (!underReplyCap(fromAddr, e.maxRepliesPerHour)) {
      deps.log.warn(
        `email: skipped uid=${mail.uid} from=${fromAddr}: reply limit reached for this hour`,
      );
      continue;
    }
    lastThreadBySender.set(normalizeAddress(mail.from), mail);
    const headers = replyHeaders(mail);
    try {
      await deps.dispatch({
        mail,
        body,
        reply: async (text) => {
          if (!text.trim()) return;
          repliesBySender.get(fromAddr)?.push(Date.now());
          await sender.send({
            to: normalizeAddress(mail.from),
            subject: replySubject(mail.subject),
            text,
            ...headers,
          });
        },
      });
      handled++;
    } catch (err) {
      deps.log.warn(`email: handling uid=${mail.uid} failed: ${String(err)}`);
    }
  }
  return handled;
}

const defaultSleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(t);
      resolve();
    });
  });

/** Runs until the signal aborts, reconnecting with backoff. */
export async function runEmailMonitor(
  e: ResolvedEmail,
  signal: AbortSignal,
  deps: MonitorDeps,
): Promise<void> {
  const backoff = deps.backoffMs ?? ((n) => Math.min(5_000 * 2 ** n, 5 * 60_000));
  const sleep = deps.sleep ?? defaultSleep;
  let attempt = 0;
  while (!signal.aborted) {
    let mailbox: Mailbox | null = null;
    try {
      mailbox = await deps.openMailbox(e);
      const sender = await deps.createSender(e);
      attempt = 0;
      deps.log.info(`email: watching ${e.mailbox} for ${e.address}`);
      let running: Promise<unknown> = processInbox(mailbox, sender, e, deps);
      mailbox.onNewMail(() => {
        // One pass at a time; a burst of notices queues one more pass.
        running = running.then(() => processInbox(mailbox!, sender, e, deps)).catch(() => {});
      });
      const onAbort = () => void mailbox?.close();
      signal.addEventListener("abort", onAbort, { once: true });
      await mailbox.closed;
      signal.removeEventListener("abort", onAbort);
      await running.catch(() => {});
    } catch (err) {
      deps.log.warn(`email: connection failed: ${String(err)}`);
    } finally {
      await mailbox?.close().catch(() => {});
    }
    if (signal.aborted) break;
    await sleep(backoff(attempt++), signal);
  }
}
