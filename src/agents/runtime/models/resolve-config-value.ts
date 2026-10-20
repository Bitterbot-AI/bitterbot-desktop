/**
 * Config value resolution for API keys and header values: shell commands
 * ("!command"), environment variable names, or literals.
 *
 * Ported from pi-coding-agent 0.73.1 (MIT, Mario Zechner / pi-mono):
 * `src/core/resolve-config-value.ts`, plus the Windows branch of
 * `getShellConfig()` from `src/utils/shell.ts` (the only part of that file
 * this module reaches).
 *
 * What is ported: `resolveConfigValue` (cached command execution),
 * `resolveConfigValueUncached`, `resolveConfigValueOrThrow`,
 * `resolveHeadersOrThrow`, `clearConfigValueCache`. Shell invocation, the
 * 10 second timeout, stdio handling and the process-lifetime cache are
 * unchanged.
 *
 * Differences from the original:
 * - The command result cache is this module's own. pi keeps a separate cache
 *   in its own module, so while both implementations are loaded a command can
 *   run once per implementation instead of once per process.
 * - `getShellConfig()` is reduced to its Windows branch with no custom shell
 *   path (pi calls it with no arguments, and only on Windows). The Unix
 *   branches and the error message text of the original are not reachable
 *   from here: any failure to find a shell falls through to the default
 *   shell, exactly as the original's try/catch does.
 *
 * Not ported: `resolveHeaders` (the non-throwing variant, unused by the
 * ported classes), `getShellEnv`, and the rest of `utils/shell.ts`.
 *
 * Security: a value starting with "!" is executed as a shell command with the
 * privileges of this process. That is pi's behaviour and it is kept exactly;
 * it is not widened. Resolved values are never logged here.
 */

import { execSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

// Cache for shell command results (persists for process lifetime).
const commandResultCache = new Map<string, string | undefined>();

/**
 * Resolve a config value (API key, header value, etc.) to an actual value.
 * - If it starts with "!", executes the rest as a shell command and uses stdout (cached).
 * - Otherwise checks the environment variable of that name first, then treats
 *   the value as a literal (not cached).
 */
export function resolveConfigValue(config: string): string | undefined {
  if (config.startsWith("!")) {
    return executeCommand(config);
  }
  const envValue = process.env[config];
  return envValue || config;
}

/** Windows only: Git Bash in known locations, then bash.exe on PATH. */
function findWindowsBash(): string | undefined {
  const paths: string[] = [];
  const programFiles = process.env.ProgramFiles;
  if (programFiles) {
    paths.push(`${programFiles}\\Git\\bin\\bash.exe`);
  }
  const programFilesX86 = process.env["ProgramFiles(x86)"];
  if (programFilesX86) {
    paths.push(`${programFilesX86}\\Git\\bin\\bash.exe`);
  }
  for (const candidate of paths) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  try {
    const result = spawnSync("where", ["bash.exe"], { encoding: "utf-8", timeout: 5000 });
    if (result.status === 0 && result.stdout) {
      const firstMatch = result.stdout.trim().split(/\r?\n/)[0];
      if (firstMatch && existsSync(firstMatch)) {
        return firstMatch;
      }
    }
  } catch {
    // Ignore errors.
  }
  return undefined;
}

function executeWithConfiguredShell(command: string): {
  executed: boolean;
  value: string | undefined;
} {
  try {
    const shell = findWindowsBash();
    if (!shell) {
      // The original throws "No bash shell found" here and catches it below.
      return { executed: false, value: undefined };
    }
    const result = spawnSync(shell, ["-c", command], {
      encoding: "utf-8",
      timeout: 10000,
      stdio: ["ignore", "pipe", "ignore"],
      shell: false,
      windowsHide: true,
    });

    if (result.error) {
      const error = result.error as NodeJS.ErrnoException;
      if (error.code === "ENOENT") {
        return { executed: false, value: undefined };
      }
      return { executed: true, value: undefined };
    }

    if (result.status !== 0) {
      return { executed: true, value: undefined };
    }

    const value = (result.stdout ?? "").trim();
    return { executed: true, value: value || undefined };
  } catch {
    return { executed: false, value: undefined };
  }
}

function executeWithDefaultShell(command: string): string | undefined {
  try {
    const output = execSync(command, {
      encoding: "utf-8",
      timeout: 10000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return output.trim() || undefined;
  } catch {
    return undefined;
  }
}

function executeCommandUncached(commandConfig: string): string | undefined {
  const command = commandConfig.slice(1);
  if (process.platform === "win32") {
    const configuredResult = executeWithConfiguredShell(command);
    return configuredResult.executed ? configuredResult.value : executeWithDefaultShell(command);
  }
  return executeWithDefaultShell(command);
}

function executeCommand(commandConfig: string): string | undefined {
  if (commandResultCache.has(commandConfig)) {
    return commandResultCache.get(commandConfig);
  }

  const result = executeCommandUncached(commandConfig);
  commandResultCache.set(commandConfig, result);
  return result;
}

/** Same resolution as `resolveConfigValue`, but a command is executed every time. */
export function resolveConfigValueUncached(config: string): string | undefined {
  if (config.startsWith("!")) {
    return executeCommandUncached(config);
  }
  const envValue = process.env[config];
  return envValue || config;
}

export function resolveConfigValueOrThrow(config: string, description: string): string {
  const resolvedValue = resolveConfigValueUncached(config);
  if (resolvedValue !== undefined) {
    return resolvedValue;
  }

  if (config.startsWith("!")) {
    throw new Error(`Failed to resolve ${description} from shell command: ${config.slice(1)}`);
  }

  throw new Error(`Failed to resolve ${description}`);
}

/** Resolve all header values using the same resolution logic as API keys. */
export function resolveHeadersOrThrow(
  headers: Record<string, string> | undefined,
  description: string,
): Record<string, string> | undefined {
  if (!headers) {
    return undefined;
  }
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    resolved[key] = resolveConfigValueOrThrow(value, `${description} header "${key}"`);
  }
  return Object.keys(resolved).length > 0 ? resolved : undefined;
}

/** Clear the config value command cache. Exported for testing. */
export function clearConfigValueCache(): void {
  commandResultCache.clear();
}
