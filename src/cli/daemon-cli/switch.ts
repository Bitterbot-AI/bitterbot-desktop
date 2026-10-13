/**
 * `bitterbot gateway switch`: hand the running gateway and the background
 * service over to THIS install (src/infra/gateway-switch.ts).
 *
 * install.sh runs `bitterbot gateway switch --check` after installing, asks
 * one question, then runs `bitterbot gateway switch --yes`; `bitterbot
 * onboard` offers the same when the gateway on the port is another install.
 *
 * Exit codes (for scripts):
 *   --check:  0 nothing to switch (also: remote gateway), 10 a switch is
 *             available, 5 the port is used by a program that is not a
 *             Bitterbot gateway, 2 blocked (the message says what to do)
 *   switch:   0 switched (or nothing to do), 1 failed but the old gateway
 *             is running as before (never stopped, or restored), 2 not done
 *             (blocked, declined, or needs --yes), 3 failed and the old
 *             gateway could not be restored, 5 as for --check
 */

import { stdin as input, stdout as output } from "node:process";
import readline from "node:readline/promises";
import {
  executeGatewaySwitch,
  serviceLabelFor,
  type GatewaySwitchDecision,
  type GatewaySwitchFindings,
  type GatewaySwitchOutcome,
  type GatewaySwitchStep,
  type InstallRef,
} from "../../infra/gateway-switch.js";
import type { InstallKind } from "../../infra/install-kind.js";
import { defaultRuntime, type RuntimeEnv } from "../../runtime.js";
import { shortenHomePath } from "../../utils.js";

export const SWITCH_EXIT = {
  ok: 0,
  rolledBack: 1,
  notDone: 2,
  failed: 3,
  portInUse: 5,
  available: 10,
} as const;

export type GatewaySwitchCommandOptions = {
  check?: boolean;
  yes?: boolean;
  json?: boolean;
  port?: string | number;
  timeout?: string | number;
};

export type GatewaySwitchCommandDeps = {
  detect: (opts: { port?: number }) => Promise<{
    findings: GatewaySwitchFindings;
    decision: GatewaySwitchDecision;
    execute: (
      onStep?: (step: GatewaySwitchStep) => void,
      onProgress?: (line: string) => void,
    ) => Promise<GatewaySwitchOutcome>;
  }>;
  confirm: (question: string) => Promise<boolean>;
  isInteractive: () => boolean;
};

function kindLabel(kind: InstallKind): string {
  switch (kind) {
    case "git":
      return "git clone";
    case "tarball":
      return "installed release";
    case "package":
      return "package install";
    case "container":
      return "container image";
    default:
      return "unknown install";
  }
}

/** "Bitterbot 1.4.0 from ~/bitterbot-desktop (git clone)". */
export function describeInstall(ref: InstallRef | null, fallbackVersion?: string | null): string {
  const version = ref?.version ?? fallbackVersion ?? null;
  const name = version ? `Bitterbot ${version}` : "Bitterbot (version unknown)";
  if (!ref?.root) {
    return `${name} (location unknown)`;
  }
  return `${name} from ${shortenHomePath(ref.root)} (${kindLabel(ref.kind)})`;
}

