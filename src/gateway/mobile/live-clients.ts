/**
 * PLAN-62: the gateway's live WebSocket clients, for the two places outside
 * the connection handler that need them: closing every socket of a device the
 * owner just removed, and asking whether a phone has the app open right now
 * (so push stays quiet while the owner is already looking).
 */

import type { GatewayWsClient } from "../server/ws-types.js";

let liveClients: ReadonlySet<GatewayWsClient> | null = null;

/** The gateway installs its client set once the WS server exists. */
export function setLiveGatewayClients(clients: ReadonlySet<GatewayWsClient> | null) {
  liveClients = clients;
}

export function deviceIdOf(client: GatewayWsClient | null | undefined): string | null {
  const id = client?.connect?.device?.id;
  return typeof id === "string" && id ? id : null;
}

/**
 * Close every open connection that authenticated as this device. Returns how
 * many were closed. 4001 tells the client not to retry with the same token.
 */
export function disconnectDevice(deviceId: string, reason = "device removed"): number {
  if (!liveClients) {
    return 0;
  }
  let closed = 0;
  for (const client of liveClients) {
    if (deviceIdOf(client) !== deviceId) {
      continue;
    }
    try {
      client.socket.close(4001, reason);
    } catch {
      // already closing
    }
    closed += 1;
  }
  return closed;
}

/** True when the device has a connection whose page last reported itself visible. */
export function isDeviceForeground(deviceId: string): boolean {
  if (!liveClients) {
    return false;
  }
  for (const client of liveClients) {
    if (deviceIdOf(client) === deviceId && client.mobileVisible === true) {
      return true;
    }
  }
  return false;
}
