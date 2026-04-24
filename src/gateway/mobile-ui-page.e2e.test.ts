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
  it("inlines the gateway ws url and token into the page", () => {
    const html = renderMobileUiPage("wss://gw.example:19001", "tok-123");
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain('"wss://gw.example:19001"');
    expect(html).toContain('"tok-123"');
  });

  it("renders without a token when none is given", () => {
    const html = renderMobileUiPage("wss://gw.example:19001");
    expect(html).toContain('"wss://gw.example:19001"');
    expect(html).toMatch(/const TOKEN = URL_PARAMS\.get\("t"\) \|\| ""/);
  });
});
