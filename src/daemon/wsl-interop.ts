/**
 * Windows interop from inside WSL: the System32 binaries the supervisor
 * backend needs (schtasks.exe for the boot trigger, wsl.exe as the task
 * action, cmd.exe to read the Windows user and temp dir) and the wslpath
 * conversions between the two path worlds. Everything takes injected exec and
 * fs probes so tests never touch the real binaries.
 */

import fsSync from "node:fs";
import { execFileUtf8, type ExecResult } from "./exec-file.js";

export type ExecFn = (command: string, args: string[]) => Promise<ExecResult>;

export type WindowsInterop = {
  system32: string;
  schtasksExe: string;
  wslExe: string;
  cmdExe: string;
};

export const DEFAULT_WSL_SYSTEM32 = "/mnt/c/Windows/System32";

export type ResolveWindowsInteropOptions = {
  env?: Record<string, string | undefined>;
  existsSync?: (path: string) => boolean;
};

/**
 * The interop binaries under the Windows system mount, or null when they are
 * not reachable (interop disabled in wsl.conf, drive not mounted).
 */
export function resolveWindowsInterop(
  options: ResolveWindowsInteropOptions = {},
): WindowsInterop | null {
  const env = options.env ?? process.env;
  const existsSync = options.existsSync ?? fsSync.existsSync;
  const system32 = env.BITTERBOT_WSL_SYSTEM32?.trim() || DEFAULT_WSL_SYSTEM32;
  const interop: WindowsInterop = {
    system32,
    schtasksExe: `${system32}/schtasks.exe`,
    wslExe: `${system32}/wsl.exe`,
    cmdExe: `${system32}/cmd.exe`,
  };
  for (const file of [interop.schtasksExe, interop.wslExe, interop.cmdExe]) {
    if (!existsSync(file)) {
      return null;
    }
  }
  return interop;
}

export function resolveWslDistroName(
  env: Record<string, string | undefined> = process.env,
): string | null {
  const name = env.WSL_DISTRO_NAME?.trim();
  return name || null;
}

function firstLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? ""
  );
}

/** `cmd.exe /c echo %USERDOMAIN%\%USERNAME%` -> DOMAIN\user */
export async function readWindowsUser(
  interop: WindowsInterop,
  exec: ExecFn = execFileUtf8,
): Promise<string | null> {
  const res = await exec(interop.cmdExe, ["/c", "echo %USERDOMAIN%\\%USERNAME%"]);
  if (res.code !== 0) {
    return null;
  }
  const value = firstLine(res.stdout);
  if (!value || value.includes("%")) {
    return null;
  }
  return value;
}

/** `cmd.exe /c echo %TEMP%` converted with `wslpath -u`. */
export async function readWindowsTempDir(
  interop: WindowsInterop,
  exec: ExecFn = execFileUtf8,
): Promise<{ windows: string; linux: string } | null> {
  const res = await exec(interop.cmdExe, ["/c", "echo %TEMP%"]);
  if (res.code !== 0) {
    return null;
  }
  const windows = firstLine(res.stdout);
  if (!windows || windows.includes("%")) {
    return null;
  }
  const linux = await toLinuxPath(windows, exec);
  if (!linux) {
    return null;
  }
  return { windows, linux };
}

export async function toWindowsPath(
  linuxPath: string,
  exec: ExecFn = execFileUtf8,
): Promise<string | null> {
  const res = await exec("wslpath", ["-w", linuxPath]);
  if (res.code !== 0) {
    return null;
  }
  return firstLine(res.stdout) || null;
}

export async function toLinuxPath(
  windowsPath: string,
  exec: ExecFn = execFileUtf8,
): Promise<string | null> {
  const res = await exec("wslpath", ["-u", windowsPath]);
  if (res.code !== 0) {
    return null;
  }
  return firstLine(res.stdout) || null;
}

export function renderNoInteropHints(): string[] {
  return [
    "Windows interop (schtasks.exe, wsl.exe under /mnt/c/Windows/System32) is not reachable from this distro, so no logon task was registered; the supervisor only runs until the next Windows reboot.",
    "Enable interop in /etc/wsl.conf ([interop] enabled=true, appendWindowsPath=true) or start the supervisor by hand after a reboot: bitterbot gateway start",
  ];
}