/** The plain-language summary of what was found (one line per fact). */
export function describeFindings(
  findings: GatewaySwitchFindings,
  decision: GatewaySwitchDecision,
): string[] {
  const lines: string[] = [];
  const target = findings.self.version ?? "this version";
  const { listener, service } = findings;
  if (decision.action === "blocked") {
    return [decision.message];
  }
  if (listener?.isGateway && !listener.isSelf) {
    const how = listener.underService ? `, as a ${service?.label ?? "background service"}` : "";
    lines.push(
      `Found ${describeInstall(listener.runsFrom, listener.reportedVersion)} running on port ${findings.port}${how}.`,
    );
  }
  const serviceAlreadyNamed = Boolean(
    listener?.isGateway && !listener.isSelf && listener.underService,
  );
  if (service && !service.pointsHere && !serviceAlreadyNamed) {
    lines.push(
      `Found the background service (${service.label}) set to run ${describeInstall(service.runsFrom)}.`,
    );
  }
  if (decision.action === "none") {
    if (decision.note) {
      lines.push(decision.note);
    }
    lines.push(
      decision.reason === "fresh"
        ? "No other Bitterbot is running or installed as a service. Nothing to switch."
        : decision.reason === "remote-mode"
          ? "This machine uses a remote gateway (gateway.mode is remote). Nothing to switch here."
          : decision.reason === "service-stopped"
            ? "Nothing was switched."
            : `Bitterbot ${target} is already the one in use. Nothing to switch.`,
    );
  } else if (decision.action === "switch") {
    lines.push(
      `This is Bitterbot ${target}${findings.self.root ? ` (${shortenHomePath(findings.self.root)})` : ""}.`,
    );
    if (decision.freshService) {
      lines.push(
        `Switching also keeps it running in the background (installs a ${serviceLabelFor(process.platform)} that starts on login).`,
      );
    } else if (decision.startDetached) {
      lines.push(
        "There is no service manager here (no systemd user services), so it is started in the background until you log out or restart.",
      );
    }
    const migration = findings.envMigration;
    if (migration && migration.keys.length > 0) {
      lines.push(
        `Will copy ${migration.keys.length} key${migration.keys.length === 1 ? "" : "s"} from ${shortenHomePath(migration.source)} into ${shortenHomePath(migration.target)} (existing keys are kept; a backup is made first): ${migration.keys.join(", ")}`,
      );
    }
    if (migration && migration.skipped.length > 0) {
      lines.push(
        `Not copied (copy these by hand from ${shortenHomePath(migration.source)}): ${migration.skipped.join(", ")}`,
      );
    }
    if (findings.processOnlyEnv && findings.processOnlyEnv.length > 0) {
      lines.push(
        `Warning: the running gateway has settings that are in neither .env file and that the new one will not see: ${findings.processOnlyEnv.join(", ")}. Add them to ${shortenHomePath(findings.target?.stateDir ?? "~/.bitterbot")}/.env if you need them.`,
      );
    }
  }
  return lines;
}

const STEP_TEXT: Record<GatewaySwitchStep, string> = {
  snapshot: "Taking a safety snapshot of your settings and memory",
  "copy-env": "Copying the missing .env keys",
  "stop-service": "Stopping the background service",
  "stop-process": "Stopping the old gateway",
  "wait-stopped": "Waiting for the old gateway to exit",
  "stop-children": "Waiting for the P2P orchestrator to exit",
  "install-service": "Pointing the background service at this version",
  "start-gateway": "Starting the gateway",
  "wait-healthy": "Waiting for the new gateway to answer",
  rollback: "Putting the previous version back",
};

/** Plain-language result lines. */
export function describeOutcome(outcome: GatewaySwitchOutcome): string[] {
  const { findings, decision } = outcome;
  const target = findings.self.version ?? "this version";
  const lines: string[] = [];
  if (outcome.status === "switched") {
    lines.push(
      `Done. Bitterbot ${target} is running on port ${findings.port}. Your settings and memory are unchanged.`,
    );
    if (outcome.envCopied && outcome.envCopied.length > 0) {
      const m = findings.envMigration;
      lines.push(
        `Copied ${outcome.envCopied.length} key${outcome.envCopied.length === 1 ? "" : "s"}${m ? ` from ${shortenHomePath(m.source)} into ${shortenHomePath(m.target)}` : ""}: ${outcome.envCopied.join(", ")}`,
      );
    }
    if (outcome.serviceFallback) {
      lines.push(
        "It runs in the background until you log out or restart (a background service could not be set up). To start it on login: bitterbot gateway install",
      );
    } else if (decision.action === "switch" && decision.freshService) {
      lines.push(
        `It runs in the background as a ${serviceLabelFor(process.platform)} and starts on login.`,
      );
    }
    if (decision.action === "switch" && decision.startDetached) {
      lines.push(
        "It runs in the background until you log out or restart. To start it on login: bitterbot gateway install",
      );
    }
    const from = decision.action === "switch" ? decision.from : null;
    if (from?.kind === "git" && from.root && !findings.self.root?.startsWith(from.root)) {
      lines.push(
        `Your git clone at ${shortenHomePath(from.root)} is no longer used. You can delete it once you are happy with ${target} (nothing was deleted).`,
      );
    }
    return lines;
  }
  if (outcome.status === "rolled-back") {
    const from = decision.action === "switch" ? decision.from : null;
    lines.push(`The switch to ${target} did not work: ${outcome.error ?? "unknown error"}`);
    if (outcome.rollback?.ok) {
      lines.push(
        from
          ? `${describeInstall(from)} is running again, as before. Your settings and memory are unchanged.`
          : "Your previous setup was restored. Your settings and memory are unchanged.",
      );
    } else {
      lines.push(
        `The previous gateway could not be restarted automatically. ${outcome.rollback?.manual ?? ""}`.trim(),
      );
    }
    if (outcome.rollback?.dataRestored && outcome.rollback.dataRestored.length > 0) {
      lines.push(
        `Restored from the safety snapshot (the new version had upgraded them): ${outcome.rollback.dataRestored.map((f) => shortenHomePath(f)).join(", ")}`,
      );
    }
    if (outcome.envCopied && outcome.envCopied.length > 0) {
      lines.push(
        `The .env keys copied earlier stay in place (they only add settings): ${outcome.envCopied.join(", ")}`,
      );
    }
    return lines;
  }
  if (outcome.error) {
    lines.push(outcome.error);
  }
  return lines;
}

