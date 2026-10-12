import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTempHome } from "../../test/helpers/temp-home.js";

// Drift-pass review HIGH-2, through the GLOBAL config API under the e2e pool
// (vmForks). There, structuredClone returns arrays from another realm, which
// isDeepStrictEqual never equates with the snapshot's: the merge patch used
// to carry every array of the loaded config (the fallback
// p2p.bootstrapPeers) into the file.

async function writeRoot(home: string, content: unknown): Promise<string> {
  const file = path.join(home, ".bitterbot", "bitterbot.json");
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(content, null, 2), "utf-8");
  return file;
}

async function readJson(file: string): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(file, "utf-8")) as Record<string, unknown>;
}

describe("global writeConfigFile never freezes load-time defaults", () => {
  it("case A: clone the snapshot, delete a key, write", async () => {
    await withTempHome(async (home) => {
      const file = await writeRoot(home, {
        gateway: { mode: "local" },
        memory: { citations: "auto" },
        ui: { seamColor: "#ffffff" },
      });
      const { readConfigFileSnapshot, writeConfigFile } = await import("./config.js");
      const snap = await readConfigFileSnapshot();
      expect(snap.config.p2p?.bootstrapPeers?.length).toBeGreaterThan(0);
      const next = structuredClone(snap.config);
      delete next.memory;
      await writeConfigFile(next);
      const persisted = await readJson(file);
      expect(persisted.memory).toBeUndefined();
      expect(persisted.p2p).toBeUndefined();
      // Schema (zod) defaults are not written either: only meta is added.
      expect(persisted.commands).toBeUndefined();
      expect(Object.keys(persisted).toSorted()).toEqual(["gateway", "meta", "ui"]);
      expect(persisted.gateway).toEqual({ mode: "local" });
      expect(persisted.ui).toEqual({ seamColor: "#ffffff" });
    });
  });

  it("case B: doctor --fix removing a deprecated key freezes nothing", async () => {
    await withTempHome(async (home) => {
      const file = await writeRoot(home, {
        gateway: { mode: "local" },
        memory: { backend: "builtin" },
      });
      const { writeConfigFile } = await import("./config.js");
      const { loadAndMaybeMigrateDoctorConfig } = await import("../commands/doctor-config-flow.js");
      const result = await loadAndMaybeMigrateDoctorConfig({
        options: { nonInteractive: true, repair: true },
        confirm: async () => false,
      });
      await writeConfigFile(result.cfg);
      const persisted = await readJson(file);
      expect(persisted.p2p).toBeUndefined();
      expect(persisted.memory).toBeUndefined();
      expect(persisted.gateway).toEqual({ mode: "local" });
    });
  });

  it("doctor --fix removes a frozen fallback peer list from the file", async () => {
    await withTempHome(async (home) => {
      const { FALLBACK_BOOTSTRAP_PEERS } = await import("./defaults.js");
      const file = await writeRoot(home, {
        gateway: { mode: "local" },
        p2p: { enabled: true, bootstrapPeers: [...FALLBACK_BOOTSTRAP_PEERS] },
      });
      const { writeConfigFile } = await import("./config.js");
      const { loadAndMaybeMigrateDoctorConfig } = await import("../commands/doctor-config-flow.js");
      const result = await loadAndMaybeMigrateDoctorConfig({
        options: { nonInteractive: true, repair: true },
        confirm: async () => false,
      });
      await writeConfigFile(result.cfg);
      expect((await readJson(file)).p2p).toEqual({ enabled: true });
    });
  });

  it("an explicit user-set p2p.bootstrapPeers is kept as written", async () => {
    await withTempHome(async (home) => {
      const peers = ["/ip4/10.0.0.1/tcp/9100/p2p/12D3KooWUserPeerUserPeerUserPeerUserPeer"];
      const file = await writeRoot(home, {
        gateway: { mode: "local" },
        p2p: { bootstrapPeers: peers },
        ui: { seamColor: "#ffffff" },
      });
      const { readConfigFileSnapshot, writeConfigFile } = await import("./config.js");
      const next = structuredClone((await readConfigFileSnapshot()).config);
      delete next.ui;
      await writeConfigFile(next);
      expect((await readJson(file)).p2p).toEqual({ bootstrapPeers: peers });
    });
  });
});
