import { useCallback, useEffect, useState } from "react";
import { useGatewayStore } from "../../stores/gateway-store";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../ui/dialog";

type Requirements = {
  platforms: string[];
  tools: Record<string, string>;
  capabilities: string[];
  runtime: Record<string, string>;
};
type Package = {
  hash: string;
  state: string;
  reason: string | null;
  manifest: {
    name: string;
    description: string;
    files: { path: string; hash: string; size: number }[];
    requirements: Requirements;
  };
};
type Release = {
  id: string;
  release: { publisher: string; skillId: string; version: number; packageHash: string };
};
type Catalog = {
  enabled: boolean;
  packages: Package[];
  releases: Release[];
  ownPackages?: Array<Package & { releaseId?: string }>;
  active?: { lineage: string; hash: string; pinned: number }[];
  costs?: unknown;
  operational?: Record<string, number | string | null>;
};
type Policy = {
  id: string;
  enabled: boolean;
  scope: { kind: string; circleId?: string };
  publishers: string[];
  skillIds: string[];
  operations: string[];
};
type Job = { id: string; release_id: string; action: string; state: string; detail: string | null };
type Evidence = {
  outcome: string;
  kind?: string;
  node?: string;
  origin?: string;
  environment: { model: string };
  cost: { providerUsd: number } | null;
};
const button = "rounded border px-3 py-1.5 text-xs disabled:opacity-50 hover:bg-muted";
const input = "w-full rounded border bg-background px-2 py-1.5 text-sm";

