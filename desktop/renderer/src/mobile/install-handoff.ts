/**
 * Pair inside the Home Screen app, not in Safari (PLAN-62).
 *
 * On iPhone, a web app added to the Home Screen gets a fresh storage area:
 * since iOS 17.2 Safari copies its cookies into the new app once, and
 * nothing else (https://webkit.org/blog/14787/). A phone paired in Safari
 * would open the installed app unpaired, and only the installed app can get
 * notifications. So when a pairing link opens in iPhone Safari, the app asks
 * for the install first and hands the one-time setup code over in a cookie
 * scoped to the app's path. The installed app claims it with a device key it
 * creates itself, and the owner confirms once. No key, token or gateway
 * secret crosses over; the setup code works once and expires in five minutes
 * whatever happens to the cookie.
 */

import { isIos, isStandalone } from "./push";

const COOKIE = "bb_pair_handoff";
const CODE_RE = /^[A-Za-z0-9_-]{16,64}$/;

/** iOS major/minor from the user agent, or null off iOS. */
export function iosVersion(ua: string = navigator.userAgent): [number, number] | null {
  const match = /OS (\d+)_(\d+)/.exec(ua);
  if (!match || !isIos()) return null;
  return [Number(match[1]), Number(match[2])];
}

/**
 * iPhone Safari, over HTTPS, on an iOS that gives Home Screen apps
 * notifications (16.4+). Older iOS and every other browser pair in place.
 */
export function shouldInstallBeforePairing(): boolean {
  if (!isIos() || isStandalone()) return false;
  if (typeof isSecureContext === "undefined" || !isSecureContext) return false;
  const version = iosVersion();
  if (!version) return true; // iPadOS reports as a Mac: assume current
  const [major, minor] = version;
  return major > 16 || (major === 16 && minor >= 4);
}

function cookiePath(loc: Location = window.location): string {
  return loc.pathname.endsWith("/") ? loc.pathname : loc.pathname.replace(/[^/]*$/, "");
}

export function stashPairCode(code: string, maxAgeSeconds = 300): void {
  if (!CODE_RE.test(code)) return;
  const secure = window.location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `${COOKIE}=${code}; Max-Age=${maxAgeSeconds}; Path=${cookiePath()}; SameSite=Strict${secure}`;
}

export function clearStashedPairCode(): void {
  document.cookie = `${COOKIE}=; Max-Age=0; Path=${cookiePath()}; SameSite=Strict`;
}

/** The handed-over setup code, read once: it is cleared as it is read. */
export function takeStashedPairCode(): string | null {
  const match = new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]*)`).exec(document.cookie);
  const code = match?.[1] ?? "";
  if (!code) return null;
  clearStashedPairCode();
  return CODE_RE.test(code) ? code : null;
}

/** A pasted pairing link (or the bare code from it). */
export function parsePairInput(text: string): string | null {
  const trimmed = text.trim();
  const fromLink = /[#&]pair=([A-Za-z0-9_-]{16,64})/.exec(trimmed);
  if (fromLink) return fromLink[1];
  return CODE_RE.test(trimmed) ? trimmed : null;
}
