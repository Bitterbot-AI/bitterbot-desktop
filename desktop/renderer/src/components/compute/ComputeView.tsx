import { useCallback, useEffect, useState } from "react";
import type {
  SoapboxJob,
  SoapboxMode,
  SoapboxStatus,
} from "../../../../../src/infra/soapbox-client";
import { useGatewayStore } from "../../stores/gateway-store";
import { ArtifactPanel } from "./ArtifactPanel";
import { ComputeSetup } from "./ComputeSetup";
import { ComputeWalletPanel } from "./ComputeWalletPanel";
import { MeshPanel } from "./MeshPanel";
import { PaymentPanel } from "./PaymentPanel";
import { WorkerPanel } from "./WorkerPanel";

const field = "w-full rounded-lg border border-border bg-background px-3 py-2 text-sm";
const button = "rounded-lg bg-brand px-4 py-2 text-sm text-white disabled:opacity-40";
function microUsdc(value: string): number | undefined {
  if (!/^\d{1,3}(?:\.\d{1,6})?$/.test(value)) return undefined;
  const [whole, fraction = ""] = value.split(".");
  return Number(whole) * 1_000_000 + Number(fraction.padEnd(6, "0"));
}

export function ComputeView() {
  const request = useGatewayStore((s) => s.request);
  const connected = useGatewayStore((s) => s.status === "connected");
  const [snapshot, setSnapshot] = useState<SoapboxStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [setupOpen, setSetupOpen] = useState(false);
  const [mode, setMode] = useState<SoapboxMode["kind"]>("private");
  const [scope, setScope] = useState("");
  const [workload, setWorkload] = useState<"sha256" | "embeddings">("sha256");
  const [model, setModel] = useState("");
  const [gpu, setGpu] = useState(true);
  const [texts, setTexts] = useState(
    "Hello from Bitterbot\nShared infrastructure, chosen by its owners",
  );
  const [budget, setBudget] = useState("0.01");
  const budgetMicros = microUsdc(budget);
  const [operator, setOperator] = useState("");
  const usdc = snapshot?.settlement === "usdc_escrow";
  const operatorOnly =
    snapshot?.local_operator ||
    (snapshot?.principal?.roles.includes("worker") &&
      !snapshot.principal.roles.includes("submitter"));
  const operators =
    snapshot?.nodes?.filter(
      (node) =>
        node.online &&
        !node.operator_paused &&
        !node.offer.paused &&
        node.offer.isolation === "docker_v1" &&
        node.offer.modes.includes("paid"),
    ) ?? [];
  const selectedOperator = operator || operators[0]?.id || "";
  const [selected, setSelected] = useState<SoapboxJob | null>(null);
  // Keep the key after uncertain network errors; editing the request creates a new intent.
  const [intent, setIntent] = useState(() => crypto.randomUUID());

  const refresh = useCallback(async () => {
    const next = await request<SoapboxStatus>("soapbox.status");
    setSnapshot(next);
    setError(null);
  }, [request]);

  useEffect(() => {
    if (!connected) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await request<SoapboxStatus>("soapbox.status");
        if (disposed) return;
        setSnapshot(next);
        setError(null);
      } catch (e) {
        if (!disposed) setError(String(e));
      } finally {
        if (!disposed) timer = setTimeout(() => void poll(), 5000);
      }
    };
    void poll();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [connected, request]);

  useEffect(() => {
    if (
      !connected ||
      !selected ||
      ![
        "queued",
        "running",
        "awaiting_payment",
        "settlement_pending",
        "refund_pending",
        "payment_review",
      ].includes(selected.status)
    )
      return;
    let disposed = false;
    const timer = setTimeout(() => {
      void request<SoapboxJob>("soapbox.job", { id: selected.id }).then(
        (job) => {
          if (!disposed) setSelected(job);
        },
        (e) => {
          if (!disposed) {
            setError(String(e));
            setSelected((current) => current && { ...current });
          }
        },
      );
    }, 2000);
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [connected, request, selected]);

  useEffect(() => {
    setIntent(crypto.randomUUID());
  }, [mode, scope, workload, model, gpu, texts, budget, operator]);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  const scopes = mode === "private" ? snapshot?.principal?.pools : snapshot?.principal?.projects;
  const selectedScope = scope || scopes?.[0] || "";
  const runtimes =
    snapshot?.nodes
      ?.filter(
        (node) =>
          node.online &&
          !node.operator_paused &&
          !node.offer.paused &&
          node.offer.gpu_observed &&
          node.offer.memory_mib >= 1024 &&
          (mode !== "paid" || !usdc || node.id === selectedOperator) &&
          node.offer.modes.includes(mode) &&
          (mode === "paid" ||
            (mode === "private" ? node.offer.pools : node.offer.projects)?.includes(selectedScope)),
      )
      .flatMap((node) => (node.offer.runtime ? [node.offer.runtime] : [])) ?? [];
  const models = [
    ...new Map(
      runtimes.map((runtime) => [`${runtime.model}@${runtime.model_digest}`, runtime]),
    ).values(),
  ];
  const chosenModel = model
    ? models.find((runtime) => `${runtime.model}@${runtime.model_digest}` === model)
    : models[0];
  const inputs = texts.split("\n").filter((text) => text.trim().length > 0);
  const submit = async () => {
    const policy: SoapboxMode =
      mode === "paid"
        ? usdc
          ? {
              kind: "paid_usdc",
              max_cost_microusdc: budgetMicros ?? 0,
              operator: selectedOperator,
            }
          : { kind: "paid", max_cost_credits: Number(budget) }
        : mode === "private"
          ? { kind: "private", pool_id: selectedScope }
          : { kind: "collective", project_id: selectedScope };
    const job = await request<SoapboxJob>("soapbox.submit", {
      idempotency_key: intent,
      mode: policy,
      workload:
        workload === "sha256"
          ? { kind: "sha256", texts: inputs }
          : {
              kind: "embeddings",
              model: chosenModel?.model,
              model_digest: chosenModel?.model_digest,
              texts: inputs,
            },
      resources: {
        cpu_threads: 1,
        memory_mib: workload === "embeddings" ? 1024 : 256,
        require_gpu: workload === "embeddings" && gpu,
      },
    });
    setSelected(job);
    setIntent(crypto.randomUUID());
    await refresh();
  };

  return (
    <div className="h-full overflow-auto p-6 space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">Soapbox Compute</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Run work on resources shared by participating operators.
          </p>
        </div>
        <div className="flex gap-2">
          <button className={button} disabled={!connected} onClick={() => setSetupOpen(true)}>
            Set up buyer or operator
          </button>
          <button
            className={button}
            disabled={!connected || busy}
            onClick={() => void run(refresh)}
          >
            Refresh
          </button>
        </div>
      </div>
      {!connected && <p role="status">Connect to the gateway to use Soapbox.</p>}
      {error && (
        <p role="alert" className="rounded-lg bg-danger/10 p-3 text-sm text-danger">
          {error}
        </p>
      )}
      {setupOpen && <ComputeSetup onClose={() => setSetupOpen(false)} />}
      <MeshPanel />
      {snapshot?.enabled === false && !setupOpen && (
        <div className="rounded-xl border border-border p-5 space-y-2">
          <h2 className="font-medium">Get started with Compute</h2>
          <p className="text-sm text-muted-foreground">
            Choose Buyer to submit work or GPU operator to contribute this device’s resources. Use
            “Set up buyer or operator” above to import your enrollment and prepare this device.
          </p>
        </div>
      )}
      {snapshot?.enabled && (
        <>
          <p className="text-sm text-muted-foreground">
            Participant: {snapshot.principal?.id} · {operatorOnly ? "Operator" : "Buyer"}
          </p>
          {usdc && !operatorOnly && <ComputeWalletPanel />}
          {operatorOnly && (
            <section
              className="rounded-xl border border-border p-4 space-y-2"
              aria-label="Operator account"
            >
              <h2 className="font-medium">Operator · {snapshot.principal?.id}</h2>
              {snapshot.local_operator ? (
                <p className="text-sm">
                  Local P2P pool · private and collective workloads. Grant peers access below; no
                  wallet or payment is required.
                </p>
              ) : (
                <>
                  <p className="text-sm">Payout network: Base Sepolia</p>
                  <p className="font-mono text-xs break-all">{snapshot.payment_account?.address}</p>
                  <p className="text-sm">
                    Confirmed earnings in recent jobs:{" "}
                    {(
                      (snapshot.jobs ?? [])
                        .filter((j) => j.status === "succeeded" && j.payment)
                        .reduce((sum, j) => sum + (j.payment?.amount_microusdc ?? 0), 0) / 1e6
                    ).toFixed(6)}{" "}
                    test USDC
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Only jobs assigned to this operator appear below. Payouts go directly to this
                    address. No buyer wallet is needed.
                  </p>
                </>
              )}
            </section>
          )}
          <div className="rounded-xl border border-warning/30 bg-warning/5 p-4 text-sm">
            {snapshot.local_operator
              ? "P2P pilot · Private and collective jobs use your approved resource limits."
              : usdc
                ? "Pilot network · Paid jobs use Base Sepolia test USDC escrow. Review and fund each quote before execution."
                : "Pilot network · Paid jobs use non-redeemable test credits."}{" "}
            Storage is temporary. Only approved workloads run.
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            {(snapshot.local_operator
              ? [
                  ["Participation", "Private and collective"],
                  ["Access", "Approved peers"],
                  ["Workers online", snapshot.nodes?.filter((n) => n.online).length ?? 0],
                ]
              : usdc
                ? [
                    ["Settlement", "Base Sepolia"],
                    ["Funding", "Per-job escrow"],
                    ["Workers online", snapshot.nodes?.filter((n) => n.online).length ?? 0],
                  ]
                : [
                    ["Available credits", snapshot.account?.available_credits ?? 0],
                    ["Reserved credits", snapshot.account?.reserved_credits ?? 0],
                    ["Workers online", snapshot.nodes?.filter((n) => n.online).length ?? 0],
                  ]
            ).map(([label, value]) => (
              <div key={label} className="rounded-xl border border-border p-4">
                <p className="text-sm text-muted-foreground">{label}</p>
                <p className="text-2xl font-semibold mt-1">{value}</p>
              </div>
            ))}
          </div>
          <div className="grid gap-6 lg:grid-cols-2">
            {!operatorOnly && (
              <form
                className="rounded-xl border border-border p-5 space-y-4"
                onSubmit={(e) => {
                  e.preventDefault();
                  void run(submit);
                }}
              >
                <h2 className="font-medium">Submit a workload</h2>
                <label className="block text-sm">
                  Participation mode
                  <select
                    className={field}
                    value={mode}
                    onChange={(e) => {
                      setMode(e.target.value as SoapboxMode["kind"]);
                      setScope("");
                    }}
                  >
                    <option value="private">Private pool</option>
                    <option value="collective">Collective project</option>
                    <option value="paid">Paid · {usdc ? "test USDC" : "test credits"}</option>
                  </select>
                </label>
                {mode === "paid" ? (
                  <label className="block text-sm">
                    {usdc ? "Maximum test USDC" : "Maximum test credits"}
                    <input
                      className={field}
                      type="number"
                      min={usdc ? 0 : 1}
                      step={usdc ? "any" : 1}
                      max={usdc ? 0.1 : 1000000}
                      value={budget}
                      onChange={(e) => setBudget(e.target.value)}
                    />
                    <span className="text-xs text-muted-foreground">
                      {usdc
                        ? "Use up to 6 decimal places. Submit for an exact quote; funding is a separate step."
                        : `Current quote: ${inputs.length} credits, charged only on acceptance.`}
                    </span>
                  </label>
                ) : (
                  <label className="block text-sm">
                    {mode === "private" ? "Pool" : "Project"}
                    <select
                      className={field}
                      value={selectedScope}
                      onChange={(e) => setScope(e.target.value)}
                    >
                      {!scopes?.length && <option value="">No memberships configured</option>}
                      {scopes?.map((id) => (
                        <option key={id} value={id}>
                          {id}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                {mode === "paid" && usdc && (
                  <label className="block text-sm">
                    Operator
                    <select
                      className={field}
                      value={selectedOperator}
                      onChange={(event) => setOperator(event.target.value)}
                    >
                      {!operators.length && <option value="">No isolated operators ready</option>}
                      {operators.map((node) => (
                        <option key={node.id} value={node.id}>
                          {node.id}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <label className="block text-sm">
                  Workload
                  <select
                    className={field}
                    value={workload}
                    onChange={(e) => setWorkload(e.target.value as "sha256" | "embeddings")}
                  >
                    <option value="sha256">CPU · SHA-256 batch</option>
                    <option value="embeddings">GPU · batch embeddings</option>
                  </select>
                </label>
                {workload === "embeddings" && (
                  <>
                    <label className="block text-sm">
                      Ready model
                      <select
                        className={field}
                        value={
                          chosenModel ? `${chosenModel.model}@${chosenModel.model_digest}` : ""
                        }
                        onChange={(e) => setModel(e.target.value)}
                        required
                      >
                        {!models.length && (
                          <option value="">No GPU models ready for this mode</option>
                        )}
                        {models.map((runtime) => (
                          <option
                            key={`${runtime.model}@${runtime.model_digest}`}
                            value={`${runtime.model}@${runtime.model_digest}`}
                          >
                            {runtime.model} · {runtime.model_digest.slice(0, 12)}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={gpu}
                        onChange={(e) => setGpu(e.target.checked)}
                      />
                      Require full GPU residency
                    </label>
                    <p className="text-xs text-muted-foreground">
                      Embedding results are checked for shape; model quality and GPU residency are
                      not independently attested.
                    </p>
                  </>
                )}
                <label className="block text-sm">
                  Inputs · one per line
                  <textarea
                    className={`${field} min-h-28`}
                    value={texts}
                    onChange={(e) => setTexts(e.target.value)}
                    required
                  />
                </label>
                <button
                  className={button}
                  disabled={
                    busy ||
                    !connected ||
                    !inputs.length ||
                    inputs.length > 128 ||
                    (mode !== "paid" && !selectedScope) ||
                    (workload === "embeddings" && !chosenModel) ||
                    (mode === "paid" &&
                      (usdc
                        ? !selectedOperator || !budgetMicros || budgetMicros > 100_000
                        : Number(budget) < inputs.length))
                  }
                >
                  Submit job
                </button>
              </form>
            )}
            <WorkerPanel
              snapshot={snapshot}
              busy={busy}
              pause={(id, paused) =>
                void run(async () => {
                  await request("soapbox.worker.pause", { id, paused });
                  await refresh();
                })
              }
            />
          </div>
          <div className="rounded-xl border border-border p-5 space-y-3">
            <h2 className="font-medium">Recent jobs</h2>
            {!snapshot.jobs?.length && (
              <p className="text-sm text-muted-foreground">
                {operatorOnly
                  ? "Waiting for assigned work."
                  : "Submit a job to see its progress and receipt here."}
              </p>
            )}
            {snapshot.jobs?.map((job) => (
              <div
                key={job.id}
                className="flex flex-wrap items-center justify-between gap-3 border-b border-border/30 py-2"
              >
                <button
                  className="text-left text-sm"
                  onClick={() =>
                    void run(async () =>
                      setSelected(await request<SoapboxJob>("soapbox.job", { id: job.id })),
                    )
                  }
                >
                  <span className="font-medium">
                    {job.spec.workload.kind} · {job.spec.mode.kind}
                  </span>
                  <span className="block font-mono text-xs text-muted-foreground">{job.id}</span>
                </button>
                <div className="flex items-center gap-3 text-sm">
                  <span>
                    {job.status} · attempt {job.attempts}
                  </span>
                  {!operatorOnly &&
                    ["queued", "running", "awaiting_payment"].includes(job.status) && (
                      <button
                        className="text-danger"
                        disabled={busy}
                        onClick={() =>
                          void run(async () => {
                            await request("soapbox.cancel", { id: job.id });
                            await refresh();
                          })
                        }
                      >
                        Cancel
                      </button>
                    )}
                </div>
              </div>
            ))}
            {selected && (
              <PaymentPanel
                job={selected}
                busy={busy}
                canFund={!operatorOnly}
                fund={() =>
                  void run(async () => {
                    const response = await request<{ job: SoapboxJob }>(
                      "soapbox.payment.fund",
                      { id: selected.id, approval: selected.payment },
                      { timeoutMs: 180000 },
                    );
                    setSelected(response.job);
                    await refresh();
                  })
                }
              />
            )}
            {selected && (
              <details open>
                <summary className="cursor-pointer text-sm">
                  Selected job result and receipt
                </summary>
                <pre className="mt-2 max-h-64 overflow-auto rounded-lg bg-muted/40 p-3 text-xs whitespace-pre-wrap">
                  {JSON.stringify(
                    {
                      id: selected.id,
                      status: selected.status,
                      result: selected.result,
                      receipt: selected.receipt,
                      error: selected.error,
                    },
                    null,
                    2,
                  )}
                </pre>
              </details>
            )}
          </div>
          {!operatorOnly && <ArtifactPanel />}
        </>
      )}
    </div>
  );
}
