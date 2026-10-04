import { describe, expect, it, vi } from "vitest";
import { createGatewayBroadcaster } from "./server-broadcast.js";
import type { GatewayWsClient } from "./server/ws-types.js";

/**
 * Live view frames show the agent's browser, logged-in pages included. They are
 * targeted at lease holders, and the event scope guard is the second lock: a
 * connection without write scope must not receive one even if it is targeted.
 */

function client(connId: string, scopes: string[], role = "operator") {
  const send = vi.fn();
  const ws = {
    socket: { bufferedAmount: 0, send, close: vi.fn() } as unknown as GatewayWsClient["socket"],
    connect: { role, scopes } as GatewayWsClient["connect"],
    connId,
  } as GatewayWsClient;
  return { ws, send };
}

describe("live view event scope", () => {
  it.each(["browser.frame", "browser.live"])("%s needs operator.write or admin", (event) => {
    const reader = client("c-read", ["operator.read"]);
    const writer = client("c-write", ["operator.write"]);
    const admin = client("c-admin", ["operator.admin"]);
    const node = client("c-node", ["operator.write"], "node");
    const { broadcastToConnIds } = createGatewayBroadcaster({
      clients: new Set([reader.ws, writer.ws, admin.ws, node.ws]),
    });

    broadcastToConnIds(event, { seq: 1 }, new Set(["c-read", "c-write", "c-admin", "c-node"]));

    expect(writer.send).toHaveBeenCalledTimes(1);
    expect(admin.send).toHaveBeenCalledTimes(1);
    expect(reader.send).not.toHaveBeenCalled();
    expect(node.send).not.toHaveBeenCalled();
  });

  it("goes only to the targeted connection", () => {
    const viewer = client("c-viewer", ["operator.admin"]);
    const other = client("c-other", ["operator.admin"]);
    const { broadcastToConnIds } = createGatewayBroadcaster({
      clients: new Set([viewer.ws, other.ws]),
    });

    broadcastToConnIds("browser.frame", { seq: 1 }, new Set(["c-viewer"]), { dropIfSlow: true });

    expect(viewer.send).toHaveBeenCalledTimes(1);
    expect(other.send).not.toHaveBeenCalled();
  });
});

describe("review event scope", () => {
  it.each(["review.requested", "review.resolved"])(
    "%s needs operator.approvals or admin",
    (event) => {
      const reader = client("c-read", ["operator.read", "operator.write"]);
      const approver = client("c-approvals", ["operator.approvals"]);
      const admin = client("c-admin", ["operator.admin"]);
      const { broadcast } = createGatewayBroadcaster({
        clients: new Set([reader.ws, approver.ws, admin.ws]),
      });

      broadcast(event, { id: "rv-00000001" });

      expect(approver.send).toHaveBeenCalledTimes(1);
      expect(admin.send).toHaveBeenCalledTimes(1);
      expect(reader.send).not.toHaveBeenCalled();
    },
  );
});