function toJson(outcome: GatewaySwitchOutcome, check: boolean): Record<string, unknown> {
  const { findings, decision } = outcome;
  return {
    ok: outcome.ok,
    status: check ? (decision.action === "switch" ? "available" : outcome.status) : outcome.status,
    check,
    port: findings.port,
    self: findings.self,
    decision,
    service: findings.service
      ? {
          label: findings.service.label,
          runsFrom: findings.service.runsFrom,
          pointsHere: findings.service.pointsHere,
          followsCurrent: findings.service.followsCurrent,
          running: findings.service.running,
          programArguments: findings.service.definition?.programArguments ?? null,
        }
      : null,
    listener: findings.listener
      ? {
          pid: findings.listener.pid,
          command: findings.listener.command,
          isGateway: findings.listener.isGateway,
          runsFrom: findings.listener.runsFrom,
          reportedVersion: findings.listener.reportedVersion,
          isSelf: findings.listener.isSelf,
          underService: findings.listener.underService,
        }
      : null,
    steps: outcome.steps,
    ...(outcome.error ? { error: outcome.error } : {}),
    ...(outcome.rollback ? { rollback: outcome.rollback } : {}),
    message: [
      ...describeFindings(findings, decision),
      ...(check ? [] : describeOutcome(outcome)),
    ].join("\n"),
  };
}

function parsePositiveInt(value: string | number | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const n = typeof value === "number" ? value : Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

async function askYesNo(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input, output });
  try {
    const answer = (await rl.question(`${question} [Y/n] `)).trim().toLowerCase();
    return !answer || answer.startsWith("y");
  } finally {
    rl.close();
  }
}

export async function defaultSwitchDeps(opts: {
  timeoutMs?: number;
  /** Ask before giving up on a gateway that is alive but still starting. */
  askBeforeGivingUp?: boolean;
}): Promise<GatewaySwitchCommandDeps> {
  const system = await import("../../infra/gateway-switch-system.js");
  const { formatElapsed } = await import("../../infra/gateway-switch.js");
  return {
    detect: async ({ port }) => {
      const { findings, decision, config } = await system.detectGatewaySwitch({ port });
      return {
        findings,
        decision,
        execute: (onStep, onProgress) =>
          executeGatewaySwitch({
            findings,
            decision,
            deps: system.createSystemSwitchDeps({
              findings,
              config,
              ...(opts.askBeforeGivingUp
                ? {
                    askKeepWaiting: (elapsedMs: number) =>
                      askYesNo(
                        `The new gateway is still starting after ${formatElapsed(elapsedMs)} (a first start can take a while when memory is upgraded). Keep waiting?`,
                      ),
                  }
                : {}),
            }),
            ...(opts.timeoutMs ? { timeouts: { healthyMs: opts.timeoutMs } } : {}),
            onStep,
            onProgress,
          }),
      };
    },
    confirm: askYesNo,
    isInteractive: () => Boolean(process.stdin.isTTY && process.stdout.isTTY),
  };
}

