import { describe, expect, it } from "vitest";
import { resolveCommandAuthorization } from "../../auto-reply/command-auth.js";
import type { MsgContext } from "../../auto-reply/templating.js";
import type { BitterbotConfig } from "../../config/config.js";
import { DROP, phoneEventPayload, redactSnapshotForPhone } from "./phone-events.js";
import {
  guardPhoneRequest,
  isPhoneMessageAllowed,
  isPhoneSessionAllowed,
  phoneApprovalRefusal,
  PHONE_ALWAYS_REFUSAL,
  PHONE_MONEY_REFUSAL,
} from "./phone-policy.js";
import { MOBILE_DEVICE_SCOPES } from "./scopes.js";

const PHONE = [...MOBILE_DEVICE_SCOPES];

describe("phone is a non-owner surface (PLAN-62)", () => {
  const ctx = (body: string, phone: boolean): MsgContext =>
    ({
      Provider: "webchat",
      Surface: "webchat",
      Body: body,
      CommandBody: body,
      SenderId: "bitterbot-mobile",
      CommandAuthorized: true,
      ...(phone ? { GatewayPhoneSurface: true } : {}),
    }) as MsgContext;

  it("the Control UI is the owner; a phone never is", () => {
    const cfg = {} as BitterbotConfig;
    const desk = resolveCommandAuthorization({
      ctx: ctx("/config show", false),
      cfg,
      commandAuthorized: true,
    });
    expect(desk.senderIsOwner).toBe(true);
    expect(desk.isAuthorizedSender).toBe(true);
    const phone = resolveCommandAuthorization({
      ctx: ctx("/config show", true),
      cfg,
      commandAuthorized: true,
    });
    expect(phone.senderIsOwner).toBe(false);
    expect(phone.isAuthorizedSender).toBe(false);
  });

  it("authorizes only the harmless commands from a phone, even with commands.allowFrom", () => {
    const cfg = { commands: { allowFrom: { "*": ["*"] } } } as unknown as BitterbotConfig;
    for (const [body, ok] of [
      ["/new", true],
      ["/status", true],
      ["/stop", true],
      ["/pair", false],
      ["/approve rv-1 allow", false],
      ["/config set x 1", false],
      ["/elevated on", false],
      ["hello there", false],
    ] as const) {
      const auth = resolveCommandAuthorization({
        ctx: ctx(body, true),
        cfg,
        commandAuthorized: true,
      });
      expect(auth.isAuthorizedSender, body).toBe(ok);
      expect(auth.senderIsOwner).toBe(false);
    }
  });

  it("lets ordinary chat and allowed commands through chat.send, refuses the rest", () => {
    expect(isPhoneMessageAllowed("what's on today?")).toBe(true);
    expect(isPhoneMessageAllowed("/new")).toBe(true);
    expect(isPhoneMessageAllowed("  /Status")).toBe(true);
    expect(isPhoneMessageAllowed("/pair approve latest")).toBe(false);
    expect(isPhoneMessageAllowed("/approve rv-1 allow")).toBe(false);
    expect(isPhoneMessageAllowed("/bash rm -rf /")).toBe(false);
    expect(isPhoneMessageAllowed("/")).toBe(false);
  });
});

describe("phone approvals (PLAN-62)", () => {
  it("never approves money or grants always-allow, may deny or allow once", () => {
    expect(phoneApprovalRefusal({ scopes: PHONE, decision: "approve", cls: "spend" })).toBe(
      PHONE_MONEY_REFUSAL,
    );
    expect(
      phoneApprovalRefusal({ scopes: PHONE, decision: "approve", cls: "command", tool: "compute" }),
    ).toBe(PHONE_MONEY_REFUSAL);
    expect(
      phoneApprovalRefusal({ scopes: PHONE, decision: "approve", cls: "command", always: true }),
    ).toBe(PHONE_ALWAYS_REFUSAL);
    expect(phoneApprovalRefusal({ scopes: PHONE, decision: "allow-always" })).toBe(
      PHONE_ALWAYS_REFUSAL,
    );
    expect(phoneApprovalRefusal({ scopes: PHONE, decision: "allow-once" })).toBeNull();
    expect(phoneApprovalRefusal({ scopes: PHONE, decision: "deny", cls: "spend" })).toBeNull();
    expect(phoneApprovalRefusal({ scopes: PHONE, decision: "approve", cls: "command" })).toBeNull();
    expect(
      phoneApprovalRefusal({ scopes: ["operator.admin"], decision: "approve", cls: "spend" }),
    ).toBeNull();
  });
});

