/**
 * Environment hand-over for `bitterbot gateway switch`
 * (src/infra/gateway-switch.ts).
 *
 * - A git clone's gateway loaded `<clone>/.env` (dotenv reads the working
 *   directory first, src/infra/dotenv.ts); a release install only reads the
 *   state directory's `.env`. The keys the state directory lacks are COPIED
 *   into it (never moved, never overwriting a key, the clone's file never
 *   touched, the target backed up first, mode 0600, existing content kept and
 *   the new keys appended). Only key names are ever printed.
 * - The old service's environment (state dir, config path, profile, keys set
 *   with `gateway install`) is carried to the new service.
 * - systemd `EnvironmentFile=` lines of the old unit are kept on the new one.
 */

import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import { KNOWN_CREDENTIAL_ENV } from "../config/known-env-vars.js";

/** Variables that belong to an install or a service manager, never carried. */
const NOT_CARRIED = new Set([
  "PATH",
  "HOME",
  "BITTERBOT_INSTALL_KIND",
  "BITTERBOT_INSTALL_ROOT",
  "BITTERBOT_NODE_OPTIONS_READY",
  "BITTERBOT_LAUNCHD_LABEL",
  "BITTERBOT_SYSTEMD_UNIT",
  "BITTERBOT_WINDOWS_TASK_NAME",
  "BITTERBOT_TASK_SCRIPT_NAME",
  "BITTERBOT_SERVICE_MARKER",
  "BITTERBOT_SERVICE_KIND",
  "BITTERBOT_SERVICE_VERSION",
]);

/** The old service's environment worth keeping on the new service. */
export function carriedServiceEnv(
  environment: Record<string, string> | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(environment ?? {})) {
    if (!NOT_CARRIED.has(key) && !key.startsWith("npm_")) {
      out[key] = value;
    }
  }
  return out;
}

/** Serialise one value so dotenv parses it back unchanged, or null when it cannot. */
export function serializeDotEnvValue(value: string): string | null {
  if (!value.includes("'") && !value.includes("\n") && !value.includes("\r")) {
    return `'${value}'`;
  }
  if (!value.includes('"') && !value.includes("\\") && !value.includes("\r")) {
    return `"${value.replace(/\n/g, "\\n")}"`;
  }
  return null;
}

export type DotEnvMergePlan = {
  /** Keys to append (in source order). */
  keys: string[];
  /** Keys that are missing but whose value cannot be written safely. */
  skipped: string[];
  lines: string[];
};

/** Which keys of `sourceText` the target lacks, and the lines that add them. Pure. */
export function planDotEnvMerge(sourceText: string, targetText: string): DotEnvMergePlan {
  const source = dotenv.parse(sourceText);
  const target = dotenv.parse(targetText);
  const plan: DotEnvMergePlan = { keys: [], skipped: [], lines: [] };
  for (const [key, value] of Object.entries(source)) {
    if (Object.hasOwn(target, key)) {
      continue;
    }
    const serialized = serializeDotEnvValue(value);
    if (serialized === null) {
      plan.skipped.push(key);
      continue;
    }
    plan.keys.push(key);
    plan.lines.push(`${key}=${serialized}`);
  }
  return plan;
}

function compactStamp(now: Date): string {
  return now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
}

/**
 * Copy the keys of `source` that `target` lacks into `target`. `target` is
 * backed up to `<target>.bak-<time>` first (when it exists); the new keys are
 * appended under a comment naming where they came from. `source` is only read.
 */
