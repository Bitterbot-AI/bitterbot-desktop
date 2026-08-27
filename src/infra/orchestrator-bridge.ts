/**
 * Orchestrator Bridge: spawns the Rust P2P orchestrator daemon as a child
 * process and communicates via Unix domain socket IPC (JSON-line protocol).
 */

import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { createInterface } from "node:readline";
import type { P2pConfig } from "../config/types.p2p.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveBootstrapDns, mergeBootstrapPeers } from "./dns-bootstrap.js";
import { formatBinaryNotFoundMessage, probeOrchestratorBinary } from "./orchestrator-binary.js";
import {
  assertManagementKeyPresent,
  migrateLegacyP2pKeys,
  resolveP2pKeyDir,
} from "./p2p-key-dir.js";

const log = createSubsystemLogger("p2p/orchestrator");

const DEFAULT_IPC_PATH =
  process.platform === "win32"
    ? "\\\\.\\pipe\\bitterbot-orchestrator"
    : "/tmp/bitterbot-orchestrator.sock";
const RECONNECT_DELAY_MS = 3000;
/**
 * Budget for the freshly spawned orchestrator to bind its IPC socket before the
 * gateway boots on without it. Cold boots (first start after an OS restart)
 * routinely need several seconds; the old fixed 1s sleep + single attempt made
 * one ECONNREFUSED fatal to the whole gateway (2026-08-26 post-reboot crash).
 */
const INITIAL_CONNECT_BUDGET_MS = 20_000;
const INITIAL_CONNECT_RETRY_MS = 750;
const MAX_RECONNECT_ATTEMPTS = 10;
/** Default IPC command timeout for background/non-interactive commands. */
const DEFAULT_IPC_TIMEOUT_MS = 10_000;
/**
 * Circle topic verbs (subscribe/unsubscribe/publish_topic) answer immediately
 * on a 0.2.0+ daemon — and on a pre-0.2.0 daemon they are unknown verbs that
 * NEVER answer (older builds dropped unknown messages without a response).
 * Keep their wait short so version skew costs ~2s once; the circle-topic
 * transport latches the mesh bus off on that failure instead of retrying.
 */
const TOPIC_VERB_TIMEOUT_MS = 2_000;
/** Tighter timeout for get_stats: it backs the UI-polled skills.network RPC. */
const STATS_IPC_TIMEOUT_MS = 2_500;

/** Bootnode census snapshot, mirrored from /api/bootstrap/census on the
 * publisher. Sent over gossipsub on `bitterbot/census/v1` and forwarded
 * to TS-side subscribers via `onCensusReceived`. */
export type CensusSnapshot = {
  enabled: boolean;
  lifetime_unique_peers: number;
  active_last_24h: number;
  active_last_7d: number;
  by_tier: Record<string, number>;
  by_address_type: Record<string, number>;
  generated_at: number;
};

/**
 * PLAN-14 Pillar 4: result envelope for computer-use IPC calls.
 * `ok: true` carries side-channel fields (png_base64, width, etc.);
 * `ok: false` carries `error` only. Build the orchestrator with
 * `--features=computer-use` and set BITTERBOT_COMPUTER_USE=1 to
 * receive ok=true responses.
 */
export type ComputerUseResult = {
  ok: boolean;
  error?: string;
  png_base64?: string;
  width?: number;
  height?: number;
  monitor_index?: number;
  x?: number;
  y?: number;
  button?: string;
  typed?: number;
  key?: string;
  [key: string]: unknown;
};

