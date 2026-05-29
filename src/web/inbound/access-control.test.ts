import { describe, expect, it } from "vitest";
import {
  sendMessageMock,
  setAccessControlTestConfig,
  setupAccessControlTestHarness,
  upsertPairingRequestMock,
} from "./access-control.test-harness.js";

setupAccessControlTestHarness();

const { checkInboundAccessControl } = await import("./access-control.js");

describe("checkInboundAccessControl pairing grace", () => {
  it("suppresses pairing replies for historical DMs on connect", async () => {
    const connectedAtMs = 1_000_000;
    const messageTimestampMs = connectedAtMs - 31_000;

    const result = await checkInboundAccessControl({
      accountId: "default",
      from: "+15550001111",
      selfE164: "+15550009999",
      senderE164: "+15550001111",
      group: false,
      pushName: "Sam",
      isFromMe: false,
      messageTimestampMs,
      connectedAtMs,
      pairingGraceMs: 30_000,
      sock: { sendMessage: sendMessageMock },
      remoteJid: "15550001111@s.whatsapp.net",
    });

    expect(result.allowed).toBe(false);
    expect(upsertPairingRequestMock).not.toHaveBeenCalled();
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it("sends pairing replies for live DMs", async () => {
    const connectedAtMs = 1_000_000;
    const messageTimestampMs = connectedAtMs - 10_000;

    const result = await checkInboundAccessControl({
      accountId: "default",
      from: "+15550001111",
      selfE164: "+15550009999",
      senderE164: "+15550001111",
      group: false,
      pushName: "Sam",
      isFromMe: false,
      messageTimestampMs,
      connectedAtMs,
      pairingGraceMs: 30_000,
      sock: { sendMessage: sendMessageMock },
      remoteJid: "15550001111@s.whatsapp.net",
    });

    expect(result.allowed).toBe(false);
    expect(upsertPairingRequestMock).toHaveBeenCalled();
    expect(sendMessageMock).toHaveBeenCalled();
  });
});

describe("WhatsApp dmPolicy precedence", () => {
  it("uses account-level dmPolicy instead of channel-level (#8736)", async () => {
    // Channel-level says "pairing" but the account-level says "allowlist".
    // The account-level override should take precedence, so an unauthorized
    // sender should be blocked silently (no pairing reply).
    setAccessControlTestConfig({
      channels: {
        whatsapp: {
          dmPolicy: "pairing",
          accounts: {
            work: {
              dmPolicy: "allowlist",
              allowFrom: ["+15559999999"],
            },
          },
        },
      },
    });

    const result = await checkInboundAccessControl({
      accountId: "work",
      from: "+15550001111",
      selfE164: "+15550009999",
      senderE164: "+15550001111",
      group: false,
      pushName: "Stranger",
      isFromMe: false,
      sock: { sendMessage: sendMessageMock },
      remoteJid: "15550001111@s.whatsapp.net",
    });

    expect(result.allowed).toBe(false);
    expect(upsertPairingRequestMock).not.toHaveBeenCalled();
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it("inherits channel-level dmPolicy when account-level dmPolicy is unset", async () => {
    // Account has allowFrom set, but no dmPolicy override. Should inherit the channel default.
    // With dmPolicy=allowlist, unauthorized senders are silently blocked.
    setAccessControlTestConfig({
      channels: {
        whatsapp: {
          dmPolicy: "allowlist",
          accounts: {
            work: {
              allowFrom: ["+15559999999"],
            },
          },
        },
      },
    });

    const result = await checkInboundAccessControl({
      accountId: "work",
      from: "+15550001111",
      selfE164: "+15550009999",
      senderE164: "+15550001111",
      group: false,
      pushName: "Stranger",
      isFromMe: false,
      sock: { sendMessage: sendMessageMock },
      remoteJid: "15550001111@s.whatsapp.net",
    });

    expect(result.allowed).toBe(false);
    expect(upsertPairingRequestMock).not.toHaveBeenCalled();
    expect(sendMessageMock).not.toHaveBeenCalled();
  });
});

describe("inbound candidate normalization (#37)", () => {
  it("allows a DM when allowFrom is stored without '+' and from is raw formatted", async () => {
    setAccessControlTestConfig({
      channels: {
        whatsapp: {
          dmPolicy: "allowlist",
          accounts: {
            work: {
              allowFrom: ["14155551234"],
            },
          },
        },
      },
    });

    const result = await checkInboundAccessControl({
      accountId: "work",
      from: "+1 415-555-1234",
      selfE164: "+15550009999",
      senderE164: "+1 415-555-1234",
      group: false,
      isFromMe: false,
      sock: { sendMessage: sendMessageMock },
      remoteJid: "14155551234@s.whatsapp.net",
    });

    expect(result.allowed).toBe(true);
    expect(upsertPairingRequestMock).not.toHaveBeenCalled();
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it("allows a group message when groupAllowFrom is stored without '+' and senderE164 has formatting", async () => {
    setAccessControlTestConfig({
      channels: {
        whatsapp: {
          accounts: {
            work: {
              groupPolicy: "allowlist",
              groupAllowFrom: ["14155551234"],
            },
          },
        },
      },
    });

    const result = await checkInboundAccessControl({
      accountId: "work",
      from: "group-jid@g.us",
      selfE164: "+15550009999",
      senderE164: "+1 415-555-1234",
      group: true,
      isFromMe: false,
      sock: { sendMessage: sendMessageMock },
      remoteJid: "group-jid@g.us",
    });

    expect(result.allowed).toBe(true);
  });

  it("treats self-chat as same phone even when from and selfE164 differ in formatting", async () => {
    setAccessControlTestConfig({
      channels: {
        whatsapp: {
          accounts: {
            work: {
              dmPolicy: "allowlist",
              allowFrom: ["+15559999999"],
            },
          },
        },
      },
    });

    const result = await checkInboundAccessControl({
      accountId: "work",
      from: "14155559999",
      selfE164: "+1 415-555-9999",
      senderE164: "14155559999",
      group: false,
      isFromMe: false,
      sock: { sendMessage: sendMessageMock },
      remoteJid: "14155559999@s.whatsapp.net",
    });

    // isSamePhone short-circuits the allowlist check, so this is allowed
    // even though "14155559999" is not in allowFrom.
    expect(result.allowed).toBe(true);
    expect(upsertPairingRequestMock).not.toHaveBeenCalled();
  });
});
