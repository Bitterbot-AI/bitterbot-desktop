/**
 * PLAN-50: the usage ledger — one durable, indexed, append-only row per model call.
 *
 * Every token the node spends (chat turns, hidden LLM lanes, embeddings, vision) is recorded
 * here with exclusive token buckets, the USD cost frozen at write time, the price used and where
 * it came from, and an attribution `feature`. The gateway aggregates from this table instead of
 * re-scanning every session transcript; the UI streams new rows over the `usage` event.
 *
 * Default DB: `<state>/usage-ledger.sqlite` (override `BITTERBOT_USAGE_LEDGER_DB`). On by
 * default; `BITTERBOT_USAGE_LEDGER=0` disables. Recording never throws into callers.
 */

import type { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import type { NormalizedUsage } from "../agents/usage.js";
import type { BitterbotConfig } from "../config/config.js";
import type {
  CacheTtlLabel,
  CacheTurnState,
  ModelPrice,
  PricingSource,
  UsageBuckets,
  UsageCost,
  UsageEventRow,
  UsageEventsPage,
  UsageKind,
  UsageLedgerHealth,
} from "./usage-ledger.types.js";
import { resolveStateDir } from "../config/paths.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { requireNodeSqlite } from "../memory/sqlite.js";
import { resolveUserPath } from "../utils.js";
import { startPricingRefresh, stopPricingRefresh } from "./model-pricing-live.js";
import { priceUsage, resolveModelPricing } from "./model-pricing.js";
import { emptyUsageCost, formatUsageDay } from "./usage-ledger.types.js";

const log = createSubsystemLogger("usage-ledger");

export const DEFAULT_USAGE_RETENTION_DAYS = 365;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS usage_events (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  ts               INTEGER NOT NULL,
  day              TEXT NOT NULL,
  dedupe_key       TEXT,
  kind             TEXT NOT NULL,
  feature          TEXT NOT NULL,
  provider         TEXT,
  model            TEXT,
  api              TEXT,
  agent_id         TEXT,
  session_key      TEXT,
  session_id       TEXT,
  run_id           TEXT,
  task_id          TEXT,
  channel          TEXT,
  input            INTEGER NOT NULL DEFAULT 0,
  cache_read       INTEGER NOT NULL DEFAULT 0,
  cache_write      INTEGER NOT NULL DEFAULT 0,
  output           INTEGER NOT NULL DEFAULT 0,
  reasoning        INTEGER NOT NULL DEFAULT 0,
  total            INTEGER NOT NULL DEFAULT 0,
  cost_input       REAL NOT NULL DEFAULT 0,
  cost_cache_read  REAL NOT NULL DEFAULT 0,
  cost_cache_write REAL NOT NULL DEFAULT 0,
  cost_output      REAL NOT NULL DEFAULT 0,
  cost_total       REAL NOT NULL DEFAULT 0,
  cost_source      TEXT NOT NULL,
  price_input      REAL,
  price_output     REAL,
  price_cache_read REAL,
  price_cache_write REAL,
  duration_ms      INTEGER,
  status           TEXT NOT NULL DEFAULT 'ok',
  stop_reason      TEXT,
  batch            INTEGER NOT NULL DEFAULT 0,
  items            INTEGER,
  source           TEXT NOT NULL DEFAULT 'live',
  cost_computed    REAL,
  cache_state      TEXT,
  cache_bust_reason TEXT,
  cache_ttl        TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_usage_events_dedupe ON usage_events(dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_usage_events_ts      ON usage_events(ts);
CREATE INDEX IF NOT EXISTS idx_usage_events_day     ON usage_events(day);
CREATE INDEX IF NOT EXISTS idx_usage_events_model   ON usage_events(provider, model);
CREATE INDEX IF NOT EXISTS idx_usage_events_feature ON usage_events(feature);
CREATE INDEX IF NOT EXISTS idx_usage_events_session ON usage_events(session_key);
CREATE INDEX IF NOT EXISTS idx_usage_events_run     ON usage_events(run_id);
CREATE INDEX IF NOT EXISTS idx_usage_events_task    ON usage_events(task_id);
CREATE TABLE IF NOT EXISTS usage_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

/** Columns added after the first release; applied with ALTER TABLE on existing databases. */
const MIGRATION_COLUMNS: Array<[string, string]> = [
  ["cost_computed", "REAL"],
  ["cache_state", "TEXT"],
  ["cache_bust_reason", "TEXT"],
  ["cache_ttl", "TEXT"],
];

export type UsageEventInput = {
  ts?: number;
  kind: UsageKind;
  feature: string;
  provider?: string | null;
  model?: string | null;
  api?: string | null;
  agentId?: string | null;
  sessionKey?: string | null;
  sessionId?: string | null;
  runId?: string | null;
  taskId?: string | null;
  channel?: string | null;
  /** Exclusive buckets in any provider spelling; `reasoning` is a subset of output. */
  usage: (NormalizedUsage & { reasoning?: number }) | null | undefined;
  /** Library/provider-reported USD cost (pi-ai `usage.cost`). Preferred when non-zero. */
  cost?: Partial<UsageCost> | null;
  /** Force a source; used for `local` and `estimated` rows whose cost is known by construction. */
  costSource?: PricingSource;
  durationMs?: number | null;
  status?: "ok" | "error";
  stopReason?: string | null;
  batch?: boolean;
  items?: number | null;
  /** PLAN-50 Phase 5: prompt-cache observation for this turn (chat rows). */
  cacheState?: CacheTurnState | null;
  cacheBustReason?: string | null;
  cacheTtl?: CacheTtlLabel | null;
  /** Stable key so live rows and transcript reconcile rows never double count. */
  dedupeKey?: string | null;
  source?: "live" | "reconcile";
  /** Config for override pricing; loaded lazily when omitted. */
  config?: BitterbotConfig;
};

type RawRow = {
  id: number;
  ts: number;
  day: string;
  kind: string;
  feature: string;
  provider: string | null;
  model: string | null;
  api: string | null;
  agent_id: string | null;
  session_key: string | null;
  session_id: string | null;
  run_id: string | null;
  task_id: string | null;
  channel: string | null;
  input: number;
  cache_read: number;
  cache_write: number;
  output: number;
  reasoning: number;
  total: number;
  cost_input: number;
  cost_cache_read: number;
  cost_cache_write: number;
  cost_output: number;
  cost_total: number;
  cost_source: string;
  price_input: number | null;
  price_output: number | null;
  price_cache_read: number | null;
  price_cache_write: number | null;
  duration_ms: number | null;
  status: string;
  stop_reason: string | null;
  batch: number;
  items: number | null;
  source: string;
  cost_computed: number | null;
  cache_state: string | null;
  cache_bust_reason: string | null;
  cache_ttl: string | null;
};

export type UsageAggregateRow = {
  group_key?: string | null;
  calls: number;
  errors: number;
  input: number;
  cache_read: number;
  cache_write: number;
  output: number;
  reasoning: number;
  total: number;
  cost_input: number;
  cost_cache_read: number;
  cost_cache_write: number;
  cost_output: number;
  cost_total: number;
  cost_computed: number;
  computed_calls: number;
  cost_reported_on_computed: number;
  reported_calls: number;
  unpriced_calls: number;
  estimated_calls: number;
  last_ts: number | null;
  [extra: string]: unknown;
};

export type UsageEventFilters = {
  startMs?: number;
  endMs?: number;
  agentId?: string;
  feature?: string;
  kind?: UsageKind;
  provider?: string;
  model?: string;
  sessionKey?: string;
  runId?: string;
  taskId?: string;
  channel?: string;
};

const nz = (v: number | undefined | null): number =>
  typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.round(v) : 0;

export function toUsageBuckets(
  usage: (NormalizedUsage & { reasoning?: number }) | null | undefined,
): UsageBuckets {
  const input = nz(usage?.input);
  const cacheRead = nz(usage?.cacheRead);
  const cacheWrite = nz(usage?.cacheWrite);
  const output = nz(usage?.output);
  const reasoning = Math.min(nz(usage?.reasoning), output);
  const derived = input + cacheRead + cacheWrite + output;
  // Providers that report only a total (embeddings) land in `input`.
  const total = derived > 0 ? derived : nz(usage?.total);
  return {
    input: derived > 0 ? input : total,
    cacheRead,
    cacheWrite,
    output,
    reasoning,
    total,
  };
}

function rowToEvent(row: RawRow): UsageEventRow {
  const price: ModelPrice | null =
    row.price_input === null && row.price_output === null
      ? null
      : {
          input: row.price_input ?? 0,
          output: row.price_output ?? 0,
          cacheRead: row.price_cache_read ?? 0,
          cacheWrite: row.price_cache_write ?? 0,
        };
  return {
    id: row.id,
    ts: row.ts,
    day: row.day,
    kind: row.kind as UsageKind,
    feature: row.feature,
    provider: row.provider,
    model: row.model,
    api: row.api,
    agentId: row.agent_id,
    sessionKey: row.session_key,
    sessionId: row.session_id,
    runId: row.run_id,
    taskId: row.task_id,
    channel: row.channel,
    usage: {
      input: row.input,
      cacheRead: row.cache_read,
      cacheWrite: row.cache_write,
      output: row.output,
      reasoning: row.reasoning,
      total: row.total,
    },
    cost: {
      input: row.cost_input,
      cacheRead: row.cost_cache_read,
      cacheWrite: row.cost_cache_write,
      output: row.cost_output,
      total: row.cost_total,
    },
    costSource: row.cost_source as PricingSource,
    price,
    durationMs: row.duration_ms,
    status: row.status === "error" ? "error" : "ok",
    stopReason: row.stop_reason,
    batch: row.batch === 1,
    items: row.items,
    source: row.source === "reconcile" ? "reconcile" : "live",
    costComputed: typeof row.cost_computed === "number" ? row.cost_computed : null,
    cacheState: (row.cache_state as CacheTurnState | null) ?? null,
    cacheBustReason: row.cache_bust_reason ?? null,
    cacheTtl: (row.cache_ttl as CacheTtlLabel | null) ?? null,
  };
}

function buildWhere(filters: UsageEventFilters | undefined): {
  where: string;
  args: Array<string | number>;
} {
  const clauses: string[] = [];
  const args: Array<string | number> = [];
  if (!filters) {
    return { where: "", args };
  }
  if (typeof filters.startMs === "number") {
    clauses.push("ts >= ?");
    args.push(filters.startMs);
  }
  if (typeof filters.endMs === "number") {
    clauses.push("ts <= ?");
    args.push(filters.endMs);
  }
  const eq: Array<[keyof UsageEventFilters, string]> = [
    ["agentId", "agent_id"],
    ["feature", "feature"],
    ["kind", "kind"],
    ["provider", "provider"],
    ["model", "model"],
    ["sessionKey", "session_key"],
    ["runId", "run_id"],
    ["taskId", "task_id"],
    ["channel", "channel"],
  ];
  for (const [key, column] of eq) {
    const value = filters[key];
    if (typeof value === "string" && value.trim()) {
      clauses.push(`${column} = ?`);
      args.push(value.trim());
    }
  }
  return { where: clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "", args };
}

export type ResolvedUsageEvent = Omit<UsageEventRow, "id">;

export class UsageLedger {
  private readonly db: DatabaseSync;
  readonly dbPath: string | null;

  constructor(db: DatabaseSync, dbPath: string | null = null) {
    this.db = db;
    this.dbPath = dbPath;
    this.db.exec(SCHEMA_SQL);
    this.ensureColumns();
  }

  private ensureColumns(): void {
    const existing = new Set(
      (
        this.db.prepare("PRAGMA table_info(usage_events)").all() as unknown as Array<{
          name: string;
        }>
      ).map((c) => c.name),
    );
    for (const [name, type] of MIGRATION_COLUMNS) {
      if (!existing.has(name)) {
        this.db.exec(`ALTER TABLE usage_events ADD COLUMN ${name} ${type}`);
      }
    }
  }

  static open(dbPath: string): UsageLedger {
    const resolved = resolveUserPath(dbPath);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    const { DatabaseSync } = requireNodeSqlite();
    const db = new DatabaseSync(resolved);
    try {
      db.prepare("PRAGMA journal_mode=WAL").get();
    } catch {
      // older SQLite — default journal.
    }
    try {
      db.exec("PRAGMA synchronous=NORMAL");
      db.exec("PRAGMA busy_timeout=5000");
    } catch {
      // non-essential.
    }
    return new UsageLedger(db, resolved);
  }

  static openInMemory(): UsageLedger {
    const { DatabaseSync } = requireNodeSqlite();
    return new UsageLedger(new DatabaseSync(":memory:"), null);
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      // already closed
    }
  }

  /** Run many inserts in one transaction (the first-run backfill is thousands of rows). */
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // nothing to roll back
      }
      throw err;
    }
  }

  /** Insert a fully-resolved event. Returns the row id, or null when the dedupe key already exists. */
  insert(evt: ResolvedUsageEvent & { dedupeKey?: string | null }): number | null {
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO usage_events
          (ts, day, dedupe_key, kind, feature, provider, model, api, agent_id, session_key, session_id,
           run_id, task_id, channel, input, cache_read, cache_write, output, reasoning, total,
           cost_input, cost_cache_read, cost_cache_write, cost_output, cost_total, cost_source,
           price_input, price_output, price_cache_read, price_cache_write,
           duration_ms, status, stop_reason, batch, items, source,
           cost_computed, cache_state, cache_bust_reason, cache_ttl)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        evt.ts,
        evt.day,
        evt.dedupeKey ?? null,
        evt.kind,
        evt.feature,
        evt.provider,
        evt.model,
        evt.api,
        evt.agentId,
        evt.sessionKey,
        evt.sessionId,
        evt.runId,
        evt.taskId,
        evt.channel,
        evt.usage.input,
        evt.usage.cacheRead,
        evt.usage.cacheWrite,
        evt.usage.output,
        evt.usage.reasoning,
        evt.usage.total,
        evt.cost.input,
        evt.cost.cacheRead,
        evt.cost.cacheWrite,
        evt.cost.output,
        evt.cost.total,
        evt.costSource,
        evt.price?.input ?? null,
        evt.price?.output ?? null,
        evt.price?.cacheRead ?? null,
        evt.price?.cacheWrite ?? null,
        evt.durationMs ?? null,
        evt.status,
        evt.stopReason ?? null,
        evt.batch ? 1 : 0,
        evt.items ?? null,
        evt.source,
        evt.costComputed ?? null,
        evt.cacheState ?? null,
        evt.cacheBustReason ?? null,
        evt.cacheTtl ?? null,
      );
    const changes = Number(result.changes ?? 0);
    if (changes === 0) {
      return null;
    }
    return Number(result.lastInsertRowid);
  }

  events(params: UsageEventFilters & { limit?: number; beforeId?: number } = {}): UsageEventsPage {
    const { where, args } = buildWhere(params);
    const clauses: string[] = [];
    if (typeof params.beforeId === "number") {
      clauses.push("id < ?");
      args.push(params.beforeId);
    }
    const fullWhere =
      clauses.length > 0
        ? where
          ? `${where} AND ${clauses.join(" AND ")}`
          : `WHERE ${clauses.join(" AND ")}`
        : where;
    const limit = Math.max(1, Math.min(params.limit ?? 50, 1000));
    const rows = this.db
      .prepare(`SELECT * FROM usage_events ${fullWhere} ORDER BY id DESC LIMIT ?`)
      .all(...args, limit) as unknown as RawRow[];
    const events = rows.map(rowToEvent);
    const last = events.at(-1);
    return { events, nextBeforeId: events.length === limit && last ? last.id : null };
  }

  // ---------------------------------------------------------------------------
  // PLAN-50 Phase 6: SQL-side aggregation. The summary used to materialize every row in range
  // on the gateway event loop; these run one GROUP BY per pivot instead. Text-to-speech rows
  // store characters in `input`, so token sums exclude kind='tts'.
  // ---------------------------------------------------------------------------

  private static readonly TOTALS_SELECT = `
    COUNT(*) AS calls,
    SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS errors,
    SUM(CASE WHEN kind = 'tts' THEN 0 ELSE input END) AS input,
    SUM(CASE WHEN kind = 'tts' THEN 0 ELSE cache_read END) AS cache_read,
    SUM(CASE WHEN kind = 'tts' THEN 0 ELSE cache_write END) AS cache_write,
    SUM(CASE WHEN kind = 'tts' THEN 0 ELSE output END) AS output,
    SUM(CASE WHEN kind = 'tts' THEN 0 ELSE reasoning END) AS reasoning,
    SUM(CASE WHEN kind = 'tts' THEN 0 ELSE total END) AS total,
    SUM(cost_input) AS cost_input,
    SUM(cost_cache_read) AS cost_cache_read,
    SUM(cost_cache_write) AS cost_cache_write,
    SUM(cost_output) AS cost_output,
    SUM(cost_total) AS cost_total,
    SUM(COALESCE(cost_computed, 0)) AS cost_computed,
    SUM(CASE WHEN cost_computed IS NOT NULL THEN 1 ELSE 0 END) AS computed_calls,
    SUM(CASE WHEN cost_computed IS NOT NULL THEN cost_total ELSE 0 END) AS cost_reported_on_computed,
    SUM(CASE WHEN cost_source = 'provider' THEN 1 ELSE 0 END) AS reported_calls,
    SUM(CASE WHEN cost_source = 'unpriced' THEN 1 ELSE 0 END) AS unpriced_calls,
    SUM(CASE WHEN cost_source = 'estimated' THEN 1 ELSE 0 END) AS estimated_calls,
    MAX(ts) AS last_ts`;

  /** Totals for the filter, or for each value of `groupExpr` when given (one row per group). */
  aggregate(filters: UsageEventFilters, groupExpr?: string, extraSelect = ""): UsageAggregateRow[] {
    const { where, args } = buildWhere(filters);
    const groupSelect = groupExpr ? `${groupExpr} AS group_key, ` : "";
    const groupBy = groupExpr ? `GROUP BY ${groupExpr}` : "";
    const rows = this.db
      .prepare(
        `SELECT ${groupSelect}${UsageLedger.TOTALS_SELECT}${extraSelect} FROM usage_events ${where} ${groupBy}`,
      )
      .all(...args) as unknown as UsageAggregateRow[];
    return rows;
  }

  /** Per model, the pricing sources and kinds seen (small; one row per model/source/kind). */
  modelFacets(filters: UsageEventFilters): Array<{
    provider: string | null;
    model: string | null;
    kind: string;
    cost_source: string;
    calls: number;
  }> {
    const { where, args } = buildWhere(filters);
    return this.db
      .prepare(
        `SELECT provider, model, kind, cost_source, COUNT(*) AS calls FROM usage_events ${where}
         GROUP BY provider, model, kind, cost_source`,
      )
      .all(...args) as unknown as Array<{
      provider: string | null;
      model: string | null;
      kind: string;
      cost_source: string;
      calls: number;
    }>;
  }

  /** Per (day, model) and per (day, kind) sums for stacked charts. */
  dailyBy(
    filters: UsageEventFilters,
    dimension: "model" | "kind",
  ): Array<{
    day: string;
    provider: string | null;
    model: string | null;
    kind: string | null;
    tokens: number;
    cost: number;
    calls: number;
  }> {
    const { where, args } = buildWhere(filters);
    const cols =
      dimension === "model"
        ? "provider, model, NULL AS kind"
        : "NULL AS provider, NULL AS model, kind";
    const group = dimension === "model" ? "day, provider, model" : "day, kind";
    return this.db
      .prepare(
        `SELECT day, ${cols}, SUM(CASE WHEN kind = 'tts' THEN 0 ELSE total END) AS tokens,
                SUM(cost_total) AS cost, COUNT(*) AS calls
         FROM usage_events ${where} GROUP BY ${group}`,
      )
      .all(...args) as unknown as Array<{
      day: string;
      provider: string | null;
      model: string | null;
      kind: string | null;
      tokens: number;
      cost: number;
      calls: number;
    }>;
  }

  /** Hourly cost/token buckets (for peak-block search without loading rows). */
  hourly(
    filters: UsageEventFilters,
  ): Array<{ hour: number; cost: number; tokens: number; calls: number }> {
    const { where, args } = buildWhere(filters);
    return this.db
      .prepare(
        `SELECT (ts / 3600000) AS hour, SUM(cost_total) AS cost,
                SUM(CASE WHEN kind = 'tts' THEN 0 ELSE total END) AS tokens, COUNT(*) AS calls
         FROM usage_events ${where} GROUP BY hour ORDER BY hour`,
      )
      .all(...args) as unknown as Array<{
      hour: number;
      cost: number;
      tokens: number;
      calls: number;
    }>;
  }

  /** Cache observations per model, feature and bust reason (chat rows on cache-capable providers). */
  cacheFacets(filters: UsageEventFilters): Array<{
    provider: string | null;
    model: string | null;
    feature: string;
    cache_bust_reason: string | null;
    calls: number;
    input: number;
    cache_read: number;
    cache_write: number;
    cost_cache_write: number;
    last_ts: number | null;
    last_ttl: string | null;
  }> {
    const { where, args } = buildWhere({ ...filters, kind: "chat" });
    return this.db
      .prepare(
        `SELECT provider, model, feature, cache_bust_reason, COUNT(*) AS calls, SUM(input) AS input,
                SUM(cache_read) AS cache_read, SUM(cache_write) AS cache_write,
                SUM(cost_cache_write) AS cost_cache_write, MAX(ts) AS last_ts,
                MAX(CASE WHEN cache_ttl IS NOT NULL THEN cache_ttl END) AS last_ttl
         FROM usage_events ${where ? `${where} AND` : "WHERE"} provider IN ('anthropic', 'openai')
         GROUP BY provider, model, feature, cache_bust_reason`,
      )
      .all(...args) as unknown as Array<{
      provider: string | null;
      model: string | null;
      feature: string;
      cache_bust_reason: string | null;
      calls: number;
      input: number;
      cache_read: number;
      cache_write: number;
      cost_cache_write: number;
      last_ts: number | null;
      last_ttl: string | null;
    }>;
  }

  /** Per-run cost, newest first, for the runaway-run detector. */
  runCosts(
    filters: UsageEventFilters,
    limit = 2000,
  ): Array<{
    run_id: string;
    session_key: string | null;
    feature: string;
    cost: number;
    calls: number;
    first_ts: number;
    last_ts: number;
  }> {
    const { where, args } = buildWhere(filters);
    const clause = where ? `${where} AND run_id IS NOT NULL` : "WHERE run_id IS NOT NULL";
    return this.db
      .prepare(
        `SELECT run_id, MIN(session_key) AS session_key, MIN(feature) AS feature, SUM(cost_total) AS cost,
                COUNT(*) AS calls, MIN(ts) AS first_ts, MAX(ts) AS last_ts
         FROM usage_events ${clause} GROUP BY run_id ORDER BY last_ts DESC LIMIT ?`,
      )
      .all(...args, limit) as unknown as Array<{
      run_id: string;
      session_key: string | null;
      feature: string;
      cost: number;
      calls: number;
      first_ts: number;
      last_ts: number;
    }>;
  }

  /** Token buckets per (provider, model, batch) for chat-like rows: the input to a what-if replay. */
  replayBuckets(filters: UsageEventFilters): Array<{
    provider: string | null;
    model: string | null;
    kind: string;
    batch: number;
    input: number;
    cache_read: number;
    cache_write: number;
    output: number;
    cost: number;
    calls: number;
  }> {
    const { where, args } = buildWhere(filters);
    return this.db
      .prepare(
        `SELECT provider, model, kind, batch, SUM(input) AS input, SUM(cache_read) AS cache_read,
                SUM(cache_write) AS cache_write, SUM(output) AS output, SUM(cost_total) AS cost, COUNT(*) AS calls
         FROM usage_events ${where} GROUP BY provider, model, kind, batch`,
      )
      .all(...args) as unknown as Array<{
      provider: string | null;
      model: string | null;
      kind: string;
      batch: number;
      input: number;
      cache_read: number;
      cache_write: number;
      output: number;
      cost: number;
      calls: number;
    }>;
  }

  /** Distinct pricing identities of rows that still lack a computed cost (for the backfill). */
  uncomputedIdentities(): Array<{
    provider: string | null;
    model: string | null;
    kind: string;
    batch: number;
    cache_ttl: string | null;
    rows: number;
  }> {
    return this.db
      .prepare(
        `SELECT provider, model, kind, batch, cache_ttl, COUNT(*) AS rows FROM usage_events
         WHERE cost_computed IS NULL AND provider IS NOT NULL AND model IS NOT NULL
           AND kind IN ('chat', 'vision', 'search', 'embedding')
         GROUP BY provider, model, kind, batch, cache_ttl`,
      )
      .all() as unknown as Array<{
      provider: string | null;
      model: string | null;
      kind: string;
      batch: number;
      cache_ttl: string | null;
      rows: number;
    }>;
  }

  /** Apply a per-million price to every row of one pricing identity that lacks cost_computed. */
  applyComputedCost(
    identity: {
      provider: string;
      model: string;
      kind: string;
      batch: number;
      cache_ttl: string | null;
    },
    price: ModelPrice,
    cacheWriteRate: number,
  ): number {
    const factor = identity.batch ? 0.5 : 1;
    const result = this.db
      .prepare(
        `UPDATE usage_events SET cost_computed =
           ((input * ?) + (cache_read * ?) + (cache_write * ?) + (output * ?)) * ? / 1000000.0
         WHERE cost_computed IS NULL AND provider = ? AND model = ? AND kind = ? AND batch = ?
           AND ((cache_ttl IS NULL AND ? IS NULL) OR cache_ttl = ?)`,
      )
      .run(
        price.input,
        price.cacheRead,
        cacheWriteRate,
        price.output,
        factor,
        identity.provider,
        identity.model,
        identity.kind,
        identity.batch,
        identity.cache_ttl,
        identity.cache_ttl,
      );
    return Number(result.changes ?? 0);
  }

  /** Relabel reconciled rows (feature / session_key / channel) for one transcript. */
  relabelReconciled(
    sessionId: string,
    agentId: string | null,
    patch: { feature: string; sessionKey: string | null; channel: string | null },
  ): number {
    const result = this.db
      .prepare(
        `UPDATE usage_events SET feature = ?, session_key = COALESCE(?, session_key), channel = COALESCE(?, channel)
         WHERE source = 'reconcile' AND session_id = ? AND (agent_id = ? OR (agent_id IS NULL AND ? IS NULL))`,
      )
      .run(patch.feature, patch.sessionKey, patch.channel, sessionId, agentId, agentId);
    return Number(result.changes ?? 0);
  }

  /** Raw rows for aggregation; callers group in JS so one query serves every pivot. */
  rows(filters: UsageEventFilters): UsageEventRow[] {
    const { where, args } = buildWhere(filters);
    const rows = this.db
      .prepare(`SELECT * FROM usage_events ${where} ORDER BY ts ASC`)
      .all(...args) as unknown as RawRow[];
    return rows.map(rowToEvent);
  }

  /** Sum of cost_total in a window, optionally scoped. Cheap: SQL-side. */
  spend(filters: UsageEventFilters): number {
    const { where, args } = buildWhere(filters);
    const row = this.db
      .prepare(`SELECT COALESCE(SUM(cost_total), 0) AS s FROM usage_events ${where}`)
      .get(...args) as { s: number } | undefined;
    return Number(row?.s ?? 0);
  }

  count(): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS c FROM usage_events`).get() as { c: number };
    return row.c;
  }

  pruneOlderThan(cutoffMs: number): number {
    const result = this.db.prepare(`DELETE FROM usage_events WHERE ts < ?`).run(cutoffMs);
    return Number(result.changes ?? 0);
  }

  getMeta(key: string): string | null {
    const row = this.db.prepare(`SELECT value FROM usage_meta WHERE key = ?`).get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO usage_meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, value);
  }

  health(retentionDays: number): UsageLedgerHealth {
    const agg = this.db
      .prepare(`SELECT COUNT(*) AS c, MIN(ts) AS lo, MAX(ts) AS hi FROM usage_events`)
      .get() as { c: number; lo: number | null; hi: number | null };
    let dbBytes: number | null = null;
    if (this.dbPath) {
      try {
        dbBytes = fs.statSync(this.dbPath).size;
      } catch {
        dbBytes = null;
      }
    }
    const lastReconcileAt = Number(this.getMeta("reconcile:lastAt") ?? "");
    const lastReconcileRows = Number(this.getMeta("reconcile:lastRows") ?? "");
    return {
      enabled: true,
      dbPath: this.dbPath,
      events: agg.c,
      oldestTs: agg.lo,
      newestTs: agg.hi,
      dbBytes,
      lastReconcileAt:
        Number.isFinite(lastReconcileAt) && lastReconcileAt > 0 ? lastReconcileAt : null,
      lastReconcileRows: Number.isFinite(lastReconcileRows) ? lastReconcileRows : null,
      retentionDays,
    };
  }
}

// ---------------------------------------------------------------------------
// Singleton + recording pipeline
// ---------------------------------------------------------------------------

type LedgerState = {
  ledger: UsageLedger;
  reconcileTimer: NodeJS.Timeout | null;
};

let state: LedgerState | null = null;
let openFailed = false;
/** Set by startUsageLedger()/ensureUsageLedger() from `usage.ledger.enabled`; null = not yet checked. */
let configEnabled: boolean | null = null;
/** Set by stopUsageLedger(); prevents a straggling recordUsage from reopening the DB during teardown. */
let closed = false;
let queue: Promise<void> = Promise.resolve();
let cachedConfig: { at: number; value: BitterbotConfig | undefined } | null = null;
const CONFIG_MEMO_MS = 60_000;
const listeners = new Set<(evt: UsageEventRow) => void>();

export function isUsageLedgerEnabled(): boolean {
  const v = process.env.BITTERBOT_USAGE_LEDGER;
  if (v === undefined) {
    return true;
  }
  return v === "1" || v === "true";
}

export function defaultUsageLedgerDbPath(): string {
  return (
    process.env.BITTERBOT_USAGE_LEDGER_DB ?? path.join(resolveStateDir(), "usage-ledger.sqlite")
  );
}

/** Lazily open the process-wide ledger. Returns null when disabled or unavailable. */
export function getUsageLedger(): UsageLedger | null {
  if (state) {
    return state.ledger;
  }
  if (openFailed || closed || configEnabled === false || !isUsageLedgerEnabled()) {
    return null;
  }
  const dbPath = defaultUsageLedgerDbPath();
  try {
    const ledger = UsageLedger.open(dbPath);
    state = { ledger, reconcileTimer: null };
    return ledger;
  } catch (err) {
    openFailed = true;
    log.warn(
      `failed to open usage ledger at ${dbPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

/** Test seam: use an explicit ledger instance (usually in-memory). */
export function setUsageLedgerForTest(ledger: UsageLedger | null): void {
  if (state?.reconcileTimer) {
    clearInterval(state.reconcileTimer);
  }
  state = ledger ? { ledger, reconcileTimer: null } : null;
  openFailed = false;
  closed = false;
  configEnabled = null;
  cachedConfig = null;
  queue = Promise.resolve();
}

/** Test seam: simulate `usage.ledger.enabled` without loading config. */
export function setUsageLedgerConfigEnabledForTest(enabled: boolean | null): void {
  configEnabled = enabled;
}

export function stopUsageLedger(): void {
  closed = true;
  stopPricingRefresh();
  if (!state) {
    return;
  }
  if (state.reconcileTimer) {
    clearInterval(state.reconcileTimer);
  }
  state.ledger.close();
  state = null;
}

export function onUsageEvent(listener: (evt: UsageEventRow) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emit(evt: UsageEventRow): void {
  for (const listener of listeners) {
    try {
      listener(evt);
    } catch (err) {
      log.debug(`usage listener failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/**
 * Library-reported cost (pi-ai `usage.cost`) is trusted when non-zero. Known upstream quirk:
 * pi-ai's openai-completions adapter adds `reasoning_tokens` on top of `completion_tokens`
 * (which already includes them), so o-series/gpt-5 output and cost are slightly inflated there.
 */
function hasNonzeroCost(cost: Partial<UsageCost> | null | undefined): boolean {
  if (!cost) {
    return false;
  }
  return [cost.total, cost.input, cost.output, cost.cacheRead, cost.cacheWrite].some(
    (v) => typeof v === "number" && Number.isFinite(v) && v > 0,
  );
}

async function loadConfigLazy(): Promise<BitterbotConfig | undefined> {
  const now = Date.now();
  if (cachedConfig && now - cachedConfig.at < CONFIG_MEMO_MS) {
    return cachedConfig.value;
  }
  let value: BitterbotConfig | undefined;
  try {
    const { loadConfig } = await import("../config/config.js");
    value = loadConfig();
  } catch {
    value = undefined;
  }
  cachedConfig = { at: now, value };
  return value;
}

/**
 * Async variant of getUsageLedger() that honors `usage.ledger.enabled` in processes that never
 * call startUsageLedger() (the CLI). Checks config once per process.
 */
async function ensureUsageLedger(input?: {
  config?: BitterbotConfig;
}): Promise<UsageLedger | null> {
  if (configEnabled === null) {
    const cfg = input?.config ?? (await loadConfigLazy());
    configEnabled = isUsageLedgerConfigEnabled(cfg);
  }
  return getUsageLedger();
}

/** Resolve pricing and cost for an input; exported for the reconciler and tests. */
export async function resolveUsageEvent(
  input: UsageEventInput,
): Promise<ResolvedUsageEvent | null> {
  const usage = toUsageBuckets(input.usage);
  const hasItems =
    typeof input.items === "number" && Number.isFinite(input.items) && input.items > 0;
  // Zero-token rows are kept only when they still represent a billable call (per-request
  // pricing such as speech-to-text minutes) or an error.
  if (usage.total <= 0 && input.status !== "error" && !hasItems) {
    return null;
  }
  const ts = typeof input.ts === "number" && Number.isFinite(input.ts) ? input.ts : Date.now();
  const provider = input.provider?.trim() || null;
  const model = input.model?.trim() || null;
  const cacheTtl = input.cacheTtl ?? null;

  let cost: UsageCost;
  let costSource: PricingSource;
  let price: ModelPrice | null = null;
  let costComputed: number | null = null;

  const cfg = input.config ?? (await loadConfigLazy());
  // Always resolve our own table so "computed" is available next to a library-reported cost.
  const table = await resolveModelPricing({ provider, model, kind: input.kind, cfg, ts });
  const tablePriced = table.source !== "unpriced" && table.source !== "local";
  if (tablePriced) {
    costComputed = priceUsage(table.price, usage, {
      batch: input.batch,
      cacheTtl,
      provider,
      source: table.source,
    }).total;
  }

  if (input.costSource === "local") {
    cost = emptyUsageCost();
    costSource = "local";
    price = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    costComputed = 0;
  } else if (hasNonzeroCost(input.cost)) {
    const c = input.cost ?? {};
    const n = (v: number | undefined) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
    const parts = {
      input: n(c.input),
      cacheRead: n(c.cacheRead),
      cacheWrite: n(c.cacheWrite),
      output: n(c.output),
    };
    const total = n(c.total) || parts.input + parts.cacheRead + parts.cacheWrite + parts.output;
    cost = { ...parts, total };
    costSource = "provider";
  } else {
    price = table.price;
    cost = priceUsage(table.price, usage, {
      batch: input.batch,
      cacheTtl,
      provider,
      source: table.source,
    });
    costSource = table.source;
    if (table.source === "local") {
      costComputed = 0;
    }
  }
  if (input.costSource === "estimated" && costSource !== "unpriced" && costSource !== "local") {
    costSource = "estimated";
  }

  return {
    ts,
    day: formatUsageDay(ts),
    kind: input.kind,
    feature: input.feature.trim() || "unknown",
    provider,
    model,
    api: input.api?.trim() || null,
    agentId: input.agentId?.trim() || null,
    sessionKey: input.sessionKey?.trim() || null,
    sessionId: input.sessionId?.trim() || null,
    runId: input.runId?.trim() || null,
    taskId: input.taskId?.trim() || null,
    channel: input.channel?.trim() || null,
    usage,
    cost,
    costSource,
    price,
    durationMs:
      typeof input.durationMs === "number" && Number.isFinite(input.durationMs)
        ? Math.round(input.durationMs)
        : null,
    status: input.status === "error" ? "error" : "ok",
    stopReason: input.stopReason?.trim() || null,
    batch: input.batch === true,
    items:
      typeof input.items === "number" && Number.isFinite(input.items)
        ? Math.round(input.items)
        : null,
    source: input.source ?? "live",
    costComputed,
    cacheState: input.cacheState ?? null,
    cacheBustReason: input.cacheBustReason?.trim() || null,
    cacheTtl,
  };
}

/**
 * Record one model call. Fire-and-forget: pricing resolution and the insert run on an ordered
 * queue, failures are logged, and callers are never blocked or thrown at.
 */
export function recordUsage(input: UsageEventInput): void {
  if (openFailed || closed || configEnabled === false || !isUsageLedgerEnabled()) {
    return;
  }
  queue = queue
    .then(async () => {
      const ledger = await ensureUsageLedger(input);
      if (!ledger) {
        return;
      }
      const resolved = await resolveUsageEvent(input);
      if (!resolved) {
        return;
      }
      const id = ledger.insert({ ...resolved, dedupeKey: input.dedupeKey ?? null });
      if (id === null) {
        return;
      }
      emit({ id, ...resolved });
    })
    .catch((err) => {
      log.debug(`recordUsage failed: ${err instanceof Error ? err.message : String(err)}`);
    });
}

/** Await every queued record; tests and shutdown hooks use this. */
export async function flushUsageLedger(): Promise<void> {
  await queue;
}

export function resolveUsageRetentionDays(cfg: BitterbotConfig | undefined): number {
  const raw = (cfg as { usage?: { ledger?: { retentionDays?: number } } } | undefined)?.usage
    ?.ledger?.retentionDays;
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    return Math.floor(raw);
  }
  return DEFAULT_USAGE_RETENTION_DAYS;
}

export function isUsageLedgerConfigEnabled(cfg: BitterbotConfig | undefined): boolean {
  const raw = (cfg as { usage?: { ledger?: { enabled?: boolean } } } | undefined)?.usage?.ledger
    ?.enabled;
  return raw !== false;
}

const RECONCILE_INTERVAL_MS = 10 * 60_000;

/**
 * PLAN-50 Phase 6: fill `cost_computed` on rows written before the column existed (and on any
 * row whose price was unknown at write time), one pricing identity at a time. Rows that still
 * have no price are left NULL so "computed" never fabricates a number.
 */
export async function backfillComputedCost(
  ledger: UsageLedger,
  cfg?: BitterbotConfig,
): Promise<number> {
  const identities = ledger.uncomputedIdentities();
  let updated = 0;
  for (const identity of identities) {
    if (!identity.provider || !identity.model) {
      continue;
    }
    const resolved = await resolveModelPricing({
      provider: identity.provider,
      model: identity.model,
      kind: identity.kind as UsageKind,
      cfg,
    });
    if (resolved.source === "unpriced") {
      continue;
    }
    const price = resolved.price;
    let cacheWriteRate = price.cacheWrite;
    if (identity.cache_ttl === "1h" && resolved.source !== "override") {
      cacheWriteRate =
        typeof price.cacheWrite1h === "number" && price.cacheWrite1h > 0
          ? price.cacheWrite1h
          : identity.provider.toLowerCase() === "anthropic"
            ? price.cacheWrite * (2 / 1.25)
            : price.cacheWrite;
    }
    if (resolved.source === "local") {
      cacheWriteRate = 0;
    }
    try {
      updated += ledger.applyComputedCost(
        {
          provider: identity.provider,
          model: identity.model,
          kind: identity.kind,
          batch: identity.batch,
          cache_ttl: identity.cache_ttl,
        },
        resolved.source === "local" ? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } : price,
        cacheWriteRate,
      );
    } catch (err) {
      log.debug(
        `cost_computed backfill failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  if (updated > 0) {
    log.info(`usage ledger: computed cost filled on ${updated} rows`);
  }
  return updated;
}

/**
 * Gateway boot: open the ledger, prune, and start the transcript reconciler (backfill on first
 * run, then a periodic safety net for any path that writes a transcript without recording live).
 */
export function startUsageLedger(opts?: {
  cfg?: BitterbotConfig;
  reconcile?: boolean;
}): UsageLedger | null {
  closed = false;
  if (opts?.cfg) {
    configEnabled = isUsageLedgerConfigEnabled(opts.cfg);
    if (!configEnabled) {
      log.info("usage ledger disabled by usage.ledger.enabled=false");
      return null;
    }
  }
  const ledger = getUsageLedger();
  if (!ledger || !state) {
    return null;
  }
  const retentionDays = resolveUsageRetentionDays(opts?.cfg);
  try {
    const pruned = ledger.pruneOlderThan(Date.now() - retentionDays * 24 * 60 * 60_000);
    if (pruned > 0) {
      log.info(`pruned ${pruned} usage rows older than ${retentionDays}d`);
    }
  } catch (err) {
    log.debug(`usage prune failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  // PLAN-50 Phase 5: dated live-pricing snapshots (OpenRouter), refreshed daily. The first
  // refresh completes before the first backfill so history for live-only models is priced.
  let pricingReady: Promise<void> = Promise.resolve();
  try {
    pricingReady = startPricingRefresh({ cfg: opts?.cfg });
  } catch (err) {
    log.debug(`live pricing start failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (opts?.reconcile !== false && !state.reconcileTimer) {
    const run = (): Promise<void> =>
      import("./usage-reconcile.js")
        .then(({ reconcileTranscripts }) => reconcileTranscripts({ ledger, cfg: opts?.cfg }))
        .then((res) => {
          if (res.rows > 0) {
            log.info(`usage reconcile: ${res.rows} rows from ${res.files} transcript files`);
          }
        })
        .catch((err) => {
          log.debug(`usage reconcile failed: ${err instanceof Error ? err.message : String(err)}`);
        });
    // First pass shortly after boot, once prices are in (capped so a slow network never
    // delays the backfill more than a few seconds).
    const firstTimer = setTimeout(() => {
      void Promise.race([pricingReady, new Promise((r) => setTimeout(r, 8_000))])
        .then(() => run())
        .then(() => backfillComputedCost(ledger, opts?.cfg))
        .catch(() => {});
    }, 2_000);
    firstTimer.unref?.();
    state.reconcileTimer = setInterval(() => {
      void run();
      // Retention is enforced on a schedule too, not only at boot.
      try {
        ledger.pruneOlderThan(Date.now() - retentionDays * 24 * 60 * 60_000);
      } catch {
        // non-essential
      }
    }, RECONCILE_INTERVAL_MS);
    state.reconcileTimer.unref?.();
  }
  return ledger;
}
