/**
 * PLAN-50 doctor lines that answer "what does this node spend when nobody is talking to it?"
 *
 * - unread prompt-cache writes (7d): dollars written to the prompt cache by lanes that never
 *   read it back, per lane; warn at >= $1/day, fail at >= $5/day.
 * - heartbeat cost and cost of pass (7d): what the heartbeat lane cost per delivered message.
 * - idle-day floor (14d): the cheapest day with zero real turns, naming the lane that set it.
 *
 * Pure over the ledger (plus the heartbeat considerations log for deliveries) so the checks
 * are testable with an in-memory database.
 */

import fs from "node:fs";
import path from "node:path";
import type { UsageLedger } from "./usage-ledger.js";
import { CONFIG_DIR } from "../utils.js";
import { __considerationsConsts } from "./heartbeat-considerations.js";
import { describeUsageFeature, USAGE_FEATURES } from "./usage-features.js";
import { formatUsageDay } from "./usage-ledger.types.js";
import { buildCacheHealth, describeUnreadCacheTip } from "./usage-summary.js";

const DAY_MS = 24 * 60 * 60_000;
const SEP = String.fromCharCode(1);

export const UNREAD_CACHE_WARN_USD_PER_DAY = 1;
export const UNREAD_CACHE_FAIL_USD_PER_DAY = 5;
export const HEARTBEAT_NO_DELIVERY_WARN_USD_PER_DAY = 1;
export const IDLE_FLOOR_WARN_USD_PER_DAY = 1;
/** A chat turn is "real" when the model actually answered or read its cache. */
export const REAL_TURN_MIN_OUTPUT = 20;

export type UsageDoctorLine = {
  level: "ok" | "info" | "warn" | "error";
  message: string;
};

const usd = (v: number) => `$${v.toFixed(2)}`;

export function unreadCacheWriteCheck(params: {
  ledger: UsageLedger;
  nowMs: number;
  days?: number;
}): UsageDoctorLine {
  const days = params.days ?? 7;
  const health = buildCacheHealth(
    params.ledger,
    { startMs: params.nowMs - days * DAY_MS, endMs: params.nowMs },
    params.nowMs,
  );
  const perDay = health.unreadWriteUsd / days;
  const lanes = health.unreadByFeature
    .map(
      (l) =>
        `${l.label} ${usd(l.usd)} (${l.requests} req${l.ttl && l.ttl !== "none" ? `, ${l.ttl} TTL` : ""})`,
    )
    .join(", ");
  const head = `unread prompt-cache writes, last ${days}d: ${usd(health.unreadWriteUsd)} (${usd(perDay)}/day)`;
  if (perDay >= UNREAD_CACHE_FAIL_USD_PER_DAY) {
    return {
      level: "error",
      message: `${head}: ${lanes}. ${describeUnreadCacheTip(health.unreadByFeature[0]?.ttl ?? health.ttl)}`,
    };
  }
  if (perDay >= UNREAD_CACHE_WARN_USD_PER_DAY) {
    return {
      level: "warn",
      message: `${head}: ${lanes}. ${describeUnreadCacheTip(health.unreadByFeature[0]?.ttl ?? health.ttl)}`,
    };
  }
  return {
    level: health.unreadWriteUsd > 0 ? "info" : "ok",
    message:
      health.unreadWriteUsd > 0
        ? `${head}, under the ${usd(UNREAD_CACHE_WARN_USD_PER_DAY)}/day watermark: ${lanes}`
        : `${head}; every cached prompt was read back`,
  };
}

/** Delivered heartbeat messages in the window, from the considerations log (sync; small files). */
export function countHeartbeatDeliveries(params: {
  nowMs: number;
  days: number;
  dir?: string;
}): number {
  const dir = params.dir ?? path.join(CONFIG_DIR, __considerationsConsts.DIR_NAME);
  let delivered = 0;
  for (let i = 0; i < params.days; i += 1) {
    const day = formatUsageDay(params.nowMs - i * DAY_MS);
    const file = path.join(
      dir,
      `${__considerationsConsts.FILE_PREFIX}${day}${__considerationsConsts.FILE_SUFFIX}`,
    );
    let raw: string;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const line of raw.split("\n")) {
      if (!line.includes("delivered heartbeat payload")) {
        continue;
      }
      try {
        const entry = JSON.parse(line) as { category?: string; decision?: string; reason?: string };
        if (
          entry.category === "channel-route" &&
          entry.decision === "acted" &&
          entry.reason === "delivered heartbeat payload"
        ) {
          delivered += 1;
        }
      } catch {
        // not a consideration line
      }
    }
  }
  return delivered;
}

