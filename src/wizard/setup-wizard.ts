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
 * 4. The doctor summary (the read-only, offline doctor subset).
 * 5. On Finish: the rest of the config (settings that restart the gateway,
 *    such as `gateway.*` and `p2p.*`) is written and the setup token deleted.
 *
 * Every config write goes through `writeConfigFile`, which never writes
 * load-time defaults (src/config/io.ts `stripLoadTimeDefaults`).
 */

import type { BitterbotConfig } from "../config/config.js";
import type { InstallKind } from "../infra/install-kind.js";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "./prompts.js";
import { detectSetupKeys, type SetupKeyEnv } from "./setup-keys.js";
import {
  commitSetupKey,
  createSetupDraft,
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

export type SetupWizardResult = { draft: SetupDraft; firstTurn?: FirstTurnResult };

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
    keyEnv,
    installKind: deps.installKind ?? "unknown",
    env,
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
    draft.config = finishConfig(draft.config);
    const split = await splitRestartSensitive(base, draft.config);
    deferredKeys = split.deferredKeys;
    await writeConfigFile(split.hot);
    await ensureWorkspaceAndSessions(workspaceDir, quietRuntime, {
      skipBootstrap: Boolean(draft.config.agents?.defaults?.skipBootstrap),
    });
    if (!draft.provider || !deps.runFirstTurn) {
      await prompter.note(
        draft.provider
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

  await prompter.note(
    [
      "Setup is complete.",
      draft.channelsNext
        ? "Next: connect a chat channel from the Channels page."
        : "Chat with your agent in the Control UI. Channels, keys and every setting stay editable in Settings.",
      deferredKeys.length > 0
        ? `Finishing writes the remaining settings (${deferredKeys.join(", ")}); the gateway restarts once to apply them.`
        : "",
    ]
      .filter(Boolean)
      .join("\n"),
    "Done",
    {
      data: {
        kind: "done",
        channelsNext: draft.channelsNext,
        restart: deferredKeys.length > 0,
      },
    },
  );
  await writeConfigFile(draft.config);
  deps.onComplete?.();
  return { draft, firstTurn };
}
