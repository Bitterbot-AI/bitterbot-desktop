/**
 * Browser setup runner (PLAN-56 Phase 4): what `wizard.start` runs.
 *
 * 1. The shared step model (setup-steps.ts), through the RPC prompter.
 * 2. The local essentials QuickStart also writes: workspace, `gateway.mode`,
 *    a gateway token when no auth exists, the built-in hooks, wizard metadata.
 * 3. The first reply: the key is stored, every setting the gateway can apply
 *    without a restart is written, and one real turn runs on the chosen model
 *    ("Say hello and tell me one thing you can do."), with its latency. A
 *    failure shows the provider error with Retry / Back / Skip.
 *    The setup session uses its own session key, so retries never land in the
 *    main chat (src/gateway/setup-first-turn.ts).
 * 4. The doctor summary (the read-only, offline doctor subset).
 * 5. "Keep running": when chosen, the gateway service is installed (and the
 *    Done screen says whether that worked).
 * 6. On Finish: the rest of the config (settings that restart the gateway,
 *    such as `gateway.*` and `p2p.*`) is written, the setup token deleted, and
 *    a setup gateway hands its port over to the new service.
 *
 * Until Finish, a marker (`setup-in-progress.json`) keeps setup "not done",
 * so a lost session can be picked up again with a new setup link.
 *
 * Every config write goes through `writeConfigFile`, which never writes
 * load-time defaults (src/config/io.ts `stripLoadTimeDefaults`).
 */

import type { BitterbotConfig } from "../config/config.js";
import type { InstallKind } from "../infra/install-kind.js";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "./prompts.js";
import { detectSetupKeys, detectSignedInProfiles, type SetupKeyEnv } from "./setup-keys.js";
import type { SetupServiceInstallResult, SetupServiceSupport } from "./setup-service.js";
import {
  commitSetupKey,
  createSetupDraft,
  draftHasCredential,
  refreshSetupCredentials,
  runSetupSteps,
  type SetupContext,
  type SetupDraft,
} from "./setup-steps.js";

export type FirstTurnResult =
  | { ok: true; latencyMs: number; reply: string; model?: string }
  | { ok: false; latencyMs: number; error: string };

export type DoctorSummary = {
  findings: Array<{ section: string; level: "ok" | "warn" | "error" | "info"; message: string }>;
  worstLevel: "ok" | "warn" | "error" | "info";
};

export type SetupWizardDeps = {
  runFirstTurn?: (cfg: BitterbotConfig) => Promise<FirstTurnResult>;
  collectDoctorSummary?: (cfg: BitterbotConfig) => Promise<DoctorSummary>;
  /** Called once setup has written everything (deletes the setup token). */
  onComplete?: () => void;
  /** Called before the first config write (marks setup as in progress). */
  markInProgress?: () => void;
  /** Whether the "Keep running" step is offered (undefined: not offered). */
  service?: SetupServiceSupport;
  /** Install the gateway service for the final config. */
  installService?: (config: BitterbotConfig) => Promise<SetupServiceInstallResult>;
  /** After Finish, when a service was installed: hand this gateway over to it. */
  onHandover?: () => void;
  keyEnv?: SetupKeyEnv;
  env?: NodeJS.ProcessEnv;
  installKind?: InstallKind;
};

