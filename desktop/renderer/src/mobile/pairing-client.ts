/**
 * The phone's half of PLAN-62 pairing: claim a one-time setup code with this
 * phone's device key, show the confirmation number, and wait for the owner.
 */

import {
  buildClaimSignaturePayload,
  deriveConfirmCode,
  type BrowserDeviceIdentity,
} from "../lib/device-identity";

export type ClaimResponse = { claimId: string; confirmCode: string; requestId: string };

export type ClaimStatus =
  | { status: "pending"; confirmCode?: string }
  | { status: "approved"; deviceToken: string; scopes: string[]; deviceId: string }
  | { status: "rejected" }
  | { status: "expired" };

/** The app's base URL (…/m/), whatever base path the gateway mounts it under. */
export function appBaseUrl(loc: Location = window.location): string {
  const path = loc.pathname.endsWith("/") ? loc.pathname : loc.pathname.replace(/[^/]*$/, "");
  return `${loc.origin}${path}`;
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(new URL(path, appBaseUrl()).toString(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    credentials: "omit",
    cache: "no-store",
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string } & T;
  if (!res.ok) {
    throw new Error(data.error || `request failed (${res.status})`);
  }
  return data;
}

/** A friendly default name, from what the browser says about itself. */
export function guessDeviceName(ua: string = navigator.userAgent): string {
  if (/iPad/.test(ua)) return "iPad";
  if (/iPhone/.test(ua)) return "iPhone";
  const android = /Android [\d.]+; ([^;)]+?)(?: Build|\))/.exec(ua);
  if (android?.[1] && !/^K$/i.test(android[1].trim())) {
    return android[1].trim().slice(0, 40);
  }
  if (/Android/.test(ua)) return "Android phone";
  if (/Macintosh/.test(ua)) return "Mac browser";
  if (/Windows/.test(ua)) return "Windows browser";
  return "Phone";
}

export function guessPlatform(ua: string = navigator.userAgent): string {
  if (/iPhone|iPad/.test(ua)) return "ios-web";
  if (/Android/.test(ua)) return "android-web";
  return "web";
}

export async function claimSetupCode(
  code: string,
  identity: BrowserDeviceIdentity,
  displayName: string,
): Promise<ClaimResponse & { localConfirmCode: string }> {
  const signedAt = Date.now();
  const signature = await identity.sign(
    buildClaimSignaturePayload({ code, deviceId: identity.deviceId, signedAtMs: signedAt }),
  );
  const localConfirmCode = await deriveConfirmCode(code, identity.publicKey);
  const res = await postJson<ClaimResponse>("api/pair/claim", {
    code,
    device: { id: identity.deviceId, publicKey: identity.publicKey, signature, signedAt },
    displayName,
    platform: guessPlatform(),
  });
  if (res.confirmCode !== localConfirmCode) {
    // The gateway saw a different key than ours: something sits in between.
    throw new Error(
      "The codes do not match what this phone computed. Do not approve anything; make a new pairing code.",
    );
  }
  return { ...res, localConfirmCode };
}

export async function readClaimStatus(claimId: string, deviceId: string): Promise<ClaimStatus> {
  return await postJson<ClaimStatus>("api/pair/status", { claimId, deviceId });
}

/** Read and remove `#pair=<code>` from the address bar so it is never bookmarked. */
export function takePairCodeFromLocation(): string | null {
  const hash = window.location.hash;
  const match = /[#&]pair=([A-Za-z0-9_-]{16,64})/.exec(hash);
  if (!match) return null;
  history.replaceState(null, "", `${window.location.pathname}${window.location.search}#/chat`);
  return match[1];
}

export function formatConfirmCode(code: string): string {
  return code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code;
}
