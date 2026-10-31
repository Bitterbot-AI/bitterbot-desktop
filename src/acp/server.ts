import { Readable, Writable } from "node:stream";
import { ndJsonStream } from "@agentclientprotocol/sdk";
import { loadConfig } from "../config/config.js";
import { resolveGatewayAuth } from "../gateway/auth.js";
import { buildGatewayConnectionDetails } from "../gateway/call.js";
import { GatewayClient } from "../gateway/client.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { AcpGatewayAgent, createAcpAgentApp } from "./translator.js";
import type { AcpServerOptions } from "./types.js";

export function serveAcpGateway(opts: AcpServerOptions = {}): Promise<void> {
  const cfg = loadConfig();
  const connection = buildGatewayConnectionDetails({
    config: cfg,
    url: opts.gatewayUrl,
  });

  const isRemoteMode = cfg.gateway?.mode === "remote";
  const remote = isRemoteMode ? cfg.gateway?.remote : undefined;
  const auth = resolveGatewayAuth({ authConfig: cfg.gateway?.auth, env: process.env });

  const token =
    opts.gatewayToken ??
    (isRemoteMode ? remote?.token?.trim() : undefined) ??
    process.env.BITTERBOT_GATEWAY_TOKEN ??
    auth.token;
  const password =
    opts.gatewayPassword ??
    (isRemoteMode ? remote?.password?.trim() : undefined) ??
    process.env.BITTERBOT_GATEWAY_PASSWORD ??
    auth.password;

  let agent: AcpGatewayAgent | null = null;
  let onClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    onClosed = resolve;
  });
  let stopped = false;
  // Resolves on the first successful gateway handshake so `initialize` can
  // hold the IDE briefly instead of failing its first prompt with
  // "gateway not connected" while the WebSocket is still coming up.
  let onGatewayReady!: () => void;
  const gatewayReady = new Promise<void>((resolve) => {
    onGatewayReady = resolve;
  });

  const gateway = new GatewayClient({
    url: connection.url,
    token: token || undefined,
    password: password || undefined,
    clientName: GATEWAY_CLIENT_NAMES.CLI,
    clientDisplayName: "ACP",
    clientVersion: "acp",
    mode: GATEWAY_CLIENT_MODES.CLI,
    onEvent: (evt) => {
      void agent?.handleGatewayEvent(evt);
    },
    onHelloOk: () => {
      onGatewayReady();
      agent?.handleGatewayReconnect();
    },
    onClose: (code, reason) => {
      agent?.handleGatewayDisconnect(`${code}: ${reason}`);
      // Resolve only on intentional shutdown (gateway.stop() sets closed
      // which skips scheduleReconnect, then fires onClose).  Transient
      // disconnects are followed by automatic reconnect attempts.
      if (stopped) {
        onClosed();
      }
    },
  });

  const shutdown = () => {
    if (stopped) {
      return;
    }
    stopped = true;
    gateway.stop();
    // If no WebSocket is active (e.g. between reconnect attempts),
    // gateway.stop() won't trigger onClose, so resolve directly.
    onClosed();
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  const input = Writable.toWeb(process.stdout);
  const output = Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>;
  const stream = ndJsonStream(input, output);

  agent = new AcpGatewayAgent(gateway, { ...opts, gatewayReady });
  const acpConnection = createAcpAgentApp(agent).connect(stream);
  agent.start();
  // When the IDE closes the stdio pipe, stop the bridge instead of lingering
  // on the gateway WebSocket with nobody to deliver to.
  void acpConnection.closed.then(shutdown);

  gateway.start();
  return closed;
}
