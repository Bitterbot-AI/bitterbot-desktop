import { execFileUtf8, type ExecResult } from "./exec-file.js";

export type ExecSchtasksOptions = {
  /**
   * Explicit executable. Windows resolves `schtasks` from PATH; from inside
   * WSL the interop binary has to be named by its mount path
   * (/mnt/c/Windows/System32/schtasks.exe).
   */
  executable?: string;
  /** Injected runner (tests). */
  exec?: (command: string, args: string[]) => Promise<ExecResult>;
};

export async function execSchtasks(
  args: string[],
  options: ExecSchtasksOptions = {},
): Promise<ExecResult> {
  const executable = options.executable ?? "schtasks";
  if (options.exec) {
    return await options.exec(executable, args);
  }
  return await execFileUtf8(executable, args, { windowsHide: true });
}
