import type { Command } from "commander";
import os from "node:os";
import path from "node:path";
import { CheckpointStore } from "../checkpoints/store.js";
import { defaultRuntime } from "../runtime.js";

/**
 * `bitterbot checkpoints` — operate on the session checkpoint graph
 * directly from the CLI. Opens the local checkpoint DB without going
 * through the gateway, so it works even when the gateway is offline.
 *
 * PLAN-14 Pillar 6 #2: ship the inspection + fork primitives so we can
 * point at a long run, fork from any step, and let Pillar 5 long-horizon
 * runtime resume from the fork point.
 */

const DEFAULT_DB_REL = ".bitterbot/checkpoints.sqlite";

function resolveDbPath(override?: string): string {
  if (override && override.trim().length > 0) {
    return override;
  }
  if (process.env.BITTERBOT_CHECKPOINT_DB) {
    return process.env.BITTERBOT_CHECKPOINT_DB;
  }
  return path.join(os.homedir(), DEFAULT_DB_REL);
}

function withStore<T>(dbPath: string | undefined, fn: (store: CheckpointStore) => T): T {
  const resolved = resolveDbPath(dbPath);
  const store = CheckpointStore.open(resolved);
  try {
    return fn(store);
  } finally {
    store.close();
  }
}

function emit(value: unknown, opts: { json?: boolean }): void {
  if (opts.json) {
    defaultRuntime.log(JSON.stringify(value, null, 2));
    return;
  }
  defaultRuntime.log(typeof value === "string" ? value : JSON.stringify(value, null, 2));
}

export function registerCheckpointsCli(program: Command): void {
  const cmd = program
    .command("checkpoints")
    .description("Inspect, fork, and replay session checkpoint graphs");

  cmd
    .command("threads")
    .description("List threads with checkpoints, most-recent first")
    .option("--db <path>", "Override checkpoint DB path")
    .option("--limit <n>", "Max threads to return", "100")
    .option("--json", "Emit raw JSON")
    .action((opts: { db?: string; limit?: string; json?: boolean }) => {
      const limit = Number.parseInt(opts.limit ?? "100", 10);
      const threads = withStore(opts.db, (s) => s.listThreads(limit));
      if (opts.json) return emit(threads, { json: true });
      if (threads.length === 0) {
        defaultRuntime.log("(no threads)");
        return;
      }
      for (const t of threads) {
        const when = new Date(t.lastTs).toISOString();
        defaultRuntime.log(`${t.threadId}\t${t.steps} steps\tlast=${when}`);
      }
    });

  cmd
    .command("list <threadId>")
    .description("List checkpoints in a thread (oldest-first)")
    .option("--db <path>", "Override checkpoint DB path")
    .option("--limit <n>", "Max checkpoints", "1000")
    .option("--json", "Emit raw JSON")
    .action((threadId: string, opts: { db?: string; limit?: string; json?: boolean }) => {
      const limit = Number.parseInt(opts.limit ?? "1000", 10);
      const rows = withStore(opts.db, (s) => s.list(threadId, { limit }));
      if (opts.json) return emit(rows, { json: true });
      if (rows.length === 0) {
        defaultRuntime.log(`(no checkpoints in ${threadId})`);
        return;
      }
      for (const r of rows) {
        const when = new Date(r.ts).toISOString();
        const parent = r.parentStepId ?? "-";
        const lbl = r.label ? ` "${r.label}"` : "";
        defaultRuntime.log(`${when}\t${r.kind}\t${r.stepId}\tparent=${parent}${lbl}`);
      }
    });

  cmd
    .command("show <threadId> <stepId>")
    .description("Print a single checkpoint's full state")
    .option("--db <path>", "Override checkpoint DB path")
    .option("--json", "Emit raw JSON (default for this command)")
    .action((threadId: string, stepId: string, opts: { db?: string; json?: boolean }) => {
      const cp = withStore(opts.db, (s) => s.get(threadId, stepId));
      if (!cp) {
        defaultRuntime.error(`no checkpoint at ${threadId}@${stepId}`);
        defaultRuntime.exit(1);
        return;
      }
      emit(cp, { json: opts.json !== false });
    });

  cmd
    .command("fork <threadId> <stepId>")
    .description("Fork a thread from the named step into a new thread")
    .option("--db <path>", "Override checkpoint DB path")
    .option("--new-thread <id>", "Override the new thread id")
    .option("--json", "Emit raw JSON")
    .action(
      (
        threadId: string,
        stepId: string,
        opts: { db?: string; newThread?: string; json?: boolean },
      ) => {
        const newId = withStore(opts.db, (s) =>
          s.fork(threadId, stepId, { newThreadId: opts.newThread }),
        );
        emit({ newThreadId: newId, forkedFrom: { threadId, stepId } }, { json: !!opts.json });
      },
    );

  cmd
    .command("delete <threadId>")
    .description("Delete every checkpoint in a thread")
    .option("--db <path>", "Override checkpoint DB path")
    .option("--json", "Emit raw JSON")
    .action((threadId: string, opts: { db?: string; json?: boolean }) => {
      const removed = withStore(opts.db, (s) => s.deleteThread(threadId));
      emit({ threadId, removed }, { json: !!opts.json });
    });
}
