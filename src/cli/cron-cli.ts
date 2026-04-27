import type { Command } from "commander";
import type { CronJobWire, CronRun } from "../cron/types.js";
import { callGateway } from "../gateway/call.js";
import { defaultRuntime } from "../runtime.js";
import { theme } from "../terminal/theme.js";
import { parseDurationMs } from "./parse-duration.js";

const PRINT_LIMIT = 50;

type RpcParams = Record<string, unknown>;

async function rpc<T = Record<string, unknown>>(
  method: string,
  params: RpcParams = {},
): Promise<T> {
  return callGateway<T>({ method, params });
}

function emit(value: unknown, opts: { json?: boolean }): void {
  if (opts.json) {
    defaultRuntime.log(JSON.stringify(value, null, 2));
    return;
  }
  defaultRuntime.log(typeof value === "string" ? value : JSON.stringify(value, null, 2));
}

function fail(err: unknown): never {
  defaultRuntime.error(err instanceof Error ? err.message : String(err));
  defaultRuntime.exit(1);
  // exit() may be a no-op in tests; throw to terminate the action.
  throw err instanceof Error ? err : new Error(String(err));
}

function pickText(opts: AddOptions): string | undefined {
  return opts.message ?? opts.systemEvent ?? opts.text;
}

function buildSchedule(opts: AddOptions): RpcParams["schedule"] {
  if (opts.at) {
    return { kind: "at", at: resolveAt(opts.at) };
  }
  if (opts.every) {
    return { kind: "every", everyMs: parseDurationMs(opts.every) };
  }
  if (opts.cron) {
    return opts.tz
      ? { kind: "cron", expr: opts.cron, tz: opts.tz }
      : { kind: "cron", expr: opts.cron };
  }
  throw new Error("specify a schedule via --at, --every, or --cron");
}

function resolveAt(input: string): string {
  // Accept either an ISO 8601 timestamp (passed through) or a duration like
  // "20m" / "2h" — which the docs use to mean "20 minutes from now".
  const trimmed = input.trim();
  if (/^\d{4}-\d{2}-\d{2}T/.test(trimmed) || /^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}/.test(trimmed)) {
    return trimmed;
  }
  try {
    const ms = parseDurationMs(trimmed);
    return new Date(Date.now() + ms).toISOString();
  } catch {
    // Fall back to passing through; Date.parse handles many other formats.
    return trimmed;
  }
}

function buildAddParams(opts: AddOptions): RpcParams {
  const schedule = buildSchedule(opts);
  const text = pickText(opts);
  if (!text) {
    throw new Error("specify the prompt with --message, --system-event, or --text");
  }
  const sessionTarget =
    opts.session === "main" || opts.session === "isolated" ? opts.session : undefined;
  const params: RpcParams = {
    schedule,
    name: opts.name,
    description: opts.description,
    enabled: opts.enabled !== false,
    notify: opts.notify,
    deleteAfterRun: opts.keepAfterRun ? false : opts.deleteAfterRun,
    keepAfterRun: opts.keepAfterRun,
    agentId: opts.agent,
    wakeMode: opts.wake,
  };
  if (sessionTarget) {
    params.sessionTarget = sessionTarget;
  }
  if (opts.message) {
    params.payload = buildAgentTurnPayload(opts);
  } else if (opts.systemEvent) {
    params.payload = { kind: "systemEvent", text: opts.systemEvent };
  } else if (opts.text) {
    params.text = opts.text;
  }
  if (opts.announce) {
    params.announce = true;
  }
  if (opts.noDeliver) {
    params.noDeliver = true;
  }
  if (opts.channel) {
    params.channel = opts.channel;
  }
  if (opts.to) {
    params.to = opts.to;
  }
  if (opts.bestEffort) {
    params.delivery = {
      mode: opts.announce ? "announce" : "none",
      channel: opts.channel,
      to: opts.to,
      bestEffort: true,
    };
  }
  return prune(params);
}

function buildAgentTurnPayload(opts: AddOptions): RpcParams {
  const payload: RpcParams = { kind: "agentTurn", message: opts.message };
  if (opts.model) {
    payload.model = opts.model;
  }
  if (opts.thinking) {
    payload.thinking = opts.thinking;
  }
  if (typeof opts.timeoutSeconds === "number") {
    payload.timeoutSeconds = opts.timeoutSeconds;
  }
  return payload;
}

function prune<T extends RpcParams>(input: T): T {
  for (const key of Object.keys(input)) {
    if (input[key] === undefined) {
      delete input[key];
    }
  }
  return input;
}

function formatJobLine(job: CronJobWire): string {
  const stateGlyph = job.enabled ? theme.success("●") : theme.muted("○");
  const next = typeof job.nextRunAt === "number" ? new Date(job.nextRunAt).toISOString() : "-";
  const last = typeof job.lastRunAt === "number" ? new Date(job.lastRunAt).toISOString() : "-";
  const target = job.sessionTarget ?? "?";
  return [
    `${stateGlyph} ${theme.heading(job.id)}  ${theme.muted(job.label ?? "(unnamed)")}`,
    `   schedule: ${theme.muted(job.schedule)}  target: ${target}`,
    `   next: ${next}   last: ${last}`,
    `   text: ${truncate(job.text, 100)}`,
  ].join("\n");
}

