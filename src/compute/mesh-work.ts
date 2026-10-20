import { createHash } from "node:crypto";
import type { ComputeMeshService } from "./mesh-service.js";
import type { MeshBatch } from "./mesh-store.js";

export type BatchRequest = Pick<
  MeshBatch,
  "intent" | "mode" | "scope" | "kind" | "model" | "digest" | "inputs" | "peers"
>;
export function validateBatch(p: BatchRequest): void {
  const fields = new Set(["intent", "mode", "scope", "kind", "model", "digest", "inputs", "peers"]);
  if (!p || typeof p !== "object" || Object.keys(p).some((key) => !fields.has(key)))
    throw Error("Unknown batch fields");
  if (p.kind === "sha256" && (p.model !== undefined || p.digest !== undefined))
    throw Error("CPU batches do not select a model");
  if (
    !p ||
    typeof p !== "object" ||
    typeof p.intent !== "string" ||
    !/^[-a-zA-Z0-9_]{8,80}$/.test(p.intent) ||
    !["private", "collective"].includes(p.mode) ||
    typeof p.scope !== "string" ||
    !/^[a-zA-Z0-9_-]{1,64}$/.test(p.scope) ||
    !["sha256", "embeddings"].includes(p.kind) ||
    !Array.isArray(p.inputs) ||
    p.inputs.length < 1 ||
    p.inputs.length > 512 ||
    p.inputs.some((s) => typeof s !== "string") ||
    Buffer.byteLength(JSON.stringify(p.inputs)) > 32 * 1024 ||
    !Array.isArray(p.peers) ||
    p.peers.length < 1 ||
    p.peers.length > 16 ||
    new Set(p.peers).size !== p.peers.length ||
    p.peers.some((s) => typeof s !== "string" || !/^12D3KooW[1-9A-HJ-NP-Za-km-z]{44}$/.test(s))
  )
    throw Error("Invalid batch: choose peers, a scope and 1–512 inputs (32 KiB maximum)");
  if (
    p.kind === "embeddings" &&
    (p.inputs.length > 32 ||
      typeof p.model !== "string" ||
      p.model.length < 1 ||
      p.model.length > 128 ||
      typeof p.digest !== "string" ||
      !/^[a-f0-9]{64}$/.test(p.digest))
  )
    throw Error("Choose a pinned model and up to 32 GPU inputs");
}
type RemoteJob = { id: string; status: string; result: unknown };
export function verifyShard(
  batch: MeshBatch,
  offset: number,
  count: number,
  value: unknown,
): unknown[] {
  if (!value || typeof value !== "object") throw Error("Missing result");
  const r = value as Record<string, unknown>;
  if (batch.kind === "sha256") {
    const expected = batch.inputs
      .slice(offset, offset + count)
      .map((s) => createHash("sha256").update(s).digest("hex"));
    if (JSON.stringify(expected) !== JSON.stringify(r.hashes)) throw Error("CPU result mismatch");
    return expected;
  }
  const rows = r.embeddings;
  if (
    !Array.isArray(rows) ||
    rows.length !== count ||
    rows.some(
      (row) =>
        !Array.isArray(row) ||
        row.length < 1 ||
        row.length > 8192 ||
        row.some((v) => typeof v !== "number" || !Number.isFinite(v)),
    ) ||
    rows.some((row) => row.length !== rows[0].length)
  )
    throw Error("Invalid embedding shape");
  const e = r.execution as Record<string, unknown> | undefined;
  if (
    !e ||
    e.model !== batch.model ||
    e.model_digest !== batch.digest ||
    e.backend !== "ollama" ||
    e.fully_gpu_resident !== true ||
    e.dimensions !== rows[0].length
  )
    throw Error("Runtime evidence mismatch");
  return rows;
}
export async function advanceBatch(mesh: ComputeMeshService, b: MeshBatch): Promise<void> {
  const pending = b.shards.filter((s) => !["succeeded", "failed", "cancelled"].includes(s.status));
  const selected = pending
    .toSorted((a, c) => (a.lastTriedAt ?? 0) - (c.lastTriedAt ?? 0))
    .slice(0, 4);
  for (const s of selected) {
    s.lastTriedAt = Date.now();
    if (b.status !== "cancelling") s.attempts = Math.max(s.attempts, 1);
  }
  mesh.store.saveBatch(b);
  await Promise.all(
    selected.map(async (s) => {
      try {
        // The same intent and shard id are sent after every transport timeout/restart.
        // A lost response must not create a second job at the same coordinator.
        if (!s.jobId && (b.status !== "cancelling" || s.attempts > 0)) {
          const access = await mesh.call<{ pools: string[]; projects: string[] }>(
            s.peerId,
            "compute/v1/access",
            {},
          );
          if (!(b.mode === "private" ? access.pools : access.projects).includes(b.scope))
            throw Error("Peer has not approved this scope");
          s.attempts = Math.max(s.attempts, 1);
          const job = await mesh.call<RemoteJob>(s.peerId, "compute/v1/submit", {
            spec: {
              idempotency_key: `mesh-${b.id}-${s.index}`,
              mode:
                b.mode === "private"
                  ? { kind: "private", pool_id: b.scope }
                  : { kind: "collective", project_id: b.scope },
              workload: {
                kind: b.kind,
                texts: b.inputs.slice(s.offset, s.offset + s.count),
                ...(b.kind === "embeddings" ? { model: b.model, model_digest: b.digest } : {}),
              },
              resources: {
                cpu_threads: 1,
                memory_mib: b.kind === "embeddings" ? 2048 : 256,
                require_gpu: b.kind === "embeddings",
              },
            },
          });
          if (!/^[a-f0-9-]{36}$/.test(job.id)) throw Error("Invalid remote job");
          s.jobId = job.id;
          s.status = "queued";
          mesh.store.activity(s.peerId, "shard_dispatched", s.count);
        }
        const cancelling = mesh.store.batch(b.id)?.status === "cancelling";
        if (cancelling && !s.jobId) {
          s.status = "cancelled";
          return;
        }
        if (!s.jobId) return;
        const job = await mesh.call<RemoteJob>(
          s.peerId,
          cancelling ? "compute/v1/cancel" : "compute/v1/job",
          { id: s.jobId },
        );
        if (job.id !== s.jobId) throw Error("Remote job binding mismatch");
        if (job.status === "succeeded") {
          s.result = verifyShard(b, s.offset, s.count, job.result);
          s.status = "succeeded";
          s.error = undefined;
          if (mesh.store.outcome(`${s.peerId}:${s.jobId}`, s.peerId, true))
            mesh.store.activity(s.peerId, "shard_completed", s.count);
        } else if (["failed", "cancelled"].includes(job.status)) {
          s.status = job.status;
          if (!cancelling && mesh.store.outcome(`${s.peerId}:${s.jobId}`, s.peerId, false))
            mesh.store.activity(s.peerId, "shard_failed", s.count);
        } else {
          s.status = "running";
          s.failures = 0;
          if (Date.now() - b.createdAt > 20 * 60_000 && !cancelling) {
            s.status = "failed";
            s.error = "Batch deadline exceeded";
            await mesh.call(s.peerId, "compute/v1/cancel", { id: s.jobId }).catch(() => {});
          }
        }
      } catch {
        s.failures = (s.failures ?? 0) + 1;
        s.error = "Peer unavailable, scope refused or result rejected";
        // Free work only. Transport failures are not negative reputation evidence.
        // Do not move ambiguous submissions elsewhere: that could duplicate work.
        if (Date.now() - b.createdAt > 20 * 60_000 && b.status !== "cancelling")
          s.status = "failed";
      }
    }),
  );
  const current = mesh.store.batch(b.id);
  if (current?.status === "cancelling") b.status = "cancelling";
  const done = b.shards.every((s) => ["succeeded", "failed", "cancelled"].includes(s.status));
  if (done) {
    if (b.status === "cancelling") b.status = "cancelled";
    else if (b.shards.every((s) => s.status === "succeeded")) {
      const rows = b.shards.flatMap((s) => s.result as unknown[]);
      if (
        b.kind === "embeddings" &&
        rows.some((row) => !Array.isArray(row) || row.length !== (rows[0] as unknown[]).length)
      )
        b.status = "failed";
      else {
        b.status = "succeeded";
        b.result = {
          [b.kind === "sha256" ? "hashes" : "embeddings"]: rows,
          verification:
            b.kind === "sha256" ? "recomputed" : "shape_and_runtime_only_trusted_operators",
        };
      }
    } else b.status = "failed";
    mesh.store.activity("", `batch_${b.status}`, b.inputs.length);
  }
  mesh.store.saveBatch(b);
}
