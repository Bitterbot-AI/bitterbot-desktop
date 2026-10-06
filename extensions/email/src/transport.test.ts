import { describe, expect, it } from "vitest";
import { senderAuthenticated, stripQuoted } from "./mail-logic.js";
import { parseMail } from "./transport.js";

const raw = [
  "Return-Path: <alice@example.com>",
  "Authentication-Results: mx.example.net;",
  "       dkim=pass header.i=@example.com header.s=s1;",
  "       spf=pass smtp.mailfrom=alice@example.com;",
  "       dmarc=pass (p=REJECT) header.from=example.com",
  'From: "Alice Doe" <alice@example.com>',
  "To: agent@example.net",
  "Subject: Re: Dinner on Friday",
  "Message-ID: <reply-2@example.com>",
  "In-Reply-To: <ask-1@example.net>",
  "References: <start-0@example.com> <ask-1@example.net>",
  "Date: Mon, 05 Oct 2026 18:04:00 +0000",
  "MIME-Version: 1.0",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "7pm works, book it.",
  "",
  "On Mon, Oct 5, 2026 at 5:00 PM Agent <agent@example.net> wrote:",
  "> Shall I book Nopa for Friday?",
  "",
].join("\r\n");

describe("parseMail", () => {
  it("reads sender, thread and authentication from a real message", async () => {
    const mail = await parseMail(7, Buffer.from(raw));
    expect(mail).toMatchObject({
      uid: 7,
      from: "alice@example.com",
      fromName: "Alice Doe",
      subject: "Re: Dinner on Friday",
      messageId: "<reply-2@example.com>",
      references: ["<start-0@example.com>", "<ask-1@example.net>"],
    });
    expect(mail.headers["authentication-results"]).toContain("dmarc=pass");
    expect(senderAuthenticated(mail)).toBe(true);
    expect(stripQuoted(mail.text)).toBe("7pm works, book it.");
  });
});