export function SkillCatalog({
  circleId,
  selfPubkey,
  onClose,
}: {
  circleId: string;
  selfPubkey?: string;
  onClose: () => void;
}) {
  const request = useGatewayStore((s) => s.request);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [detail, setDetail] = useState<{ title: string; value: unknown } | null>(null);
  const [directory, setDirectory] = useState("");
  const [publisher, setPublisher] = useState(selfPubkey ?? "");
  const [skill, setSkill] = useState("");
  const [agent, setAgent] = useState("main");
  const [dollars, setDollars] = useState("0");
  const [capabilities, setCapabilities] = useState("");
  const [operations, setOperations] = useState<string[]>([]);
  const refresh = useCallback(async () => {
    const value = await request<Catalog>("skills.packages.list", { circleId, agentId: agent });
    setCatalog(value);
    if (value.enabled) {
      const [grants, queue] = await Promise.all([
        request<Policy[]>("skills.packages.policies", {}),
        request<Job[]>("skills.packages.jobs", {}),
      ]);
      setPolicies(grants.filter((p) => p.scope.kind === "circle" && p.scope.circleId === circleId));
      setJobs(queue);
    }
  }, [request, circleId, agent]);
  useEffect(() => {
    void refresh().catch((e) => setNotice(String(e)));
    const timer = setInterval(() => void refresh().catch(() => {}), 10000);
    return () => clearInterval(timer);
  }, [refresh]);
  const act = async (method: string, params: Record<string, unknown>) => {
    setBusy(true);
    setNotice("");
    try {
      const result = await request(`skills.packages.${method}`, {
        agentId: agent,
        ...params,
      });
      setDetail({ title: "Request result", value: result });
      await refresh();
    } catch (error) {
      setNotice(String(error));
    } finally {
      setBusy(false);
    }
  };
  const inspect = async (entry: Release, pkg: Package) => {
    setBusy(true);
    try {
      const result = await request<{
        text: string;
        receipts: Evidence[];
        peerEvidence: Evidence[];
      }>("skills.packages.inspect", { packageHash: pkg.hash });
      const active = catalog?.active?.find(
        (a) => a.lineage === `${entry.release.publisher}/${entry.release.skillId}`,
      );
      const diff = await request("skills.packages.diff", {
        before: active?.hash,
        after: pkg.hash,
      });
      setDetail({
        title: `${pkg.manifest.name} · files and evidence`,
        value: {
          files: pkg.manifest.files,
          changes: diff,
          requirements: pkg.manifest.requirements,
          recipientEvidence: result.receipts,
          sourceAndPeerReports: result.peerEvidence,
          instructions: result.text,
        },
      });
    } catch (error) {
      setNotice(String(error));
    } finally {
      setBusy(false);
    }
  };
  const grant = async () => {
    const identity = new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(JSON.stringify([circleId, agent, publisher, skill])),
      ),
    );
    await act("policy.set", {
      policy: {
        id: `circle-${Array.from(identity, (n) => n.toString(16).padStart(2, "0")).join("")}`,
        scope: { kind: "circle", circleId },
        enabled: true,
        agents: [agent],
        publishers: [publisher],
        skillIds: [skill],
        operations,
        categories: [
          "skill-package",
          ...(operations.includes("evidence") ? ["execution-summary"] : []),
        ],
        capabilities: capabilities
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
        budget: { providerUsd: Number(dollars), toolCalls: 2000, wallMs: 3600000 },
        expiresAt: Date.now() + 30 * 86400000,
      },
    });
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Circle skill catalog</DialogTitle>
          <DialogDescription>
            Complete procedures, independent local checks, and permissions for this Circle.
            Publishing a generated brief still requires draft review.
          </DialogDescription>
        </DialogHeader>
        {notice && (
          <p role="alert" className="text-sm text-destructive">
            {notice}
          </p>
        )}
        {!catalog ? (
          <p>Loading catalog…</p>
        ) : !catalog.enabled ? (
          <p className="text-sm">
            Complete packages are disabled on this gateway. Enable collective skills in gateway
            configuration to stage packages and configure grants.
          </p>
        ) : (
          <>
            <div className="space-y-3">
              {catalog.releases.length === 0 && (
                <p className="text-sm text-muted-foreground">
                  No packages have been shared with this Circle.
                </p>
              )}
              {catalog.releases.map((entry) => {
                const release = entry.release,
                  pkg = catalog.packages.find((p) => p.hash === release.packageHash);
                const active = catalog.active?.find(
                  (a) => a.lineage === `${release.publisher}/${release.skillId}`,
                );
                return (
                  <article key={entry.id} className="rounded-lg border p-3 space-y-2">
                    <div className="flex justify-between gap-3">
                      <strong>
                        {pkg?.manifest.name ?? release.skillId} · v{release.version}
                      </strong>
                      <span className="text-xs">
                        {pkg?.state ?? "Awaiting download permission"}
                      </span>
                    </div>
                    <p className="text-sm">
                      {pkg?.manifest.description ??
                        "The manifest will be verified after an authorized download."}
                    </p>
                    <p className="text-xs break-all">Author: {release.publisher}</p>
                    <p className="text-xs break-all">Package: {release.packageHash}</p>
                    {pkg && (
                      <p className="text-xs">
                        {pkg.manifest.files.length} files ·{" "}
                        {pkg.manifest.files.reduce((s, f) => s + f.size, 0).toLocaleString()} bytes
                        · Capabilities:{" "}
                        {pkg.manifest.requirements.capabilities.join(", ") || "none requested"}
                      </p>
                    )}
                    {pkg?.reason && <p className="text-xs">Waiting/status reason: {pkg.reason}</p>}
                    {jobs
                      .filter((j) => j.release_id === entry.id)
                      .slice(0, 3)
                      .map((j) => (
                        <p key={j.id} className="text-xs">
                          {j.action}: {j.state}
                          {j.detail ? ` — ${j.detail}` : ""}
                        </p>
                      ))}
                    <div className="flex flex-wrap gap-2">
                      <button
                        className={button}
                        disabled={busy || !pkg}
                        onClick={() => pkg && void inspect(entry, pkg)}
                      >
                        Inspect files, differences and evidence
                      </button>
                      <button
                        className={button}
                        disabled={busy}
                        onClick={() => void act("validate", { releaseId: entry.id })}
                      >
                        Evaluate
                      </button>
                      <button
                        className={button}
                        disabled={
                          busy || !pkg || !["locally-validated", "stable"].includes(pkg.state)
                        }
                        onClick={() => void act("adopt", { releaseId: entry.id })}
                      >
                        Adopt
                      </button>
                      {!!active?.pinned && (
                        <button
                          className={button}
                          disabled={
                            busy || !pkg || !["locally-validated", "stable"].includes(pkg.state)
                          }
                          onClick={() => void act("replace", { releaseId: entry.id })}
                        >
                          Explicitly replace pinned version
                        </button>
                      )}
                      <button
                        className={button}
                        disabled={busy || !active}
                        onClick={() =>
                          void act("pin", { releaseId: entry.id, pinned: !active?.pinned })
                        }
                      >
                        {active?.pinned ? "Unpin" : "Keep and pin"}
                      </button>
                      <button
                        className={button}
                        disabled={busy || !pkg}
                        onClick={() =>
                          void act("fork", {
                            releaseId: entry.id,
                            skillId: `${release.skillId}-local`,
                          })
                        }
                      >
                        Fork locally
                      </button>
                      <button
                        className={button}
                        disabled={busy || active?.hash === release.packageHash}
                        onClick={() => void act("reject", { releaseId: entry.id })}
                      >
                        Reject
                      </button>
                      <button
                        className={button}
                        disabled={busy || !active}
                        onClick={() => void act("rollback", { releaseId: entry.id })}
                      >
                        Roll back
                      </button>
                      {release.publisher === selfPubkey && (
                        <button
                          className={button}
                          disabled={busy}
                          onClick={() => void act("withdraw", { releaseId: entry.id })}
                        >
                          Stop sharing release
                        </button>
                      )}
                    </div>
                  </article>
                );
              })}
            </div>
            <details className="rounded border p-3">
              <summary className="cursor-pointer text-sm font-medium">
                Stage or publish a local package
              </summary>
              <div className="space-y-2 mt-3">
                <label className="text-sm">
                  Local package directory
                  <input
                    className={input}
                    value={directory}
                    onChange={(e) => setDirectory(e.target.value)}
                  />
                </label>
                <button
                  className={button}
                  disabled={busy || !directory}
                  onClick={() => void act("stage", { directory })}
                >
                  Snapshot for review
                </button>
                {(catalog.ownPackages ?? []).map((pkg) => (
                  <div key={pkg.hash} className="flex justify-between gap-2 text-sm">
                    <span>
                      {pkg.manifest.name} · {pkg.state}
                      {pkg.reason ? ` · ${pkg.reason}` : ""}
                    </span>
                    {pkg.releaseId &&
                      !["stable", "canary", "locally-validated"].includes(pkg.state) && (
                        <button
                          className={button}
                          disabled={busy}
                          onClick={() => void act("validate", { releaseId: pkg.releaseId })}
                        >
                          Validate locally
                        </button>
                      )}
                    {pkg.releaseId && pkg.state === "locally-validated" && (
                      <button
                        className={button}
                        disabled={busy}
                        onClick={() => void act("adopt", { releaseId: pkg.releaseId })}
                      >
                        Start canary
                      </button>
                    )}
                    <button
                      className={button}
                      disabled={busy || pkg.state !== "stable"}
                      onClick={() =>
                        void act("publish", {
                          packageHash: pkg.hash,
                          scope: { kind: "circle", circleId },
                        })
                      }
                    >
                      Share under grant
                    </button>
                  </div>
                ))}
              </div>
            </details>
            <details className="rounded border p-3">
              <summary className="cursor-pointer text-sm font-medium">
                Persistent automation grants
              </summary>
              <div className="space-y-3 mt-3">
                <p className="text-xs">
                  Each grant expires in 30 days. Only an operator with approval authority can save
                  it. Zero dollars permits no paid work; the gateway budget is an additional limit.
                </p>
                <label className="block text-sm">
                  Agent
                  <input
                    className={input}
                    value={agent}
                    onChange={(e) => setAgent(e.target.value)}
                  />
                </label>
                <label className="block text-sm">
                  Publisher identity
                  <input
                    className={input}
                    value={publisher}
                    onChange={(e) => setPublisher(e.target.value)}
                  />
                </label>
                <label className="block text-sm">
                  Stable skill ID
                  <input
                    className={input}
                    value={skill}
                    onChange={(e) => setSkill(e.target.value)}
                  />
                </label>
                <label className="block text-sm">
                  Allowed capabilities, separated by commas
                  <input
                    className={input}
                    value={capabilities}
                    onChange={(e) => setCapabilities(e.target.value)}
                  />
                </label>
                <label className="block text-sm">
                  Maximum dollars
                  <input
                    className={input}
                    type="number"
                    min="0"
                    step="0.01"
                    value={dollars}
                    onChange={(e) => setDollars(e.target.value)}
                  />
                </label>
                <div className="flex flex-wrap gap-3">
                  {[
                    ["publish", "Publish packages"],
                    ["evidence", "Share structured evidence"],
                    ["evaluate", "Evaluate incoming packages"],
                    ["adopt", "Adopt qualified updates"],
                  ].map(([value, label]) => (
                    <label key={value} className="text-sm flex gap-2">
                      <input
                        type="checkbox"
                        checked={operations.includes(value)}
                        onChange={(e) =>
                          setOperations((old) =>
                            e.target.checked ? [...old, value] : old.filter((v) => v !== value),
                          )
                        }
                      />
                      {label}
                    </label>
                  ))}
                </div>
                <button
                  className={button}
                  disabled={
                    busy ||
                    !skill ||
                    !publisher ||
                    !operations.length ||
                    !Number.isFinite(Number(dollars)) ||
                    Number(dollars) < 0
                  }
                  onClick={() => void grant()}
                >
                  Save Circle grant
                </button>
                {policies.map((p) => (
                  <div key={p.id} className="text-xs border-t pt-2 space-y-1">
                    <p>
                      {p.skillIds.join(", ")} · {p.operations.join(", ")} ·{" "}
                      {p.enabled ? "enabled" : "revoked"}
                    </p>
                    <p className="break-all">{p.publishers.join(", ")}</p>
                    <button
                      className={button}
                      disabled={busy || !p.enabled}
                      onClick={() => void act("policy.revoke", { id: p.id })}
                    >
                      Revoke grant
                    </button>
                  </div>
                ))}
              </div>
            </details>
            <details className="rounded border p-3">
              <summary className="text-sm">Operations, costs and waiting jobs</summary>
              <pre className="text-xs whitespace-pre-wrap mt-2">
                {JSON.stringify(
                  {
                    operations: catalog.operational,
                    costs: catalog.costs,
                    waitingJobs: jobs.filter(
                      (job) => job.state === "blocked" || job.state === "queued",
                    ),
                  },
                  null,
                  2,
                )}
              </pre>
            </details>
            {detail && (
              <section className="rounded border p-3">
                <h3 className="font-medium text-sm">{detail.title}</h3>
                <pre className="text-xs whitespace-pre-wrap break-all mt-2 max-h-96 overflow-y-auto">
                  {JSON.stringify(detail.value, null, 2)}
                </pre>
              </section>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
