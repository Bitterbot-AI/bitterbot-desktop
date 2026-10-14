import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  decideGatewaySwitch,
  type GatewaySwitchFindings,
  type GatewaySwitchOutcome,
  type GatewaySwitchStep,
} from "../../infra/gateway-switch.js";
import type { RuntimeEnv } from "../../runtime.js";
import { runGatewaySwitch, SWITCH_EXIT, type GatewaySwitchCommandDeps } from "./switch.js";

const CLONE_FINDINGS: GatewaySwitchFindings = {
  port: 19001,
  self: { root: path.resolve("/home/u/.bitterbot/app/1.5.0"), kind: "tarball", version: "1.5.0" },
  service: null,
  listener: {
    pid: 4242,
    command: "bitterbot-gateway",
    isGateway: true,
    runsFrom: { root: path.resolve("/home/u/bitterbot-desktop"), kind: "git", version: "1.4.0" },
    reportedVersion: null,
    isSelf: false,
    underService: false,
    exePath: "/usr/bin/node",
    childPids: [],
  },
  remoteMode: false,
};

function harness(opts: {
  findings?: GatewaySwitchFindings;
  outcome?: Partial<GatewaySwitchOutcome>;
  interactive?: boolean;
  answer?: boolean;
}) {
  const findings = opts.findings ?? CLONE_FINDINGS;
  const decision = decideGatewaySwitch(findings);
  const execute = vi.fn(
    async (
      _onStep?: (step: GatewaySwitchStep) => void,
      _onProgress?: (line: string) => void,
    ): Promise<GatewaySwitchOutcome> => ({
      ok: true,
      status: "switched",
      findings,
      decision,
      steps: [],
      ...opts.outcome,
    }),
  );
  const deps: GatewaySwitchCommandDeps = {
    detect: vi.fn(async () => ({ findings, decision, execute })),
    confirm: vi.fn(async () => opts.answer ?? true),
    isInteractive: () => opts.interactive ?? false,
  };
  const out: string[] = [];
  const runtime: RuntimeEnv = {
    log: (...a: unknown[]) => void out.push(a.join(" ")),
    error: (...a: unknown[]) => void out.push(a.join(" ")),
    exit: (code: number) => {
      throw new Error(`exit ${code}`);
    },
  };
  return { deps, execute, out, runtime };
}

