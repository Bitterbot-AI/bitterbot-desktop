/**
 * Orchestrator Bridge: spawns the Rust P2P orchestrator daemon as a child
 * process and communicates via Unix domain socket IPC (JSON-line protocol).
 */

import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import { createConnection, type Socket } from "node:net";
import { randomUUID } from "node:crypto";
import os from "node:os";
import { createInterface } from "node:readline";
import path from "node:path";
import type { P2pConfig } from "../config/types.p2p.js";
import { resolveBootstrapDns, mergeBootstrapPeers } from "./dns-bootstrap.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("p2p/orchestrator");

const DEFAULT_IPC_PATH = process.platform === "win32"
  ? "\\\\.\\pipe\\bitterbot-orchestrator"
  : "/tmp/bitterbot-orchestrator.sock";
const RECONNECT_DELAY_MS = 3000;
const MAX_RECONNECT_ATTEMPTS = 10;

type SkillReceivedEvent = {
  version: number;
  skill_md: string;      // base64
  name: string;
  author_peer_id: string;
  author_pubkey: string;  // base64
  signature: string;      // base64
  timestamp: number;
  content_hash: string;   // sha256 hex
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
};

export type OrchestratorHealth = {
  /** True once start() has been called and not yet stop()'d. */
  enabled: boolean;
  /** True if the child process is currently alive. */
  processRunning: boolean;
  /** True if the IPC socket is connected and usable. */
  ipcConnected: boolean;
  /** True if we've successfully connected to the orchestrator at least once. */
  everConnected: boolean;
  /** Resolved path of the binary that was spawned, if any. */
  binaryPath: string | null;
  /** Most recent unrecoverable error, if any. */
  lastError: string | null;
};

export class OrchestratorBridge {
  private process: ChildProcess | null = null;
  private socket: Socket | null = null;
  private ipcPath: string;
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private closed = false;
  private started = false;
  private everConnected = false;
  private lastError: string | null = null;
  private resolvedBinaryPath: string | null = null;
  private pending = new Map<string, PendingRequest>();
  private skillReceivedCallbacks: Array<(event: SkillReceivedEvent) => void> = [];
  private peerConnectedCallbacks: Array<(peerId: string, addrs: string[]) => void> = [];
  private peerDisconnectedCallbacks: Array<(peerId: string) => void> = [];
  private peerIdentifiedCallbacks: Array<(event: { peer_id: string; tier: string; verified: boolean; pubkey: string }) => void> = [];
  private weatherReceivedCallbacks: Array<(event: {
    global_cortisol_spike: number; duration_ms: number; reason: string;
    management_pubkey: string; timestamp: number;
  }) => void> = [];
  private bountyReceivedCallbacks: Array<(event: {
    bounty_id: string; target_type: string; description: string;
    priority: number; reward_multiplier: number; region_hint?: string;
    expires_at: number; management_pubkey: string; timestamp: number;
  }) => void> = [];
  private telemetryReceivedCallbacks: Array<(event: {
    signal_type: string; data: unknown;
    author_peer_id: string; timestamp: number;
  }) => void> = [];
  private queryReceivedCallbacks: Array<(event: {
    query_id: string; query: string; domain_hint?: string;
    author_peer_id: string; timestamp: number;
  }) => void> = [];
  /** Bootstrap peers after merging config + DNS discovery. */
  private resolvedBootstrapPeers: string[] | null = null;

  constructor(private readonly config: P2pConfig) {
    this.ipcPath = DEFAULT_IPC_PATH;
  }

