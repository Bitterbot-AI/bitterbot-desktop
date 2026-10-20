import os from "node:os";
import path from "node:path";
import { DEFAULT_ACCOUNT_ID } from "./config.js";

/** Mirrors core resolveStateDir: BITTERBOT_STATE_DIR override, else ~/.bitterbot. */
export function resolveXStateDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.BITTERBOT_STATE_DIR?.trim();
  if (override) {
    return override.startsWith("~")
      ? path.join(os.homedir(), override.slice(1))
      : path.resolve(override);
  }
  return path.join(os.homedir(), ".bitterbot");
}

export function resolveXDir(env?: NodeJS.ProcessEnv): string {
  return path.join(resolveXStateDir(env), "x");
}

function safeAccountId(accountId?: string | null): string {
  const id = (accountId ?? DEFAULT_ACCOUNT_ID).trim() || DEFAULT_ACCOUNT_ID;
  return id.replace(/[^A-Za-z0-9_.-]/g, "_");
}

export function resolveTokenFilePath(params: {
  accountId?: string | null;
  override?: string;
  env?: NodeJS.ProcessEnv;
}): string {
  if (params.override?.trim()) {
    const raw = params.override.trim();
    return raw.startsWith("~") ? path.join(os.homedir(), raw.slice(1)) : path.resolve(raw);
  }
  return path.join(resolveXDir(params.env), `${safeAccountId(params.accountId)}.token.json`);
}

export function resolveLedgerPath(params: { accountId?: string | null; env?: NodeJS.ProcessEnv }) {
  return path.join(resolveXDir(params.env), `${safeAccountId(params.accountId)}.posts.jsonl`);
}

/** Presence of this file blocks every outbound post regardless of config. */
export function resolveKillSwitchPath(env?: NodeJS.ProcessEnv): string {
  return path.join(resolveXDir(env), "KILL");
}
