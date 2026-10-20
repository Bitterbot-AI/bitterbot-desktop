import type { WebSocket } from "ws";
import type { ConnectParams } from "../protocol/index.js";

export type GatewayWsClient = {
  socket: WebSocket;
  connect: ConnectParams;
  connId: string;
  presenceKey?: string;
  clientIp?: string;
  /** The setup token a setup-only connection presented (PLAN-56 Phase 4). */
  setupToken?: string;
};