describe("bitterbot gateway switch", () => {
  beforeEach(() => {
    vi.stubEnv("HOME", "/home/u");
    vi.stubEnv("BITTERBOT_HOME", "");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("--check reports a git clone in plain language and exits 10 without changing anything", async () => {
    const h = harness({});
    const code = await runGatewaySwitch({ check: true }, h.runtime, h.deps);
    expect(code).toBe(SWITCH_EXIT.available);
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.out.join("\n")).toContain(
      "Found Bitterbot 1.4.0 from ~/bitterbot-desktop (git clone) running on port 19001.",
    );
    expect(h.out.join("\n")).not.toMatch(/—/);
  });

  it("--check on a fresh machine exits 0", async () => {
    const h = harness({ findings: { ...CLONE_FINDINGS, listener: null } });
    expect(await runGatewaySwitch({ check: true }, h.runtime, h.deps)).toBe(SWITCH_EXIT.ok);
    expect(h.out.join("\n")).toContain("Nothing to switch");
  });

  it("--yes switches and tells a clone user the clone can go (never deleting it)", async () => {
    const h = harness({});
    const code = await runGatewaySwitch({ yes: true }, h.runtime, h.deps);
    expect(code).toBe(SWITCH_EXIT.ok);
    const text = h.out.join("\n");
    expect(text).toContain("Switching to 1.5.0...");
    expect(text).toContain("Your settings and memory are unchanged.");
    expect(text).toContain("Your git clone at ~/bitterbot-desktop is no longer used");
    expect(text).toContain("nothing was deleted");
  });

  it("without --yes and without a terminal it changes nothing and prints the command", async () => {
    const h = harness({ interactive: false });
    expect(await runGatewaySwitch({}, h.runtime, h.deps)).toBe(SWITCH_EXIT.notDone);
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.out.join("\n")).toContain("bitterbot gateway switch --yes");
  });

  it("asks once in a terminal (default yes), and a no changes nothing", async () => {
    const yes = harness({ interactive: true, answer: true });
    expect(await runGatewaySwitch({}, yes.runtime, yes.deps)).toBe(SWITCH_EXIT.ok);
    expect(yes.deps.confirm).toHaveBeenCalledWith("Switch to 1.5.0 now?");
    const no = harness({ interactive: true, answer: false });
    expect(await runGatewaySwitch({}, no.runtime, no.deps)).toBe(SWITCH_EXIT.notDone);
    expect(no.execute).not.toHaveBeenCalled();
  });

  it("a rolled-back switch exits 1 and says the old version runs again", async () => {
    const h = harness({
      outcome: {
        ok: false,
        status: "rolled-back",
        error: "The new gateway exited during startup.",
        rollback: { ok: true, restored: "process", manual: null },
      },
    });
    expect(await runGatewaySwitch({ yes: true }, h.runtime, h.deps)).toBe(SWITCH_EXIT.rolledBack);
    expect(h.out.join("\n")).toContain(
      "Bitterbot 1.4.0 from ~/bitterbot-desktop (git clone) is running again, as before.",
    );
  });

  it("a failed rollback exits 3 and says what to run", async () => {
    const h = harness({
      outcome: {
        ok: false,
        status: "rolled-back",
        error: "boom",
        rollback: {
          ok: false,
          restored: "nothing",
          manual: "cd ~/bitterbot-desktop && pnpm start gateway",
        },
      },
    });
    expect(await runGatewaySwitch({ yes: true }, h.runtime, h.deps)).toBe(SWITCH_EXIT.failed);
    expect(h.out.join("\n")).toContain("pnpm start gateway");
  });

  it("a foreign program on the port is reported and left alone (exit 5)", async () => {
    const h = harness({
      findings: {
        ...CLONE_FINDINGS,
        listener: {
          ...CLONE_FINDINGS.listener!,
          isGateway: false,
          command: "python3 -m http.server",
        },
      },
    });
    expect(await runGatewaySwitch({ yes: true }, h.runtime, h.deps)).toBe(SWITCH_EXIT.portInUse);
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.out.join("\n")).toContain("not a Bitterbot gateway");
  });

  it("a detection error is reported, not thrown (exit 3)", async () => {
    const h = harness({});
    h.deps.detect = vi.fn(async () => {
      throw new Error("config unreadable");
    });
    expect(await runGatewaySwitch({ check: true }, h.runtime, h.deps)).toBe(SWITCH_EXIT.failed);
    expect(h.out.join("\n")).toContain("config unreadable");
  });

  it("--check exits 5 for a program that is not a gateway, 0 for a remote gateway", async () => {
    const foreign = harness({
      findings: {
        ...CLONE_FINDINGS,
        listener: { ...CLONE_FINDINGS.listener!, isGateway: false, command: "nginx" },
      },
    });
    expect(await runGatewaySwitch({ check: true }, foreign.runtime, foreign.deps)).toBe(
      SWITCH_EXIT.portInUse,
    );
    const remote = harness({ findings: { ...CLONE_FINDINGS, remoteMode: true } });
    expect(await runGatewaySwitch({ check: true }, remote.runtime, remote.deps)).toBe(
      SWITCH_EXIT.ok,
    );
    expect(remote.out.join("\n")).toContain("remote gateway");
  });

  it("names the .env keys it will copy and the settings it cannot carry (names, never values)", async () => {
    const h = harness({
      findings: {
        ...CLONE_FINDINGS,
        serviceManager: true,
        envMigration: {
          source: path.resolve("/home/u/bitterbot-desktop/.env"),
          target: path.resolve("/home/u/.bitterbot/.env"),
          keys: ["OPENAI_API_KEY", "RPC_URL"],
          skipped: ["ODD_VALUE"],
        },
        processOnlyEnv: ["GITHUB_TOKEN"],
      },
      outcome: { envCopied: ["OPENAI_API_KEY", "RPC_URL"] },
    });
    await runGatewaySwitch({ yes: true }, h.runtime, h.deps);
    const text = h.out.join("\n");
    expect(text).toContain(
      "Will copy 2 keys from ~/bitterbot-desktop/.env into ~/.bitterbot/.env (existing keys are kept; a backup is made first): OPENAI_API_KEY, RPC_URL",
    );
    expect(text).toContain("copy these by hand from ~/bitterbot-desktop/.env): ODD_VALUE");
    expect(text).toContain("will not see: GITHUB_TOKEN");
    expect(text).toContain("keeps it running in the background");
    expect(text).toContain("Copied 2 keys from ~/bitterbot-desktop/.env into ~/.bitterbot/.env");
  });

  it("forwards progress lines while it waits", async () => {
    const h = harness({});
    h.execute.mockImplementation(async (_onStep, onProgress) => {
      onProgress?.("  Still starting (2m10s)...");
      return {
        ok: true,
        status: "switched",
        findings: CLONE_FINDINGS,
        decision: decideGatewaySwitch(CLONE_FINDINGS),
        steps: [],
      };
    });
    await runGatewaySwitch({ yes: true }, h.runtime, h.deps);
    expect(h.out).toContain("  Still starting (2m10s)...");
  });

  it("--no-summary (install.sh already showed it) goes straight to Switching", async () => {
    const h = harness({});
    await runGatewaySwitch({ yes: true, summary: false }, h.runtime, h.deps);
    expect(h.out[0]).toBe("Switching to 1.5.0...");
    expect(h.out.join("\n")).not.toContain("Found Bitterbot");
  });

  it("for the installer, nothing to switch prints nothing (its config line is all that shows)", async () => {
    const h = harness({ findings: { ...CLONE_FINDINGS, listener: null } });
    expect(await runGatewaySwitch({ check: true, installer: true }, h.runtime, h.deps)).toBe(
      SWITCH_EXIT.ok,
    );
    expect(h.out).toEqual([]);
  });

  it("--json prints one JSON object", async () => {
    const h = harness({});
    await runGatewaySwitch({ check: true, json: true }, h.runtime, h.deps);
    expect(h.out).toHaveLength(1);
    const parsed = JSON.parse(h.out[0] ?? "{}") as Record<string, unknown>;
    expect(parsed).toMatchObject({ status: "available", check: true, port: 19001 });
  });
});
