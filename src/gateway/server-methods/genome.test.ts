import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ workspace: "" }));

vi.mock("../../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/config.js")>()),
  loadConfig: () => ({ agents: { defaults: { workspace: state.workspace } } }),
}));

import { parseGenomeTemperament } from "../../memory/genome-parser.js";
import { authorizeGatewayMethod } from "../server-methods.js";
import { genomeHandlers } from "./genome.js";

type Reply = [boolean, any, { message?: string } | undefined];
const call = (method: string, params: Record<string, unknown> = {}) =>
  new Promise<Reply>((resolve) => {
    void genomeHandlers[method]({
      params,
      respond: (ok: boolean, payload: unknown, error: unknown) =>
        resolve([ok, payload, error as { message?: string }]),
    } as never);
  });

const OLD_GENOME = "# Genome\n\n## Core Values\n\n- Earn trust through competence\n";
let dir: string;
let savedStateDir: string | undefined;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "bb-genome-rpc-"));
  state.workspace = path.join(dir, "workspace");
  await fs.mkdir(state.workspace);
  await fs.writeFile(path.join(state.workspace, "GENOME.md"), OLD_GENOME);
  savedStateDir = process.env.BITTERBOT_STATE_DIR;
  process.env.BITTERBOT_STATE_DIR = path.join(dir, "state");
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

describe("genome.temperament.*", () => {
  it("status previews the section for a Genome without one", async () => {
    const [ok, status] = await call("genome.temperament.status", {});
    expect(ok).toBe(true);
    expect(status).toMatchObject({
      present: false,
      genomeExists: true,
      defaultLevel: "irreverent",
    });
    expect(status.levels).toEqual(["calm", "playful", "irreverent"]);
    expect(status.preview).toContain("level: irreverent");
  });

  it("apply add, then setLevel; status follows", async () => {
    const [added, result] = await call("genome.temperament.apply", { action: "add" });
    expect(added).toBe(true);
    expect(result).toMatchObject({ changed: true, status: { present: true, level: "irreverent" } });
    expect((await genome()).startsWith(OLD_GENOME.trimEnd())).toBe(true);

    const [set] = await call("genome.temperament.apply", { action: "setLevel", level: "calm" });
    expect(set).toBe(true);
    expect(parseGenomeTemperament(await genome())?.level).toBe("calm");
    const [, status] = await call("genome.temperament.status", {});
    expect(status).toMatchObject({ present: true, level: "calm" });
  });

  it("rejects bad input without writing", async () => {
    const bad = [
      { action: "add", level: "feral" },
      { action: "setLevel" },
      { action: "rewrite" },
      { action: "add", agentId: "nobody" },
    ];
    for (const params of bad) {
      const [ok] = await call("genome.temperament.apply", params);
      expect(ok, JSON.stringify(params)).toBe(false);
    }
    expect(await genome()).toBe(OLD_GENOME);
  });

  it("status is a read, apply needs the admin scope", () => {
    const client = (scopes: string[]) =>
      ({ connect: { role: "operator", scopes } }) as Parameters<typeof authorizeGatewayMethod>[1];
    expect(authorizeGatewayMethod("genome.temperament.status", client(["operator.read"]))).toBe(
      null,
    );
    expect(
      authorizeGatewayMethod("genome.temperament.apply", client(["operator.write"])),
    ).not.toBeNull();
    expect(authorizeGatewayMethod("genome.temperament.apply", client(["operator.admin"]))).toBe(
      null,
    );
  });
});
