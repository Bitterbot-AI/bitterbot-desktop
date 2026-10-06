/**
 * Completed wallet top-ups (PLAN-53 C5).
 *
 * The monthly funding ceiling counts what has already been added this period.
 * Nothing recorded a completed top-up before, so the ceiling always saw a
 * fresh month and could not stop anything. Each completed on-ramp session is
 * now written here once (keyed by its session id), and the ceiling reads it.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { assertNotRealStateUnderTest } from "../../infra/test-state-guard.js";
import type { TopUp } from "./funding-policy.js";

export type TopUpRecord = TopUp & {
  sessionId: string;
  /** "stripe-verified" when the amount was read back from Stripe. */
  source: "stripe-verified" | "reported";
  network?: string;
};

export function defaultTopUpLedgerPath(walletStorePath?: string): string {
  return path.join(
    walletStorePath ?? path.join(os.homedir(), ".bitterbot", "wallet"),
    "topups.json",
  );
}

export async function listTopUps(filePath: string): Promise<TopUpRecord[]> {
  assertNotRealStateUnderTest(filePath);
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
    return Array.isArray(parsed) ? (parsed as TopUpRecord[]) : [];
  } catch {
    return [];
  }
}

let writes: Promise<unknown> = Promise.resolve();

/** Record a completed top-up once. Returns false if the session was already recorded. */
export function recordTopUp(filePath: string, record: TopUpRecord): Promise<boolean> {
  const run = writes.then(async () => {
    const existing = await listTopUps(filePath);
    if (existing.some((r) => r.sessionId === record.sessionId)) {
      return false;
    }
    existing.push(record);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(existing.slice(-1000), null, 2), { mode: 0o600 });
    await fs.rename(tmp, filePath);
    return true;
  });
  writes = run.catch(() => {});
  return run;
}

/** Stripe's session id is the client secret's prefix: "cos_..._secret_...". */
export function sessionIdFromClientSecret(clientSecret: string): string | null {
  const id = clientSecret.split("_secret_")[0];
  return id && id !== clientSecret ? id : null;
}
