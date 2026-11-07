import { afterEach, describe, expect, it, vi } from "vitest";
import {
  iosVersion,
  parsePairInput,
  shouldInstallBeforePairing,
  stashPairCode,
  takeStashedPairCode,
} from "./install-handoff";

const IPHONE_18 =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 Version/18.1 Mobile/15E148 Safari/604.1";
const IPHONE_16_2 = IPHONE_18.replace(/18_1/g, "16_2");
const PIXEL = "Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP1A) Chrome/130";
const CODE = "AbCdEfGhIjKlMnOpQrStUv";

function asBrowser(ua: string, opts: { standalone?: boolean; secure?: boolean } = {}) {
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(ua);
  vi.stubGlobal("isSecureContext", opts.secure ?? true);
  vi.stubGlobal(
    "matchMedia",
    (query: string) =>
      ({ matches: query.includes("standalone") && opts.standalone === true }) as MediaQueryList,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.cookie = "bb_pair_handoff=; Max-Age=0; Path=/";
});

describe("pairing inside the Home Screen app (PLAN-62)", () => {
  it("asks iPhone Safari to install first, and nobody else", () => {
    asBrowser(IPHONE_18);
    expect(iosVersion()).toEqual([18, 1]);
    expect(shouldInstallBeforePairing()).toBe(true);

    asBrowser(IPHONE_18, { standalone: true });
    expect(shouldInstallBeforePairing()).toBe(false);

    // No web push before iOS 16.4: installing first would buy nothing.
    asBrowser(IPHONE_16_2);
    expect(shouldInstallBeforePairing()).toBe(false);

    // Plain HTTP cannot get notifications either.
    asBrowser(IPHONE_18, { secure: false });
    expect(shouldInstallBeforePairing()).toBe(false);

    // Android installs share the browser's storage: pair in place.
    asBrowser(PIXEL);
    expect(shouldInstallBeforePairing()).toBe(false);
  });

  it("hands the setup code over once", () => {
    stashPairCode(CODE);
    expect(takeStashedPairCode()).toBe(CODE);
    expect(takeStashedPairCode()).toBeNull();
  });

  it("never stores something that is not a setup code", () => {
    stashPairCode("bad; Path=/; x=");
    expect(takeStashedPairCode()).toBeNull();
  });

  it("reads a pasted link or a bare code", () => {
    expect(parsePairInput(` https://box.ts.net/m/#pair=${CODE} `)).toBe(CODE);
    expect(parsePairInput(CODE)).toBe(CODE);
    expect(parsePairInput("hello")).toBeNull();
  });
});
