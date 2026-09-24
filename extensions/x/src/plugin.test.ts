import type { BitterbotConfig } from "bitterbot/plugin-sdk";
import { describe, expect, it } from "vitest";
import { xPlugin } from "./plugin.js";

const cfg = {
  channels: { x: { clientId: "cid", handle: "BitterbotDreams" } },
} as unknown as BitterbotConfig;

describe("xPlugin", () => {
  it("has no inbound gateway and only direct chat type", () => {
    expect(xPlugin.gateway).toBeUndefined();
    expect(xPlugin.capabilities.chatTypes).toEqual(["direct"]);
    expect(xPlugin.meta.aliases).toContain("twitter");
  });

  it("treats timeline and reply targets as ids", () => {
    expect(xPlugin.messaging?.targetResolver?.looksLikeId?.("timeline")).toBe(true);
    expect(xPlugin.messaging?.targetResolver?.looksLikeId?.("reply:1234567")).toBe(true);
    expect(xPlugin.messaging?.targetResolver?.looksLikeId?.("@someone")).toBe(false);
    expect(xPlugin.messaging?.normalizeTarget?.("ME")).toBe("timeline");
  });

  it("describes accounts and exposes policy in the agent hints", () => {
    expect(xPlugin.config.listAccountIds(cfg)).toEqual(["default"]);
    expect(xPlugin.config.isConfigured?.(xPlugin.config.resolveAccount(cfg, "default"), cfg)).toBe(
      true,
    );
    expect(
      xPlugin.config.isConfigured?.(
        xPlugin.config.resolveAccount({} as BitterbotConfig, "default"),
        cfg,
      ),
    ).toBe(false);
    const hints = xPlugin.agentPrompt?.messageToolHints?.({ cfg, accountId: "default" }) ?? [];
    expect(hints.join("\n")).toMatch(/4 posts\/day/);
    expect(hints.join("\n")).toMatch(/saying nothing is always acceptable/i);
  });

  it("builds an offline snapshot marking authorized as running", async () => {
    const account = xPlugin.config.resolveAccount(cfg, "default");
    const snapshot = await xPlugin.status?.buildAccountSnapshot?.({
      account,
      cfg,
      probe: { authorized: true },
    });
    expect(snapshot).toMatchObject({ accountId: "default", configured: true, running: true });
    expect(
      xPlugin.status?.resolveAccountState?.({ account, cfg, configured: false, enabled: true }),
    ).toBe("not configured");
  });
});
