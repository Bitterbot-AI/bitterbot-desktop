import { Option, type Command } from "commander";
import { installerOutputMode } from "../../infra/installer-env.js";
import { defaultRuntime } from "../../runtime.js";
import {
  runDaemonInstall,
  runDaemonRestart,
  runDaemonStart,
  runDaemonStatus,
  runDaemonStop,
  runDaemonUninstall,
} from "./runners.js";

export function addGatewayServiceCommands(parent: Command, opts?: { statusDescription?: string }) {
  parent
    .command("status")
    .description(opts?.statusDescription ?? "Show gateway service status + probe the Gateway")
    .option("--url <url>", "Gateway WebSocket URL (defaults to config/remote/local)")
    .option("--token <token>", "Gateway token (if required)")
    .option("--password <password>", "Gateway password (password auth)")
    .option("--timeout <ms>", "Timeout in ms", "10000")
    .option("--no-probe", "Skip RPC probe")
    .option("--deep", "Scan system-level services", false)
    .option("--json", "Output JSON", false)
    .action(async (cmdOpts) => {
      await runDaemonStatus({
        rpc: cmdOpts,
        probe: Boolean(cmdOpts.probe),
        deep: Boolean(cmdOpts.deep),
        json: Boolean(cmdOpts.json),
      });
    });

  parent
    .command("install")
    .description("Install the Gateway service (launchd/systemd/schtasks)")
    .option("--port <port>", "Gateway port")
    .option("--runtime <runtime>", "Daemon runtime (node|bun). Default: node")
    .option("--token <token>", "Gateway token (token auth)")
    .option("--force", "Reinstall/overwrite if already installed", false)
    .option("--json", "Output JSON", false)
    .action(async (cmdOpts) => {
      await runDaemonInstall(cmdOpts);
    });

  parent
    .command("uninstall")
    .description("Uninstall the Gateway service (launchd/systemd/schtasks)")
    .option("--json", "Output JSON", false)
    .action(async (cmdOpts) => {
      await runDaemonUninstall(cmdOpts);
    });

  parent
    .command("start")
    .description("Start the Gateway service (launchd/systemd/schtasks)")
    .option("--json", "Output JSON", false)
    .action(async (cmdOpts) => {
      await runDaemonStart(cmdOpts);
    });

  parent
    .command("stop")
    .description("Stop the Gateway service (launchd/systemd/schtasks)")
    .option("--json", "Output JSON", false)
    .action(async (cmdOpts) => {
      await runDaemonStop(cmdOpts);
    });

  parent
    .command("switch")
    .description(
      "Switch the running gateway and the background service to this install (after installing over a git clone or an older version)",
    )
    .option(
      "--check",
      "Only report what would be switched (exit 10 when a switch is available)",
      false,
    )
    .option("--dry-run", "Same as --check", false)
    .option("-y, --yes", "Switch without asking", false)
    .option("--port <port>", "Gateway port (default: from config)")
    .option("--timeout <ms>", "How long to wait for the new gateway to answer", "300000")
    .option("--json", "Output JSON", false)
    // install.sh already showed the summary before asking.
    .addOption(new Option("--no-summary").hideHelp())
    .action(async (cmdOpts) => {
      const { runGatewaySwitch } = await import("./switch.js");
      const code = await runGatewaySwitch({
        check: Boolean(cmdOpts.check || cmdOpts.dryRun),
        yes: Boolean(cmdOpts.yes),
        summary: cmdOpts.summary !== false,
        installer: installerOutputMode(process.env) !== null,
        json: Boolean(cmdOpts.json),
        port: cmdOpts.port,
        timeout: cmdOpts.timeout,
      });
      // Exit explicitly: install.sh waits on this command.
      defaultRuntime.exit(code);
    });

  parent
    .command("restart")
    .description("Restart the Gateway service (launchd/systemd/schtasks)")
    .option("--json", "Output JSON", false)
    .action(async (cmdOpts) => {
      await runDaemonRestart(cmdOpts);
    });
}
