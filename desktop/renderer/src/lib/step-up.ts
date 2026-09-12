/**
 * Client-side step-up confirmation for high-value spend approvals
 * (PLAN-48 Phase 2, D-2).
 *
 * Above a configured threshold, approving an escalation in the Control UI
 * requires the operator to prove they are present with a platform passkey /
 * biometric (Touch ID / Windows Hello) before the one-time grant is minted.
 * This is a local "human present + verified" gate on the already operator-authed
 * approve action — like a sudo re-auth — raising the bar for a large spend even
 * from an already-open session.
 *
 * HONEST LIMITATION: the ceremony is verified only in the browser. The server
 * records the confirmation method for the audit trail but does not (yet) verify
 * a WebAuthn assertion against a registered credential — server-side assertion
 * verification is the tracked fast-follow. A determined attacker with a modified
 * client could bypass the step-up; its value is against a casual mis-approval
 * from an unattended, already-authenticated Control UI.
 *
 * WebAuthn requires a secure context (https or localhost). The whole feature is
 * gated off by default (threshold undefined) and degrades to a typed
 * confirmation when no platform authenticator is present, so it never hard-locks
 * an operator out of approving.
 */

export type StepUpMethod = "passkey" | "typed";

const CRED_KEY = "bitterbot.stepup.credentialId";

/** Whether a platform authenticator (Touch ID / Windows Hello) is usable here. */
export async function isPlatformAuthenticatorAvailable(): Promise<boolean> {
  try {
    if (typeof window === "undefined") return false;
    const pk = window.PublicKeyCredential;
    if (!pk?.isUserVerifyingPlatformAuthenticatorAvailable) return false;
    return await pk.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch {
    return false;
  }
}

function toBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function fromBytes(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** Random bytes in a fresh ArrayBuffer-backed view (satisfies BufferSource). */
function randomBytes(n: number): Uint8Array<ArrayBuffer> {
  const a = new Uint8Array(n);
  crypto.getRandomValues(a);
  return a;
}

function readStoredCredId(): Uint8Array<ArrayBuffer> | null {
  try {
    const v = localStorage.getItem(CRED_KEY);
    return v ? toBytes(v) : null;
  } catch {
    return null;
  }
}

/**
 * Force a platform user-verification gesture (biometric / device PIN). Registers
 * one resident credential on first use (cached by id in localStorage) and
 * asserts against it on subsequent step-ups, so the device accrues a single
 * step-up passkey rather than one per approval. Returns true when the ceremony
 * completed (human verified present), false on cancel / unavailable / error.
 */
export async function passkeyCeremony(): Promise<boolean> {
  try {
    if (!(await isPlatformAuthenticatorAvailable())) return false;
    const challenge = randomBytes(32);

    const stored = readStoredCredId();
    if (stored) {
      try {
        const assertion = await navigator.credentials.get({
          publicKey: {
            challenge,
            allowCredentials: [{ id: stored, type: "public-key" }],
            userVerification: "required",
            timeout: 60_000,
          },
        });
        if (assertion) return true;
      } catch {
        // Stored credential gone/unusable — fall through to (re-)register.
      }
    }

    const created = (await navigator.credentials.create({
      publicKey: {
        challenge,
        rp: { name: "Bitterbot Control" },
        user: {
          id: randomBytes(16),
          name: "operator",
          displayName: "Operator",
        },
        pubKeyCredParams: [
          { type: "public-key", alg: -7 }, // ES256
          { type: "public-key", alg: -257 }, // RS256
        ],
        authenticatorSelection: {
          authenticatorAttachment: "platform",
          userVerification: "required",
        },
        timeout: 60_000,
        attestation: "none",
      },
    })) as PublicKeyCredential | null;
    if (!created) return false;
    try {
      localStorage.setItem(CRED_KEY, fromBytes(created.rawId));
    } catch {
      // non-fatal: we just re-register next time
    }
    return true;
  } catch {
    return false;
  }
}
