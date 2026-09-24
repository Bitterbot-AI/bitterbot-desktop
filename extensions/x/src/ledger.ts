/**
 * Append-only JSONL ledger of everything this channel has posted. The policy
 * gate reads it for rate limits and duplicate detection; the CLI prints it.
 * One file per account under <stateDir>/x/.
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { XLedgerEntry } from "./types.js";
import { resolveLedgerPath } from "./paths.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export async function readLedger(params: {
  accountId: string;
  sinceMs?: number;
  ledgerPath?: string;
}): Promise<XLedgerEntry[]> {
  const file = params.ledgerPath ?? resolveLedgerPath({ accountId: params.accountId });
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw err;
  }
  const since = params.sinceMs ?? 0;
  const out: XLedgerEntry[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const entry = JSON.parse(trimmed) as XLedgerEntry;
      if (typeof entry.ts === "number" && entry.ts >= since && typeof entry.text === "string") {
        out.push(entry);
      }
    } catch {
      // skip corrupt line; never let one bad line disable the gate
    }
  }
  return out;
}

export async function appendLedger(entry: XLedgerEntry, ledgerPath?: string): Promise<void> {
  const file = ledgerPath ?? resolveLedgerPath({ accountId: entry.accountId });
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await fs.appendFile(file, `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: 0o600 });
}

export function ledgerWindowStart(days: number, now = Date.now()): number {
  return now - Math.max(1, days) * DAY_MS;
}