/** Run the command; returns the exit code (the caller exits). */
export async function runGatewaySwitch(
  opts: GatewaySwitchCommandOptions,
  runtime: RuntimeEnv = defaultRuntime,
  injected?: GatewaySwitchCommandDeps,
): Promise<number> {
  const json = Boolean(opts.json);
  const check = Boolean(opts.check);
  const port = parsePositiveInt(opts.port);
  if (opts.port !== undefined && port === undefined) {
    runtime.error("Invalid --port");
    return SWITCH_EXIT.notDone;
  }
  const deps =
    injected ??
    (await defaultSwitchDeps({
      timeoutMs: parsePositiveInt(opts.timeout),
      askBeforeGivingUp: !opts.yes && !json && Boolean(process.stdin.isTTY && process.stdout.isTTY),
    }));
  let detected: Awaited<ReturnType<GatewaySwitchCommandDeps["detect"]>>;
  try {
    detected = await deps.detect({ port });
  } catch (err) {
    const message = `Could not check what runs on the gateway port: ${err instanceof Error ? err.message : String(err)}`;
    if (json) {
      runtime.log(JSON.stringify({ ok: false, status: "error", error: message }));
    } else {
      runtime.error(message);
    }
    return SWITCH_EXIT.failed;
  }
  const { findings, decision, execute } = detected;
  const say = (lines: string[]) => {
    if (!json) {
      for (const line of lines) {
        runtime.log(line);
      }
    }
  };
  const nothing: GatewaySwitchOutcome = {
    ok: decision.action !== "blocked",
    status: decision.action === "blocked" ? "blocked" : "nothing-to-do",
    findings,
    decision,
    steps: [],
    ...(decision.action === "blocked" ? { error: decision.message } : {}),
  };

  if (check || decision.action !== "switch") {
    if (json) {
      runtime.log(JSON.stringify(toJson(nothing, check)));
    } else {
      say(describeFindings(findings, decision));
    }
    if (decision.action === "blocked") {
      return decision.reason === "foreign-listener" ? SWITCH_EXIT.portInUse : SWITCH_EXIT.notDone;
    }
    if (check && decision.action === "switch") {
      return SWITCH_EXIT.available;
    }
    return SWITCH_EXIT.ok;
  }

  say(describeFindings(findings, decision));
  const target = findings.self.version ?? "this version";
  if (!opts.yes) {
    if (json || !deps.isInteractive()) {
      const message = "Not switching without confirmation. Run: bitterbot gateway switch --yes";
      if (json) {
        runtime.log(
          JSON.stringify({
            ...toJson(nothing, false),
            ok: false,
            status: "needs-confirmation",
            message,
          }),
        );
      } else {
        runtime.log(message);
      }
      return SWITCH_EXIT.notDone;
    }
    if (!(await deps.confirm(`Switch to ${target} now?`))) {
      runtime.log("Nothing was changed. To switch later: bitterbot gateway switch");
      return SWITCH_EXIT.notDone;
    }
  }

  say([`Switching to ${target}...`]);
  const outcome = await execute(
    (step) => say([`  ${STEP_TEXT[step]}...`]),
    (line) => say([line]),
  );
  if (json) {
    runtime.log(JSON.stringify(toJson(outcome, false)));
  } else {
    for (const line of describeOutcome(outcome)) {
      if (outcome.ok) {
        runtime.log(line);
      } else {
        runtime.error(line);
      }
    }
  }
  if (outcome.status === "switched" || outcome.status === "nothing-to-do") {
    return SWITCH_EXIT.ok;
  }
  // Nothing was changed ("failed" before stopping anything), or the old
  // gateway is back: the user still has what they had.
  if (outcome.status === "failed" || (outcome.status === "rolled-back" && outcome.rollback?.ok)) {
    return SWITCH_EXIT.rolledBack;
  }
  if (outcome.status === "blocked") {
    return SWITCH_EXIT.notDone;
  }
  return SWITCH_EXIT.failed;
}
