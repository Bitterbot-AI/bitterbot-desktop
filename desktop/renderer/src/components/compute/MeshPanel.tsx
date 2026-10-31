import { useCallback, useEffect, useRef, useState } from "react";
import type { ComputeMeshSnapshot } from "../../../../../src/compute/mesh-types";
import { useGatewayStore } from "../../stores/gateway-store";

type Snapshot = ComputeMeshSnapshot;
const field = "rounded-md border border-border bg-background px-3 py-2 text-sm";
const button = "rounded-md border border-border px-3 py-2 text-sm disabled:opacity-40";
export function MeshPanel() {
  const request = useGatewayStore((s) => s.request);
  const connected = useGatewayStore((s) => s.status) === "connected";
  const [data, setData] = useState<Snapshot>();
  const [error, setError] = useState("");
  const [pollError, setPollError] = useState("");
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [mode, setMode] = useState<"private" | "collective">("private");
  const [scope, setScope] = useState("circle");
  const [kind, setKind] = useState<"sha256" | "embeddings">("sha256");
  const [model, setModel] = useState("");
  const [inputs, setInputs] = useState("");
  const [grantScope, setGrantScope] = useState("");
  const [result, setResult] = useState<string>();
  const intent = useRef<{ body: string; id: string }>();
  const refresh = useCallback(async () => {
    const next = await request<Snapshot>("soapbox.mesh.status");
    setData({
      ...next,
      peers: next.peers ?? [],
      batches: next.batches ?? [],
      activity: next.activity ?? [],
      pools: next.pools ?? [],
      projects: next.projects ?? [],
      permissions: next.permissions ?? [],
    });
  }, [request]);
  useEffect(() => {
    if (!connected) return;
    let live = true;
    const poll = async () => {
      try {
        await refresh();
        if (live) setPollError("");
      } catch {
        if (live) setPollError("Compute mesh needs an updated, connected gateway.");
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 5000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [connected, refresh]);
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await action();
      await refresh();
    } catch {
      setError(
        "Action failed. Check peer approval, matching runtime versions and connectivity. Retrying this submission uses the same job identifier.",
      );
    } finally {
      setBusy(false);
    }
  };
  const peers = data?.peers ?? [];
  const selectedPeers = peers.filter((p) => selected.includes(p.peerId));
  const models = (selectedPeers[0]?.models ?? []).filter((m) =>
    selectedPeers.every((p) =>
      p.models.some((other) => other.digest === m.digest && other.model === m.model),
    ),
  );
  const chosen = models.find((m) => `${m.model}@${m.digest}` === model);
  const completed = (data?.batches ?? []).filter((b) => b.status === "succeeded");
  return (
    <section
      aria-label="P2P compute mesh"
      className="rounded-xl border border-border p-5 space-y-4"
    >
      <div className="flex flex-wrap justify-between gap-3">
        <div>
          <h2 className="font-semibold">Compute across your P2P network</h2>
          <p className="text-sm text-muted-foreground">
            Split independent tasks across approved nodes. Inputs travel over encrypted peer
            connections.
          </p>
        </div>
        <span className="text-sm">{data?.ready ? "Discovery active" : "Connecting to mesh"}</span>
      </div>
      <div className="grid grid-cols-3 gap-3 text-sm">
        <div>
          <strong className="text-xl">{peers.filter((p) => p.accepting).length}</strong>
          <br />
          available peers
        </div>
        <div>
          <strong className="text-xl">{peers.reduce((n, p) => n + p.gpuSlots, 0)}</strong>
          <br />
          advertised GPU slots
        </div>
        <div>
          <strong className="text-xl">{completed.reduce((n, b) => n + b.items, 0)}</strong>
          <br />
          items in completed batches
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        Capacity is self-reported and expires after two minutes. Completed items reflect your local
        batch history.
      </p>
      {data?.error && (
        <p role="status" className="text-sm">
          {data.error}
        </p>
      )}
      {pollError && (
        <p role="alert" className="text-sm text-danger">
          {pollError}
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      {data?.peerId && (
        <p className="text-xs break-all">
          Your peer ID: <code>{data.peerId}</code>
        </p>
      )}
      <details>
        <summary className="cursor-pointer font-medium">Peers and operator access</summary>
        <div className="space-y-3 mt-3">
          <p className="text-sm">
            The operator grants a buyer’s peer ID access to a specific pool or project. Granting
            access lets that peer submit free work using those resources.
          </p>
          {data?.hosting ? (
            <label className="block text-sm">
              Scope to share{" "}
              <select
                aria-label="Scope to share"
                className={field}
                value={grantScope}
                onChange={(e) => setGrantScope(e.target.value)}
              >
                <option value="">Choose a scope</option>
                {data.pools.map((p) => (
                  <option key={`private:${p}`} value={`private:${p}`}>
                    Private: {p}
                  </option>
                ))}
                {data.projects.map((p) => (
                  <option key={`collective:${p}`} value={`collective:${p}`}>
                    Collective: {p}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <p className="text-sm text-muted-foreground">
              This gateway can submit to approved peers. Hosting requires a local coordinator with
              the mesh runtime update.
            </p>
          )}
          {!peers.length && (
            <p className="text-sm">
              No Compute peers discovered yet. Both nodes need the updated P2P orchestrator.
            </p>
          )}
          {(data?.permissions ?? [])
            .filter((g) => !peers.some((p) => p.peerId === g.peerId))
            .map((g) => (
              <div key={g.peerId} className="rounded-lg bg-muted/30 p-3 text-xs space-y-2">
                <code className="break-all">{g.peerId}</code>
                <p>
                  Offline · {g.enabled ? "Access granted" : "Access disabled"} ·{" "}
                  {[...g.pools, ...g.projects].join(", ")}
                </p>
                <button
                  className={button}
                  disabled={busy}
                  onClick={() =>
                    void run(() => request("soapbox.mesh.revoke", { peerId: g.peerId }))
                  }
                >
                  Revoke offline peer
                </button>
              </div>
            ))}
          {peers.map((p) => (
            <div key={p.peerId} className="rounded-lg bg-muted/30 p-3 space-y-2">
              <code className="block text-xs break-all">{p.peerId}</code>
              <p className="text-sm">
                {p.accepting ? "Available" : "Discovery only"} · {p.cpuSlots} CPU / {p.gpuSlots} GPU
                slots · {p.memoryMib} MiB allowance
              </p>
              <p className="text-xs">
                {p.admitted ? "You granted this peer access" : "No local access granted"}
              </p>
              {data?.hosting && (
                <div className="flex gap-2">
                  <button
                    className={button}
                    disabled={busy || !grantScope}
                    onClick={() =>
                      void run(() =>
                        request("soapbox.mesh.grant", {
                          peerId: p.peerId,
                          pools: grantScope.startsWith("private:") ? [grantScope.slice(8)] : [],
                          projects: grantScope.startsWith("collective:")
                            ? [grantScope.slice(11)]
                            : [],
                        }),
                      )
                    }
                  >
                    Grant selected scope
                  </button>
                  {(p.admitted || data?.permissions?.some((g) => g.peerId === p.peerId)) && (
                    <button
                      className={button}
                      disabled={busy}
                      onClick={() =>
                        void run(() => request("soapbox.mesh.revoke", { peerId: p.peerId }))
                      }
                    >
                      Revoke access
                    </button>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      </details>
      <details>
        <summary className="cursor-pointer font-medium">Run a distributed batch</summary>
        <form
          className="space-y-3 mt-3"
          onSubmit={(e) => {
            e.preventDefault();
            const body = {
              mode,
              scope,
              kind,
              inputs: inputs.split("\n").filter(Boolean),
              peers: selected,
              ...(chosen && kind === "embeddings"
                ? { model: chosen.model, digest: chosen.digest }
                : {}),
            };
            const serialized = JSON.stringify(body);
            if (intent.current?.body !== serialized)
              intent.current = { body: serialized, id: crypto.randomUUID() };
            void run(() => request("soapbox.mesh.submit", { ...body, intent: intent.current!.id }));
          }}
        >
          <p className="text-sm">
            Select operators you trust with these inputs. Each must have granted your peer ID the
            scope below.
          </p>
          <fieldset disabled={busy} className="space-y-2">
            <legend className="text-sm">Execution peers</legend>
            {peers
              .filter((p) => p.accepting)
              .map((p) => (
                <label key={p.peerId} className="flex gap-2 text-xs break-all">
                  <input
                    type="checkbox"
                    checked={selected.includes(p.peerId)}
                    onChange={(e) =>
                      setSelected(
                        e.target.checked
                          ? [...selected, p.peerId]
                          : selected.filter((id) => id !== p.peerId),
                      )
                    }
                  />
                  {p.peerId}
                </label>
              ))}
          </fieldset>
          <div className="flex flex-wrap gap-3">
            <label className="text-sm">
              Sharing mode{" "}
              <select
                className={field}
                value={mode}
                disabled={busy}
                onChange={(e) => {
                  setMode(e.target.value as typeof mode);
                  setScope(e.target.value === "private" ? "circle" : "science");
                }}
              >
                <option value="private">Private pool</option>
                <option value="collective">Collective project</option>
              </select>
            </label>
            <label className="text-sm">
              Pool or project{" "}
              <input
                className={field}
                required
                pattern="[a-zA-Z0-9_-]{1,64}"
                value={scope}
                disabled={busy}
                onChange={(e) => setScope(e.target.value)}
              />
            </label>
            <label className="text-sm">
              Batch workload{" "}
              <select
                className={field}
                value={kind}
                disabled={busy}
                onChange={(e) => setKind(e.target.value as typeof kind)}
              >
                <option value="sha256">CPU SHA-256</option>
                <option value="embeddings">GPU embeddings</option>
              </select>
            </label>
          </div>
          {kind === "embeddings" && (
            <label className="block text-sm">
              Pinned model{" "}
              <select
                className={field}
                required
                value={model}
                disabled={busy}
                onChange={(e) => setModel(e.target.value)}
              >
                <option value="">Select a common model</option>
                {models.map((m) => (
                  <option key={m.digest} value={`${m.model}@${m.digest}`}>
                    {m.model} · {m.digest}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="block text-sm">
            Batch inputs, one per line
            <textarea
              className={`${field} block w-full mt-1`}
              rows={4}
              required
              value={inputs}
              disabled={busy}
              onChange={(e) => setInputs(e.target.value)}
              placeholder="One independent input per line"
            />
          </label>
          <p className="text-xs text-muted-foreground">
            Up to 512 CPU or 32 GPU inputs / 32 KiB. CPU hashes are independently recomputed. GPU
            embeddings use shape and runtime checks; independent numerical verification is not yet
            available. This batch flow makes no payment. Paid Compute jobs remain on Base Sepolia.
          </p>
          <button
            className={button}
            disabled={
              busy ||
              !data?.ready ||
              selectedPeers.length !== selected.length ||
              !selected.length ||
              (kind === "embeddings" && !chosen)
            }
          >
            Run distributed batch
          </button>
        </form>
      </details>
      {!!data?.batches.length && (
        <div className="space-y-2">
          <h3 className="font-medium">Batch activity</h3>
          {data.batches.slice(0, 10).map((b) => (
            <div key={b.id} className="rounded-lg bg-muted/30 p-3 text-sm space-y-2">
              <p>
                {b.kind} · {b.items} inputs · {b.status}
              </p>
              <progress
                aria-label={`Progress ${b.id}`}
                max={b.shards.length}
                value={b.shards.filter((s) => s.status === "succeeded").length}
                className="w-full"
              />
              <p className="text-xs">
                {b.shards.filter((s) => s.status === "succeeded").length} / {b.shards.length} shards
                completed across {new Set(b.shards.map((s) => s.peerId)).size} peers
              </p>
              {b.status === "cancelling" && (
                <p className="text-xs">
                  Cancellation requested. Waiting for the operator to confirm; no new work will be
                  submitted. An offline operator will be contacted again automatically. Both nodes
                  need the current Compute release.
                </p>
              )}
              {b.status === "cancelled" &&
                b.shards.some(
                  (s) => s.status === "succeeded" || s.cancelledRemoteStatus === "succeeded",
                ) && (
                  <p className="text-xs">Some work completed before cancellation was confirmed.</p>
                )}
              {b.status === "running" && b.shards.some((s) => s.error) && (
                <p className="text-xs">
                  Waiting for a peer or its approval. Retrying the same shard safely.
                </p>
              )}
              <div className="flex gap-2">
                {b.status === "running" && (
                  <button
                    className={button}
                    disabled={busy}
                    onClick={() => void run(() => request("soapbox.mesh.cancel", { id: b.id }))}
                  >
                    Cancel batch
                  </button>
                )}
                {b.status === "succeeded" && (
                  <button
                    className={button}
                    onClick={() =>
                      void run(async () => {
                        const value = await request<{ result: unknown }>("soapbox.mesh.batch", {
                          id: b.id,
                        });
                        setResult(JSON.stringify(value.result, null, 2));
                      })
                    }
                  >
                    View result
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
      {!!data?.activity.length && (
        <details>
          <summary className="cursor-pointer font-medium">Recent mesh activity</summary>
          <ul className="text-xs space-y-2 mt-2">
            {data.activity.slice(0, 12).map((a, i) => (
              <li key={`${a.at}-${i}`} className="break-all">
                {new Date(a.at).toLocaleTimeString()} · {a.kind.replaceAll("_", " ")}
                {a.items ? ` · ${a.items} items` : ""}
                {a.peer ? ` · ${a.peer}` : ""}
              </li>
            ))}
          </ul>
        </details>
      )}
      {result && (
        <div>
          <button className={button} onClick={() => setResult(undefined)}>
            Close result
          </button>
          <pre className="max-h-72 overflow-auto text-xs mt-2">{result}</pre>
        </div>
      )}
    </section>
  );
}
