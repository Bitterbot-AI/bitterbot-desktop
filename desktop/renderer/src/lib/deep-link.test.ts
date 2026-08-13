import { describe, expect, it } from "vitest";
import { initDeepLinkJoin, parseBitterbotJoinUrl } from "./deep-link";

// The guest page's CTA emits `bitterbot://join#${encodeURIComponent(code)}`
// (deploy/guest-page/index.html). The parser must round-trip exactly that,
// and reject everything that isn't a bbc1 invite riding the join path.

describe("parseBitterbotJoinUrl", () => {
  const code = "bbc1.eyJlbnYiOnsidHlwZSI6Imludml0ZSJ9fQ";

  it("round-trips the guest page's CTA shape", () => {
    expect(parseBitterbotJoinUrl(`bitterbot://join#${encodeURIComponent(code)}`)).toBe(code);
    // Some platforms normalize a path slash into the URL.
    expect(parseBitterbotJoinUrl(`bitterbot://join/#${encodeURIComponent(code)}`)).toBe(code);
    // Unencoded fragments (hand-typed links) still parse.
    expect(parseBitterbotJoinUrl(`bitterbot://join#${code}`)).toBe(code);
    // Scheme is case-insensitive per RFC 3986.
    expect(parseBitterbotJoinUrl(`BITTERBOT://JOIN#${code}`)).toBe(code);
  });

  it("rejects everything that is not a bbc1 join link", () => {
    expect(parseBitterbotJoinUrl("bitterbot://join")).toBeNull(); // no fragment
    expect(parseBitterbotJoinUrl("bitterbot://join#")).toBeNull();
    expect(parseBitterbotJoinUrl(`bitterbot://settings#${code}`)).toBeNull(); // wrong path
    expect(parseBitterbotJoinUrl(`https://join.bitterbot.ai/i#${code}`)).toBeNull(); // wrong scheme
    expect(parseBitterbotJoinUrl("bitterbot://join#not-an-invite")).toBeNull(); // not bbc1
    expect(parseBitterbotJoinUrl("bitterbot://join#%E0%A4%A")).toBeNull(); // bad percent-encoding
    expect(parseBitterbotJoinUrl("")).toBeNull();
  });
});

describe("initDeepLinkJoin", () => {
  it("is a no-op outside the Tauri shell", async () => {
    // happy-dom has no __TAURI_INTERNALS__ — the browser Control UI path.
    await expect(initDeepLinkJoin()).resolves.toBe(false);
  });
});
