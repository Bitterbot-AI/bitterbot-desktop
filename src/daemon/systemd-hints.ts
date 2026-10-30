import { formatCliCommand } from "../cli/command-format.js";

export function isSystemdUnavailableDetail(detail?: string): boolean {
  if (!detail) {
    return false;
  }
  const normalized = detail.toLowerCase();
  return (
    normalized.includes("systemctl --user unavailable") ||
    normalized.includes("systemctl not available") ||
    normalized.includes("not been booted with systemd") ||
    normalized.includes("failed to connect to bus") ||
    normalized.includes("systemd user services are required")
  );
}

export function renderSystemdUnavailableHints(options: { wsl?: boolean } = {}): string[] {
  if (options.wsl) {
    return [
      `WSL2 without systemd: the gateway can run under the WSL supervisor (crash relaunch + a Windows logon task): ${formatCliCommand("bitterbot gateway install")}`,
      "Alternative: enable systemd in /etc/wsl.conf ([boot] systemd=true), then wsl --shutdown from PowerShell and reopen the distro; verify with systemctl --user status.",
    ];
  }
  return [
    "systemd user services are unavailable; install/enable systemd or run the gateway under your supervisor.",
    `If you're in a container, run the gateway in the foreground instead of \`${formatCliCommand("bitterbot gateway")}\`.`,
  ];
}
