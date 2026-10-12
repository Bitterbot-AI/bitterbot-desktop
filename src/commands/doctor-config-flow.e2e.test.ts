import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { withTempHome } from "../../test/helpers/temp-home.js";
import { loadAndMaybeMigrateDoctorConfig } from "./doctor-config-flow.js";

describe("doctor config flow", () => {
  it("removes inert deprecated keys on repair and keeps them without it", async () => {
    await withTempHome(async (home) => {
      const configDir = path.join(home, ".bitterbot");
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(
        path.join(configDir, "bitterbot.json"),
        JSON.stringify(
          {
            memory: { backend: "builtin" },
            update: { uiRestart: { enabled: true } },
            agents: { list: [{ id: "main", runtime: { engine: "pi" } }] },
          },
          null,
          2,
        ),
        "utf-8",
      );

      const kept = await loadAndMaybeMigrateDoctorConfig({
        options: { nonInteractive: true },
        confirm: async () => false,
      });
      expect((kept.cfg as Record<string, { backend?: string }>).memory?.backend).toBe("builtin");

      const repaired = await loadAndMaybeMigrateDoctorConfig({
        options: { nonInteractive: true, repair: true },
        confirm: async () => false,
      });
      const cfg = repaired.cfg as {
        memory?: { backend?: string };
        update?: { uiRestart?: unknown };
        agents?: { list?: Array<{ id: string; runtime?: unknown }> };
      };
      expect(cfg.memory?.backend).toBeUndefined();
      expect(cfg.update?.uiRestart).toBeUndefined();
      expect(cfg.agents?.list?.[0]).toEqual(expect.objectContaining({ id: "main" }));
      expect(cfg.agents?.list?.[0]?.runtime).toBeUndefined();
    });
  });

  it("preserves invalid config for doctor repairs", async () => {
    await withTempHome(async (home) => {
      const configDir = path.join(home, ".bitterbot");
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(
        path.join(configDir, "bitterbot.json"),
        JSON.stringify(
          {
            gateway: { auth: { mode: "token", token: 123 } },
            agents: { list: [{ id: "pi" }] },
          },
          null,
          2,
        ),
        "utf-8",
      );

      const result = await loadAndMaybeMigrateDoctorConfig({
        options: { nonInteractive: true },
        confirm: async () => false,
      });

      expect((result.cfg as Record<string, unknown>).gateway).toEqual({
        auth: { mode: "token", token: 123 },
      });
    });
  });

  it("never removes deprecated keys from a config that uses $include", async () => {
    await withTempHome(async (home) => {
      const configDir = path.join(home, ".bitterbot");
      await fs.mkdir(configDir, { recursive: true });
      const rootFile = path.join(configDir, "bitterbot.json");
      const rootText = [
        "// my comment",
        "{",
        '  "agents": { "$include": "./agents.json5" },',
        '  "memory": { "backend": "builtin" }',
        "}",
        "",
      ].join("\n");
      await fs.writeFile(rootFile, rootText, "utf-8");
      await fs.writeFile(
        path.join(configDir, "agents.json5"),
        JSON.stringify({ defaults: { contextPruning: { mode: "cache-ttl" } } }),
        "utf-8",
      );

      const result = await loadAndMaybeMigrateDoctorConfig({
        options: { nonInteractive: true, repair: true },
        confirm: async () => false,
      });
      const cfg = result.cfg as {
        memory?: { backend?: string };
        agents?: { defaults?: { contextPruning?: unknown } };
      };
      expect(cfg.memory?.backend).toBe("builtin");
      expect(cfg.agents?.defaults?.contextPruning).toBeDefined();
      expect(result.shouldWriteConfig).toBe(false);
      // The flow itself never touches the file.
      expect(await fs.readFile(rootFile, "utf-8")).toBe(rootText);
    });
  });

  it("the repair prompt for deprecated keys alone defaults to no", async () => {
    await withTempHome(async (home) => {
      const configDir = path.join(home, ".bitterbot");
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(
        path.join(configDir, "bitterbot.json"),
        JSON.stringify({ memory: { backend: "builtin" } }),
        "utf-8",
      );
      const prompts: Array<{ message: string; initialValue: boolean }> = [];
      const result = await loadAndMaybeMigrateDoctorConfig({
        options: {},
        confirm: async (p) => {
          prompts.push(p);
          return p.initialValue;
        },
      });
      expect(prompts).toHaveLength(1);
      expect(prompts[0]?.initialValue).toBe(false);
      expect(prompts[0]?.message).toContain("deprecated");
      expect(result.shouldWriteConfig).toBe(false);
    });
  });

  it("drops unknown keys on repair", async () => {
    await withTempHome(async (home) => {
      const configDir = path.join(home, ".bitterbot");
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(
        path.join(configDir, "bitterbot.json"),
        JSON.stringify(
          {
            bridge: { bind: "auto" },
            gateway: { auth: { mode: "token", token: "ok", extra: true } },
            agents: { list: [{ id: "pi" }] },
          },
          null,
          2,
        ),
        "utf-8",
      );

      const result = await loadAndMaybeMigrateDoctorConfig({
        options: { nonInteractive: true, repair: true },
        confirm: async () => false,
      });

      const cfg = result.cfg as Record<string, unknown>;
      expect(cfg.bridge).toBeUndefined();
      expect((cfg.gateway as Record<string, unknown>)?.auth).toEqual({
        mode: "token",
        token: "ok",
      });
    });
  });

  it("resolves Telegram @username allowFrom entries to numeric IDs on repair", async () => {
    const fetchSpy = vi.fn(async (url: string) => {
      const u = String(url);
      const chatId = new URL(u).searchParams.get("chat_id") ?? "";
      const id =
        chatId.toLowerCase() === "@testuser"
          ? 111
          : chatId.toLowerCase() === "@groupuser"
            ? 222
            : chatId.toLowerCase() === "@topicuser"
              ? 333
              : chatId.toLowerCase() === "@accountuser"
                ? 444
                : null;
      return {
        ok: id != null,
        json: async () => (id != null ? { ok: true, result: { id } } : { ok: false }),
      } as unknown as Response;
    });
    vi.stubGlobal("fetch", fetchSpy);
    try {
      await withTempHome(async (home) => {
        const configDir = path.join(home, ".bitterbot");
        await fs.mkdir(configDir, { recursive: true });
        await fs.writeFile(
          path.join(configDir, "bitterbot.json"),
          JSON.stringify(
            {
              channels: {
                telegram: {
                  botToken: "123:abc",
                  allowFrom: ["@testuser"],
                  groupAllowFrom: ["groupUser"],
                  groups: {
                    "-100123": {
                      allowFrom: ["tg:@topicUser"],
                      topics: { "99": { allowFrom: ["@accountUser"] } },
                    },
                  },
                  accounts: {
                    alerts: { botToken: "456:def", allowFrom: ["@accountUser"] },
                  },
                },
              },
            },
            null,
            2,
          ),
          "utf-8",
        );

        const result = await loadAndMaybeMigrateDoctorConfig({
          options: { nonInteractive: true, repair: true },
          confirm: async () => false,
        });

        const cfg = result.cfg as unknown as {
          channels: {
            telegram: {
              allowFrom: string[];
              groupAllowFrom: string[];
              groups: Record<
                string,
                { allowFrom: string[]; topics: Record<string, { allowFrom: string[] }> }
              >;
              accounts: Record<string, { allowFrom: string[] }>;
            };
          };
        };
        expect(cfg.channels.telegram.allowFrom).toEqual(["111"]);
        expect(cfg.channels.telegram.groupAllowFrom).toEqual(["222"]);
        expect(cfg.channels.telegram.groups["-100123"].allowFrom).toEqual(["333"]);
        expect(cfg.channels.telegram.groups["-100123"].topics["99"].allowFrom).toEqual(["444"]);
        expect(cfg.channels.telegram.accounts.alerts.allowFrom).toEqual(["444"]);
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
