import { describe, expect, it } from "vitest";
import { authorizeGatewayMethod } from "../server-methods.js";
import { isMobileScopedConnection, MOBILE_DEVICE_SCOPES } from "./scopes.js";

function phone(scopes: readonly string[] = MOBILE_DEVICE_SCOPES) {
  return {
    connect: {
      role: "operator",
      scopes: [...scopes],
      client: { id: "bitterbot-mobile", version: "1", platform: "ios-web", mode: "ui" },
      minProtocol: 3,
      maxProtocol: 3,
    },
  } as never;
}

describe("phone scopes (PLAN-62)", () => {
  it.each([
    "chat.send",
    "chat.abort",
    "chat.history",
    "sessions.list",
    "talk.transcribe",
    "dream.status",
    "dream.emotional",
    "dream.journal",
    "agent.identity.get",
    "review.list",
    "review.resolve",
    "push.subscribe",
    "push.unsubscribe",
    "push.config",
    "push.test",
    "mobile.self.get",
    "mobile.self.rename",
    "mobile.self.unpair",
    "mobile.presence",
  ])("lets a phone call %s", (method) => {
    expect(authorizeGatewayMethod(method, phone())).toBeNull();
  });

  it.each([
    // admin: config, updates, skills, sessions admin
    "config.get",
    "config.apply",
    "update.run",
    "skills.install",
    "sessions.delete",
    "wallet.setConfig",
    // exec and remote control
    "exec.approvals.set",
    "node.invoke",
    "browser.request",
    "workspace.write",
    "cron.add",
    // pairing: a phone can never approve, rename or remove devices
    "device.pair.approve",
    "device.pair.list",
    "device.token.rotate",
    "device.remove",
    "device.rename",
    "mobile.pair.create",
    // broad reads stay off
    "health",
    "logs.tail",
    "memory.list",
    "wallet.getBalance",
  ])("refuses %s to a phone", (method) => {
    expect(authorizeGatewayMethod(method, phone())).not.toBeNull();
  });

  it("does not let the notifications scope alone chat", () => {
    expect(authorizeGatewayMethod("chat.send", phone(["operator.notifications"]))).not.toBeNull();
    expect(authorizeGatewayMethod("push.subscribe", phone(["operator.notifications"]))).toBeNull();
  });

  it("recognises phone-scoped connections, never admin ones", () => {
    expect(isMobileScopedConnection(MOBILE_DEVICE_SCOPES)).toBe(true);
    expect(isMobileScopedConnection(["operator.admin", "operator.chat"])).toBe(false);
    expect(isMobileScopedConnection(["operator.read"])).toBe(false);
    expect(isMobileScopedConnection(undefined)).toBe(false);
  });

  it("keeps the device scope list sorted, as device tokens store scopes", () => {
    expect([...MOBILE_DEVICE_SCOPES]).toEqual([...MOBILE_DEVICE_SCOPES].toSorted());
  });
});
