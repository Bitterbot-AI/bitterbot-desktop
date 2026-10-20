/**
 * `bitterbot compute` (PLAN-57 Phases 4 and 5): the owner's terminal surface
 * for compute pools. `status` and `jobs` show what the agent sees; `quote`
 * and `approve` handle a paid job (the CLI holds an admin connection, so
 * `compute.approve` binds the funding to that authority; the agent has no
 * equivalent); `pause` rests one of this node's workers; `trust` sets what
 * memory may reach a pool.
 */

import type { Command } from "commander";
import { callGateway } from "../gateway/call.js";
import { defaultRuntime } from "../runtime.js";
import { theme } from "../terminal/theme.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { withProgress } from "./progress.js";

type ComputeRpcOpts = {
  url?: string;
  token?: string;
  password?: string;
  timeout?: string;
  json?: boolean;
  yes?: boolean;
};

export type ComputeQuoteView = {
  jobId: string;
  quote: {
    amountUsdc: number;
    payee: string;
    network: string | null;
    expiresAt: number | null;
    quoteHash: string;
  } | null;
  pendingReview: string | null;
  fundedTx: string | null;
  paid: { enabled: boolean; maxUsdcPerJob: number; maxUsdcPerDay: number };
};

const callOpts = (cmd: Command, defaults?: { timeoutMs?: number }) =>
  cmd
    .option("--url <url>", "Gateway WebSocket URL (defaults to gateway.remote.url when configured)")
    .option("--token <token>", "Gateway token (if required)")
    .option("--password <password>", "Gateway password (password auth)")
    .option("--timeout <ms>", "Timeout in ms", String(defaults?.timeoutMs ?? 30_000))
    .option("--json", "Output JSON", false);

const callGatewayCli = async (method: string, opts: ComputeRpcOpts, params?: unknown) =>
  withProgress(
    {
      label: `Compute ${method}`,
      indeterminate: true,
      enabled: opts.json !== true,
    },
    async () =>
      await callGateway({
        url: opts.url,
        token: opts.token,
        password: opts.password,
        method,
        params,
        timeoutMs: Number(opts.timeout ?? 30_000),
        clientName: GATEWAY_CLIENT_NAMES.CLI,
        mode: GATEWAY_CLIENT_MODES.CLI,
      }),
  );

/** One line per fact, for a person deciding whether to pay. */
export function describeQuote(view: ComputeQuoteView): string[] {
  const lines: string[] = [];
  if (view.fundedTx) {
    lines.push(`Job ${view.jobId} is already funded (transaction ${view.fundedTx}).`);
    return lines;
  }
  if (!view.quote) {
    lines.push(`Job ${view.jobId} is not waiting for payment.`);
    return lines;
  }
  lines.push(`Job ${view.jobId} is waiting for payment.`);
  lines.push(`  Amount: ${view.quote.amountUsdc} USDC`);
  lines.push(`  Payee: ${view.quote.payee}${view.quote.network ? ` (${view.quote.network})` : ""}`);
  if (view.quote.expiresAt) {
    lines.push(`  Quote valid until: ${new Date(view.quote.expiresAt).toISOString()}`);
  }
  if (view.pendingReview) {
    lines.push(`  Pending approval: ${view.pendingReview} (the agent asked for this job)`);
  }
  if (!view.paid.enabled) {
    lines.push("  Paid compute is off (compute.paid.enabled); approving will be refused.");
  } else if (view.quote.amountUsdc > view.paid.maxUsdcPerJob) {
    lines.push(
      `  Above the per-job cap of ${view.paid.maxUsdcPerJob} USDC (compute.paid.maxUsdcPerJob); approving will be refused.`,
    );
  }
  return lines;
}

export type ComputeStatusView = {
  backend: boolean;
  reachable: boolean;
  as_of?: string;
  settlement?: string | null;
  credits?: { available: number; reserved: number; currency: string } | null;
  pools: Array<{
    id: string;
    kind: string;
    trust: string;
    configured_trust?: string;
    workers_online: number;
    workers_total: number;
    gpu_workers_online: number;
  }>;
  workers: Array<{
    id: string;
    online: boolean;
    paused: boolean;
    gpu: boolean;
    model: string | null;
  }>;
  jobs_in_flight: Array<{ id: string; status: string; workload: string; items: number }>;
  paid?: { enabled: boolean; available: boolean; maxUsdcPerJob: number; maxUsdcPerDay: number };
  runtime?: boolean;
};

