import { describe, expect, it } from "vitest";
import {
  type InboundMail,
  isAutomated,
  replyHeaders,
  replySubject,
  senderAllowed,
  senderAuthenticated,
  stripQuoted,
} from "./mail-logic.js";

const mail = (o: Partial<InboundMail> = {}): InboundMail => ({
  uid: 1,
  from: "Alice <alice@example.com>",
  subject: "Dinner",
  text: "Book us a table",
  references: [],
  headers: {},
  ...o,
});

describe("who may write", () => {
  it("matches addresses, domains and the wildcard", () => {
    expect(senderAllowed("Alice <ALICE@example.com>", ["alice@example.com"])).toBe(true);
    expect(senderAllowed("bob@example.com", ["@example.com"])).toBe(true);
    expect(senderAllowed("bob@evil.com", ["@example.com"])).toBe(false);
    expect(senderAllowed("x@y.z", ["*"])).toBe(true);
    expect(senderAllowed("x@y.z", [])).toBe(false);
  });

  it("trusts only what the receiving server verified", () => {
    expect(senderAuthenticated(mail())).toBe(false);
    expect(
      senderAuthenticated(
        mail({
          headers: {
            "authentication-results": "mx.google.com; dmarc=pass (p=NONE) header.from=example.com",
          },
        }),
      ),
    ).toBe(true);
    expect(
      senderAuthenticated(
        mail({
          headers: { "authentication-results": "mx; dkim=pass header.d=example.com; spf=fail" },
        }),
      ),
    ).toBe(true);
    // A valid signature from someone else's domain proves nothing about the sender.
    expect(
      senderAuthenticated(
        mail({
          headers: { "authentication-results": "mx; dkim=pass header.d=evil.com; dmarc=fail" },
        }),
      ),
    ).toBe(false);
  });

  it("recognises mail no person wrote", () => {
    expect(isAutomated(mail())).toBe(false);
    expect(isAutomated(mail({ headers: { "auto-submitted": "auto-replied" } }))).toBe(true);
    expect(isAutomated(mail({ headers: { "list-id": "<news.example.com>" } }))).toBe(true);
    expect(isAutomated(mail({ headers: { precedence: "bulk" } }))).toBe(true);
    expect(isAutomated(mail({ from: "no-reply@shop.com" }))).toBe(true);
    expect(isAutomated(mail({ headers: { "auto-submitted": "no" } }))).toBe(false);
  });
});

describe("replies", () => {
  it("keeps only the new part of a reply", () => {
    const text =
      "Sounds good, 7pm.\n\nOn Mon, Oct 5, 2026 at 9:00 AM Agent <a@x.com> wrote:\n> Shall I book?\n";
    expect(stripQuoted(text)).toBe("Sounds good, 7pm.");
    expect(stripQuoted("Hi\n> quoted\nthere\n-- \nAlice")).toBe("Hi\nthere");
    expect(stripQuoted("x".repeat(50), 10)).toBe(`${"x".repeat(10)}\n[truncated]`);
  });

  it("threads the reply", () => {
    expect(replySubject("Dinner")).toBe("Re: Dinner");
    expect(replySubject("RE: Dinner")).toBe("RE: Dinner");
    expect(replyHeaders(mail({ messageId: "<m2@x>", references: ["<m1@x>"] }))).toEqual({
      inReplyTo: "<m2@x>",
      references: ["<m1@x>", "<m2@x>"],
    });
    expect(replyHeaders(mail())).toEqual({});
  });
});
