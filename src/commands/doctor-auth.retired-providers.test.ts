import { describe, expect, it } from "vitest";
import type { BitterbotConfig } from "../config/config.js";
import { findRetiredOAuthProviderUse } from "./doctor-auth.js";

describe("findRetiredOAuthProviderUse", () => {
  it("reports retired Google OAuth profiles and model refs, and nothing else", () => {
    const cfg = {
      auth: {
        profiles: { "google-antigravity:me": { provider: "google-antigravity", mode: "oauth" } },
      },
      agents: {
        defaults: {
          model: {
            primary: "google-gemini-cli/gemini-3-pro-preview",
            fallbacks: ["anthropic/claude-opus-4-8"],
          },
        },
        list: [{ id: "helper", model: "google-antigravity/claude-opus-4-5-thinking" }],
      },
    } as unknown as BitterbotConfig;

    const findings = findRetiredOAuthProviderUse(cfg, {
      "google-gemini-cli:default": { provider: "google-gemini-cli" },
      "anthropic:default": { provider: "anthropic" },
    });

    expect(findings.toSorted()).toEqual(
      [
        "auth profile google-antigravity:me (Google Antigravity OAuth)",
        "auth profile google-gemini-cli:default (Google Gemini CLI OAuth)",
        "model google-antigravity/claude-opus-4-5-thinking (Google Antigravity OAuth)",
        "model google-gemini-cli/gemini-3-pro-preview (Google Gemini CLI OAuth)",
      ].toSorted(),
    );
  });

  it("is quiet for a normal config", () => {
    const cfg = {
      agents: { defaults: { model: "google/gemini-3-pro-preview" } },
    } as unknown as BitterbotConfig;
    expect(findRetiredOAuthProviderUse(cfg, { "google:default": { provider: "google" } })).toEqual(
      [],
    );
  });
});