describe("phone conversations (PLAN-62)", () => {
  it("allows the main conversation and the phone's own, nothing from channels", () => {
    const me = "A1b2C3d4E5f6a7b8c9d0";
    const other = "ffffeeeeddddccccbbbb";
    expect(isPhoneSessionAllowed("default")).toBe(true);
    expect(isPhoneSessionAllowed("agent:main:main")).toBe(true);
    expect(isPhoneSessionAllowed("agent:main:mobile-a1b2c3d4e5f6-202611061200", me)).toBe(true);
    // Another phone's conversation, an untagged legacy key, or no device id: refused.
    expect(isPhoneSessionAllowed("agent:main:mobile-a1b2c3d4e5f6-202611061200", other)).toBe(false);
    expect(isPhoneSessionAllowed("agent:main:mobile-202611061200", me)).toBe(false);
    expect(isPhoneSessionAllowed("agent:main:mobile-a1b2c3d4e5f6-202611061200")).toBe(false);
    expect(isPhoneSessionAllowed("agent:main:whatsapp:dm:+15551234567")).toBe(false);
    expect(isPhoneSessionAllowed("agent:main:discord:channel:123")).toBe(false);
    expect(isPhoneSessionAllowed("agent:main:cron:nightly")).toBe(false);
    expect(isPhoneSessionAllowed("")).toBe(false);
  });

  it("refuses history of another conversation and filters lists and previews", () => {
    expect(guardPhoneRequest("chat.history", { sessionKey: "agent:main:telegram:dm:9" }).ok).toBe(
      false,
    );
    expect(guardPhoneRequest("chat.history", {}).ok).toBe(false);
    expect(guardPhoneRequest("chat.history", { sessionKey: "default" }).ok).toBe(true);
    const mine = "agent:main:mobile-a1b2c3d4e5f6-1";
    expect(guardPhoneRequest("chat.history", { sessionKey: mine }, "a1b2c3d4e5f6xx").ok).toBe(true);
    expect(guardPhoneRequest("chat.history", { sessionKey: mine }, "999999999999xx").ok).toBe(
      false,
    );
    const preview = guardPhoneRequest("sessions.preview", {
      keys: ["default", "agent:main:whatsapp:dm:1"],
    });
    expect(preview.ok && preview.params.keys).toEqual(["default"]);
    const list = guardPhoneRequest("sessions.list", {});
    if (!list.ok || !list.filterPayload) throw new Error("expected a filter");
    expect(
      list.filterPayload({
        path: "/home/me/.bitterbot/sessions.json",
        count: 2,
        sessions: [{ key: "agent:main:main" }, { key: "agent:main:whatsapp:dm:1" }],
      }),
    ).toEqual({ path: undefined, count: 1, sessions: [{ key: "agent:main:main" }] });
  });
});

