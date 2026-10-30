/**
 * The Windows scheduled task that starts the WSL gateway supervisor at logon.
 *
 * Registered through `schtasks.exe /Create /XML` rather than `/SC ONLOGON`
 * flags: the flags cannot turn off the default 72 hour ExecutionTimeLimit,
 * which would kill a supervisor that has to run for weeks. The XML is written
 * as UTF-16 LE with a BOM, the encoding schtasks expects for /XML input.
 */

import { normalizeGatewayProfile } from "./constants.js";

export const WSL_TASK_SCHEMA = "http://schemas.microsoft.com/windows/2004/02/mit/task";
export const WINDOWS_WSL_EXE = "C:\\Windows\\System32\\wsl.exe";

export type WslTaskSpec = {
  taskName: string;
  description: string;
  /** DOMAIN\\user as cmd.exe reports it; the logon trigger and principal. */
  windowsUser: string;
  distro: string;
  linuxUser: string;
  /**
   * The Linux program that runs `gateway supervise`: the release launcher
   * (["/home/u/.bitterbot/app/current/bin/bitterbot"]) or node plus the CLI
   * entry (["/usr/bin/node", "/opt/bitterbot/dist/entry.js"]).
   */
  launcher: string[];
  /** Defaults to C:\\Windows\\System32\\wsl.exe. */
  wslExe?: string;
};

export function resolveWslTaskName(distro: string, profile?: string): string {
  const normalized = normalizeGatewayProfile(profile);
  const base = `Bitterbot Gateway (WSL ${distro})`;
  return normalized ? `${base} (${normalized})` : base;
}

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** `wsl.exe -d <distro> -u <user> -- <launcher...> gateway supervise` */
export function buildWslTaskArguments(
  spec: Pick<WslTaskSpec, "distro" | "linuxUser" | "launcher">,
): string {
  const quote = (value: string) => (/\s/.test(value) ? `"${value}"` : value);
  return [
    "-d",
    quote(spec.distro),
    "-u",
    quote(spec.linuxUser),
    "--",
    ...spec.launcher.map(quote),
    "gateway",
    "supervise",
  ].join(" ");
}

export function buildWslTaskXml(spec: WslTaskSpec): string {
  const user = escapeXml(spec.windowsUser);
  const lines = [
    '<?xml version="1.0" encoding="UTF-16"?>',
    `<Task version="1.4" xmlns="${WSL_TASK_SCHEMA}">`,
    "  <RegistrationInfo>",
    `    <Description>${escapeXml(spec.description)}</Description>`,
    `    <URI>\\${escapeXml(spec.taskName)}</URI>`,
    "  </RegistrationInfo>",
    "  <Triggers>",
    "    <LogonTrigger>",
    "      <Enabled>true</Enabled>",
    `      <UserId>${user}</UserId>`,
    "    </LogonTrigger>",
    "  </Triggers>",
    "  <Principals>",
    '    <Principal id="Author">',
    `      <UserId>${user}</UserId>`,
    "      <LogonType>InteractiveToken</LogonType>",
    "      <RunLevel>LeastPrivilege</RunLevel>",
    "    </Principal>",
    "  </Principals>",
    "  <Settings>",
    "    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>",
    "    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>",
    "    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>",
    "    <AllowHardTerminatingTask>true</AllowHardTerminatingTask>",
    "    <StartWhenAvailable>true</StartWhenAvailable>",
    "    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>",
    "    <IdleSettings>",
    "      <StopOnIdleEnd>false</StopOnIdleEnd>",
    "      <RestartOnIdle>false</RestartOnIdle>",
    "    </IdleSettings>",
    "    <AllowStartOnDemand>true</AllowStartOnDemand>",
    "    <Enabled>true</Enabled>",
    "    <Hidden>false</Hidden>",
    "    <RunOnlyIfIdle>false</RunOnlyIfIdle>",
    "    <WakeToRun>false</WakeToRun>",
    "    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>",
    "    <Priority>7</Priority>",
    "    <RestartOnFailure>",
    "      <Interval>PT1M</Interval>",
    "      <Count>3</Count>",
    "    </RestartOnFailure>",
    "  </Settings>",
    '  <Actions Context="Author">',
    "    <Exec>",
    `      <Command>${escapeXml(spec.wslExe ?? WINDOWS_WSL_EXE)}</Command>`,
    `      <Arguments>${escapeXml(buildWslTaskArguments(spec))}</Arguments>`,
    "    </Exec>",
    "  </Actions>",
    "</Task>",
  ];
  return `${lines.join("\r\n")}\r\n`;
}

/** UTF-16 LE with BOM, as schtasks.exe /XML expects. */
export function encodeTaskXmlUtf16(xml: string): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, "utf16le")]);
}
