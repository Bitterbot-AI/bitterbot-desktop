import type { Command } from "commander";
import { callGateway } from "../gateway/call.js";
import { defaultRuntime } from "../runtime.js";
import { theme } from "../terminal/theme.js";

// PLAN-54: the curiosity loop from the terminal. Same RPCs as the Curiosity
// page: see what the agent wonders about and what it learned, pause or
// resume it, hand it a question, or make it look into something now.

type Status = {
  enabled: boolean;
  disabledBy: string | null;
  paused: boolean;
  searchConfigured: boolean;
  intervalMinutes: number;
  nextRunAt: number | null;
  today: { attempted: number; budget: number };
  openQuestions: number;
  totals: { learned: number; used: number; roi: number; costUsd: number };
  last30d: { learned: number; used: number; roi: number; costUsd: number };
};

type Listing = {
  wondering: Array<{
    id: string;
    description: string;
    attempts: number;
    lastOutcome: string | null;
    source: string | null;
    heldPhrase: string | null;
  }>;
  learned: Array<{
    id: string;
    question: string;
    answer: string;
    confidence: number;
    sources: Array<{ url: string }>;
    createdAt: number;
    usedCount: number;
    costUsd: number;
    verified: boolean;
    current: boolean;
  }>;
  closed: Array<{ id: string; description: string; outcome: string | null }>;
};

async function rpc<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  return callGateway<T>({ method, params });
}

function emit(value: unknown, opts: { json?: boolean }): boolean {
  if (opts.json) {
    defaultRuntime.log(JSON.stringify(value, null, 2));
    return true;
  }
  return false;
}

function fail(err: unknown): never {
  defaultRuntime.error(err instanceof Error ? err.message : String(err));
  defaultRuntime.exit(1);
  throw err instanceof Error ? err : new Error(String(err));
}

const when = (ms: number | null) => (ms ? new Date(ms).toLocaleString() : "—");

export function formatStatus(s: Status): string {
  const state = s.paused
    ? "paused"
    : !s.enabled
      ? `off (${s.disabledBy ?? "config"})`
      : !s.searchConfigured
        ? "off (no web search configured)"
        : "exploring";
  return [
    `${theme.heading("Curiosity")}: ${state}`,
    `today: ${s.today.attempted} of ${s.today.budget} questions; next pass ${when(s.nextRunAt)} (every ${s.intervalMinutes} min)`,
    `open questions: ${s.openQuestions}`,
    `learned: ${s.totals.learned}, came in useful: ${s.totals.used} (${Math.round(s.totals.roi * 100)}%), cost $${s.totals.costUsd.toFixed(3)}`,
    `last 30 days: ${s.last30d.learned} learned, $${s.last30d.costUsd.toFixed(3)}`,
  ].join("\n");
}

export function formatListing(l: Listing): string {
  const lines: string[] = [];
  lines.push(theme.heading("Wondering about"));
  if (l.wondering.length === 0) {
    lines.push(theme.muted("  nothing in the queue"));
  }
  for (const w of l.wondering) {
    lines.push(`  ${w.id.slice(0, 8)}  ${w.description}`);
    const note = [
      w.source ? `from ${w.source.replace("_", " ")}` : null,
      w.attempts > 0 ? `${w.attempts} attempt(s), last ${w.lastOutcome ?? "?"}` : null,
      w.heldPhrase ? `refused to send: “${w.heldPhrase}”` : null,
    ]
      .filter(Boolean)
      .join("; ");
    if (note) lines.push(theme.muted(`            ${note}`));
  }
  lines.push("", theme.heading("Learned on its own"));
  if (l.learned.length === 0) {
    lines.push(theme.muted("  nothing yet"));
  }
  for (const f of l.learned) {
    const tag = !f.verified
      ? " (found, not confident enough to remember)"
      : !f.current
        ? " (superseded)"
        : "";
    lines.push(`  ${f.question}${tag}`);
    lines.push(`    ${f.answer}`);
    lines.push(
      theme.muted(
        `    ${new Date(f.createdAt).toLocaleDateString()} · confidence ${Math.round(f.confidence * 100)}% · ${
          f.usedCount > 0 ? `used ${f.usedCount}×` : "not used yet"
        } · $${f.costUsd.toFixed(3)}${f.sources.length ? ` · ${f.sources.map((s) => s.url).join(" ")}` : ""}`,
      ),
    );
  }
  if (l.closed.length > 0) {
    lines.push("", theme.heading("Set aside"));
    for (const c of l.closed) {
      lines.push(theme.muted(`  ${c.description} · ${c.outcome ?? "closed"}`));
    }
  }
  return lines.join("\n");
}

