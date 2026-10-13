import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createConfigIO, stripLoadTimeDefaults } from "./io.js";

// A write that starts from the loaded config (loadConfig / snapshot.config,
// with every load-time default applied) must persist only what the caller
// changed: never the fallback p2p.bootstrapPeers, the compaction/context
// pruning modes or any other applyLoadTimeDefaults value (drift-pass review
// HIGH-2).

const silentLogger = { warn: () => {}, error: () => {} };
let root = "";
let n = 0;

async function setup(initial: unknown) {
  const home = path.join(root, `h${n++}`);
  const configPath = path.join(home, ".bitterbot", "bitterbot.json");
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, JSON.stringify(initial, null, 2), "utf-8");
  const io = createConfigIO({
    env: {} as NodeJS.ProcessEnv,
    homedir: () => home,
    logger: silentLogger,
  });
  const read = async () =>
    JSON.parse(await fs.readFile(configPath, "utf-8")) as Record<string, unknown>;
  return { io, read };
}

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "bb-io-frozen-"));
});
afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const DEFAULTED_BLOCKS = ["p2p", "circles", "a2a", "session", "logging", "messages"] as const;

describe("writeConfigFile never freezes load-time defaults", () => {
  for (const source of ["snapshot", "loadConfig"] as const) {
    it(`deleting one key writes no defaulted block (${source})`, async () => {
      const { io, read } = await setup({
        gateway: { mode: "local" },
        ui: { seamColor: "#123456" },
        memory: { citations: "auto" },
        auth: { profiles: { "anthropic:default": { provider: "anthropic", mode: "api_key" } } },
        agents: { defaults: { workspace: "/tmp/bb-ws" } },
      });
      const loaded =
        source === "snapshot" ? (await io.readConfigFileSnapshot()).config : io.loadConfig();
      // Sanity: the loaded view really carries the defaults.
      expect(loaded.p2p?.bootstrapPeers?.length).toBeGreaterThan(0);
      const next = structuredClone(loaded) as Record<string, unknown>;
      delete next.memory;
      await io.writeConfigFile(next as never);
      const persisted = await read();
      expect(persisted.memory).toBeUndefined();
      for (const block of DEFAULTED_BLOCKS) {
        expect(persisted[block]).toBeUndefined();
      }
      expect(persisted.agents).toEqual({ defaults: { workspace: "/tmp/bb-ws" } });
      expect(persisted.ui).toEqual({ seamColor: "#123456" });
    });
  }

  it("keeps an explicit user-set p2p.bootstrapPeers", async () => {
    const peers = ["/ip4/10.0.0.1/tcp/9100/p2p/12D3KooWExampleExampleExampleExampleExample"];
    const { io, read } = await setup({
      p2p: { bootstrapPeers: peers },
      ui: { seamColor: "#123456" },
    });
    const next = structuredClone((await io.readConfigFileSnapshot()).config) as Record<
      string,
      unknown
    >;
    delete next.ui;
    await io.writeConfigFile(next as never);
    expect((await read()).p2p).toEqual({ bootstrapPeers: peers });
  });

  it("keeps a caller change inside a defaulted block, and only that", async () => {
    const { io, read } = await setup({ ui: { seamColor: "#123456" } });
    const next = structuredClone((await io.readConfigFileSnapshot()).config);
    next.p2p = { ...next.p2p, enabled: false };
    await io.writeConfigFile(next);
    expect((await read()).p2p).toEqual({ enabled: false });
  });
});

describe("stripLoadTimeDefaults", () => {
  it("drops defaulted values the file lacks, whatever built the candidate", async () => {
    const { io } = await setup({ ui: { seamColor: "#123456" } });
    const loaded = io.loadConfig();
    const stripped = stripLoadTimeDefaults(loaded, { ui: { seamColor: "#123456" } }) as Record<
      string,
      unknown
    >;
    for (const block of DEFAULTED_BLOCKS) {
      expect(stripped[block]).toBeUndefined();
    }
    expect(stripped.ui).toEqual({ seamColor: "#123456" });
  });

  it("keeps values the file holds even when they equal the default", () => {
    const stripped = stripLoadTimeDefaults(
      { p2p: { enabled: true, bootstrapDns: "p2p.bitterbot.ai" } },
      { p2p: { enabled: true } },
    ) as { p2p?: Record<string, unknown> };
    expect(stripped.p2p).toEqual({ enabled: true });
  });
});

describe("configValuesEqual", () => {
  it("is structural and ignores the realm of arrays and objects", async () => {
    const { configValuesEqual } = await import("./io.js");
    const vm = await import("node:vm");
    const foreign = vm.runInNewContext('[["a", {"b": 1}], {"c": [2]}]') as unknown[];
    expect(configValuesEqual(foreign, [["a", { b: 1 }], { c: [2] }])).toBe(true);
    expect(configValuesEqual([1, 2], [1, 2, 3])).toBe(false);
    expect(configValuesEqual({ a: 1 }, { a: 1, b: undefined })).toBe(false);
    expect(configValuesEqual({ a: [1] }, { a: [2] })).toBe(false);
  });
});
