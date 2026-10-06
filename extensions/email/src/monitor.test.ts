import { describe, expect, it, vi } from "vitest";
import type { ResolvedEmail } from "./config.js";
import type { InboundMail } from "./mail-logic.js";
import { processInbox, runEmailMonitor } from "./monitor.js";
import type { Mailbox, OutboundMail } from "./transport.js";

const e: ResolvedEmail = {
  enabled: true,
  address: "agent@example.com",
  imap: { host: "imap", port: 993, secure: true, user: "agent@example.com", password: "p" },
  smtp: { host: "smtp", port: 465, secure: true, user: "agent@example.com", password: "p" },
  allowFrom: ["@example.com"],
  requireAuthenticated: true,
  mailbox: "INBOX",
  maxBodyChars: 20_000,
};

const verified = { "authentication-results": "mx; dmarc=pass header.from=example.com" };
const mail = (uid: number, o: Partial<InboundMail> = {}): InboundMail => ({
  uid,
  from: "alice@example.com",
  subject: "Dinner",
  text: "Book us a table for two at 7.",
  messageId: `<m${uid}@example.com>`,
  references: [],
  headers: verified,
  ...o,
});

function fakeMailbox(mails: InboundMail[]) {
  const seen: number[] = [];
  let close: () => void = () => {};
  let notify: () => void = () => {};
  const box: Mailbox & { push(m: InboundMail): void } = {
    fetchUnseen: async () => mails.filter((m) => !seen.includes(m.uid)),
    markSeen: async (uid) => void seen.push(uid),
    onNewMail: (cb) => (notify = cb),
    closed: new Promise<void>((r) => (close = r)),
    close: async () => close(),
    push: (m) => {
      mails.push(m);
      notify();
    },
  };
  return { box, seen };
}

describe("processInbox", () => {
  it("answers verified, allowed people on their thread and skips everyone else", async () => {
    const { box, seen } = fakeMailbox([
      mail(1),
      mail(2, { from: "mallory@evil.com" }),
      mail(3, { headers: {} }),
      mail(4, { headers: { ...verified, "auto-submitted": "auto-replied" } }),
      mail(5, { from: "agent@example.com" }),
    ]);
    const sent: OutboundMail[] = [];
    const dispatch = vi.fn(async ({ body, reply }) => {
      expect(body).toBe("Book us a table for two at 7.");
      await reply("Booked for 7pm.");
    });
    const handled = await processInbox(
      box,
      {
        send: async (m) => {
          sent.push(m);
          return {};
        },
      },
      e,
      {
        dispatch,
        log: { info: () => {}, warn: () => {} },
      },
    );

    expect(handled).toBe(1);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(sent).toEqual([
      {
        to: "alice@example.com",
        subject: "Re: Dinner",
        text: "Booked for 7pm.",
        inReplyTo: "<m1@example.com>",
        references: ["<m1@example.com>"],
      },
    ]);
    // Everything is marked seen, so nothing is looked at twice.
    expect(seen).toEqual([1, 2, 3, 4, 5]);
  });

  it("keeps going when one message fails", async () => {
    const { box } = fakeMailbox([mail(1), mail(2)]);
    const warn = vi.fn();
    let n = 0;
    const handled = await processInbox(box, { send: async () => ({}) }, e, {
      dispatch: async () => {
        if (++n === 1) throw new Error("model down");
      },
      log: { info: () => {}, warn },
    });
    expect(handled).toBe(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("model down"));
  });
});

describe("runEmailMonitor", () => {
  it("handles new mail as it arrives and stops on abort", async () => {
    const { box } = fakeMailbox([mail(1)]);
    const dispatch = vi.fn(async () => {});
    const ac = new AbortController();
    const done = runEmailMonitor(e, ac.signal, {
      openMailbox: async () => box,
      createSender: async () => ({ send: async () => ({}) }),
      dispatch,
      log: { info: () => {}, warn: () => {} },
    });
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1));
    box.push(mail(2));
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(2));
    ac.abort();
    await done;
  });

  it("reconnects after a failed connection", async () => {
    const { box } = fakeMailbox([]);
    const ac = new AbortController();
    let attempts = 0;
    const done = runEmailMonitor(e, ac.signal, {
      openMailbox: async () => {
        if (++attempts === 1) throw new Error("ECONNREFUSED");
        return box;
      },
      createSender: async () => ({ send: async () => ({}) }),
      dispatch: async () => {},
      log: { info: () => {}, warn: () => {} },
      backoffMs: () => 1,
    });
    await vi.waitFor(() => expect(attempts).toBe(2));
    ac.abort();
    await done;
  });
});