export function heartbeatCostCheck(params: {
  ledger: UsageLedger;
  nowMs: number;
  days?: number;
  /** Test hook; defaults to the considerations log. */
  deliveries?: number;
  considerationsDir?: string;
}): UsageDoctorLine {
  const days = params.days ?? 7;
  const row = params.ledger.aggregate({
    feature: USAGE_FEATURES.agentHeartbeat,
    startMs: params.nowMs - days * DAY_MS,
    endMs: params.nowMs,
  })[0];
  const ticks = Number(row?.calls ?? 0);
  const cost = Number(row?.cost_total ?? 0);
  if (ticks === 0) {
    return { level: "ok", message: `heartbeat: no model calls in the last ${days}d` };
  }
  const deliveries =
    params.deliveries ??
    countHeartbeatDeliveries({ nowMs: params.nowMs, days, dir: params.considerationsDir });
  const perDay = cost / days;
  const pass =
    deliveries > 0
      ? `cost of pass: ${usd(cost / deliveries)} per delivered message (${deliveries} delivered)`
      : "cost of pass: no deliveries (every tick returned only the ack)";
  const message = `heartbeat: ${ticks} ticks cost ${usd(cost)} in ${days}d (${usd(perDay)}/day); ${pass}`;
  if (deliveries === 0 && perDay >= HEARTBEAT_NO_DELIVERY_WARN_USD_PER_DAY) {
    return {
      level: "warn",
      message: `${message}. Make HEARTBEAT.md comments-only to skip idle ticks, or set agents.defaults.heartbeat.model to a cheap model / a longer every.`,
    };
  }
  return { level: "info", message };
}

export function idleDayFloorCheck(params: {
  ledger: UsageLedger;
  nowMs: number;
  days?: number;
}): UsageDoctorLine {
  const days = params.days ?? 14;
  // Whole UTC days only: today is partial and would always be the floor.
  const todayStart = Date.parse(`${formatUsageDay(params.nowMs)}T00:00:00Z`);
  const rows = params.ledger.aggregate(
    { startMs: todayStart - days * DAY_MS, endMs: todayStart - 1 },
    `day || '${SEP}' || feature`,
    `, SUM(CASE WHEN feature = '${USAGE_FEATURES.agentTurn}' AND (output > ${REAL_TURN_MIN_OUTPUT} OR cache_read > 0) THEN 1 ELSE 0 END) AS real_turns`,
  );
  type DayAcc = { cost: number; realTurns: number; lanes: Map<string, number> };
  const byDay = new Map<string, DayAcc>();
  for (const r of rows) {
    const [day, feature] = String(r.group_key ?? "").split(SEP);
    if (!day) {
      continue;
    }
    const acc = byDay.get(day) ?? { cost: 0, realTurns: 0, lanes: new Map() };
    acc.cost += Number(r.cost_total ?? 0);
    acc.realTurns += Number((r as { real_turns?: number }).real_turns ?? 0);
    acc.lanes.set(
      feature ?? "unknown",
      (acc.lanes.get(feature ?? "unknown") ?? 0) + Number(r.cost_total ?? 0),
    );
    byDay.set(day, acc);
  }
  const idle = Array.from(byDay.entries()).filter(([, d]) => d.realTurns === 0);
  if (idle.length === 0) {
    return {
      level: "info",
      message: `idle-day floor: no idle days in the last ${days}d (every day had real chat turns)`,
    };
  }
  const [floorDay, floor] = idle.toSorted((a, b) => a[1].cost - b[1].cost)[0]!;
  const top = Array.from(floor.lanes.entries()).toSorted((a, b) => b[1] - a[1])[0];
  const topText = top ? `${describeUsageFeature(top[0])} ${usd(top[1])}` : "nothing";
  const message = `idle-day floor: ${usd(floor.cost)}/day (${floorDay}, lowest of ${idle.length} idle day(s) in ${days}d with zero real turns); top lane that day: ${topText}`;
  if (floor.cost >= IDLE_FLOOR_WARN_USD_PER_DAY) {
    return {
      level: "warn",
      message: `${message}. That is what the node burns with nobody talking to it; start with that lane.`,
    };
  }
  return { level: "info", message };
}

export function collectUsageDoctorLines(params: {
  ledger: UsageLedger;
  nowMs: number;
  considerationsDir?: string;
}): UsageDoctorLine[] {
  return [unreadCacheWriteCheck(params), heartbeatCostCheck(params), idleDayFloorCheck(params)];
}
