import type { Command } from "commander";
import {
  __considerationsTodayKey,
  loadDayConsiderations,
  recentConsiderations,
  type Consideration,
  type ConsiderationCategory,
  type ConsiderationDecision,
  type WhyQuery,
} from "../infra/heartbeat-considerations.js";
import { defaultRuntime } from "../runtime.js";
import { theme } from "../terminal/theme.js";

const VALID_CATEGORIES: ReadonlyArray<ConsiderationCategory> = [
  "trigger",
  "skill-eligibility",
  "channel-route",
  "bounty-match",
  "dream-target",
  "skill-crystallize",
  "compaction",
  "spawn",
  "other",
];

const VALID_DECISIONS: ReadonlyArray<ConsiderationDecision> = [
  "acted",
  "skipped",
  "deferred",
  "blocked",
];

function parseQueryFromOpts(opts: {
  session?: string;
  category?: string;
  decision?: string;
  limit?: string;
}): { ok: true; query: WhyQuery } | { ok: false; error: string } {
  const query: WhyQuery = {};
  if (typeof opts.session === "string" && opts.session.trim()) {
    query.sessionKey = opts.session.trim();
  }
  if (typeof opts.category === "string" && opts.category.trim()) {
    const c = opts.category.trim();
    if (!VALID_CATEGORIES.includes(c as ConsiderationCategory)) {
      return {
        ok: false,
        error: `unknown category "${c}" (valid: ${VALID_CATEGORIES.join(", ")})`,
      };
    }
    query.category = c as ConsiderationCategory;
  }
  if (typeof opts.decision === "string" && opts.decision.trim()) {
    const d = opts.decision.trim();
    if (!VALID_DECISIONS.includes(d as ConsiderationDecision)) {
      return {
        ok: false,
        error: `unknown decision "${d}" (valid: ${VALID_DECISIONS.join(", ")})`,
      };
    }
    query.decision = d as ConsiderationDecision;
  }
  if (typeof opts.limit === "string" && opts.limit.trim()) {
    const n = Number.parseInt(opts.limit.trim(), 10);
    if (!Number.isFinite(n) || n < 1) {
      return { ok: false, error: `--limit must be a positive integer` };
    }
    query.limit = n;
  }
  return { ok: true, query };
}

function formatRow(e: Consideration): string {
  const dt = new Date(e.ts).toISOString();
  const session = e.sessionKey ?? "-";
  const decisionColor =
    e.decision === "acted"
      ? (theme.success ?? ((s: string) => s))
      : e.decision === "blocked"
        ? (theme.error ?? ((s: string) => s))
        : theme.muted;
  const dec = decisionColor(e.decision.padEnd(8));
  const cat = e.category.padEnd(20);
  const subject = e.subject.length > 50 ? `${e.subject.slice(0, 47)}…` : e.subject;
  return `${dt}  ${dec} ${cat} ${session}  ${subject}\n    ${theme.muted(e.reason)}`;
}

export function registerHeartbeatCli(program: Command) {
  const heartbeat = program
    .command("heartbeat")
    .description("Inspect what the heartbeat considered (acted on or skipped).");

  heartbeat
    .command("why")
    .description("Show recent heartbeat considerations (newest first).")
    .option("--session <key>", "Filter by session key")
    .option("--category <name>", `Filter by category (${VALID_CATEGORIES.join("|")})`)
    .option("--decision <name>", `Filter by decision (${VALID_DECISIONS.join("|")})`)
    .option("--limit <n>", "Max rows (default 50, max 500)")
    .option(
      "--day <YYYY-MM-DD>",
      "Read from a specific day's NDJSON file (default: in-memory ring)",
    )
    .option("--json", "Output as JSON", false)
    .action(async (opts) => {
      const parsed = parseQueryFromOpts(opts);
      if (!parsed.ok) {
        defaultRuntime.error(parsed.error);
        defaultRuntime.exit(1);
        return;
      }
      let entries: Consideration[];
      if (typeof opts.day === "string" && opts.day.trim()) {
        entries = await loadDayConsiderations(opts.day.trim(), parsed.query);
      } else {
        entries = recentConsiderations(parsed.query);
      }
      if (opts.json) {
        defaultRuntime.log(JSON.stringify(entries, null, 2));
        return;
      }
      if (entries.length === 0) {
        defaultRuntime.log(theme.muted("No considerations match."));
        return;
      }
      for (const e of entries) {
        defaultRuntime.log(formatRow(e));
      }
      defaultRuntime.log(
        theme.muted(
          `\n${entries.length} entries${opts.day ? ` (day ${opts.day})` : " (in-memory ring)"}`,
        ),
      );
    });

  heartbeat
    .command("today")
    .description("Show today's persisted considerations file path.")
    .action(() => {
      defaultRuntime.log(`Day key: ${__considerationsTodayKey()}`);
    });
}