function truncate(input: string | undefined, max: number): string {
  if (!input) {
    return "";
  }
  if (input.length <= max) {
    return input;
  }
  return `${input.slice(0, max - 1)}…`;
}

type AddOptions = {
  json?: boolean;
  name?: string;
  description?: string;
  at?: string;
  every?: string;
  cron?: string;
  tz?: string;
  session?: string;
  message?: string;
  systemEvent?: string;
  text?: string;
  wake?: "now" | "next-heartbeat";
  announce?: boolean;
  noDeliver?: boolean;
  deliver?: string;
  channel?: string;
  to?: string;
  agent?: string;
  enabled?: boolean;
  notify?: boolean;
  keepAfterRun?: boolean;
  deleteAfterRun?: boolean;
  model?: string;
  thinking?: string;
  timeoutSeconds?: number;
  bestEffort?: boolean;
};

export function registerCronCli(program: Command): void {
  const cmd = program.command("cron").description("Manage cron jobs for the gateway scheduler");

  cmd
    .command("list")
    .description("List configured cron jobs")
    .option("--json", "Output as JSON")
    .option("--include-disabled", "Include disabled jobs (default: true)")
    .option("--no-include-disabled", "Hide disabled jobs")
    .action(async (opts: { json?: boolean; includeDisabled?: boolean }) => {
      try {
        const res = await rpc<{ jobs: CronJobWire[] }>("cron.list", {
          includeDisabled: opts.includeDisabled !== false,
        });
        const jobs = res.jobs ?? [];
        if (opts.json) {
          emit(jobs, opts);
          return;
        }
        if (jobs.length === 0) {
          defaultRuntime.log(theme.muted("no cron jobs configured"));
          return;
        }
        defaultRuntime.log(jobs.map(formatJobLine).join("\n\n"));
      } catch (err) {
        fail(err);
      }
    });

  cmd
    .command("status")
    .description("Show cron engine status")
    .option("--json", "Output as JSON")
    .action(async (opts: { json?: boolean }) => {
      try {
        const status = await rpc("cron.status");
        emit(status, opts);
      } catch (err) {
        fail(err);
      }
    });

  cmd
    .command("add")
    .description("Schedule a new cron job")
    .option("--json", "Output as JSON")
    .option("--name <name>", "Display label")
    .option("--description <text>", "Description")
    .option("--at <iso-or-duration>", "One-shot timestamp or duration (20m, 2h, ISO 8601)")
    .option("--every <duration>", "Recurring interval (e.g. 10m, 1h)")
    .option("--cron <expr>", "5/6/7-field cron expression")
    .option("--tz <timezone>", "IANA timezone for cron schedules")
    .option("--session <main|isolated>", "Session target")
    .option("--message <text>", "Prompt text for an isolated agent turn")
    .option("--system-event <text>", "System-event payload for main-session jobs")
    .option("--text <text>", "Generic prompt text (auto-routes by session target)")
    .option("--wake <now|next-heartbeat>", "When to wake the heartbeat after firing")
    .option("--announce", "Announce the result over an outbound channel")
    .option("--no-deliver", "Skip outbound delivery (isolated jobs only)")
    .option(
      "--deliver <mode>",
      '"announce" or "none" (deprecated alias for --announce/--no-deliver)',
    )
    .option("--channel <name>", "Outbound channel (whatsapp, telegram, slack, …)")
    .option("--to <target>", "Channel-specific recipient identifier")
    .option("--agent <agentId>", "Pin the job to a specific agent")
    .option("--no-enabled", "Create the job in a disabled state")
    .option("--notify", "Post finished-run events to cron.webhook")
    .option("--keep-after-run", "Keep one-shot jobs after success (disable instead of delete)")
    .option("--delete-after-run", "Delete one-shot jobs after success (default for --at)")
    .option("--model <ref>", "Model override (isolated jobs only)")
    .option("--thinking <level>", "Thinking level (isolated jobs only)")
    .option("--timeout-seconds <s>", "Per-run timeout (isolated jobs)", parseInt)
    .option("--best-effort", "Tolerate delivery failures without erroring the job")
    .action(async (opts: AddOptions) => {
      try {
        if (!opts.session) {
          opts.session = opts.cron || opts.every ? "isolated" : "main";
        }
        if (opts.deliver === "announce") {
          opts.announce = true;
        }
        if (opts.deliver === "none") {
          opts.noDeliver = true;
        }
        const params = buildAddParams(opts);
        const job = await rpc<CronJobWire>("cron.add", params);
        if (opts.json) {
          emit(job, opts);
          return;
        }
        defaultRuntime.log(theme.success(`scheduled ${job.id}`));
        defaultRuntime.log(formatJobLine(job));
      } catch (err) {
        fail(err);
      }
    });

  cmd
    .command("edit <jobId>")
    .description("Patch fields on an existing cron job")
    .option("--json", "Output as JSON")
    .option("--name <name>")
    .option("--description <text>")
    .option("--at <iso-or-duration>")
    .option("--every <duration>")
    .option("--cron <expr>")
    .option("--tz <timezone>")
    .option("--session <main|isolated>")
    .option("--message <text>")
    .option("--system-event <text>")
    .option("--wake <now|next-heartbeat>")
    .option("--announce")
    .option("--no-deliver")
    .option("--channel <name>")
    .option("--to <target>")
    .option("--agent <agentId>")
    .option("--clear-agent")
    .option("--enable")
    .option("--disable")
    .option("--notify")
    .option("--no-notify")
    .option("--keep-after-run")
    .option("--delete-after-run")
    .option("--model <ref>")
    .option("--thinking <level>")
    .action(
      async (
        jobId: string,
        opts: AddOptions & { enable?: boolean; disable?: boolean; clearAgent?: boolean },
      ) => {
        try {
          const patch: RpcParams = {};
          if (opts.name !== undefined) {
            patch.name = opts.name;
          }
          if (opts.description !== undefined) {
            patch.description = opts.description;
          }
          if (opts.at || opts.every || opts.cron) {
            patch.schedule = buildSchedule(opts as AddOptions);
          }
          if (opts.session) {
            patch.sessionTarget = opts.session;
          }
          if (opts.message) {
            patch.payload = buildAgentTurnPayload(opts);
          } else if (opts.systemEvent) {
            patch.payload = { kind: "systemEvent", text: opts.systemEvent };
          }
          if (opts.wake) {
            patch.wakeMode = opts.wake;
          }
          if (opts.announce) {
            patch.delivery = { mode: "announce", channel: opts.channel, to: opts.to };
          } else if (opts.noDeliver === true) {
            patch.delivery = { mode: "none" };
          }
          if (opts.clearAgent) {
            patch.agentId = null;
          } else if (opts.agent) {
            patch.agentId = opts.agent;
          }
          if (opts.enable) {
            patch.enabled = true;
          }
          if (opts.disable) {
            patch.enabled = false;
          }
          if (opts.notify === true) {
            patch.notify = true;
          }
          if (opts.notify === false) {
            patch.notify = false;
          }
          if (opts.keepAfterRun) {
            patch.deleteAfterRun = false;
          }
          if (opts.deleteAfterRun) {
            patch.deleteAfterRun = true;
          }
          const job = await rpc<CronJobWire>("cron.update", { jobId, patch: prune(patch) });
          if (opts.json) {
            emit(job, opts);
            return;
          }
          defaultRuntime.log(theme.success(`updated ${job.id}`));
          defaultRuntime.log(formatJobLine(job));
        } catch (err) {
          fail(err);
        }
      },
    );

  cmd
    .command("run <jobId>")
    .description("Run a cron job now")
    .option("--json", "Output as JSON")
    .option("--due", "Only run if the job is currently due")
    .action(async (jobId: string, opts: { json?: boolean; due?: boolean }) => {
      try {
        const run = await rpc<CronRun>("cron.run", { jobId, mode: opts.due ? "due" : "force" });
        emit(run, opts);
      } catch (err) {
        fail(err);
      }
    });

  cmd
    .command("remove <jobId>")
    .description("Delete a cron job")
    .option("--json", "Output as JSON")
    .action(async (jobId: string, opts: { json?: boolean }) => {
      try {
        const res = await rpc<{ ok: boolean }>("cron.remove", { jobId });
        emit(res, opts);
      } catch (err) {
        fail(err);
      }
    });

  cmd
    .command("runs")
    .description("Show recent runs for a cron job")
    .option("--json", "Output as JSON")
    .option("--id <jobId>", "Job to inspect")
    .option("--limit <n>", "Number of runs to return", parseInt, PRINT_LIMIT)
    .action(async (opts: { json?: boolean; id?: string; limit?: number }) => {
      try {
        if (!opts.id) {
          throw new Error("--id <jobId> is required");
        }
        const res = await rpc<{ runs: CronRun[]; count: number }>("cron.runs", {
          jobId: opts.id,
          limit: opts.limit,
        });
        if (opts.json) {
          emit(res, opts);
          return;
        }
        const runs = res.runs ?? [];
        if (runs.length === 0) {
          defaultRuntime.log(theme.muted("no run history"));
          return;
        }
        for (const run of runs) {
          const ts = new Date(run.ts).toISOString();
          const status = run.status === "ok" ? theme.success(run.status) : theme.warn(run.status);
          const ms = run.durationMs ? `${run.durationMs}ms` : "-";
          const detail = run.error ? ` ${theme.muted(run.error)}` : "";
          defaultRuntime.log(`${ts}  ${status}  ${ms}  trigger=${run.trigger ?? "-"}${detail}`);
        }
      } catch (err) {
        fail(err);
      }
    });
}