export function registerCuriosityCli(program: Command): void {
  const cmd = program
    .command("curiosity")
    .description("What the agent wonders about and learns on its own; pause, ask, or run a pass");

  cmd
    .command("status")
    .description(
      "Whether it is exploring, today's budget, what it learned and whether that was used",
    )
    .option("--json", "Output JSON", false)
    .action(async (opts: { json?: boolean }) => {
      try {
        const s = await rpc<Status>("curiosity.status");
        if (!emit(s, opts)) defaultRuntime.log(formatStatus(s));
      } catch (err) {
        fail(err);
      }
    });

  cmd
    .command("list")
    .description("Open questions, what it learned (with sources), and what was set aside")
    .option("--json", "Output JSON", false)
    .option("--limit <n>", "Max items per section", "50")
    .action(async (opts: { json?: boolean; limit?: string }) => {
      try {
        const l = await rpc<Listing>("curiosity.list", { limit: Number(opts.limit) || 50 });
        if (!emit(l, opts)) defaultRuntime.log(formatListing(l));
      } catch (err) {
        fail(err);
      }
    });

  cmd
    .command("pause")
    .description("Stop exploring until resumed")
    .action(async () => {
      try {
        await rpc("curiosity.pause");
        defaultRuntime.log("curiosity paused");
      } catch (err) {
        fail(err);
      }
    });

  cmd
    .command("resume")
    .description("Resume exploring")
    .action(async () => {
      try {
        await rpc("curiosity.resume");
        defaultRuntime.log("curiosity resumed");
      } catch (err) {
        fail(err);
      }
    });

  cmd
    .command("ask <question...>")
    .description("Give the agent something to find out")
    .action(async (words: string[]) => {
      try {
        const question = words.join(" ").trim();
        const r = await rpc<{ id: string | null; queued: boolean }>("curiosity.ask", { question });
        defaultRuntime.log(
          r.queued
            ? `queued (${(r.id ?? "").slice(0, 8)})`
            : "already on the list (or answered recently)",
        );
      } catch (err) {
        fail(err);
      }
    });

  cmd
    .command("dismiss <id>")
    .description("Don't bother with a question (id or its prefix from `list`)")
    .action(async (id: string) => {
      try {
        let target = id;
        if (id.length < 36) {
          const l = await rpc<Listing>("curiosity.list", { limit: 200 });
          const hits = l.wondering.filter((w) => w.id.startsWith(id));
          if (hits.length !== 1) {
            fail(
              new Error(
                hits.length === 0 ? `no open question starts with ${id}` : `ambiguous prefix ${id}`,
              ),
            );
          }
          target = hits[0]!.id;
        }
        const r = await rpc<{ dismissed: boolean }>("curiosity.dismiss", { id: target });
        defaultRuntime.log(r.dismissed ? "dismissed" : "nothing to dismiss");
      } catch (err) {
        fail(err);
      }
    });

  cmd
    .command("run")
    .description("Look into something now (counts against today's budget; runs in the background)")
    .action(async () => {
      try {
        const r = await rpc<{ started: boolean }>("curiosity.runNow");
        defaultRuntime.log(
          r.started
            ? "started; see `bitterbot curiosity list` in a few minutes"
            : "a pass is already running",
        );
      } catch (err) {
        fail(err);
      }
    });
}