  async start(): Promise<void> {
    if (!this.config.enabled) {
      log.debug("P2P orchestrator disabled");
      return;
    }

    this.started = true;

    // Resolve DNS bootstrap peers before starting the orchestrator
    if (this.config.bootstrapDns) {
      const dnsPeers = await resolveBootstrapDns(this.config.bootstrapDns);
      this.resolvedBootstrapPeers = mergeBootstrapPeers(
        this.config.bootstrapPeers,
        dnsPeers,
      );
    }

    let binary: string;
    try {
      binary = this.config.orchestratorBinary ?? this.resolveBinary();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.lastError = msg;
      log.error(msg);
      throw err;
    }
    this.resolvedBinaryPath = binary;
    const args = this.buildArgs();

    log.info(`Starting orchestrator: ${binary} ${args.join(" ")}`);

    const child = spawn(binary, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, RUST_LOG: "info" },
    });
    this.process = child;

    // Spawn errors (ENOENT, EACCES, etc.) arrive on 'error', not 'exit'.
    // Without this listener, Node treats it as an uncaughtException and can
    // crash the gateway. Suppress reconnect in this state — the binary is
    // fundamentally unreachable and retrying won't help.
    child.on("error", (err) => {
      const reason =
        (err as NodeJS.ErrnoException).code === "ENOENT"
          ? `Orchestrator binary could not be executed (ENOENT): ${binary}. ` +
            `Build it with: cargo build --release --manifest-path orchestrator/Cargo.toml`
          : `Orchestrator process error: ${err.message}`;
      this.lastError = reason;
      log.error(reason);
      this.process = null;
      // Do not scheduleReconnect — spawn errors are not recoverable without intervention.
    });

    child.stdout?.on("data", (data: Buffer) => {
      log.debug(`orchestrator stdout: ${data.toString().trim()}`);
    });

    child.stderr?.on("data", (data: Buffer) => {
      log.debug(`orchestrator stderr: ${data.toString().trim()}`);
    });

    child.on("exit", (code) => {
      log.warn(`Orchestrator exited with code ${code}`);
      this.process = null;
      // Only reconnect if we had a working IPC at some point. A process that
      // exits before ever connecting is almost always a config/binary problem,
      // and retrying just fills the log with "IPC not connected" noise.
      if (this.everConnected) {
        this.scheduleReconnect();
      }
    });

    // Wait briefly for the socket to become available, then connect
    await new Promise((resolve) => setTimeout(resolve, 1000));
    if (!this.process) {
      // 'error' fired during the wait — surface a clean rejection.
      throw new Error(this.lastError ?? "Orchestrator failed to start");
    }
    await this.connectIpc();
    this.everConnected = true;
  }

  /** Current health snapshot, safe to call from doctor / health endpoints. */
  getHealth(): OrchestratorHealth {
    return {
      enabled: this.started && !this.closed,
      processRunning: this.process !== null && !this.process.killed,
      ipcConnected: this.socket !== null && !this.socket.destroyed,
      everConnected: this.everConnected,
      binaryPath: this.resolvedBinaryPath,
      lastError: this.lastError,
    };
  }

  async stop(): Promise<void> {
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    for (const [id, req] of this.pending) {
      clearTimeout(req.timer);
      req.reject(new Error("bridge shutting down"));
    }
    this.pending.clear();
    this.socket?.destroy();
    this.socket = null;
    if (this.process) {
      try {
        // On Windows, SIGTERM doesn't reliably kill processes. Use SIGKILL.
        if (process.platform === "win32") {
          this.process.kill("SIGKILL");
        } else {
          this.process.kill("SIGTERM");
        }
      } catch {
        // Process may already be dead
      }
      this.process = null;
    }
  }

  async publishSkill(skillMdBase64: string, name: string): Promise<unknown> {
    return this.sendCommand("publish_skill", { skill_md: skillMdBase64, name });
  }

  async getPeers(): Promise<unknown> {
    return this.sendCommand("get_peers", {});
  }

  async getStats(): Promise<unknown> {
    return this.sendCommand("get_stats", {});
  }

  onSkillReceived(callback: (event: SkillReceivedEvent) => void): () => void {
    this.skillReceivedCallbacks.push(callback);
    return () => {
      this.skillReceivedCallbacks = this.skillReceivedCallbacks.filter((cb) => cb !== callback);
    };
  }

  onPeerConnected(callback: (peerId: string, addrs: string[]) => void): () => void {
    this.peerConnectedCallbacks.push(callback);
    return () => {
      this.peerConnectedCallbacks = this.peerConnectedCallbacks.filter((cb) => cb !== callback);
    };
  }

  onPeerDisconnected(callback: (peerId: string) => void): () => void {
    this.peerDisconnectedCallbacks.push(callback);
    return () => {
      this.peerDisconnectedCallbacks = this.peerDisconnectedCallbacks.filter(
        (cb) => cb !== callback,
      );
    };
  }

  onPeerIdentified(callback: (event: { peer_id: string; tier: string; verified: boolean; pubkey: string }) => void): () => void {
    this.peerIdentifiedCallbacks.push(callback);
    return () => { this.peerIdentifiedCallbacks = this.peerIdentifiedCallbacks.filter(cb => cb !== callback); };
  }

  onWeatherReceived(callback: (event: {
    global_cortisol_spike: number; duration_ms: number; reason: string;
    management_pubkey: string; timestamp: number;
  }) => void): () => void {
    this.weatherReceivedCallbacks.push(callback);
    return () => { this.weatherReceivedCallbacks = this.weatherReceivedCallbacks.filter(cb => cb !== callback); };
  }

  onBountyReceived(callback: (event: {
    bounty_id: string; target_type: string; description: string;
    priority: number; reward_multiplier: number; region_hint?: string;
    expires_at: number; management_pubkey: string; timestamp: number;
  }) => void): () => void {
    this.bountyReceivedCallbacks.push(callback);
    return () => { this.bountyReceivedCallbacks = this.bountyReceivedCallbacks.filter(cb => cb !== callback); };
  }

  async signAsManagement(skillMdBase64: string, name: string): Promise<unknown> {
    return this.sendCommand("sign_as_management", { skill_md: skillMdBase64, name });
  }

  async publishWeather(cortisolSpike: number, durationMs: number, reason: string): Promise<unknown> {
    return this.sendCommand("publish_weather", { global_cortisol_spike: cortisolSpike, duration_ms: durationMs, reason });
  }

  async publishBounty(bounty: {
    bounty_id: string; target_type: string; description: string;
    priority: number; reward_multiplier: number; expires_at: number; region_hint?: string;
  }): Promise<unknown> {
    return this.sendCommand("publish_bounty", bounty);
  }

  async publishTelemetry(signalType: string, data: unknown): Promise<unknown> {
    return this.sendCommand("publish_telemetry", { signal_type: signalType, data });
  }

  async publishQuery(queryId: string, query: string, domainHint?: string): Promise<unknown> {
    return this.sendCommand("publish_query", { query_id: queryId, query, domain_hint: domainHint });
  }

  onTelemetryReceived(callback: (event: {
    signal_type: string; data: unknown;
    author_peer_id: string; timestamp: number;
  }) => void): () => void {
    this.telemetryReceivedCallbacks.push(callback);
    return () => { this.telemetryReceivedCallbacks = this.telemetryReceivedCallbacks.filter(cb => cb !== callback); };
  }

  onQueryReceived(callback: (event: {
    query_id: string; query: string; domain_hint?: string;
    author_peer_id: string; timestamp: number;
  }) => void): () => void {
    this.queryReceivedCallbacks.push(callback);
    return () => { this.queryReceivedCallbacks = this.queryReceivedCallbacks.filter(cb => cb !== callback); };
  }

  private async connectIpc(): Promise<void> {
    // Clean up any existing socket before creating a new one
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.destroy();
      this.socket = null;
    }

    return new Promise((resolve, reject) => {
      // On Windows, the orchestrator listens on TCP 19002 (named pipe TODO).
      // On Unix, connects via Unix domain socket.
      const connectTarget = process.platform === "win32"
        ? { host: "127.0.0.1", port: 19002 }
        : { path: this.ipcPath };
      let settled = false;
      const socket = createConnection(connectTarget, () => {
        settled = true;
        log.info("Connected to orchestrator IPC");
        this.reconnectAttempts = 0;
        resolve();
      });

      this.socket = socket;

      socket.on("error", (err) => {
        log.warn(`IPC connection error: ${err.message}`);
        if (!settled) {
          settled = true;
          reject(err);
        }
        // Don't let connection errors crash the process — they're expected
        // when the orchestrator isn't running or is still starting up
        this.scheduleReconnect();
      });

      socket.on("close", () => {
        if (!this.closed) {
          this.scheduleReconnect();
        }
      });

      // Read JSON-line responses
      const rl = createInterface({ input: socket });
      rl.on("line", (line) => {
        this.handleMessage(line);
      });
    });
  }

  private handleMessage(line: string): void {
    try {
      const msg = JSON.parse(line) as {
        type: string;
        id?: string;
        payload?: unknown;
      };

      if (msg.type === "response" && msg.id) {
        const pending = this.pending.get(msg.id);
        if (pending) {
          clearTimeout(pending.timer);
          this.pending.delete(msg.id);
          pending.resolve(msg.payload);
        }
        return;
      }

      if (msg.type === "skill_received") {
        const event = msg.payload as SkillReceivedEvent;
        for (const cb of this.skillReceivedCallbacks) {
          try {
            cb(event);
          } catch (err) {
            log.warn(`skill_received callback error: ${String(err)}`);
          }
        }
        return;
      }

      if (msg.type === "peer_connected") {
        const payload = msg.payload as { peer_id: string; addrs: string[] };
        for (const cb of this.peerConnectedCallbacks) {
          try {
            cb(payload.peer_id, payload.addrs);
          } catch (err) {
            log.warn(`peer_connected callback error: ${String(err)}`);
          }
        }
        return;
      }

      if (msg.type === "peer_disconnected") {
        const payload = msg.payload as { peer_id: string };
        for (const cb of this.peerDisconnectedCallbacks) {
          try {
            cb(payload.peer_id);
          } catch (err) {
            log.warn(`peer_disconnected callback error: ${String(err)}`);
          }
        }
        return;
      }

      if (msg.type === "peer_identified") {
        const payload = msg.payload as { peer_id: string; tier: string; verified: boolean; pubkey: string };
        for (const cb of this.peerIdentifiedCallbacks) {
          try { cb(payload); } catch (err) { log.warn(`peer_identified callback error: ${String(err)}`); }
        }
        return;
      }

      if (msg.type === "weather_received") {
        const payload = msg.payload as {
          global_cortisol_spike: number; duration_ms: number; reason: string;
          management_pubkey: string; timestamp: number;
        };
        for (const cb of this.weatherReceivedCallbacks) {
          try { cb(payload); } catch (err) { log.warn(`weather_received callback error: ${String(err)}`); }
        }
        return;
      }

      if (msg.type === "bounty_received") {
        const payload = msg.payload as {
          bounty_id: string; target_type: string; description: string;
          priority: number; reward_multiplier: number; region_hint?: string;
          expires_at: number; management_pubkey: string; timestamp: number;
        };
        for (const cb of this.bountyReceivedCallbacks) {
          try { cb(payload); } catch (err) { log.warn(`bounty_received callback error: ${String(err)}`); }
        }
        return;
      }

      if (msg.type === "telemetry_received") {
        const payload = msg.payload as {
          signal_type: string; data: unknown;
          author_peer_id: string; timestamp: number;
        };
        for (const cb of this.telemetryReceivedCallbacks) {
          try { cb(payload); } catch (err) { log.warn(`telemetry_received callback error: ${String(err)}`); }
        }
        return;
      }

      if (msg.type === "query_received") {
        const payload = msg.payload as {
          query_id: string; query: string; domain_hint?: string;
          author_peer_id: string; timestamp: number;
        };
        for (const cb of this.queryReceivedCallbacks) {
          try { cb(payload); } catch (err) { log.warn(`query_received callback error: ${String(err)}`); }
        }
        return;
      }

      // Relay / NAT traversal events (log only for now)
      if (msg.type === "relay_reservation_accepted") {
        const p = msg.payload as { relay_peer_id: string; renewal: boolean };
        log.info(`Relay reservation accepted by ${p.relay_peer_id} (renewal: ${p.renewal})`);
        return;
      }
      if (msg.type === "relay_reservation_failed") {
        const p = msg.payload as { relay_peer_id: string; error: string };
        log.warn(`Relay reservation failed with ${p.relay_peer_id}: ${p.error}`);
        return;
      }
      if (msg.type === "relay_circuit_established") {
        const p = msg.payload as { relay_peer_id?: string; src_peer_id?: string; direction: string };
        log.info(`Relay circuit established (${p.direction})`);
        return;
      }
      if (msg.type === "hole_punch_succeeded") {
        const p = msg.payload as { peer_id: string };
        log.info(`DCUtR hole-punch succeeded with ${p.peer_id}`);
        return;
      }
      if (msg.type === "hole_punch_failed") {
        const p = msg.payload as { peer_id: string; error: string };
        log.warn(`DCUtR hole-punch failed with ${p.peer_id}: ${p.error}`);
        return;
      }
      if (msg.type === "relay_server_reservation") {
        const p = msg.payload as { peer_id: string; renewed: boolean };
        log.info(`Relay server: reservation from ${p.peer_id} (renewed: ${p.renewed})`);
        return;
      }
      if (msg.type === "nat_status_changed") {
        const p = msg.payload as { status: string; previous: string };
        log.info(`NAT status changed: ${p.previous} → ${p.status}`);
        return;
      }
    } catch (err) {
      log.warn(`Failed to parse IPC message: ${String(err)}`);
    }
  }

  private sendCommand(type: string, payload: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.socket || this.socket.destroyed) {
        reject(new Error("IPC not connected"));
        return;
      }

      const id = randomUUID();
      const msg = JSON.stringify({ type, id, payload }) + "\n";

      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`IPC command ${type} timed out`));
      }, 10_000);

      this.pending.set(id, { resolve, reject, timer });
      this.socket.write(msg);
    });
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) {
      return;
    }
    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      log.error("Max reconnect attempts reached for orchestrator IPC");
      return;
    }
    this.reconnectAttempts++;
    const delay = RECONNECT_DELAY_MS * this.reconnectAttempts;
    log.debug(`Reconnecting to orchestrator in ${delay}ms (attempt ${this.reconnectAttempts})`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connectIpc().catch((err) => {
        log.warn(`IPC reconnect failed: ${String(err)}`);
      });
    }, delay);
  }

  private resolveBinary(): string {
    // Priority order:
    //   1. Explicit config override (operator knows best)
    //   2. Local cargo RELEASE build — dev iteration on Rust code must
    //      never be shadowed by a stale prebuilt
    //   3. Local cargo DEBUG build, with a warning
    //   4. Prebuilt downloaded to ~/.bitterbot/bin/ via postinstall
    // Only throws if none of the above exist; the thrown error is the
    // operator-facing remediation guide.
    if (this.config.orchestratorBinary) {
      // Honor explicit config. Spawn will surface ENOENT via the 'error'
      // listener if the operator-provided path is wrong.
      return this.config.orchestratorBinary;
    }
    const isWindows = process.platform === "win32";
    const exeName = isWindows ? "bitterbot-orchestrator.exe" : "bitterbot-orchestrator";
    const cargoBase = path.resolve(process.cwd(), "orchestrator", "target");
    const release = path.join(cargoBase, "release", exeName);
    const debug = path.join(cargoBase, "debug", exeName);
    const prebuilt = path.join(os.homedir(), ".bitterbot", "bin", exeName);
    try {
      fs.accessSync(release);
      return release;
    } catch {}
    try {
      fs.accessSync(debug);
      log.warn(
        `Using debug orchestrator build at ${debug}. ` +
          `Run \`cargo build --release --manifest-path orchestrator/Cargo.toml\` for production.`,
      );
      return debug;
    } catch {}
    try {
      fs.accessSync(prebuilt);
      return prebuilt;
    } catch {}
    throw new Error(
      `Orchestrator binary not found. Looked in:\n` +
        `  ${release}\n` +
        `  ${debug}\n` +
        `  ${prebuilt}\n` +
        `Build it locally:     cargo build --release --manifest-path orchestrator/Cargo.toml\n` +
        `Or download prebuilt: reinstall with \`pnpm install\` to run the postinstall fetcher.\n` +
        `Or override via config: set p2p.orchestratorBinary to an explicit binary path.`,
    );
  }

  private buildArgs(): string[] {
    const args: string[] = [];
    args.push("--ipc-path", this.ipcPath);
    if (this.config.keyDir) {
      args.push("--key-dir", this.config.keyDir);
    }
    for (const addr of this.config.listenAddrs ?? []) {
      args.push("--listen-addr", addr);
    }
    const peers = this.resolvedBootstrapPeers ?? this.config.bootstrapPeers ?? [];
    for (const peer of peers) {
      args.push("--bootstrap", peer);
    }
    if (this.config.httpAddr) {
      args.push("--http-addr", this.config.httpAddr);
    }
    if (this.config.httpAuthToken) {
      args.push("--http-auth-token", this.config.httpAuthToken);
    }
    // Relay mode and servers for NAT traversal
    if (this.config.relayMode) {
      args.push("--relay-mode", this.config.relayMode);
    }
    for (const relay of this.config.relayServers ?? []) {
      args.push("--relay-servers", relay);
    }
    // Management tier auth is handled in TypeScript (ManagementKeyAuth).
    // The Rust orchestrator runs as edge — it doesn't verify management pubkeys.
    // Do NOT pass --node-tier or --genesis-trust-list to the Rust binary as it
    // will reject startup if the orchestrator's own libp2p pubkey isn't in the
    // trust list (which contains the TypeScript management key, not the libp2p key).
    return args;
  }
}