type SkillReceivedEvent = {
  version: number;
  skill_md: string; // base64
  name: string;
  author_peer_id: string;
  author_pubkey: string; // base64
  signature: string; // base64
  timestamp: number;
  content_hash: string; // sha256 hex
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

/**
 * Module-scoped accessor so agent tools can reach the active bridge
 * without needing it threaded through every factory. The gateway
 * registers the live bridge on startup; tools that need P2P or
 * computer-use IPC look it up here.
 */
let activeBridge: OrchestratorBridge | null = null;

export function setActiveOrchestratorBridge(bridge: OrchestratorBridge | null): void {
  activeBridge = bridge;
}

export function getActiveOrchestratorBridge(): OrchestratorBridge | null {
  return activeBridge;
}

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
  private peerIdentifiedCallbacks: Array<
    (event: { peer_id: string; tier: string; verified: boolean; pubkey: string }) => void
  > = [];
  private censusReceivedCallbacks: Array<
    (event: { source_peer_id: string; snapshot: CensusSnapshot }) => void
  > = [];
  private weatherReceivedCallbacks: Array<
    (event: {
      global_cortisol_spike: number;
      duration_ms: number;
      reason: string;
      management_pubkey: string;
      timestamp: number;
    }) => void
  > = [];
  private bountyReceivedCallbacks: Array<
    (event: {
      bounty_id: string;
      target_type: string;
      description: string;
      priority: number;
      reward_multiplier: number;
      region_hint?: string;
      expires_at: number;
      management_pubkey: string;
      timestamp: number;
    }) => void
  > = [];
  private telemetryReceivedCallbacks: Array<
    (event: {
      signal_type: string;
      data: unknown;
      author_peer_id: string;
      timestamp: number;
    }) => void
  > = [];
  private queryReceivedCallbacks: Array<
    (event: {
      query_id: string;
      query: string;
      domain_hint?: string;
      author_peer_id: string;
      timestamp: number;
    }) => void
  > = [];
  /** PLAN-36 Phase 4: inbound frames on subscribed per-circle gossip topics. */
  /** Stage 4: inbound circle-RPC requests awaiting a gateway answer. */
  private circleRequestCallbacks: Array<
    (event: { request_id: number; from_peer_id: string; data_b64: string }) => void
  > = [];
  /** Stage 4: outbound circle-RPC awaiting their circle_response event. */
  private circleResponseWaiters = new Map<
    string,
    { resolve: (dataB64: string) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }
  >();
  private topicMessageCallbacks: Array<
    (event: { topic: string; from_peer_id: string; data_b64: string }) => void
  > = [];
  /** Bootstrap peers after merging config + DNS discovery. */
  private resolvedBootstrapPeers: string[] | null = null;

  constructor(private readonly config: P2pConfig) {
    // Env override exists for tests and for running multiple nodes on one
    // machine without their orchestrators fighting over a single socket path.
    this.ipcPath = process.env.BITTERBOT_ORCHESTRATOR_IPC_PATH?.trim() || DEFAULT_IPC_PATH;
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
      this.resolvedBootstrapPeers = mergeBootstrapPeers(this.config.bootstrapPeers, dnsPeers);
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

    // PLAN-41 Phase 1 (p0-7): pin the identity to its stable home before
    // spawn. Migration failure must not brick an edge node (worst case the
    // orchestrator generates a fresh identity in the new dir, which is
    // exactly the pre-migration behavior for a fresh checkout) — but a
    // management node without its keypair must NOT boot.
    const keyDir = resolveP2pKeyDir(this.config.keyDir);
    try {
      migrateLegacyP2pKeys({ targetDir: keyDir });
    } catch (err) {
      log.warn(`P2P key-dir migration failed (continuing): ${String(err)}`);
    }
    assertManagementKeyPresent({ targetDir: keyDir, nodeTier: this.config.nodeTier });

    const args = this.buildArgs();

    // A stale socket file (a previous boot's, surviving an OS restart in /tmp
    // on some setups, or a crashed daemon's) makes the fresh child fail to bind
    // and exit, after which every connect is refused. Unlink it ONLY when
    // nothing answers on it — a live orchestrator owning the socket must be
    // left alone (the child will fail to bind against it and we connect to the
    // running one, which is today's takeover-free behavior).
    if (process.platform !== "win32") {
      await this.cleanStaleIpcSocket();
    }

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

    // Wait for the child to bind its IPC socket, retrying with a budget. The
    // old shape (fixed 1s sleep, single connect) made a slow cold boot fatal:
    // the lone ECONNREFUSED escaped as an uncaught exception and killed the
    // gateway (2026-08-26). IPC unavailability must degrade the P2P surface,
    // never the node: if the budget runs out with the child still alive, boot
    // on and let the standing reconnect loop attach when the socket appears.
    const deadline = Date.now() + INITIAL_CONNECT_BUDGET_MS;
    let attempts = 0;
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, INITIAL_CONNECT_RETRY_MS));
      if (!this.process) {
        // 'error'/'exit' fired — the binary is unusable or died before binding.
        throw new Error(this.lastError ?? "Orchestrator failed to start");
      }
      // connectIpc's error handler arms the shared reconnect timer on every
      // failure; while this loop owns the retrying, keep that timer clear so
      // two paths never dial the socket concurrently.
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
      attempts += 1;
      try {
        await this.connectIpc();
        this.everConnected = true;
        this.reconnectAttempts = 0;
        return;
      } catch (err) {
        if (Date.now() >= deadline) {
          this.lastError = `IPC not reachable after ${attempts} attempts: ${String(err)}`;
          log.warn(
            `Orchestrator IPC not up after ${Math.round(INITIAL_CONNECT_BUDGET_MS / 1000)}s — ` +
              "continuing without P2P; the reconnect loop will attach when the socket appears.",
          );
          // Hand off to the background loop with a fresh attempt budget (the
          // failed dials above each consumed one via connectIpc's handler).
          this.reconnectAttempts = 0;
          this.scheduleReconnect();
          return;
        }
      }
    }
  }

  /**
   * Remove the IPC socket file iff it is stale: present on disk but with
   * nothing accepting connections behind it. Best-effort — a probe error other
   * than "connection refused" leaves the file untouched.
   */
  private async cleanStaleIpcSocket(): Promise<void> {
    if (!existsSync(this.ipcPath)) {
      return;
    }
    const alive = await new Promise<boolean>((resolve) => {
      const probe = createConnection({ path: this.ipcPath });
      const done = (value: boolean) => {
        probe.removeAllListeners();
        probe.once("error", () => {}); // a late abort error must not go listener-less
        probe.destroy();
        resolve(value);
      };
      probe.setTimeout(500);
      probe.once("connect", () => done(true));
      probe.once("timeout", () => done(true)); // slow but alive: leave it alone
      // Alive ONLY on a successful connect. The refused-connection error code is
      // platform-dependent (Linux says ECONNREFUSED, macOS says ENOTSOCK for a
      // plain file at the path — which is how CI caught this), and an
      // allowlist here wrongly preserved the stale file on macOS. Any probe
      // error means nothing usable answers; the unlink below is best-effort,
      // so an EACCES-style case degrades to a logged warning, not a crash.
      probe.once("error", () => done(false));
    });
    if (alive) {
      return;
    }
    try {
      unlinkSync(this.ipcPath);
      log.warn(`Removed stale orchestrator IPC socket at ${this.ipcPath} (nothing listening)`);
    } catch (err) {
      log.warn(`Could not remove stale IPC socket ${this.ipcPath}: ${String(err)}`);
    }
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
    for (const [_id, req] of this.pending) {
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

  // PLAN-36 Phase 4: dynamic per-circle gossip topics. The orchestrator only
  // permits bitterbot/circle/*/v1 here; a circle rides its blinded topic so
  // messages reach members over the mesh without a public a2a URL.
  async subscribeCircleTopic(topic: string): Promise<unknown> {
    return this.sendCommand("subscribe_topic", { topic }, TOPIC_VERB_TIMEOUT_MS);
  }

  async unsubscribeCircleTopic(topic: string): Promise<unknown> {
    return this.sendCommand("unsubscribe_topic", { topic }, TOPIC_VERB_TIMEOUT_MS);
  }

  /** Publish opaque frame bytes (base64) to a circle topic. */
  async publishCircleTopic(topic: string, dataB64: string): Promise<unknown> {
    return this.sendCommand("publish_topic", { topic, data_b64: dataB64 }, TOPIC_VERB_TIMEOUT_MS);
  }

  async getPeers(): Promise<unknown> {
    return this.sendCommand("get_peers", {});
  }

  async getStats(): Promise<unknown> {
    // Short timeout: this feeds the interactive skills.network RPC that the
    // Control UI polls. A slow/stuck orchestrator must not stall the handler
    // (and starve the WS keepalive) for the full default IPC timeout.
    return this.sendCommand("get_stats", {}, STATS_IPC_TIMEOUT_MS);
  }

  /**
   * Management census snapshot. Returns null on edge nodes (which do not
   * produce a census) or when the orchestrator hasn't initialized
   * management state yet. Used by the periodic agent-awareness poller
   * and by management.census RPC consumers.
   */
  async getNetworkCensus(): Promise<{
    ok: boolean;
    total_peers_seen?: number;
    lifetime_unique_peer_ids?: number;
    peak_concurrent_peers?: number;
    peers_by_tier?: Record<string, number>;
    skills_published_network_wide?: number;
    telemetry_counts_by_type?: Record<string, number>;
    network_health_score?: number;
    last_census_at?: number;
    connected_peers?: number;
    peer_count_history?: Array<[number, number]>;
  } | null> {
    try {
      const result = (await this.sendCommand("get_network_census", {})) as {
        ok?: boolean;
      };
      if (!result || result.ok === false) return null;
      return result as Awaited<ReturnType<OrchestratorBridge["getNetworkCensus"]>>;
    } catch {
      return null;
    }
  }

  /** Active anomaly alerts (management-tier only). Empty list otherwise. */
  async getAnomalyAlerts(): Promise<unknown[]> {
    try {
      const result = (await this.sendCommand("get_anomaly_alerts", {})) as {
        ok?: boolean;
        alerts?: unknown[];
      };
      if (!result || result.ok === false) return [];
      return Array.isArray(result.alerts) ? result.alerts : [];
    } catch {
      return [];
    }
  }

  /**
   * Fetch the bootnode census via the orchestrator's HTTP API. Returns the
   * lifetime peer registry maintained when --bootnode-mode is enabled. On
   * non-bootnode deployments the response carries `enabled: false` and zero
   * counts. Best-effort: returns null if the HTTP API is unreachable.
   */
  async getBootstrapCensus(): Promise<{
    enabled: boolean;
    lifetime_unique_peers: number;
    active_last_24h: number;
    active_last_7d: number;
    by_tier: Record<string, number>;
    by_address_type: Record<string, number>;
    generated_at: number;
  } | null> {
    const httpAddr = this.config.httpAddr ?? "127.0.0.1:9847";
    const url = `http://${httpAddr}/api/bootstrap/census`;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2000);
      const resp = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);
      if (!resp.ok) {
        return null;
      }
      return (await resp.json()) as {
        enabled: boolean;
        lifetime_unique_peers: number;
        active_last_24h: number;
        active_last_7d: number;
        by_tier: Record<string, number>;
        by_address_type: Record<string, number>;
        generated_at: number;
      };
    } catch {
      return null;
    }
  }

  /**
   * Fetch the orchestrator's identity over IPC: the Ed25519 libp2p pubkey
   * (base64), the libp2p PeerId, and the configured node tier.
   *
   * The base64 pubkey is the canonical management-node identity — it is what
   * the genesis trust list contains and what management-action signatures
   * verify against. Cached after the first successful call since it never
   * changes for a running orchestrator.
   */
  private cachedIdentity: { pubkey: string; peerId: string; nodeTier: string } | null = null;

  async getIdentity(): Promise<{ pubkey: string; peerId: string; nodeTier: string }> {
    if (this.cachedIdentity) {
      return this.cachedIdentity;
    }
    const result = (await this.sendCommand("get_identity", {})) as
      | { pubkey?: string; peer_id?: string; node_tier?: string }
      | undefined;
    if (!result?.pubkey || !result.peer_id || typeof result.node_tier !== "string") {
      throw new Error(
        `Orchestrator returned malformed identity payload: ${JSON.stringify(result)}`,
      );
    }
    this.cachedIdentity = {
      pubkey: result.pubkey,
      peerId: result.peer_id,
      nodeTier: result.node_tier,
    };
    return this.cachedIdentity;
  }

  /** True if the IPC socket is connected and ready to accept commands. */
  isConnected(): boolean {
    return this.socket !== null && !this.socket.destroyed;
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

  onPeerIdentified(
    callback: (event: { peer_id: string; tier: string; verified: boolean; pubkey: string }) => void,
  ): () => void {
    this.peerIdentifiedCallbacks.push(callback);
    return () => {
      this.peerIdentifiedCallbacks = this.peerIdentifiedCallbacks.filter((cb) => cb !== callback);
    };
  }

  /**
   * Subscribe to bootnode census snapshots received over gossipsub
   * (`bitterbot/census/v1`). The bootnode publishes its lifetime registry
   * snapshot every ~60s when started with `--bootnode-mode`; subscribers
   * see real-time network-wide counts without polling.
   */
  onCensusReceived(
    callback: (event: { source_peer_id: string; snapshot: CensusSnapshot }) => void,
  ): () => void {
    this.censusReceivedCallbacks.push(callback);
    return () => {
      this.censusReceivedCallbacks = this.censusReceivedCallbacks.filter((cb) => cb !== callback);
    };
  }

  onWeatherReceived(
    callback: (event: {
      global_cortisol_spike: number;
      duration_ms: number;
      reason: string;
      management_pubkey: string;
      timestamp: number;
    }) => void,
  ): () => void {
    this.weatherReceivedCallbacks.push(callback);
    return () => {
      this.weatherReceivedCallbacks = this.weatherReceivedCallbacks.filter((cb) => cb !== callback);
    };
  }

  onBountyReceived(
    callback: (event: {
      bounty_id: string;
      target_type: string;
      description: string;
      priority: number;
      reward_multiplier: number;
      region_hint?: string;
      expires_at: number;
      /** v1: management pubkey. v2 (PLAN-29 Forage): the poster's pubkey. */
      management_pubkey: string;
      timestamp: number;
      // PLAN-29 Forage v2 fields; present when version === 2. The Rust side
      // has already checked structural funding + poster signature; economic
      // validation of funding_proof is this side's job before ingest.
      version?: number | null;
      poster_wallet_address?: string | null;
      kind?: string | null;
      category?: string | null;
      oracle_commitment?: string | null;
      reward_usdc?: number | null;
      funding_proof?: string | null;
      claim_stake_usdc?: number | null;
      deadline?: number | null;
      max_claims?: number | null;
    }) => void,
  ): () => void {
    this.bountyReceivedCallbacks.push(callback);
    return () => {
      this.bountyReceivedCallbacks = this.bountyReceivedCallbacks.filter((cb) => cb !== callback);
    };
  }

  async signAsManagement(skillMdBase64: string, name: string): Promise<unknown> {
    return this.sendCommand("sign_as_management", { skill_md: skillMdBase64, name });
  }

  async publishWeather(
    cortisolSpike: number,
    durationMs: number,
    reason: string,
  ): Promise<unknown> {
    return this.sendCommand("publish_weather", {
      global_cortisol_spike: cortisolSpike,
      duration_ms: durationMs,
      reason,
    });
  }

  async publishBounty(bounty: {
    bounty_id: string;
    target_type: string;
    description: string;
    priority: number;
    reward_multiplier: number;
    expires_at: number;
    region_hint?: string;
    // PLAN-29 Forage v2: set version: 2 to publish an any-node funded
    // bounty. The orchestrator refuses v2 payloads missing wallet, oracle
    // commitment, funding proof, or a positive reward; v1 payloads still
    // require a management-tier node.
    version?: number;
    poster_wallet_address?: string;
    kind?: "oneshot" | "heartbeat" | "pool" | "standing";
    category?: string;
    oracle_commitment?: string;
    reward_usdc?: number;
    funding_proof?: string;
    claim_stake_usdc?: number;
    deadline?: number;
    max_claims?: number;
  }): Promise<unknown> {
    return this.sendCommand("publish_bounty", bounty);
  }

  async publishTelemetry(signalType: string, data: unknown): Promise<unknown> {
    return this.sendCommand("publish_telemetry", { signal_type: signalType, data });
  }

  async publishQuery(queryId: string, query: string, domainHint?: string): Promise<unknown> {
    return this.sendCommand("publish_query", { query_id: queryId, query, domain_hint: domainHint });
  }

  // PLAN-14 Pillar 4: OS-level computer use via the orchestrator daemon.
  // Each method is a thin wrapper around the corresponding IPC command;
  // payloads are validated on the Rust side. Responses are normalized
  // to ComputerUseResult so callers can branch on `ok` without
  // inspecting the raw IPC shape.
  async computerScreenshot(monitorIndex?: number): Promise<ComputerUseResult> {
    return this.computerCall("computer_screenshot", { monitor_index: monitorIndex });
  }

  async computerScreenSize(monitorIndex?: number): Promise<ComputerUseResult> {
    return this.computerCall("computer_screen_size", { monitor_index: monitorIndex });
  }

  async computerMouseMove(x: number, y: number): Promise<ComputerUseResult> {
    return this.computerCall("computer_mouse_move", { x, y });
  }

  async computerMouseClick(
    button: "left" | "right" | "middle" = "left",
  ): Promise<ComputerUseResult> {
    return this.computerCall("computer_mouse_click", { button });
  }

  async computerType(text: string): Promise<ComputerUseResult> {
    return this.computerCall("computer_type", { text });
  }

  async computerKey(key: string): Promise<ComputerUseResult> {
    return this.computerCall("computer_key", { key });
  }

  private async computerCall(
    type: string,
    payload: Record<string, unknown>,
  ): Promise<ComputerUseResult> {
    const raw = (await this.sendCommand(type, payload)) as Record<string, unknown> | undefined;
    if (!raw || typeof raw !== "object") {
      return { ok: false, error: "no response from orchestrator" };
    }
    if (raw.ok === true) {
      return { ok: true, ...raw };
    }
    const message = typeof raw.error === "string" ? raw.error : "unknown computer-use error";
    return { ok: false, error: message };
  }

  onTelemetryReceived(
    callback: (event: {
      signal_type: string;
      data: unknown;
      author_peer_id: string;
      timestamp: number;
    }) => void,
  ): () => void {
    this.telemetryReceivedCallbacks.push(callback);
    return () => {
      this.telemetryReceivedCallbacks = this.telemetryReceivedCallbacks.filter(
        (cb) => cb !== callback,
      );
    };
  }

  onQueryReceived(
    callback: (event: {
      query_id: string;
      query: string;
      domain_hint?: string;
      author_peer_id: string;
      timestamp: number;
    }) => void,
  ): () => void {
    this.queryReceivedCallbacks.push(callback);
    return () => {
      this.queryReceivedCallbacks = this.queryReceivedCallbacks.filter((cb) => cb !== callback);
    };
  }

  /** PLAN-36 Phase 4: subscribe to inbound frames on per-circle gossip topics. */
  onCircleTopicMessage(
    callback: (event: { topic: string; from_peer_id: string; data_b64: string }) => void,
  ): () => void {
    this.topicMessageCallbacks.push(callback);
    return () => {
      this.topicMessageCallbacks = this.topicMessageCallbacks.filter((cb) => cb !== callback);
    };
  }

  /**
   * Stage 4: point-to-point circle RPC. Two-phase under the hood (the daemon
   * answers the enqueue immediately; the network outcome arrives as a
   * circle_response event) but presented as one promise. The enqueue uses the
   * short topic-verb timeout so a pre-0.2.2 daemon costs ~2s, not 10s — and
   * an explicit "unknown message type" answer rejects instantly.
   */
  async circleRequest(peerId: string, dataB64: string, timeoutMs = 15_000): Promise<string> {
    const enq = (await this.sendCommand(
      "circle_request",
      { peer_id: peerId, data_b64: dataB64 },
      TOPIC_VERB_TIMEOUT_MS,
    )) as { ok?: boolean; request_id?: string; error?: string };
    if (!enq?.ok || typeof enq.request_id !== "string") {
      throw new Error(`circle_request refused: ${enq?.error ?? "no request id"}`);
    }
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.circleResponseWaiters.delete(enq.request_id as string);
        reject(new Error("circle rpc timed out"));
      }, timeoutMs);
      this.circleResponseWaiters.set(enq.request_id as string, { resolve, reject, timer });
    });
  }

  /** Stage 4: answer an inbound circle-RPC request (see onCircleRequest). */
  async circleRespond(requestId: number, dataB64: string): Promise<void> {
    await this.sendCommand(
      "circle_respond",
      { request_id: requestId, data_b64: dataB64 },
      TOPIC_VERB_TIMEOUT_MS,
    );
  }

  /** Stage 4: subscribe to inbound circle-RPC requests from peers. */
  onCircleRequest(
    callback: (event: { request_id: number; from_peer_id: string; data_b64: string }) => void,
  ): () => void {
    this.circleRequestCallbacks.push(callback);
    return () => {
      this.circleRequestCallbacks = this.circleRequestCallbacks.filter((cb) => cb !== callback);
    };
  }

  private async connectIpc(): Promise<void> {
    // Clean up any existing socket before creating a new one. Keep a swallow
    // error listener on it: if its connect is still in flight, the abort (or a
    // late ECONNREFUSED/ENOENT) emits AFTER removeAllListeners, and an 'error'
    // with no listener is an uncaughtException — which is exactly how one
    // refused dial killed the whole gateway on 2026-08-26.
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.on("error", () => {});
      this.socket.destroy();
      this.socket = null;
    }

    return new Promise((resolve, reject) => {
      // On Windows, the orchestrator listens on TCP 19002 (named pipe TODO).
      // On Unix, connects via Unix domain socket.
      const connectTarget =
        process.platform === "win32" ? { host: "127.0.0.1", port: 19002 } : { path: this.ipcPath };
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
      // Readline RE-EMITS the input stream's 'error' on the Interface, and an
      // 'error' event with no listener is an uncaughtException. This is the
      // 2026-08-26 crash: the socket's own handler logged the ECONNREFUSED,
      // then readline's re-emission of the same error killed the gateway.
      rl.on("error", () => {
        // Already logged and recovered by the socket's 'error' handler above.
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
        const payload = msg.payload as {
          peer_id: string;
          tier: string;
          verified: boolean;
          pubkey: string;
        };
        for (const cb of this.peerIdentifiedCallbacks) {
          try {
            cb(payload);
          } catch (err) {
            log.warn(`peer_identified callback error: ${String(err)}`);
          }
        }
        return;
      }

      if (msg.type === "census_received") {
        const payload = msg.payload as {
          source_peer_id: string;
          snapshot: CensusSnapshot;
        };
        for (const cb of this.censusReceivedCallbacks) {
          try {
            cb(payload);
          } catch (err) {
            log.warn(`census_received callback error: ${String(err)}`);
          }
        }
        return;
      }

      if (msg.type === "weather_received") {
        const payload = msg.payload as {
          global_cortisol_spike: number;
          duration_ms: number;
          reason: string;
          management_pubkey: string;
          timestamp: number;
        };
        for (const cb of this.weatherReceivedCallbacks) {
          try {
            cb(payload);
          } catch (err) {
            log.warn(`weather_received callback error: ${String(err)}`);
          }
        }
        return;
      }

      if (msg.type === "bounty_received") {
        const payload = msg.payload as {
          bounty_id: string;
          target_type: string;
          description: string;
          priority: number;
          reward_multiplier: number;
          region_hint?: string;
          expires_at: number;
          management_pubkey: string;
          timestamp: number;
        };
        for (const cb of this.bountyReceivedCallbacks) {
          try {
            cb(payload);
          } catch (err) {
            log.warn(`bounty_received callback error: ${String(err)}`);
          }
        }
        return;
      }

      if (msg.type === "telemetry_received") {
        const payload = msg.payload as {
          signal_type: string;
          data: unknown;
          author_peer_id: string;
          timestamp: number;
        };
        for (const cb of this.telemetryReceivedCallbacks) {
          try {
            cb(payload);
          } catch (err) {
            log.warn(`telemetry_received callback error: ${String(err)}`);
          }
        }
        return;
      }

      if (msg.type === "query_received") {
        const payload = msg.payload as {
          query_id: string;
          query: string;
          domain_hint?: string;
          author_peer_id: string;
          timestamp: number;
        };
        for (const cb of this.queryReceivedCallbacks) {
          try {
            cb(payload);
          } catch (err) {
            log.warn(`query_received callback error: ${String(err)}`);
          }
        }
        return;
      }

      if (msg.type === "circle_request") {
        const payload = msg.payload as {
          request_id: number;
          from_peer_id: string;
          data_b64: string;
        };
        for (const cb of this.circleRequestCallbacks) {
          try {
            cb(payload);
          } catch (err) {
            log.warn(`circle_request callback error: ${String(err)}`);
          }
        }
        return;
      }

      if (msg.type === "circle_response") {
        const payload = msg.payload as {
          request_id: string;
          ok: boolean;
          data_b64?: string;
          error?: string;
        };
        const waiter = this.circleResponseWaiters.get(payload.request_id);
        if (waiter) {
          this.circleResponseWaiters.delete(payload.request_id);
          clearTimeout(waiter.timer);
          if (payload.ok && typeof payload.data_b64 === "string") {
            waiter.resolve(payload.data_b64);
          } else {
            waiter.reject(new Error(payload.error ?? "circle rpc failed"));
          }
        }
        return;
      }

      if (msg.type === "topic_message") {
        const payload = msg.payload as { topic: string; from_peer_id: string; data_b64: string };
        for (const cb of this.topicMessageCallbacks) {
          try {
            cb(payload);
          } catch (err) {
            log.warn(`topic_message callback error: ${String(err)}`);
          }
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
        const p = msg.payload as {
          relay_peer_id?: string;
          src_peer_id?: string;
          direction: string;
        };
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

  private sendCommand(
    type: string,
    payload: unknown,
    timeoutMs: number = DEFAULT_IPC_TIMEOUT_MS,
  ): Promise<unknown> {
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
      }, timeoutMs);

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
    // Delegates to the shared probe so doctor and wizard see the same
    // priority order. Preserves the throw-on-missing contract this
    // bridge has always had.
    const probe = probeOrchestratorBinary(this.config);
    if (probe.found) {
      if (probe.source === "debug") {
        log.warn(
          `Using debug orchestrator build at ${probe.path}. ` +
            `Run \`cargo build --release --manifest-path orchestrator/Cargo.toml\` for production.`,
        );
      }
      return probe.path;
    }
    throw new Error(formatBinaryNotFoundMessage(probe.candidates));
  }

  private buildArgs(): string[] {
    const args: string[] = [];
    args.push("--ipc-path", this.ipcPath);
    // Always passed (PLAN-41 p0-7): without it the Rust side falls back to
    // `./keys` relative to ITS cwd, which scatters identities across
    // checkouts and service working directories.
    args.push("--key-dir", resolveP2pKeyDir(this.config.keyDir));
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
    // Management tier: the orchestrator's libp2p Ed25519 keypair IS the
    // management identity. When configured as management, pass the tier and
    // trust list so the Rust side activates census, anomaly detection, and
    // signing — and self-verifies that its pubkey is in the trust list at
    // startup. The TypeScript ManagementKeyAuth reads the same pubkey via
    // IPC (getIdentity) so both sides agree on identity.
    if (this.config.nodeTier === "management") {
      args.push("--node-tier", "management");
      const trustListPath = this.config.genesisTrustListPath;
      if (trustListPath) {
        args.push("--genesis-trust-list", trustListPath);
      }
    }
    return args;
  }
}
