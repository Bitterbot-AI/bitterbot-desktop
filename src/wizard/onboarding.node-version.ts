/**
 * Gate the wizard on Node runtime version.
 *
 * The gateway imports Rolldown, which uses `styleText` from `node:util` —
 * that was added in Node 20.12 and is standard on 22 LTS. `package.json`
 * declares `engines.node: ">=22.12.0"`; pnpm warns but doesn't block, so
 * users on Node 18 would sail through install, walk the whole wizard, and
 * hit a cryptic `SyntaxError: ... does not provide an export named
 * 'styleText'` when the gateway tries to start. Gate at wizard entry so
 * the failure mode is "upgrade Node first" instead of "wizard lied to me."
 *
 * Behaviour:
 *   - Current Node >= min → silent pass.
 *   - Current Node < min → detect version managers (fnm / volta / asdf
 *     are binaries we can spawn; nvm is a shell function we cannot). For
 *     the binary-based managers, offer to run the install command now;
 *     after install, the *current* process still runs on the old Node, so
 *     we always tell the user to restart the shell and re-run the wizard.
 *     For nvm or no manager, print the exact command and bail cleanly.
 *
 * Why we don't just relaunch under the new Node: the path to the new
 * node binary varies by manager (fnm has per-version symlinks, nvm
 * doesn't export PATH changes to child processes, volta shims things
 * differently) and re-execing PID 1 of the wizard without the user's
 * shell rc sourcing is a recipe for weird environments. Restart is
 * boring but reliable.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { RuntimeEnv } from "../runtime.js";
import { WizardCancelledError, type WizardPrompter } from "./prompts.js";

// Kept in sync with package.json#engines.node.
const MIN_NODE = { major: 22, minor: 12, patch: 0 } as const;

type NodeVersion = { major: number; minor: number; patch: number };

function parseNodeVersion(raw: string): NodeVersion | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(raw.trim());
  if (!m) {
    return null;
  }
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
  };
}

function meetsMinimum(current: NodeVersion, min: NodeVersion): boolean {
  if (current.major !== min.major) {
    return current.major > min.major;
  }
  if (current.minor !== min.minor) {
    return current.minor > min.minor;
  }
  return current.patch >= min.patch;
}

type VersionManager = "fnm" | "volta" | "asdf" | "nvm";

function hasBinary(name: string): boolean {
  try {
    const result = spawnSync(name, ["--version"], {
      stdio: ["ignore", "ignore", "ignore"],
      shell: process.platform === "win32",
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

function hasNvm(): boolean {
  const nvmDir = process.env.NVM_DIR;
  if (!nvmDir) {
    return false;
  }
  try {
    return fs.existsSync(path.join(nvmDir, "nvm.sh"));
  } catch {
    return false;
  }
}

function detectManagers(): Set<VersionManager> {
  const found = new Set<VersionManager>();
  if (hasBinary("fnm")) {
    found.add("fnm");
  }
  if (hasBinary("volta")) {
    found.add("volta");
  }
  if (hasBinary("asdf")) {
    found.add("asdf");
  }
  if (hasNvm()) {
    found.add("nvm");
  }
  return found;
}

async function tryRunManagerInstall(
  manager: "fnm" | "volta" | "asdf",
  runtime: RuntimeEnv,
): Promise<boolean> {
  const commands: [string, string[]][] =
    manager === "fnm"
      ? [
          ["fnm", ["install", "22"]],
          ["fnm", ["use", "22"]],
        ]
      : manager === "volta"
        ? [["volta", ["install", "node@22"]]]
        : [
            ["asdf", ["plugin", "add", "nodejs"]],
            ["asdf", ["install", "nodejs", "22.12.0"]],
            ["asdf", ["global", "nodejs", "22.12.0"]],
          ];

  for (const [cmd, args] of commands) {
    runtime.log(`$ ${cmd} ${args.join(" ")}`);
    const result = spawnSync(cmd, args, {
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    if (result.status !== 0) {
      runtime.error(`${cmd} ${args.join(" ")} exited with code ${result.status ?? "null"}.`);
      return false;
    }
  }
  return true;
}

function platformInstallHint(): string {
  if (process.platform === "darwin") {
    return [
      "macOS:",
      "  brew install node@22",
      "  # or install a version manager: https://github.com/Schniz/fnm",
    ].join("\n");
  }
  if (process.platform === "linux") {
    return [
      "Linux / WSL2:",
      "  # fnm (recommended, single binary):",
      "  curl -fsSL https://fnm.vercel.app/install | bash",
      "  # then restart shell and:",
      "  fnm install 22 && fnm use 22",
    ].join("\n");
  }
  if (process.platform === "win32") {
    return [
      "Windows:",
      "  # fnm via winget:",
      "  winget install Schniz.fnm",
      "  # or nvm-windows: https://github.com/coreybutler/nvm-windows",
    ].join("\n");
  }
  return "Install Node 22 LTS: https://nodejs.org/en/download/";
}

export async function gateNodeVersion(params: {
  prompter: WizardPrompter;
  runtime: RuntimeEnv;
}): Promise<void> {
  const { prompter, runtime } = params;
  const current = parseNodeVersion(process.version);
  if (current && meetsMinimum(current, MIN_NODE)) {
    return;
  }

  const minStr = `${MIN_NODE.major}.${MIN_NODE.minor}.${MIN_NODE.patch}`;
  await prompter.note(
    [
      `You're running Node ${process.version}. Bitterbot needs >=${minStr}.`,
      "",
      "The gateway bundles Rolldown which depends on node:util styleText (added",
      "in Node 20.12 and standard in 22 LTS). On older Node you'd hit a cryptic",
      "SyntaxError partway through gateway startup — so we stop here instead.",
    ].join("\n"),
    "Node version",
  );

  const managers = detectManagers();

  // Offer to run the install for managers we can safely spawn as binaries.
  // nvm is a shell function; we can't invoke it directly from Node, so we
  // fall through to the "run these commands yourself" branch.
  const runnable: ("fnm" | "volta" | "asdf")[] = [];
  if (managers.has("fnm")) runnable.push("fnm");
  if (managers.has("volta")) runnable.push("volta");
  if (managers.has("asdf")) runnable.push("asdf");

  if (runnable.length > 0) {
    const picked =
      runnable.length === 1
        ? runnable[0]
        : ((await prompter.select({
            message: "Which version manager should install Node 22?",
            options: runnable.map((m) => ({ value: m, label: m })),
            initialValue: runnable[0],
          })) as "fnm" | "volta" | "asdf");

    const consent = await prompter.confirm({
      message: `Run ${picked} to install Node 22 now?`,
      initialValue: true,
    });
    if (consent) {
      const ok = await tryRunManagerInstall(picked, runtime);
      if (ok) {
        await prompter.note(
          [
            `Node 22 installed via ${picked}.`,
            "",
            "IMPORTANT: this wizard is still running on the old Node. You need to",
            "restart your shell so the new Node becomes active, then re-run",
            "`pnpm bitterbot onboard`.",
            "",
            "Quickest path:",
            "  exec $SHELL    # (re-sources your shell rc)",
            "  node -v        # (verify you see v22.x.x)",
            "  pnpm bitterbot onboard",
          ].join("\n"),
          "Restart required",
        );
        throw new WizardCancelledError("node upgrade complete — restart shell and re-run wizard");
      }
      await prompter.note(
        `${picked} install failed. Run it by hand, restart your shell, then re-run \`pnpm bitterbot onboard\`.`,
        "Node upgrade failed",
      );
      throw new WizardCancelledError("node upgrade failed");
    }
  }

  if (managers.has("nvm")) {
    await prompter.note(
      [
        "nvm is a shell function, so this wizard can't run it directly.",
        "Run these commands, then re-run the wizard:",
        "",
        "  nvm install 22",
        "  nvm use 22",
        "  pnpm bitterbot onboard",
      ].join("\n"),
      "Node upgrade via nvm",
    );
    throw new WizardCancelledError("node upgrade required (nvm)");
  }

  await prompter.note(
    [
      "No Node version manager detected (fnm / volta / asdf / nvm).",
      "Install one, or install Node 22 directly:",
      "",
      platformInstallHint(),
      "",
      "Then: pnpm bitterbot onboard",
    ].join("\n"),
    "Node upgrade required",
  );
  throw new WizardCancelledError("node upgrade required");
}
