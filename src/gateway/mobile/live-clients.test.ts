import { afterEach, describe, expect, it } from "vitest";
import { disconnectDevice, setLiveGatewayClients } from "./live-clients.js";

function client(deviceId: string, role: string) {
  const closed: number[] = [];
  return {
    closed,
    c: {
      connId: `${deviceId}-${role}`,
      connect: { role, device: { id: deviceId } },
      socket: { close: (code: number) => closed.push(code) },
    } as never,
  };
}

afterEach(() => setLiveGatewayClients(null));

describe("disconnectDevice (PLAN-62)", () => {
  it("closes only the revoked role's sockets and tolerates padded ids", () => {
    const op = client("dev-1", "operator");
    const node = client("dev-1", "node");
    const other = client("dev-2", "operator");
    setLiveGatewayClients(new Set([op.c, node.c, other.c]));
    expect(disconnectDevice(" dev-1 ", "device token revoked", { role: "node" })).toBe(1);
    expect(node.closed).toEqual([4001]);
    expect(op.closed).toEqual([]);
    expect(disconnectDevice("dev-1", "device removed")).toBe(2);
    expect(other.closed).toEqual([]);
  });
});
