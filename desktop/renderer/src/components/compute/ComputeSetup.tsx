import { useCallback, useEffect, useState } from "react";
import type { SoapboxSetupStatus } from "../../../../../src/infra/soapbox-setup-types";
import { useGatewayStore } from "../../stores/gateway-store";
import { SoapboxLogo } from "./SoapboxLogo";

const button = "rounded-lg bg-brand px-4 py-2 text-sm text-white disabled:opacity-40";
const field = "w-full rounded-lg border border-border bg-background px-3 py-2 text-sm";
const emptyCredentials = { apiKeyId: "", apiKeySecret: "", walletSecret: "" };

export function ComputeSetup({ onClose }: { onClose: () => void }) {
  const request = useGatewayStore((s) => s.request);
  const connected = useGatewayStore((s) => s.status === "connected");
  const [status, setStatus] = useState<SoapboxSetupStatus>();
  const [role, setRole] = useState<"buyer" | "operator">("buyer");
  const [credentials, setCredentials] = useState(emptyCredentials);
  const [customCredentials, setCustomCredentials] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [connectionError, setConnectionError] = useState("");
  const [upload, setUpload] = useState<number>();
  const [activating, setActivating] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [remoteOperator, setRemoteOperator] = useState(false);
  const refresh = useCallback(async () => {
    const next = await request<SoapboxSetupStatus>("soapbox.setup.status");
    setStatus(next);
    if (next.enrollment) {
      setRole(next.enrollment.role);
      setRemoteOperator(next.enrollment.role === "operator");
    }
  }, [request]);
  useEffect(() => {
    if (!connected) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await request<SoapboxSetupStatus>("soapbox.setup.status");
        if (!disposed) {
          setStatus(next);
          setConnectionError("");
          if (next.enrollment) {
            setRole(next.enrollment.role);
            setRemoteOperator(next.enrollment.role === "operator");
          }
        }
      } catch (e) {
        if (!disposed && !activating) setConnectionError(String(e));
      } finally {
        if (!disposed) timer = setTimeout(() => void poll(), 2000);
      }
    };
    void poll();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [request, connected, activating]);
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await action();
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  const enrolled = status?.enrollment?.role === role;
  const preparing =
    status?.progress.state === "preparing" || status?.progress.state === "uploading";
  const locked = busy || preparing || !connected || activating;

  const importEnrollment = async (file: File) => {
    if (file.size > 16384) throw new Error("Enrollment files must be smaller than 16 KB");
    await request("soapbox.setup.import", { enrollment: JSON.parse(await file.text()), role });
    setAcknowledged(false);
  };
  const importRuntime = async (file: File) => {
    if (!status || file.size !== status.release.bytes)
      throw new Error("Select the approved runtime archive from the linked release");
    setUpload(0);
    try {
      const started = await request<{ id: string }>("soapbox.setup.runtime.begin");
      for (let offset = 0; offset < file.size; ) {
        const bytes = new Uint8Array(await file.slice(offset, offset + 262144).arrayBuffer());
        let binary = "";
        for (let i = 0; i < bytes.length; i += 8192)
          binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
        const next = await request<{ offset: number }>("soapbox.setup.runtime.chunk", {
          id: started.id,
          offset,
          data: btoa(binary),
        });
        offset = next.offset;
        setUpload(Math.floor((offset / file.size) * 100));
      }
      await request("soapbox.setup.runtime.prepare", { id: started.id });
    } finally {
      setUpload(undefined);
    }
  };

  return (
    <section aria-label="Compute setup" className="rounded-xl border border-border p-5 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <SoapboxLogo compact />
          <h2 className="font-semibold">Set up this device</h2>
        </div>
        <button className="text-sm underline" disabled={busy} onClick={onClose}>
          Close setup
        </button>
      </div>
      <p className="text-sm text-muted-foreground">
        Base Sepolia test network. Compute uses a separate wallet and spending history. Your main
        wallet stays on its current network.
      </p>
      {(error || connectionError) && (
        <p role="alert" className="text-sm text-danger">
          {error || connectionError}
        </p>
      )}
      {!status && <p role="status">Loading setup…</p>}
      {status?.configured ? (
        <div className="space-y-2">
          <p role="status">
            {status.configuredRole === "mesh-operator"
              ? "This device is configured as a P2P GPU operator."
              : `Compute is configured on this gateway (${status.configuredRole}).`}
          </p>
          <p className="text-sm">
            Use the Compute dashboard to submit work or manage your operator. Run setup on the
            tester’s own Bitterbot app.
          </p>
          <button className={button} onClick={onClose}>
            Open Compute dashboard
          </button>
        </div>
      ) : (
        status && (
          <>
            <fieldset disabled={locked || Boolean(status.enrollment)} className="space-y-2">
              <legend className="text-sm font-medium">How will this device participate?</legend>
              <label className="mr-5 text-sm">
                <input
                  type="radio"
                  name="compute-role"
                  checked={role === "buyer"}
                  onChange={() => setRole("buyer")}
                />{" "}
                Buyer · submit jobs
              </label>
              <label className="text-sm">
                <input
                  type="radio"
                  name="compute-role"
                  checked={role === "operator"}
                  onChange={() => setRole("operator")}
                />{" "}
                GPU operator · share this device
              </label>
            </fieldset>
            {role === "operator" && !status.enrollment && (
              <div className="rounded-lg border border-border p-4 space-y-3">
                <h3 className="font-medium">Host a P2P compute pool</h3>
                <p className="text-sm">
                  Enable an isolated GPU operator with one CPU thread and 2 GiB of host memory.
                  Setup checks Docker and NVIDIA support, prepares the model, and verifies
                  execution. Ubuntu 24.04 or WSL2 and 4 GiB free disk are required.
                </p>
                <p className="text-sm">
                  Your pools are <strong>private</strong> and <strong>community</strong>. After
                  setup, grant selected Bitterbot peers access in P2P Compute. No enrollment file or
                  wallet is needed for these private and collective jobs.
                </p>
                <p className="text-sm text-muted-foreground">
                  The first setup downloads the runtime model and may take several minutes. You can
                  pause new work from Compute.
                </p>
                <button
                  className={button}
                  disabled={
                    locked ||
                    !status.platformSupported ||
                    !status.bundledRuntimeAvailable ||
                    Boolean(status.enrollment)
                  }
                  onClick={() =>
                    void run(async () => {
                      await request("soapbox.setup.operator.enable");
                    })
                  }
                >
                  Enable this GPU operator
                </button>
                {!status.platformSupported && (
                  <p role="alert">This operator requires an Ubuntu x64 or WSL2 gateway.</p>
                )}
                {!status.bundledRuntimeAvailable && (
                  <p role="alert">
                    Install the current Compute release to include the approved runtime.
                  </p>
                )}
                <div role="status" aria-live="polite">
                  <p className="text-sm">
                    {status.progress.state === "idle"
                      ? "Ready to prepare this operator."
                      : status.progress.message}
                  </p>
                  <progress
                    className="w-full"
                    aria-label="Local operator setup progress"
                    max={100}
                    value={status.progress.percent}
                  />
                </div>
                <label className="block text-sm">
                  <input
                    type="checkbox"
                    checked={remoteOperator}
                    disabled={locked || Boolean(status.enrollment)}
                    onChange={(e) => setRemoteOperator(e.target.checked)}
                  />{" "}
                  Connect to an existing coordinator for paid Base Sepolia jobs instead
                </label>
              </div>
            )}
            {role === "buyer" && (
              <div className="space-y-3 rounded-lg bg-muted/20 p-4">
                <h3 className="font-medium">1. Create your Compute test wallet</h3>
                {status.walletAddress ? (
                  <>
                    <p className="text-xs font-mono break-all" aria-label="Test wallet address">
                      {status.walletAddress}
                    </p>
                    <p className="text-sm">
                      Share this public address with the coordinator owner to receive your buyer
                      enrollment. Fund it with Base Sepolia test USDC and test ETH for gas.
                    </p>
                    <p className="text-sm">
                      Limits: 0.10 test USDC per job and 1 test USDC per day. Each job’s funding
                      requires your approval in Compute.
                    </p>
                  </>
                ) : (
                  <>
                    {status.hasWalletCredentials && (
                      <label className="block text-sm">
                        <input
                          type="checkbox"
                          checked={customCredentials}
                          onChange={(e) => setCustomCredentials(e.target.checked)}
                          disabled={locked}
                        />{" "}
                        Use different CDP credentials for Compute
                      </label>
                    )}
                    {!status.hasWalletCredentials || customCredentials ? (
                      <>
                        <p className="text-sm">
                          Enter your Coinbase Developer Platform API key and wallet secret. These
                          are stored privately on this gateway for the Compute test wallet.
                        </p>
                        {(
                          [
                            ["apiKeyId", "CDP API key ID"],
                            ["apiKeySecret", "CDP API key secret"],
                            ["walletSecret", "CDP wallet secret"],
                          ] as const
                        ).map(([key, label]) => (
                          <label key={key} className="block text-sm">
                            {label}
                            <input
                              type="password"
                              autoComplete="off"
                              className={field}
                              value={credentials[key]}
                              disabled={locked}
                              onChange={(e) =>
                                setCredentials({ ...credentials, [key]: e.target.value })
                              }
                            />
                          </label>
                        ))}
                      </>
                    ) : (
                      <p className="text-sm">
                        Use the CDP credentials already configured on this gateway to create a
                        separate Base Sepolia account.
                      </p>
                    )}
                    <button
                      className={button}
                      disabled={
                        locked ||
                        ((!status.hasWalletCredentials || customCredentials) &&
                          Object.values(credentials).some((v) => !v.trim()))
                      }
                      onClick={() =>
                        void run(async () => {
                          try {
                            await request(
                              "soapbox.setup.wallet",
                              !status.hasWalletCredentials || customCredentials
                                ? { credentials }
                                : {},
                              { timeoutMs: 120000 },
                            );
                          } finally {
                            setCredentials(emptyCredentials);
                          }
                        })
                      }
                    >
                      Create test wallet
                    </button>
                  </>
                )}
              </div>
            )}
            {(role === "buyer" || remoteOperator) && (
              <div className="space-y-2">
                <h3 className="font-medium">
                  {role === "buyer" ? "2" : "1"}. Import your {role} enrollment
                </h3>
                <p className="text-sm text-muted-foreground">
                  Choose the private enrollment JSON supplied by the coordinator owner.{" "}
                  {role === "operator" &&
                    "It must contain the Base Sepolia address where you want to receive payouts. No wallet signing keys are needed."}
                </p>
                <label className="block text-sm">
                  Enrollment file
                  <input
                    className={field}
                    type="file"
                    accept=".json,application/json"
                    disabled={locked || (role === "buyer" && !status.walletAddress)}
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      e.target.value = "";
                      if (file) void run(() => importEnrollment(file));
                    }}
                  />
                </label>
              </div>
            )}
            {role === "operator" && remoteOperator && (
              <div className="space-y-2">
                <h3 className="font-medium">2. Prepare your GPU</h3>
                <p className="text-sm">
                  Requires an Ubuntu x64 gateway (including WSL2), Docker with NVIDIA GPU support
                  and swap limits, plus 3 GB of free disk space.
                </p>
                {!status.platformSupported && (
                  <p role="alert" className="text-warning text-sm">
                    This gateway platform cannot run the current GPU runtime. Use a Linux or WSL2
                    gateway, or choose Buyer.
                  </p>
                )}
                {status.bundledRuntimeAvailable ? (
                  <div className="space-y-2">
                    <p className="text-sm">
                      The approved GPU runtime is included in this installation.
                    </p>
                    <button
                      className={button}
                      disabled={locked || !enrolled || !status.platformSupported}
                      onClick={() =>
                        void run(async () => {
                          await request("soapbox.setup.runtime.bundled");
                        })
                      }
                    >
                      Prepare GPU runtime
                    </button>
                  </div>
                ) : (
                  <>
                    <p className="text-sm">
                      <a
                        className="underline"
                        href={status.release.url}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Download the approved runtime from the release
                      </a>
                      , then choose{" "}
                      <span className="font-mono text-xs">{status.release.filename}</span> below.
                      The runtime checksum is verified before execution.
                    </p>
                    <label className="block text-sm">
                      GPU runtime archive
                      <input
                        className={field}
                        type="file"
                        accept=".gz"
                        disabled={locked || !enrolled || !status.platformSupported}
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          e.target.value = "";
                          if (file) void run(() => importRuntime(file));
                        }}
                      />
                    </label>
                  </>
                )}
                {(upload !== undefined || status.progress.state !== "idle") && (
                  <div role="status" aria-live="polite">
                    <p className="text-sm">
                      {upload !== undefined
                        ? `Uploading runtime · ${upload}%`
                        : status.progress.message}
                    </p>
                    <progress
                      className="w-full"
                      aria-label="GPU setup progress"
                      max={100}
                      value={upload ?? status.progress.percent}
                    />
                  </div>
                )}
              </div>
            )}
            {enrolled && status.enrollment && (
              <div className="rounded-lg border border-border p-4 space-y-3">
                <h3 className="font-medium">Review and activate</h3>
                <dl className="text-sm space-y-1">
                  <div>
                    <dt className="inline font-medium">Participant: </dt>
                    <dd className="inline">
                      {status.enrollment.id} · {role}
                    </dd>
                  </div>
                  <div>
                    <dt className="inline font-medium">Coordinator: </dt>
                    <dd className="inline break-all">{status.enrollment.url}</dd>
                  </div>
                  <div>
                    <dt className="inline font-medium">
                      {role === "operator" ? "Payout" : "Buyer"} address:{" "}
                    </dt>
                    <dd className="inline font-mono text-xs break-all">
                      {status.enrollment.address}
                    </dd>
                  </div>
                  <div>
                    <dt className="inline font-medium">Network: </dt>
                    <dd className="inline">Base Sepolia (84532)</dd>
                  </div>
                </dl>
                <label className="flex gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={acknowledged}
                    disabled={locked}
                    onChange={(e) => setAcknowledged(e.target.checked)}
                  />
                  {role === "operator"
                    ? "Allow this device to run approved paid workloads with 2 GiB of memory. I can pause new work from Compute."
                    : "Use this test wallet for Compute. I will review and fund each job separately."}
                </label>
                <button
                  className={button}
                  disabled={
                    locked ||
                    !acknowledged ||
                    (role === "operator" && status.progress.state !== "ready")
                  }
                  onClick={() =>
                    void run(async () => {
                      await request("soapbox.setup.activate");
                      setActivating(true);
                    })
                  }
                >
                  Activate {role}
                </button>
                {activating && (
                  <p role="status">
                    Setup saved. The gateway is reconnecting; Compute will show your participant
                    when ready.
                  </p>
                )}
              </div>
            )}
          </>
        )
      )}
    </section>
  );
}
