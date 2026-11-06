/**
 * What the phone app remembers between launches. The device token is here;
 * on its own it is worthless, because every connection must also sign the
 * gateway's nonce with the device key, which WebCrypto keeps non-extractable.
 */

export type ThemePref = "system" | "dark" | "light";

export type MobilePersisted = {
  deviceToken?: string;
  deviceId?: string;
  sessionKey?: string;
  theme?: ThemePref;
  /** The owner dismissed the add-to-home-screen guide. */
  installDismissed?: boolean;
};

const KEY = "bitterbot-mobile-v1";

export function readPersisted(): MobilePersisted {
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
  } catch {
    // private mode: the app still works for this session
  }
  return next;
}

export function clearPersistedPairing(): void {
  writePersisted({ deviceToken: undefined, deviceId: undefined });
}
