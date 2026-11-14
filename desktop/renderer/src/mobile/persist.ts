/**
 * What the phone app remembers between launches. The device token is here;
 * on its own it is worthless, because every connection must also sign the
 * gateway's nonce with the device key, which WebCrypto keeps non-extractable.
 */

export type ThemePref = "system" | "dark" | "light";

/** A claimed setup code still waiting for the owner, so a reload can resume. */
export type PendingClaim = {
  claimId: string;
  deviceId: string;
  confirmCode: string;
  expiresAtMs: number;
};

export type MobilePersisted = {
  deviceToken?: string;
  deviceId?: string;
  sessionKey?: string;
  theme?: ThemePref;
  pendingClaim?: PendingClaim;
};

const KEY = "bitterbot-mobile-v1";

/**
 * Where everything lives when the browser refuses storage (private browsing,
 * storage blocked): the app keeps working until the page closes, and pairing
 * does not fail because a write vanished.
 */
let memoryCopy: MobilePersisted | null = null;

export function readPersisted(): MobilePersisted {
  if (memoryCopy) return { ...memoryCopy };
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as MobilePersisted) : {};
  } catch {
    return {};
  }
}

export function writePersisted(patch: Partial<MobilePersisted>): MobilePersisted {
  const next = { ...readPersisted(), ...patch };
  for (const [k, v] of Object.entries(next)) {
    if (v === undefined) delete (next as Record<string, unknown>)[k];
  }
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
    memoryCopy = null;
  } catch {
    // private mode: the app still works for this session
    memoryCopy = next;
  }
  return next;
}

export function clearPersistedPairing(): void {
  writePersisted({ deviceToken: undefined, deviceId: undefined, pendingClaim: undefined });
}