describe("what a phone socket hears (PLAN-62)", () => {
  it("passes approvals and notices, drops presence, cron, health and the rest", () => {
    const notice = { kind: "cron-error", text: "x", ts: 1 };
    expect(phoneEventPayload("owner.notice", notice)).toBe(notice);
    expect(phoneEventPayload("review.requested", { id: "rv" })).toEqual({ id: "rv" });
    for (const event of [
      "presence",
      "cron",
      "monitor",
      "health",
      "usage",
      "circles",
      "update",
      "device.pair.requested",
    ]) {
      expect(phoneEventPayload(event, {}), event).toBe(DROP);
    }
  });

  it("passes chat only for the phone's conversations", () => {
    const mine = { runId: "r", sessionKey: "agent:main:main", state: "final" };
    expect(phoneEventPayload("chat", mine)).toBe(mine);
    expect(phoneEventPayload("chat", { runId: "r", sessionKey: "agent:main:whatsapp:dm:1" })).toBe(
      DROP,
    );
    const theirs = { runId: "r", sessionKey: "agent:main:mobile-a1b2c3d4e5f6-1" };
    expect(phoneEventPayload("chat", theirs, "a1b2c3d4e5f6zz")).toBe(theirs);
    expect(phoneEventPayload("chat", theirs, "0000000000000z")).toBe(DROP);
  });

  it("cuts tool events down to name and phase, no arguments or results", () => {
    const cut = phoneEventPayload("agent", {
      runId: "r",
      seq: 3,
      stream: "tool",
      ts: 9,
      sessionKey: "default",
      data: {
        phase: "start",
        name: "web_search",
        toolCallId: "t1",
        args: { query: "secret" },
        result: "x",
      },
    });
    expect(cut).toEqual({
      runId: "r",
      seq: 3,
      stream: "tool",
      ts: 9,
      sessionKey: "default",
      data: { phase: "start", name: "web_search", toolCallId: "t1" },
    });
    expect(JSON.stringify(cut)).not.toContain("secret");
    expect(
      phoneEventPayload("agent", { runId: "r", stream: "assistant", sessionKey: "default" }),
    ).toBe(DROP);
    expect(
      phoneEventPayload("agent", { runId: "r", stream: "tool", sessionKey: "agent:main:slack:x" }),
    ).toBe(DROP);
  });

  it("redacts the hello snapshot: no paths, no presence", () => {
    const redacted = redactSnapshotForPhone({
      presence: [{ host: "laptop", ip: "10.0.0.2" }],
      health: { channels: {} },
      stateVersion: { presence: 1, health: 2 },
      uptimeMs: 5,
      configPath: "/home/me/.bitterbot/bitterbot.json",
      stateDir: "/home/me/.bitterbot",
      sessionDefaults: {
        defaultAgentId: "main",
        mainKey: "main",
        mainSessionKey: "agent:main:main",
        scope: "per-sender",
      },
      authMode: "token",
    } as never);
    const text = JSON.stringify(redacted);
    expect(text).not.toContain("/home/me");
    expect(text).not.toContain("10.0.0.2");
    expect((redacted as { presence: unknown[] }).presence).toEqual([]);
  });
});

describe("broadcasts to a phone socket (PLAN-62)", () => {
  it("delivers the cut-down frame to phones and the full one to the desktop", async () => {
    const { createGatewayBroadcaster } = await import("../server-broadcast.js");
    const sent: Record<string, string[]> = { phone: [], desk: [] };
    const fake = (name: "phone" | "desk", scopes: string[]) =>
      ({
        connId: name,
        connect: { role: "operator", scopes },
        socket: { bufferedAmount: 0, send: (f: string) => sent[name].push(f), close: () => {} },
      }) as never;
    const clients = new Set([fake("phone", PHONE), fake("desk", ["operator.admin"])]);
    const { broadcast } = createGatewayBroadcaster({ clients });
    broadcast("presence", { presence: [{ ip: "10.0.0.2" }] });
    broadcast("agent", {
      runId: "r",
      stream: "tool",
      sessionKey: "default",
      data: { phase: "start", name: "exec", args: { command: "cat ~/.ssh/id_ed25519" } },
    });
    broadcast("chat", { runId: "r", sessionKey: "agent:main:whatsapp:dm:1", state: "final" });
    expect(sent.desk).toHaveLength(3);
    expect(sent.phone).toHaveLength(1);
    expect(sent.phone[0]).toContain('"name":"exec"');
    expect(sent.phone[0]).not.toContain("id_ed25519");
  });
});
