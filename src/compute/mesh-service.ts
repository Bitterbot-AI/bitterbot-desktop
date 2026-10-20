import { randomBytes, randomUUID } from "node:crypto";
import type { SoapboxJob, SoapboxStatus } from "../infra/soapbox-client.js";
import { SoapboxClient } from "../infra/soapbox-client.js";
import {
  COMPUTE_TOPIC,
  DESCRIPTOR_TTL_MS,
  decodeMesh,
  encodeMesh,
  parseDescriptor,
  type MeshBridge,
  type ComputeDescriptor,
} from "./mesh-protocol.js";
import { ComputeMeshStore, type MeshBatch, type MeshGrant } from "./mesh-store.js";
import type { ComputeMeshSnapshot } from "./mesh-types.js";
import { advanceBatch, validateBatch, type BatchRequest } from "./mesh-work.js";

export type MeshBackend = { admin: SoapboxClient; client(token: string): SoapboxClient };
export const COMPUTE_METHODS = new Set([
  "compute/v1/access",
  "compute/v1/submit",
  "compute/v1/job",
  "compute/v1/cancel",
]);
type RpcReply = { ok: boolean; result?: unknown; error?: string };
export class ComputeMeshService {
  private timer?: ReturnType<typeof setInterval>;
  private unsub?: () => void;
  private stopping = false;
  private cycle?: Promise<void>;
  private lastAdvertised = 0;
  private identity?: { peerId: string; pubkey: string };
  private local?: SoapboxStatus;
  private ready = false;
  private lastError: string | null = null;
  private incoming = 0;
  private rates = new Map<string, { at: number; count: number; active: number }>();
  private mutations: Promise<unknown> = Promise.resolve();
  private requests = new Set<Promise<RpcReply>>();
  private batchCursor = 0;
  constructor(
    readonly bridge: MeshBridge,
    readonly store: ComputeMeshStore,
    private readonly backend: () => MeshBackend | null,
  ) {}
  async start(): Promise<void> {
    this.identity = await this.bridge.getIdentity();
    this.unsub = this.bridge.onCircleTopicMessage((event) => {
      if (event.topic !== COMPUTE_TOPIC || event.from_peer_id === this.identity?.peerId) return;
      try {
        if (event.data_b64.length > 12_000) return;
        const d = parseDescriptor(decodeMesh(event.data_b64), event.from_peer_id);
        this.store.peer(d);
      } catch {
        /* Invalid, stale or mismatched identities never enter discovery. */
      }
    });
    // Older daemons fail visibly; never advertise capacity without a working signer.
    const subscribed = (await this.bridge.subscribeCircleTopic(COMPUTE_TOPIC)) as { ok?: boolean };
    if (subscribed?.ok !== true) throw Error("Compute topic requires an updated orchestrator");
    await this.tick();
    this.timer = setInterval(() => {
      void this.tick();
    }, 2000);
    this.timer.unref();
  }
  async stop(): Promise<void> {
    this.stopping = true;
    clearInterval(this.timer);
    this.unsub?.();
    await this.cycle;
    await this.mutations.catch(() => {});
    await Promise.allSettled(this.requests);
    await this.bridge.unsubscribeCircleTopic(COMPUTE_TOPIC).catch(() => {});
    this.store.close();
  }
  tick(): Promise<void> {
    if (this.stopping) return Promise.resolve();
    if (this.cycle) return this.cycle;
    this.cycle = this.runCycle()
      .catch(() => {
        this.lastError = "Compute mesh temporarily unavailable";
      })
      .finally(() => {
        this.cycle = undefined;
      });
    return this.cycle;
  }
  private async runCycle(): Promise<void> {
    if (Date.now() - this.lastAdvertised > 30_000) {
      try {
        const backend = this.backend();
        this.local = backend ? await backend.admin.status(3000).catch(() => undefined) : undefined;
        const nodes = (
          this.local?.capabilities?.mesh_admissions ? (this.local.nodes ?? []) : []
        ).filter(
          (n) =>
            n.online &&
            !n.operator_paused &&
            !n.offer.paused &&
            n.offer.isolation === "docker_v1" &&
            n.offer.modes.some((m) => m === "private" || m === "collective"),
        );
        const now = Date.now();
        const unsigned: Omit<ComputeDescriptor, "signature"> = {
          version: 1,
          peerId: this.identity!.peerId,
          pubkey: this.identity!.pubkey,
          issuedAt: now,
          expiresAt: now + DESCRIPTOR_TTL_MS,
          region: "",
          accepting: nodes.length > 0,
          cpuSlots: Math.min(4096, nodes.length),
          gpuSlots: Math.min(
            256,
            nodes.filter((n) => n.offer.gpu_observed && n.offer.runtime).length,
          ),
          memoryMib: Math.min(
            16_777_216,
            nodes.reduce((sum, n) => sum + n.offer.memory_mib, 0),
          ),
          models: [
            ...new Map(
              nodes
                .filter((n) => n.offer.runtime && n.offer.gpu_observed)
                .map((n) => [
                  n.offer.runtime!.model_digest,
                  { model: n.offer.runtime!.model, digest: n.offer.runtime!.model_digest },
                ]),
            ).values(),
          ].slice(0, 16),
        };
        const descriptor = {
          ...unsigned,
          signature: await this.bridge.signComputeDescriptor(unsigned),
        };
        parseDescriptor(descriptor, this.identity!.peerId);
        const published = (await this.bridge.publishCircleTopic(
          COMPUTE_TOPIC,
          encodeMesh(descriptor),
        )) as { ok?: boolean };
        if (published?.ok !== true) throw Error("Compute announcement could not reach peers");
        this.lastAdvertised = now;
        this.ready = true;
        this.lastError = null;
      } catch {
        this.ready = false;
        this.lastError = "Compute discovery is waiting for connected, compatible peers";
      }
    }
    // Round-robin batches prevent an offline peer from starving later work. There
    // are at most four outbound shard steps, even when many batches are queued.
    const active = this.store.active();
    if (active.length) {
      const batch = active[this.batchCursor++ % active.length]!;
      await advanceBatch(this, batch);
    }
  }
  status(): ComputeMeshSnapshot {
    return {
      enabled: true,
      ready: this.ready,
      error: this.lastError,
      peerId: this.identity?.peerId,
      hosting: Boolean(
        this.local?.capabilities?.mesh_admissions && this.local?.principal?.roles.includes("admin"),
      ),
      pools: this.local?.principal?.pools ?? [],
      projects: this.local?.principal?.projects ?? [],
      localWorkers: (this.local?.nodes ?? []).filter((n) => n.online).length,
      peers: this.store.peers().map((d) => ({
        ...d,
        admitted: this.store.grant(d.peerId)?.enabled === true,
        reliability: this.store.reliability(d.peerId),
      })),
      batches: this.store.batches().map(({ inputs, result: _result, ...b }) => ({
        ...b,
        items: inputs.length,
        shards: b.shards.map(({ result: _result, ...s }) => s),
      })),
      activity: this.store.recent(),
      permissions: this.store.permissions(),
      payments: "base-sepolia-separate-wallet",
      verification:
        "CPU recomputed; embeddings checked for shape and pinned runtime, trusted operators only",
    };
  }
  async grant(peerId: string, pools: string[], projects: string[]): Promise<void> {
    return this.mutate(async () => {
      const peer = this.store.peers().find((p) => p.peerId === peerId);
      const backend = this.backend();
      if (!peer || !backend) throw Error("A discovered peer and local coordinator are required");
      const valid = (s: unknown): s is string[] =>
        Array.isArray(s) &&
        s.length <= 16 &&
        s.every((x) => typeof x === "string" && /^[a-zA-Z0-9_-]{1,64}$/.test(x));
      if (!valid(pools) || !valid(projects) || pools.length + projects.length === 0)
        throw Error("Choose at least one pool or project");
      const old = this.store.grant(peerId);
      const grant: MeshGrant = {
        peerId,
        pubkey: peer.pubkey,
        principal: `mesh_${Buffer.from(peer.pubkey, "base64").toString("hex")}`,
        token: old?.token ?? randomBytes(32).toString("hex"),
        pools,
        projects,
        enabled: false,
      };
      // Journal intent before touching the runtime. A crash can only deny access.
      this.store.saveGrant(grant);
      await backend.admin.request("POST", "/v1/admissions", {
        public_key: Buffer.from(peer.pubkey, "base64").toString("hex"),
        token: grant.token,
        pools,
        projects,
      });
      grant.enabled = true;
      this.store.saveGrant(grant);
      this.store.activity(peerId, "access_granted");
    });
  }
  async revoke(peerId: string): Promise<void> {
    return this.mutate(async () => {
      const grant = this.store.grant(peerId);
      if (!grant) return;
      grant.enabled = false;
      this.store.saveGrant(grant);
      const backend = this.backend();
      if (!backend)
        throw Error("Access disabled; reconnect coordinator to cancel outstanding jobs");
      await backend.admin.request(
        "POST",
        `/v1/admissions/${Buffer.from(grant.pubkey, "base64").toString("hex")}/revoke`,
        {},
      );
      this.store.revoke(peerId);
      this.store.activity(peerId, "access_revoked");
    });
  }
  private mutate<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.mutations.then(fn);
    this.mutations = result.catch(() => {});
    return result;
  }
  handle(peerId: string, method: string, params: unknown): Promise<RpcReply> {
    if (this.stopping) return Promise.resolve({ ok: false, error: "Compute stopping" });
    const task = this.handleRequest(peerId, method, params);
    this.requests.add(task);
    void task.finally(() => this.requests.delete(task)).catch(() => {});
    return task;
  }
  private async handleRequest(peerId: string, method: string, params: unknown): Promise<RpcReply> {
    if (!COMPUTE_METHODS.has(method)) return { ok: false, error: "method not allowed" };
    const grant = this.store.grant(peerId);
    if (!grant?.enabled) return { ok: false, error: "Operator approval required" };
    const now = Date.now();
    for (const [key, r] of this.rates)
      if (now - r.at > 60_000 && r.active === 0) this.rates.delete(key);
    const rate = this.rates.get(peerId) ?? { at: now, count: 0, active: 0 };
    if (this.incoming >= 8 || rate.active >= 2 || rate.count >= 120)
      return { ok: false, error: "Compute request limit reached" };
    this.rates.set(peerId, rate);
    rate.count++;
    rate.active++;
    this.incoming++;
    try {
      if (!params || typeof params !== "object" || Array.isArray(params))
        throw Error("Invalid request");
      const p = params as Record<string, unknown>;
      const backend = this.backend();
      if (!backend) throw Error("Unavailable");
      const client = backend.client(grant.token);
      if (method === "compute/v1/access")
        return { ok: true, result: { pools: grant.pools, projects: grant.projects } };
      if (method === "compute/v1/submit") {
        const spec = p.spec as SoapboxJob["spec"] & { idempotency_key?: unknown };
        if (
          !spec ||
          !["private", "collective"].includes(spec.mode?.kind) ||
          typeof spec.idempotency_key !== "string" ||
          !/^mesh-[a-f0-9-]{36}-\d+$/.test(spec.idempotency_key)
        )
          throw Error("Invalid job");
        if (Buffer.byteLength(JSON.stringify(spec)) > 48 * 1024) throw Error("Oversized job");
        const inputs = spec.workload?.texts;
        if (
          !Array.isArray(inputs) ||
          inputs.length > 16 ||
          (spec.workload.kind === "embeddings" && inputs.length !== 1)
        )
          throw Error("Invalid batch size");
        const job = await client.request<SoapboxJob>("POST", "/v1/jobs", spec);
        this.store.remoteJob(job.id, peerId, job.status, inputs.length);
        // Never put workload inputs, runtime tokens or wallet configuration on gossip.
        return { ok: true, result: this.publicJob(job) };
      }
      if (typeof p.id !== "string" || !/^[a-f0-9-]{36}$/.test(p.id)) throw Error("Invalid job id");
      const job = await client.request<SoapboxJob>(
        method.endsWith("/cancel") ? "POST" : "GET",
        `/v1/jobs/${p.id}${method.endsWith("/cancel") ? "/cancel" : ""}`,
        method.endsWith("/cancel") ? {} : undefined,
      );
      this.store.remoteJob(job.id, peerId, job.status, job.spec.workload.texts.length);
      return { ok: true, result: this.publicJob(job) };
    } catch {
      return { ok: false, error: "Compute request refused or coordinator unavailable" };
    } finally {
      rate.active--;
      this.incoming--;
    }
  }
  private publicJob(job: SoapboxJob) {
    return {
      id: job.id,
      status: job.status,
      result: job.result,
      error: job.error ? "Worker could not complete this job" : null,
    };
  }
  async call<T>(peer: string, method: string, params: unknown): Promise<T> {
    const reply = decodeMesh(
      await this.bridge.circleRequest(peer, encodeMesh({ method, params }), 12_000),
    ) as { ok?: unknown; result?: unknown };
    if (!reply || reply.ok !== true) throw Error("Peer refused request or is unavailable");
    return reply.result as T;
  }
  submit(request: BatchRequest): MeshBatch {
    validateBatch(request);
    const old = this.store.batch(request.intent);
    if (old) {
      if (
        JSON.stringify([
          old.mode,
          old.scope,
          old.kind,
          old.model,
          old.digest,
          old.inputs,
          old.peers,
        ]) !==
        JSON.stringify([
          request.mode,
          request.scope,
          request.kind,
          request.model,
          request.digest,
          request.inputs,
          request.peers,
        ])
      )
        throw Error("Submission identifier already used for different inputs");
      return old;
    }
    if (this.store.active().length >= 16) throw Error("Wait for running batches to finish");
    const peers = this.store.peers();
    if (
      request.peers.some(
        (id) =>
          !peers.some(
            (p) =>
              p.peerId === id &&
              p.accepting &&
              (request.kind === "sha256" ||
                p.models.some((m) => m.model === request.model && m.digest === request.digest)),
          ),
      )
    )
      throw Error("Select online peers with matching capacity and model");
    const batch: MeshBatch = {
      ...request,
      id: randomUUID(),
      createdAt: Date.now(),
      status: "running",
      result: null,
      shards: [],
    };
    const size = request.kind === "embeddings" ? 1 : 16;
    for (let offset = 0; offset < request.inputs.length; offset += size) {
      const index = batch.shards.length;
      batch.shards.push({
        index,
        offset,
        count: Math.min(size, request.inputs.length - offset),
        peerId: request.peers[index % request.peers.length]!,
        status: "pending",
        attempts: 0,
      });
    }
    this.store.saveBatch(batch);
    this.store.activity("", "batch_submitted", request.inputs.length);
    return batch;
  }
  cancel(id: string): void {
    const batch = this.store.batch(id);
    if (!batch) throw Error("Unknown batch");
    if (batch.status === "running") {
      batch.status = "cancelling";
      this.store.saveBatch(batch);
    }
  }
}
