import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  workspace: "",
  gateway: vi.fn(async (_opts: { method: string; params: unknown }): Promise<unknown> => {
    throw new Error("gateway closed (1006 abnormal closure (no close frame)): no close reason");
  }),
  logs: [] as string[],
  errors: [] as string[],
}));

vi.mock("../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/config.js")>()),
  loadConfig: () => ({ agents: { defaults: { workspace: state.workspace } } }),
}));
vi.mock("../gateway/call.js", () => ({
  callGateway: (opts: { method: string; params: unknown }) => state.gateway(opts),
}));
vi.mock("../runtime.js", () => ({
  defaultRuntime: {
    log: (line: string) => state.logs.push(line),
    error: (line: string) => state.errors.push(line),
    exit: () => {},
  },
}));

import { parseGenomeTemperament } from "../memory/genome-parser.js";
import { runGenomeTemperament } from "./genome-cli.js";

const OLD_GENOME = "# Genome\n\n## Core Values\n\n- Earn trust through competence\n";
let dir: string;
let savedStateDir: string | undefined;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "bb-genome-cli-"));
  state.workspace = path.join(dir, "workspace");
  await fs.mkdir(state.workspace);
  await fs.writeFile(path.join(state.workspace, "GENOME.md"), OLD_GENOME);
  savedStateDir = process.env.BITTERBOT_STATE_DIR;
  process.env.BITTERBOT_STATE_DIR = path.join(dir, "state");
  state.logs = [];
  state.errors = [];
  state.gateway.mockClear();
});

afterEach(async () => {
  if (savedStateDir === undefined) {
    delete process.env.BITTERBOT_STATE_DIR;
  } else {
    process.env.BITTERBOT_STATE_DIR = savedStateDir;
  }
  await fs.rm(dir, { recursive: true, force: true });
});

const genome = () => fs.readFile(path.join(state.workspace, "GENOME.md"), "utf-8");

describe("bitterbot genome temperament", () => {
  it("without flags shows the offer and writes nothing", async () => {
    await runGenomeTemperament({});
    const out = state.logs.join("\n");
    expect(out).toContain("A base personality is available for your agent");
    expect(out).toContain("level: irreverent");
    expect(out).toContain("bitterbot genome temperament --add");
    expect(out).not.toContain("—");
    expect(await genome()).toBe(OLD_GENOME);
    expect(state.gateway).not.toHaveBeenCalled();
  });

  it("--add --level asks the running gateway first, then writes locally when none runs", async () => {
    await runGenomeTemperament({ add: true, level: "playful", yes: true });
    expect(state.gateway).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "genome.temperament.apply",
        params: { agentId: "main", action: "add", level: "playful" },
      }),
    );
    const after = await genome();
    expect(after.startsWith(OLD_GENOME.trimEnd())).toBe(true);
    expect(parseGenomeTemperament(after)?.level).toBe("playful");
    expect(state.logs.join("\n")).toContain("Previous GENOME.md kept at");
  });

  it("--level changes an existing section; a gateway error is not papered over", async () => {
    await runGenomeTemperament({ add: true, yes: true });
    await runGenomeTemperament({ level: "calm", yes: true });
    expect(parseGenomeTemperament(await genome())?.level).toBe("calm");

    state.gateway.mockImplementationOnce(async () => {
      throw new Error("GENOME.md is larger than 1048576 bytes.");
    });
    await expect(runGenomeTemperament({ level: "playful", yes: true })).rejects.toThrow(
      /larger than/,
    );
    expect(parseGenomeTemperament(await genome())?.level).toBe("calm");
  });

  it("refuses an unknown level and --level without the section", async () => {
    await expect(runGenomeTemperament({ level: "feral" })).rejects.toThrow(/--level must be/);
    await expect(runGenomeTemperament({ level: "calm", yes: true })).rejects.toThrow(/--add/);
    expect(await genome()).toBe(OLD_GENOME);
  });
});