export function copyDotEnvKeys(params: { source: string; target: string; now?: Date }): {
  copied: string[];
  skipped: string[];
  backup: string | null;
} {
  const sourceText = fs.readFileSync(params.source, "utf8");
  const targetExists = fs.existsSync(params.target);
  const targetText = targetExists ? fs.readFileSync(params.target, "utf8") : "";
  const plan = planDotEnvMerge(sourceText, targetText);
  if (plan.keys.length === 0) {
    return { copied: [], skipped: plan.skipped, backup: null };
  }
  const now = params.now ?? new Date();
  let backup: string | null = null;
  if (targetExists) {
    backup = `${params.target}.bak-${compactStamp(now)}`;
    fs.copyFileSync(params.target, backup, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(backup, 0o600);
  } else {
    fs.mkdirSync(path.dirname(params.target), { recursive: true, mode: 0o700 });
  }
  const separator = targetText.length === 0 || targetText.endsWith("\n") ? "" : "\n";
  const block = [
    `${targetText.length > 0 ? "\n" : ""}# Copied from ${params.source} by \`bitterbot gateway switch\` on ${now.toISOString()}`,
    ...plan.lines,
    "",
  ].join("\n");
  fs.writeFileSync(params.target, `${targetText}${separator}${block}`, { mode: 0o600 });
  fs.chmodSync(params.target, 0o600);
  return { copied: plan.keys, skipped: plan.skipped, backup };
}

const PROCESS_ONLY_IGNORED = new Set([
  "BITTERBOT_NODE_OPTIONS_READY",
  "BITTERBOT_INSTALL_KIND",
  "BITTERBOT_INSTALL_ROOT",
  "BITTERBOT_INSTALLER",
  "BITTERBOT_SERVICE_MARKER",
  "BITTERBOT_SERVICE_KIND",
  "BITTERBOT_SERVICE_VERSION",
]);

/** A variable Bitterbot reads: a BITTERBOT_* setting or a credential it knows. */
export function isBitterbotEnvName(name: string): boolean {
  return (
    (name.startsWith("BITTERBOT_") && !PROCESS_ONLY_IGNORED.has(name)) ||
    KNOWN_CREDENTIAL_ENV.has(name)
  );
}

/**
 * Names of credentials Bitterbot reads and BITTERBOT_* settings the old
 * process had that
 * neither `.env` file, the old service definition nor this shell provide: a
 * new gateway would not see them. Names only.
 */
export function processOnlyEnvNames(params: {
  processEnv: Record<string, string>;
  known: Array<Record<string, string | undefined>>;
}): string[] {
  const out: string[] = [];
  for (const name of Object.keys(params.processEnv)) {
    if (!isBitterbotEnvName(name)) {
      continue;
    }
    if (params.known.some((k) => k[name] !== undefined)) {
      continue;
    }
    out.push(name);
  }
  return out.toSorted();
}

/** `EnvironmentFile=` values of a systemd unit. */
export function parseEnvironmentFiles(unit: string): string[] {
  const out: string[] = [];
  for (const raw of unit.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("EnvironmentFile=")) {
      out.push(line.slice("EnvironmentFile=".length).trim());
    }
  }
  return out;
}

/** Add `EnvironmentFile=` lines to the [Service] section (skipping ones already there). */
export function insertEnvironmentFiles(unit: string, files: string[]): string {
  const existing = new Set(parseEnvironmentFiles(unit));
  const add = files.filter((f) => f && !existing.has(f));
  if (add.length === 0) {
    return unit;
  }
  const lines = unit.split("\n");
  const at = lines.findIndex((l) => l.trim() === "[Service]");
  if (at === -1) {
    return unit;
  }
  lines.splice(at + 1, 0, ...add.map((f) => `EnvironmentFile=${f}`));
  return lines.join("\n");
}

/** A process's environment (Linux, own processes), or null. */
export function readProcEnviron(pid: number, procRoot = "/proc"): Record<string, string> | null {
  try {
    const raw = fs.readFileSync(path.join(procRoot, String(pid), "environ"), "utf8");
    const out: Record<string, string> = {};
    for (const entry of raw.split("\0")) {
      const i = entry.indexOf("=");
      if (i > 0) {
        out[entry.slice(0, i)] = entry.slice(i + 1);
      }
    }
    return out;
  } catch {
    return null;
  }
}
