import { describe, expect, it } from "vitest";
import {
  addressesFromConfig,
  addressesFromSessions,
  contactKey,
  KnownContacts,
  normalizeContact,
} from "./contacts.js";

describe("normalizeContact", () => {
  it("reads one person out of the ways channels write them", () => {
    for (const form of [
      "+1 (555) 010-0100",
      "whatsapp:+15550100100",
      "15550100100@s.whatsapp.net",
      "15550100100:12@s.whatsapp.net",
      "15550100100",
    ]) {
      expect(normalizeContact(form)).toBe("15550100100");
    }
    expect(normalizeContact("telegram:@Alice")).toBe("alice");
    expect(normalizeContact("tg:123456")).toBe("123456");
    expect(normalizeContact("<@!4242>")).toBe("4242");
    expect(normalizeContact("discord:user:4242")).toBe("4242");
    // A group keeps its own id.
    expect(normalizeContact("120363-456@g.us")).toBe("120363-456@g.us");
  });
});

describe("KnownContacts", () => {
  const known = new KnownContacts([
    { channel: "whatsapp", address: "+15550100100" },
    { channel: "telegram", address: "telegram:777" },
    { address: "+15550100999" },
    { channel: "discord", address: "*" },
  ]);

  it("knows an address on its channel, however it is written", () => {
    expect(known.has({ channel: "whatsapp", target: "15550100100@s.whatsapp.net" })).toBe(true);
    expect(known.has({ channel: "Telegram", target: "777" })).toBe(true);
  });

  it("does not carry a channel's contact over to another channel", () => {
    expect(known.has({ channel: "telegram", target: "+15550100100" })).toBe(false);
  });

  it("knows a channel-less entry everywhere, and matches any channel when the call names none", () => {
    expect(known.has({ channel: "signal", target: "+1 555 010 0999" })).toBe(true);
    expect(known.has({ target: "777" })).toBe(true);
  });

  it("never counts the open wildcard as a person", () => {
    expect(known.has({ channel: "discord", target: "*" })).toBe(false);
    expect(known.has({ channel: "discord", target: "12345" })).toBe(false);
    expect(known.size).toBe(3);
  });
});

describe("where known addresses come from", () => {
  it("takes everyone a session has talked to", () => {
    const addresses = addressesFromSessions({
      "agent:main:main": {
        lastChannel: "whatsapp",
        lastTo: "+15550100100",
        origin: { provider: "whatsapp", from: "+15550100100", to: "+15550100001" },
      },
      "agent:main:telegram:group:-100": {
        deliveryContext: { channel: "telegram", to: "telegram:-100" },
      },
      "agent:main:cron:x": {},
    });
    const known = new KnownContacts(addresses);

    expect(known.has({ channel: "whatsapp", target: "+15550100100" })).toBe(true);
    expect(known.has({ channel: "telegram", target: "-100" })).toBe(true);
    expect(known.has({ channel: "telegram", target: "555" })).toBe(false);
  });

  it("takes the owner and allow-listed senders from config", () => {
    const known = new KnownContacts(
      addressesFromConfig({
        commands: { ownerAllowFrom: ["telegram:42", "+15550100777", 99] },
        channels: {
          whatsapp: { allowFrom: ["+15550100100", "*"] },
          discord: { dm: { allowFrom: ["4242"] }, accounts: { work: { allowFrom: ["5151"] } } },
          slack: null,
        },
      }),
    );

    expect(known.has({ channel: "telegram", target: "42" })).toBe(true);
    expect(known.has({ channel: "signal", target: "+15550100777" })).toBe(true);
    expect(known.has({ channel: "whatsapp", target: "+15550100100" })).toBe(true);
    expect(known.has({ channel: "discord", target: "user:4242" })).toBe(true);
    expect(known.has({ channel: "discord", target: "5151" })).toBe(true);
    expect(known.has({ channel: "whatsapp", target: "+15550100555" })).toBe(false);
  });
});

describe("contactKey", () => {
  it("is the same for one recipient written two ways", () => {
    expect(contactKey({ channel: "WhatsApp", target: "+1 555 010 0100" })).toBe(
      contactKey({ channel: "whatsapp", target: "15550100100@s.whatsapp.net" }),
    );
    expect(contactKey({ target: "777" })).toBe("*|777");
  });
});