const quietRuntime: RuntimeEnv = {
  log: () => {},
  error: () => {},
  exit: (code: number) => {
    throw new Error(`setup exited with code ${code}`);
  },
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Split the edits into what the running gateway applies in place and the
 * top-level sections whose change restarts it (gateway.*, p2p.*, ...). The
 * first reply runs between the two writes, so a restart cannot cut setup off.
 */
export async function splitRestartSensitive(
  base: BitterbotConfig,
  next: BitterbotConfig,
): Promise<{ hot: BitterbotConfig; deferredKeys: string[] }> {
  const { diffConfigPaths, buildGatewayReloadPlan } = await import("../gateway/config-reload.js");
  const keys = new Set<string>();
  for (const changed of diffConfigPaths(base, next)) {
    if (buildGatewayReloadPlan([changed]).restartGateway) {
      keys.add(changed.split(".")[0] ?? changed);
    }
  }
  const hot: Record<string, unknown> = { ...(next as Record<string, unknown>) };
  const baseRecord = base as Record<string, unknown>;
  for (const key of keys) {
    if (key in baseRecord) {
      hot[key] = baseRecord[key];
    } else {
      delete hot[key];
    }
  }
  return { hot: hot as BitterbotConfig, deferredKeys: [...keys] };
}

/** Effective config as it will be after the final write (for the doctor summary). */
function mergeDeferred(
  effective: BitterbotConfig,
  draft: BitterbotConfig,
  keys: string[],
): BitterbotConfig {
  const out: Record<string, unknown> = { ...(effective as Record<string, unknown>) };
  const from = draft as Record<string, unknown>;
  for (const key of keys) {
    const a = out[key];
    const b = from[key];
    out[key] = isPlainObject(a) && isPlainObject(b) ? { ...a, ...b } : (b ?? a);
  }
  return out as BitterbotConfig;
}

/** A gateway token when no auth exists at all (QuickStart's default). */
export function ensureGatewayAuth(
  config: BitterbotConfig,
  env: NodeJS.ProcessEnv,
  makeToken: () => string,
): BitterbotConfig {
  const auth = config.gateway?.auth;
  if (
    auth?.token ||
    auth?.password ||
    auth?.mode === "trusted-proxy" ||
    env.BITTERBOT_GATEWAY_TOKEN?.trim() ||
    env.BITTERBOT_GATEWAY_PASSWORD?.trim()
  ) {
    return config;
  }
  return {
    ...config,
    gateway: { ...config.gateway, auth: { ...auth, mode: "token", token: makeToken() } },
  };
}

function formatLatency(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

function summarizeDoctor(summary: DoctorSummary): string {
  const counts = { ok: 0, warn: 0, error: 0, info: 0 };
  for (const f of summary.findings) {
    counts[f.level] += 1;
  }
  const lines = summary.findings
    .filter((f) => f.level === "warn" || f.level === "error")
    .map((f) => `- ${f.level === "error" ? "Problem" : "Warning"} (${f.section}): ${f.message}`);
  return [
    `${counts.ok} ok, ${counts.warn} warning(s), ${counts.error} problem(s).`,
    ...lines,
    "Run `bitterbot doctor` any time for the full report.",
  ].join("\n");
}

/** What the Done screen reports about running in the background. */
export type ServiceOutcome =
  | { state: "installed"; label: string }
  | { state: "existing"; label: string }
  | { state: "failed"; label: string; error: string }
  | { state: "declined" }
  | { state: "unavailable" };

function describeService(service: ServiceOutcome): string {
  switch (service.state) {
    case "installed":
      return `Bitterbot now runs in the background as a ${service.label} and starts on login.`;
    case "existing":
      return `Bitterbot runs in the background as a ${service.label} (already installed).`;
    case "failed":
      return `The ${service.label} could not be installed (${service.error}). Bitterbot runs only while this gateway process runs; try \`bitterbot gateway install\`.`;
    case "declined":
      return "Bitterbot is not installed as a background service; start it with `bitterbot gateway` when you want it.";
    case "unavailable":
      return "";
  }
}

export type SetupWizardResult = {
  draft: SetupDraft;
  firstTurn?: FirstTurnResult;
  service?: ServiceOutcome;
};

export async function runSetupWizard(
  prompter: WizardPrompter,
  deps: SetupWizardDeps = {},
): Promise<SetupWizardResult> {
  const env = deps.env ?? process.env;
  const { loadConfig, readConfigFileSnapshot, writeConfigFile } =
    await import("../config/config.js");
  const snapshot = await readConfigFileSnapshot();
  if (snapshot.exists && !snapshot.valid) {
    const issues = snapshot.issues.map((iss) => `- ${iss.path}: ${iss.message}`).join("\n");
    await prompter.note(
      `The config file has problems setup will not overwrite:\n${issues}\nRun \`bitterbot doctor --fix\`, then reload this page.`,
      "Config needs repair",
    );
    throw new Error("config invalid");
  }
  // A missing file's snapshot carries load-time defaults; start from nothing.
  const base: BitterbotConfig = snapshot.exists ? snapshot.config : {};
  const keyEnv = deps.keyEnv ?? { env };
  const ctx: SetupContext = {
    effective: loadConfig(),
    keys: detectSetupKeys(keyEnv),
    profiles: detectSignedInProfiles(keyEnv.agentDir),
    keyEnv,
    installKind: deps.installKind ?? "unknown",
    env,
    service: deps.service,
  };
  const draft = createSetupDraft(base);
  await runSetupSteps({ ctx, draft, prompter });

  const { applyOnboardingLocalWorkspaceConfig } = await import("../commands/onboard-config.js");
  const { applyQuickstartHookDefaults } = await import("../commands/onboard-hooks.js");
  const { applyWizardMetadata, DEFAULT_WORKSPACE, ensureWorkspaceAndSessions, randomToken } =
    await import("../commands/onboard-helpers.js");
  const { resolveUserPath } = await import("../utils.js");
  const workspaceDir = resolveUserPath(base.agents?.defaults?.workspace ?? DEFAULT_WORKSPACE);
  const finishConfig = (config: BitterbotConfig) =>
    applyWizardMetadata(
      applyQuickstartHookDefaults(
        ensureGatewayAuth(
          applyOnboardingLocalWorkspaceConfig(config, workspaceDir),
          env,
          randomToken,
        ),
      ),
      { command: "setup", mode: "local" },
    );

  let firstTurn: FirstTurnResult | undefined;
  let deferredKeys: string[] = [];
  for (;;) {
    await commitSetupKey(draft, ctx);
    if (draft.notices.length > 0) {
      await prompter.note(draft.notices.join("\n"), "Your previous key was kept");
      draft.notices = [];
    }
    draft.config = finishConfig(draft.config);
    const split = await splitRestartSensitive(base, draft.config);
    deferredKeys = split.deferredKeys;
    // Setup is "in progress" until Finish: a lost session leaves a config a
    // new setup link may still complete (wizard.start's onboardingComplete).
    deps.markInProgress?.();
    await writeConfigFile(split.hot);
    await ensureWorkspaceAndSessions(workspaceDir, quietRuntime, {
      skipBootstrap: Boolean(draft.config.agents?.defaults?.skipBootstrap),
    });
    if (!draftHasCredential(draft) || !deps.runFirstTurn) {
      await prompter.note(
        draftHasCredential(draft)
          ? "The first reply runs in the browser setup; open the Control UI to say hello."
          : "No model key yet, so there is no first reply to show. Add a key in Settings, then say hello in Chat.",
        "First reply",
        { data: { kind: "first-turn", skipped: true } },
      );
      break;
    }
    firstTurn = await deps.runFirstTurn(loadConfig());
    if (firstTurn.ok) {
      await prompter.note(
        `${firstTurn.reply}\n\nFirst reply in ${formatLatency(firstTurn.latencyMs)}${firstTurn.model ? ` from ${firstTurn.model}` : ""}.`,
        "First reply",
        {
          data: {
            kind: "first-turn",
            ok: true,
            latencyMs: firstTurn.latencyMs,
            reply: firstTurn.reply,
            model: firstTurn.model,
          },
        },
      );
      break;
    }
    const next = await prompter.select({
      message: `The test turn failed after ${formatLatency(firstTurn.latencyMs)}. The provider said:\n${firstTurn.error}`,
      options: [
        { value: "retry", label: "Retry", hint: "Run the test turn again" },
        { value: "back", label: "Back", hint: "Choose a different key or model" },
        { value: "skip", label: "Skip", hint: "Finish setup and fix it in Settings" },
      ],
      initialValue: "retry",
      data: {
        kind: "first-turn",
        ok: false,
        latencyMs: firstTurn.latencyMs,
        error: firstTurn.error,
      },
    });
    if (next === "back") {
      // The commit above moved the chosen key (an env key is now a saved
      // one): offer what is there now, not the list from the start.
      refreshSetupCredentials(ctx);
      await runSetupSteps({ ctx, draft, prompter, only: ["auth", "model"] });
    } else if (next !== "retry") {
      break;
    }
  }

  if (deps.collectDoctorSummary) {
    const summary = await deps.collectDoctorSummary(
      mergeDeferred(loadConfig(), draft.config, deferredKeys),
    );
    await prompter.note(summarizeDoctor(summary), "Health check", {
      data: { kind: "doctor", worstLevel: summary.worstLevel, findings: summary.findings },
    });
  }

  // "Keep running": install before the Done screen so it can say how it went.
  // The service's gateway waits for this one to hand over its port at Finish.
  let service: ServiceOutcome;
  if (draft.installService && deps.installService) {
    const result = await deps.installService(
      mergeDeferred(loadConfig(), draft.config, deferredKeys),
    );
    service = result.ok
      ? { state: "installed", label: result.label }
      : { state: "failed", label: result.label, error: result.error };
  } else if (ctx.service?.kind === "installed") {
    service = { state: "existing", label: ctx.service.label };
  } else if (draft.answers.service === "no") {
    service = { state: "declined" };
  } else {
    service = { state: "unavailable" };
  }

  await prompter.note(
    [
      "Setup is complete.",
      describeService(service),
      draft.channelsNext
        ? "Next: connect a chat channel from the Channels page."
        : "Chat with your agent in the Control UI. Channels, keys and every setting stay editable in Settings.",
      deferredKeys.length > 0 || service.state === "installed"
        ? `Finishing writes the remaining settings${deferredKeys.length > 0 ? ` (${deferredKeys.join(", ")})` : ""}; the gateway restarts once to apply them.`
        : "",
    ]
      .filter(Boolean)
      .join("\n"),
    "Done",
    {
      data: {
        kind: "done",
        channelsNext: draft.channelsNext,
        restart: deferredKeys.length > 0 || service.state === "installed",
        service,
      },
    },
  );
  await writeConfigFile(draft.config);
  deps.onComplete?.();
  if (service.state === "installed") {
    deps.onHandover?.();
  }
  return { draft, firstTurn, service };
}