export type ComputeJobView = {
  id: string;
  status: string;
  mode: string;
  scope: string | null;
  workload: string;
  items: number;
  worker: string | null;
  verification: string | null;
  error: string | null;
  awaiting_usdc: number | null;
};

/** The status a person reads: one line per pool and worker, then what is running. */
export function describeStatus(view: ComputeStatusView): string[] {
  if (!view.backend) {
    return ["No compute backend is loaded on this node (the Soapbox plugin registers one)."];
  }
  const lines: string[] = [];
  lines.push(
    `Coordinator: ${view.reachable ? "reachable" : "unreachable"}${view.as_of ? ` (as of ${view.as_of})` : ""}${view.settlement ? `, settlement ${view.settlement}` : ""}`,
  );
  if (view.credits) {
    lines.push(
      `Credits: ${view.credits.available} available, ${view.credits.reserved} reserved (${view.credits.currency})`,
    );
  }
  if (view.pools.length === 0) {
    lines.push("Pools: none joined (local machine only).");
  } else {
    lines.push("Pools:");
    for (const p of view.pools) {
      const trust =
        p.configured_trust && p.configured_trust !== p.trust
          ? `${p.trust}, configured ${p.configured_trust}`
          : p.trust;
      lines.push(
        `  ${p.id}  ${p.kind}, ${trust}, ${p.workers_online}/${p.workers_total} workers online (${p.gpu_workers_online} GPU)`,
      );
    }
  }
  if (view.workers.length > 0) {
    lines.push("Workers:");
    for (const w of view.workers) {
      const state = w.paused ? "paused" : w.online ? "online" : "offline";
      lines.push(
        `  ${w.id}  ${state}${w.gpu ? ", GPU" : ""}${w.model ? `, model ${w.model}` : ""}`,
      );
    }
  }
  lines.push(
    view.jobs_in_flight.length === 0
      ? "Jobs in flight: none."
      : `Jobs in flight: ${view.jobs_in_flight.map((j) => `${j.id} (${j.status}, ${j.workload} x${j.items})`).join(", ")}`,
  );
  if (view.paid) {
    lines.push(
      `Paid jobs: ${view.paid.enabled ? "enabled" : "off (compute.paid.enabled)"}, ${view.paid.available ? "offered by the coordinator" : "not offered to this node"}; caps ${view.paid.maxUsdcPerJob} USDC per job, ${view.paid.maxUsdcPerDay} per day`,
    );
  }
  if (view.runtime === false) {
    lines.push(
      "Note: no compute runtime is registered; the agent cannot submit and nothing is delivered.",
    );
  }
  return lines;
}

export function describeJobs(jobs: ComputeJobView[]): string[] {
  if (jobs.length === 0) {
    return ["No jobs."];
  }
  return jobs.map((j) => {
    const scope = j.scope ? ` ${j.scope}` : "";
    const worker = j.worker ? ` on ${j.worker}` : "";
    const ver = j.verification ? `, ${j.verification}` : "";
    const usdc = j.awaiting_usdc !== null ? `, awaiting ${j.awaiting_usdc} USDC` : "";
    const err = j.error ? `, error: ${j.error}` : "";
    return `${j.id}  ${j.status}  ${j.mode}${scope}  ${j.workload} x${j.items}${worker}${ver}${usdc}${err}`;
  });
}

