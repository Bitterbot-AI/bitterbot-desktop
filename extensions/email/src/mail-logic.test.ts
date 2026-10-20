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
  authResults: [],
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

  it("trusts only the receiving server's own verdict", () => {
    const ar = (...authResults: string[]) => mail({ authResults });
    expect(senderAuthenticated(mail())).toBe(false);
    expect(
      senderAuthenticated(ar("mx.google.com; dmarc=pass (p=NONE) header.from=example.com")),
    ).toBe(true);
    expect(senderAuthenticated(ar("mx; dkim=pass header.d=example.com; spf=fail"))).toBe(true);
    // A valid signature from someone else's domain proves nothing about the sender.
    expect(senderAuthenticated(ar("mx; dkim=pass header.d=evil.com; dmarc=fail"))).toBe(false);
  });

  it("is not fooled by a forged header below the real one", () => {
    const forged = mail({
      authResults: [
        "mx.google.com; dmarc=fail header.from=example.com",
        "evil; dmarc=pass header.from=example.com",
      ],
    });
    expect(senderAuthenticated(forged)).toBe(false);
  });

  it("ignores pass in comments, other properties and header.i", () => {
    const ar = (v: string) => mail({ authResults: [v] });
    expect(senderAuthenticated(ar("mx; spf=pass smtp.mailfrom=dmarc=pass@evil.com"))).toBe(false);
    expect(senderAuthenticated(ar("mx; dmarc=fail (dmarc=pass) header.from=example.com"))).toBe(
      false,
    );
    expect(senderAuthenticated(ar("mx; dmarc=pass header.from=evil.com"))).toBe(false);
    expect(
      senderAuthenticated(ar("mx; dkim=pass header.i=example.com@evil.com header.d=evil.com")),
    ).toBe(false);
  });

  it("with authservId, needs exactly one verdict from that server, on top", () => {
    const real = "mx.google.com; dmarc=pass header.from=example.com";
    expect(senderAuthenticated(mail({ authResults: [real] }), "mx.google.com")).toBe(true);
    expect(senderAuthenticated(mail({ authResults: [real] }), "other.server")).toBe(false);
    expect(senderAuthenticated(mail({ authResults: [real, real] }), "mx.google.com")).toBe(false);
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
