import { describe, expect, it } from "vitest";
import { containsCardData, luhnValid, scrubCardData, scrubCardDataDeep } from "./card-data.js";

describe("scrubCardData", () => {
  it("removes card numbers however they are spaced, keeping the last four", () => {
    expect(scrubCardData("Paid with 4111 1111 1111 1111 today")).toBe(
      "Paid with [card ending 1111] today",
    );
    expect(scrubCardData("card=4111-1111-1111-1111")).toBe("card=[card ending 1111]");
    expect(scrubCardData("5555555555554444")).toBe("[card ending 4444]");
    // 15-digit Amex and a 19-digit number.
    expect(scrubCardData("378282246310005")).toBe("[card ending 0005]");
    expect(scrubCardData("6011111111111117")).toBe("[card ending 1117]");
  });

  it("leaves numbers that are not cards alone", () => {
    for (const text of [
      "order 1234567890123456 shipped", // fails Luhn
      "tx 0x30ee075e39d5a0aaefa95fc9a878", // hex, not a digit run
      "call +1 555 010 0100", // too short
      "timestamp 1791236880000", // 13 digits, fails Luhn
      "ISBN 978-0-306-40615-7",
    ]) {
      expect(scrubCardData(text)).toBe(text);
    }
  });

  it("removes security codes next to their label, and nothing else", () => {
    expect(scrubCardData("CVV: 123, exp 12/28")).toBe("CVV: [removed], exp 12/28");
    expect(scrubCardData("security code is 4321")).toBe("security code is [removed]");
    expect(scrubCardData('{"cvc":"981"}')).toBe('{"cvc":"[removed]"}');
    expect(scrubCardData("room 123 on floor 4")).toBe("room 123 on floor 4");
  });

  it("removes a security code in a browser snapshot line", () => {
    expect(scrubCardData('textbox "CVC" [ref=e5]: 123')).toBe('textbox "CVC" [ref=e5]: [removed]');
  });

  it("is cheap on text with no digits", () => {
    const text = "no numbers here at all";
    expect(scrubCardData(text)).toBe(text);
    expect(containsCardData("4242 4242 4242 4242")).toBe(true);
    expect(containsCardData("nothing")).toBe(false);
  });
});

describe("scrubCardDataDeep", () => {
  it("scrubs strings anywhere in a tool result, and returns the same object when clean", () => {
    const result = {
      content: [{ type: "text", text: "Entered 4242 4242 4242 4242 and CVV 123" }],
      details: { form: { number: "4242424242424242", nested: [{ cvv: "cvv=123" }] } },
    };
    const scrubbed = scrubCardDataDeep(result);
    expect(scrubbed.content[0].text).toBe("Entered [card ending 4242] and CVV [removed]");
    expect(scrubbed.details.form.number).toBe("[card ending 4242]");
    expect(scrubbed.details.form.nested[0].cvv).toBe("cvv=[removed]");

    const clean = { content: [{ type: "text", text: "fine" }] };
    expect(scrubCardDataDeep(clean)).toBe(clean);
  });
});

describe("luhnValid", () => {
  it("accepts real test numbers and rejects a typo", () => {
    expect(luhnValid("4111111111111111")).toBe(true);
    expect(luhnValid("4111111111111112")).toBe(false);
  });
});
