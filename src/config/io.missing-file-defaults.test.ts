/**
 * PLAN-56 Phase 2: a missing config file loads exactly like an empty `{}`
 * file. Before, loadConfig() returned a bare `{}` for a missing file without
 * the apply*Defaults chain, so an unconfigured container (no bitterbot.json)
 * ran with no P2P, circles or model defaults while an empty file got them.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createConfigIO } from "./io.js";

async function withTempHome(run: (home: string) => Promise<void>): Promise<void> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "bitterbot-nofile-"));
  try {
    await run(home);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
}

function ioFor(home: string) {
  const logs: string[] = [];
  const logger = {
    warn: (msg: string) => logs.push(`warn:${msg}`),
    error: (msg: string) => logs.push(`error:${msg}`),
  } as unknown as typeof console;
  return {
    io: createConfigIO({ env: {} as NodeJS.ProcessEnv, homedir: () => home, logger }),
    logs,
  };
}

describe("loadConfig without a config file (PLAN-56 Phase 2)", () => {
  it("equals loading an empty {} file", async () => {
    await withTempHome(async (missingHome) => {
      await withTempHome(async (emptyHome) => {
        await fs.mkdir(path.join(emptyHome, ".bitterbot"), { recursive: true });
        await fs.writeFile(path.join(emptyHome, ".bitterbot", "bitterbot.json"), "{}\n");

        const missing = ioFor(missingHome);
        const empty = ioFor(emptyHome);
        const fromMissing = missing.io.loadConfig();
        const fromEmpty = empty.io.loadConfig();

        expect(fromMissing).toEqual(fromEmpty);
        expect(missing.logs).toEqual(empty.logs);
      });
    });
  });

  it("applies the load-time defaults (P2P on, bootstrap peers, circles)", async () => {
    await withTempHome(async (home) => {
      const cfg = ioFor(home).io.loadConfig();
      expect(cfg.p2p?.enabled).toBe(true);
      expect(cfg.p2p?.bootstrapPeers?.length ?? 0).toBeGreaterThan(0);
      expect(cfg.circles).toBeDefined();
      expect(cfg.a2a).toBeDefined();
    });
  });

  it("does not create the file: 'not configured' stays detectable by file presence", async () => {
    await withTempHome(async (home) => {
      const { io } = ioFor(home);
      io.loadConfig();
      const snapshot = await io.readConfigFileSnapshot();
      expect(snapshot.exists).toBe(false);
      await expect(fs.stat(io.configPath)).rejects.toThrow();
      // The gateway's own gate is unaffected by the defaults: gateway.mode is
      // never defaulted, so `gateway` without --allow-unconfigured still
      // refuses a fresh install.
      expect(io.loadConfig().gateway?.mode).toBeUndefined();
    });
  });

  it("the missing-file snapshot equals what loadConfig() returns", async () => {
    await withTempHome(async (home) => {
      const { io } = ioFor(home);
      const snapshot = await io.readConfigFileSnapshot();
      const { talk: _talk, ...snapshotConfig } = snapshot.config;
      expect(snapshotConfig).toEqual(io.loadConfig());
    });
  });

  // Zod-level schema defaults (today only `commands.native/nativeSkills`)
  // are written by every config write, to an existing file too; that is
  // pre-existing behaviour, so it is stripped here and pinned by the
  // missing-vs-empty equality test below.
  const ZOD_WRITE_DEFAULTS = ["meta", "commands"];
  function writtenWithoutZodDefaults(raw: string): Record<string, unknown> {
    const written = JSON.parse(raw) as Record<string, unknown>;
    for (const key of ZOD_WRITE_DEFAULTS) {
      delete written[key];
    }
    return written;
  }

  it("writing a loaded config to a missing file persists only the caller's change", async () => {
    await withTempHome(async (home) => {
      const { io } = ioFor(home);
      const cfg = io.loadConfig();
      await io.writeConfigFile({ ...cfg, plugins: { ...cfg.plugins, enabled: false } });
      expect(writtenWithoutZodDefaults(await fs.readFile(io.configPath, "utf-8"))).toEqual({
        plugins: { enabled: false },
      });
    });
  });

  it("writing from an empty base to a missing file keeps only what was given", async () => {
    await withTempHome(async (home) => {
      const { io } = ioFor(home);
      await io.writeConfigFile({ gateway: { auth: { mode: "token", token: "t" } } });
      expect(writtenWithoutZodDefaults(await fs.readFile(io.configPath, "utf-8"))).toEqual({
        gateway: { auth: { mode: "token", token: "t" } },
      });
    });
  });

  it("a write to a missing file produces the same file as a write to an empty {} file", async () => {
    await withTempHome(async (missingHome) => {
      await withTempHome(async (emptyHome) => {
        await fs.mkdir(path.join(emptyHome, ".bitterbot"), { recursive: true });
        await fs.writeFile(path.join(emptyHome, ".bitterbot", "bitterbot.json"), "{}\n");
        const results: Record<string, unknown>[] = [];
        for (const home of [missingHome, emptyHome]) {
          const { io } = ioFor(home);
          const cfg = io.loadConfig();
          await io.writeConfigFile({ ...cfg, plugins: { ...cfg.plugins, enabled: false } });
          const written = JSON.parse(await fs.readFile(io.configPath, "utf-8")) as Record<
            string,
            unknown
          >;
          delete written.meta;
          results.push(written);
        }
        expect(results[0]).toEqual(results[1]);
      });
    });
  });
});
