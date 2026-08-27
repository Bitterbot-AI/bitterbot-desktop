import { describe, expect, it } from "vitest";
import { buildMobilePairingUrl, renderMobileUiPage } from "./mobile-ui-page.js";

describe("buildMobilePairingUrl", () => {
  it("attaches the token as a query param", () => {
    const url = buildMobilePairingUrl("https://gw.example:19001", "abc123");
    expect(url).toBe("https://gw.example:19001/m?t=abc123");
  });

  it("trims trailing slashes from the base", () => {
    const url = buildMobilePairingUrl("https://gw.example:19001/", "abc");
    expect(url).toBe("https://gw.example:19001/m?t=abc");
  });

  it("includes an optional sessionKey", () => {
    const url = buildMobilePairingUrl("https://gw.example:19001", "abc", "mobile:alice");
    expect(url).toContain("t=abc");
    expect(url).toContain("s=mobile%3Aalice");
  });

  it("omits the query string when no token is given", () => {
    const url = buildMobilePairingUrl("https://gw.example:19001", "");
    expect(url).toBe("https://gw.example:19001/m");
  });
});

describe("renderMobileUiPage", () => {
  it("inlines the ws url and session-token path — NEVER the token (PLAN-41 mgmt-token-html)", () => {
    const html = renderMobileUiPage("wss://gw.example:19001", "/auth/session-token");
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain('"wss://gw.example:19001"');
    expect(html).toContain('"/auth/session-token"');
    expect(html).toContain("fetchSessionToken");
  });

  it("keeps the ?t= override for tailnet phones and defaults TOKEN empty", () => {
    const html = renderMobileUiPage("wss://gw.example:19001");
    expect(html).toContain('"wss://gw.example:19001"');
    expect(html).toMatch(/let TOKEN = URL_PARAMS\.get\("t"\) \|\| ""/);
  });
});