export function registerComputeCli(program: Command) {
  const compute = program
    .command("compute")
    .description("Compute pools: status, jobs, paid-job approvals, worker pause and pool trust");

  callOpts(
    compute
      .command("status")
      .description("Pools, workers, credits and jobs in flight, as the agent sees them")
      .action(async (opts: ComputeRpcOpts) => {
        const view = (await callGatewayCli("compute.status", opts, {})) as ComputeStatusView;
        if (opts.json) {
          defaultRuntime.log(JSON.stringify(view, null, 2));
          return;
        }
        for (const line of describeStatus(view)) {
          defaultRuntime.log(line);
        }
      }),
  );

  callOpts(
    compute
      .command("jobs")
      .description("Recent compute jobs")
      .option("--limit <n>", "How many (default 20, max 200)", "20")
      .option("--status <status>", "Only jobs in this status")
      .action(async (opts: ComputeRpcOpts & { limit?: string; status?: string }) => {
        const parsed = Number(opts.limit ?? 20);
        const limit = Number.isFinite(parsed) ? Math.max(1, Math.min(200, Math.floor(parsed))) : 20;
        if (!opts.json && String(limit) !== String(opts.limit ?? 20)) {
          defaultRuntime.log(`Using --limit ${limit} (1 to 200).`);
        }
        const res = (await callGatewayCli("compute.jobs", opts, {
          limit,
          ...(opts.status ? { status: opts.status } : {}),
        })) as { jobs: ComputeJobView[] };
        if (opts.json) {
          defaultRuntime.log(JSON.stringify(res, null, 2));
          return;
        }
        for (const line of describeJobs(res.jobs)) {
          defaultRuntime.log(line);
        }
      }),
  );

  callOpts(
    compute
      .command("pause")
      .description("Pause one of this node's workers (or resume it with --resume)")
      .argument("<workerId>", "Worker id")
      .option("--resume", "Resume instead of pausing", false)
      .action(async (workerId: string, opts: ComputeRpcOpts & { resume?: boolean }) => {
        const res = (await callGatewayCli("compute.pause", opts, {
          workerId,
          paused: !opts.resume,
        })) as { workerId: string; paused: boolean };
        if (opts.json) {
          defaultRuntime.log(JSON.stringify(res, null, 2));
          return;
        }
        defaultRuntime.log(
          `${theme.success(res.paused ? "Paused" : "Resumed")} ${theme.command(res.workerId)}`,
        );
      }),
  );

  callOpts(
    compute
      .command("trust")
      .description("Set a pool's trust: trusted (personal memory may reach it) or untrusted")
      .argument("<poolId>", "Pool id")
      .argument("<level>", "trusted or untrusted")
      .action(async (poolId: string, level: string, opts: ComputeRpcOpts) => {
        if (level !== "trusted" && level !== "untrusted") {
          defaultRuntime.error(`level must be trusted or untrusted, not "${level}"`);
          defaultRuntime.exit(1);
          return;
        }
        const res = (await callGatewayCli("compute.trust", opts, { poolId, trust: level })) as {
          poolId: string;
          trust: string;
          note?: string;
        };
        if (opts.json) {
          defaultRuntime.log(JSON.stringify(res, null, 2));
          return;
        }
        defaultRuntime.log(
          `${theme.success("Set")} compute.pools.${res.poolId}.trust = ${res.trust}.${res.note ? ` ${res.note}` : ""}`,
        );
      }),
  );

  callOpts(
    compute
      .command("quote")
      .description("Show what a paid compute job is waiting for")
      .argument("<jobId>", "Job id")
      .action(async (jobId: string, opts: ComputeRpcOpts) => {
        const view = (await callGatewayCli("compute.quote", opts, { jobId })) as ComputeQuoteView;
        if (opts.json) {
          defaultRuntime.log(JSON.stringify(view, null, 2));
          return;
        }
        for (const line of describeQuote(view)) {
          defaultRuntime.log(line);
        }
      }),
  );

  callOpts(
    compute
      .command("approve")
      .description("Fund a paid compute job at its quoted amount (owner only)")
      .argument("<jobId>", "Job id")
      .option("--yes", "Fund without the confirmation step", false)
      .action(async (jobId: string, opts: ComputeRpcOpts) => {
        const view = (await callGatewayCli("compute.quote", opts, { jobId })) as ComputeQuoteView;
        if (!view.quote || view.fundedTx) {
          if (opts.json) {
            defaultRuntime.log(JSON.stringify({ ok: false, ...view }, null, 2));
          } else {
            for (const line of describeQuote(view)) {
              defaultRuntime.log(line);
            }
          }
          return;
        }
        if (!opts.yes) {
          if (opts.json) {
            defaultRuntime.log(JSON.stringify({ ok: false, confirm: true, ...view }, null, 2));
          } else {
            for (const line of describeQuote(view)) {
              defaultRuntime.log(line);
            }
            defaultRuntime.log("Nothing funded. Re-run with --yes to fund it.");
          }
          return;
        }
        const result = (await callGatewayCli("compute.approve", opts, {
          jobId,
          quoteHash: view.quote.quoteHash,
          via: "cli",
        })) as { txHash?: string; status?: string; amountUsdc?: number; payee?: string };
        if (opts.json) {
          defaultRuntime.log(JSON.stringify(result, null, 2));
          return;
        }
        defaultRuntime.log(
          `${theme.success("Funded")} ${theme.command(jobId)}: ${result.amountUsdc ?? "?"} USDC to ${result.payee ?? "?"}. Transaction ${result.txHash ?? "?"}${result.status ? ` (${result.status})` : ""}.`,
        );
      }),
  );
}
