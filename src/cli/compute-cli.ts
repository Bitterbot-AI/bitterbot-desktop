/**
 * `bitterbot compute` (PLAN-57 §4.8): the owner's terminal surface for paid
 * compute. `quote` shows what a job is waiting for; `approve` funds it. The
 * CLI holds an admin connection, so `compute.approve` binds the funding to
 * that authority; the agent has no equivalent. Phase 5 adds status, jobs,
 * pause and trust here.
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

export function registerComputeCli(program: Command) {
  const compute = program
    .command("compute")
    .description("Compute pools: quotes and approvals for paid jobs");

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
