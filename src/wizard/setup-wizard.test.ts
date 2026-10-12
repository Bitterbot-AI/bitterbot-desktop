import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WizardSession, type WizardStep } from "./session.js";
import { detectSetupKeys } from "./setup-keys.js";
import {
  createSetupDraft,
  P2P_EGRESS_SENTENCE,
  runSetupSteps,
  SETUP_STEP_IDS,
  TELEMETRY_STATEMENT,
} from "./setup-steps.js";
import { runSetupWizard, type FirstTurnResult, type SetupWizardDeps } from "./setup-wizard.js";

const ANTHROPIC = "sk-ant-api03-SECRET-anthropic-value-9f2c";
const PASTED = "sk-ant-api03-SECRET-pasted-value-aaaa";

let dir: string;
let configPath: string;
const savedEnv: Record<string, string | undefined> = {};

function setEnv(key: string, value: string | undefined) {
  if (!(key in savedEnv)) {
    savedEnv[key] = process.env[key];
  }
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-setup-wizard-"));
  configPath = path.join(dir, "bitterbot.json");
  setEnv("BITTERBOT_STATE_DIR", dir);
  setEnv("BITTERBOT_CONFIG_PATH", configPath);
  setEnv("BITTERBOT_AGENT_DIR", path.join(dir, "agent"));
  setEnv("BITTERBOT_DISABLE_CONFIG_CACHE", "1");
  setEnv("BITTERBOT_GATEWAY_TOKEN", undefined);
  setEnv("BITTERBOT_GATEWAY_PASSWORD", undefined);
  for (const key of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY"]) {
    setEnv(key, undefined);
  }
  for (const key of ["BRAVE_API_KEY", "TAVILY_API_KEY", "PERPLEXITY_API_KEY", "SERPLY_API_KEY"]) {
    setEnv(key, undefined);
  }
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
    delete savedEnv[key];
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

function readConfigFile(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
}

type Answerer = (step: WizardStep) => unknown;

/** Drive a setup session the way the browser does: next, answer, next... */
async function drive(deps: SetupWizardDeps, answer: Answerer) {
  const session = new WizardSession(async (prompter) => {
    await runSetupWizard(prompter, deps);
  });
  const steps: WizardStep[] = [];
  let result = await session.next();
  while (!result.done) {
    const step = result.step;
    if (!step) {
      throw new Error("missing step");
    }
    steps.push(step);
    await session.answer(step.id, answer(step));
    result = await session.next();
  }
  return { steps, status: result.status, error: result.error };
}

function baseDeps(overrides: Partial<SetupWizardDeps> = {}): SetupWizardDeps {
  const env = { ANTHROPIC_API_KEY: ANTHROPIC } as NodeJS.ProcessEnv;
  return {
    env,
    keyEnv: { env, envFilePath: path.join(dir, ".env"), agentDir: path.join(dir, "agent") },
    installKind: "package",
    runFirstTurn: vi.fn(async (): Promise<FirstTurnResult> => ({
      ok: true,
      latencyMs: 1234,
      reply: "Hello! I can remember what you tell me.",
      model: "anthropic/claude-opus-4-8",
    })),
    collectDoctorSummary: vi.fn(async () => ({
      worstLevel: "warn" as const,
      findings: [
        { section: "Install", level: "ok" as const, message: "No version drift" },
        { section: "Install", level: "warn" as const, message: "Browser tool: no Chrome" },
      ],
    })),
    onComplete: vi.fn(),
    ...overrides,
  };
}

const dataKind = (step: WizardStep) => (step.data as { kind?: string } | undefined)?.kind;

describe("setup over the wizard session (the RPC renderer)", () => {
  it("recommended defaults: one click, key stored once, first reply, doctor, then the rest", async () => {
    const deps = baseDeps();
    let fileAtFirstTurn: Record<string, unknown> | null = null;
    deps.runFirstTurn = vi.fn(async () => {
      fileAtFirstTurn = readConfigFile();
      return { ok: true as const, latencyMs: 1500, reply: "Hello!", model: "anthropic/x" };
    });
    const { steps, status } = await drive(deps, (step) =>
      step.type === "select" ? (step.initialValue ?? step.options?.[0]?.value) : null,
    );
    expect(status).toBe("done");

    // Fork, first reply, doctor, done: nothing else was asked.
    expect(steps.map((s) => dataKind(s) ?? s.type)).toEqual([
      "select",
      "first-turn",
      "doctor",
      "done",
    ]);
    expect(steps[0]?.message).toContain(P2P_EGRESS_SENTENCE);
    expect(steps[0]?.message).toContain(TELEMETRY_STATEMENT);
    expect(steps[1]?.data).toMatchObject({ kind: "first-turn", ok: true, latencyMs: 1500 });
    expect(steps[1]?.message).toContain("1.5 s");
    expect(steps[2]?.data).toMatchObject({ kind: "doctor", worstLevel: "warn" });

    // The key never went to the browser.
    expect(JSON.stringify(steps)).not.toContain(ANTHROPIC);
    expect(JSON.stringify(steps)).not.toContain("SECRET");

    // Ask once, remember: the env key is now in the auth store.
    const store = JSON.parse(
      fs.readFileSync(path.join(dir, "agent", "auth-profiles.json"), "utf8"),
    );
    expect(store.profiles["anthropic:default"].key).toBe(ANTHROPIC);

    // Restart-sensitive settings (gateway.*) waited until after the first reply.
    expect(fileAtFirstTurn).not.toBeNull();
    expect((fileAtFirstTurn as unknown as { gateway?: unknown }).gateway).toBeUndefined();
    const written = readConfigFile();
    expect((written.gateway as { mode?: string }).mode).toBe("local");
    expect((written.gateway as { auth?: { token?: string } }).auth?.token).toMatch(
      /^[0-9a-f]{48}$/,
    );
    expect(deps.onComplete).toHaveBeenCalledOnce();

    // Only what setup chose: no load-time defaults frozen into the file.
    expect(Object.keys(written).toSorted()).toEqual(
      ["agents", "auth", "gateway", "hooks", "meta", "wizard"].toSorted(),
    );
    expect(written).not.toHaveProperty("p2p");
    expect(written).not.toHaveProperty("tools");
    expect(written).not.toHaveProperty("memory");
    expect(
      (written.agents as { defaults?: Record<string, unknown> }).defaults?.memorySearch,
    ).toBeUndefined();
  });

  it("step by step: every step of the model is asked, in order, with its section", async () => {
    const deps = baseDeps();
    const answers: Record<string, unknown> = {
      auth: "env:ANTHROPIC_API_KEY",
      model: "anthropic/claude-haiku-4-5",
      embeddings: "local",
      webSearch: "parallel",
      channels: "now",
      p2p: "local",
    };
    const { steps, status } = await drive(deps, (step) => {
      if (!step.section) {
        return step.type === "select" && step.options?.some((o) => o.value === "custom")
          ? "custom"
          : null;
      }
      return answers[step.section.id] ?? null;
    });
    expect(status).toBe("done");
    const sections = [...new Set(steps.map((s) => s.section?.id).filter(Boolean))];
    expect(sections).toEqual([...SETUP_STEP_IDS]);
    expect(steps.find((s) => s.section?.id === "p2p")?.initialValue).toBe("join");
    const done = steps.find((s) => dataKind(s) === "done");
    expect(done?.data).toMatchObject({ channelsNext: true, restart: true });

    const written = readConfigFile() as {
      agents: { defaults: { model: { primary: string }; memorySearch: { provider: string } } };
      tools: { web: { search: { provider: string } } };
      p2p: { enabled: boolean };
      circles: { enabled: boolean };
    };
    expect(written.agents.defaults.model.primary).toBe("anthropic/claude-haiku-4-5");
    expect(written.agents.defaults.memorySearch.provider).toBe("local");
    expect(written.tools.web.search.provider).toBe("parallel");
    expect(written.p2p.enabled).toBe(false);
    expect(written.circles.enabled).toBe(false);
  });

  it("a failed first reply shows the provider error, then Retry and Back work", async () => {
    const outcomes: FirstTurnResult[] = [
      { ok: false, latencyMs: 300, error: "401 invalid x-api-key" },
      { ok: false, latencyMs: 200, error: "401 invalid x-api-key" },
      { ok: true, latencyMs: 900, reply: "Hi" },
    ];
    const deps = baseDeps({ runFirstTurn: vi.fn(async () => outcomes.shift()!) });
    let failures = 0;
    const { steps, status } = await drive(deps, (step) => {
      const data = step.data as { kind?: string; ok?: boolean } | undefined;
      if (data?.kind === "first-turn" && data.ok === false) {
        failures += 1;
        return failures === 1 ? "retry" : "back";
      }
      if (step.type === "text") {
        return PASTED;
      }
      if (step.section?.id === "auth") {
        return "paste:anthropic";
      }
      if (step.section?.id === "model") {
        return "anthropic/claude-sonnet-4-6";
      }
      return step.type === "select" ? (step.initialValue ?? step.options?.[0]?.value) : null;
    });
    expect(status).toBe("done");
    expect(deps.runFirstTurn).toHaveBeenCalledTimes(3);
    const failed = steps.find((s) => (s.data as { ok?: boolean } | undefined)?.ok === false);
    expect(failed?.message).toContain("401 invalid x-api-key");
    expect(failed?.options?.map((o) => o.value)).toEqual(["retry", "back", "skip"]);
    const keyPrompt = steps.find((s) => s.type === "text");
    expect(keyPrompt?.sensitive).toBe(true);
    // The pasted key replaced the env key in the store; it never echoes back.
    const store = JSON.parse(
      fs.readFileSync(path.join(dir, "agent", "auth-profiles.json"), "utf8"),
    );
    expect(store.profiles["anthropic:default"].key).toBe(PASTED);
    const afterPaste = steps.slice(steps.indexOf(keyPrompt!) + 1);
    expect(JSON.stringify(afterPaste)).not.toContain(PASTED);
    expect(
      (readConfigFile().agents as { defaults: { model: { primary: string } } }).defaults.model
        .primary,
    ).toBe("anthropic/claude-sonnet-4-6");
  });

  it("with no key found, recommended still asks for one; skipping skips the first reply", async () => {
    const env = {} as NodeJS.ProcessEnv;
    const deps = baseDeps({
      env,
      keyEnv: { env, envFilePath: path.join(dir, ".env"), agentDir: path.join(dir, "agent") },
    });
    const { steps, status } = await drive(deps, (step) =>
      step.section?.id === "auth"
        ? "skip"
        : step.type === "select"
          ? (step.initialValue ?? step.options?.[0]?.value)
          : null,
    );
    expect(status).toBe("done");
    expect(steps.filter((s) => s.section).map((s) => s.section?.id)).toEqual(["auth"]);
    expect(steps.find((s) => dataKind(s) === "first-turn")?.data).toMatchObject({
      skipped: true,
    });
    expect(deps.runFirstTurn).not.toHaveBeenCalled();
  });

  it("refuses to overwrite an invalid config", async () => {
    fs.writeFileSync(configPath, '{ "gateway": { "port": "not-a-number" } }');
    const deps = baseDeps();
    const { status, steps } = await drive(deps, () => null);
    expect(status).toBe("error");
    expect(steps[0]?.title).toBe("Config needs repair");
    expect(deps.onComplete).not.toHaveBeenCalled();
  });
});

describe("--non-interactive uses the same model", () => {
  it("takes every recommended answer, and the first key found", async () => {
    const env = { ANTHROPIC_API_KEY: ANTHROPIC } as NodeJS.ProcessEnv;
    const keyEnv = { env, envFilePath: path.join(dir, ".env"), agentDir: path.join(dir, "agent") };
    const draft = createSetupDraft({});
    await runSetupSteps({
      ctx: { effective: {}, keys: detectSetupKeys(keyEnv), keyEnv, installKind: "package", env },
      draft,
    });
    expect(Object.keys(draft.answers)).toEqual([...SETUP_STEP_IDS]);
    expect(draft.answers).toMatchObject({
      auth: "env:ANTHROPIC_API_KEY",
      embeddings: "auto",
      webSearch: "later",
      channels: "later",
      p2p: "join",
      telemetry: "ack",
    });
    expect(draft.pendingKey?.provider).toBe("anthropic");
  });
});
