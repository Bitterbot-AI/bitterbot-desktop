/**
 * Keys for conversations started on this phone. The gateway lets a phone use
 * only `main` and keys carrying its own device tag, so another phone can never
 * open them (src/gateway/mobile/phone-policy.ts phoneSessionTag).
 */
export function phoneSessionTag(deviceId: string | undefined | null): string | null {
  const tag = (deviceId ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 12);
  return tag.length === 12 ? tag : null;
}

/**
 * `mobile-<tag>-<yyyymmddhhmm>-<random>`; null until the phone knows its
 * device id. The random part keeps two New taps in the same minute apart.
 */
export function newPhoneSessionKey(
  deviceId: string | undefined | null,
  now = new Date(),
  random: (bytes: Uint8Array) => Uint8Array = (bytes) => crypto.getRandomValues(bytes),
): string | null {
  const tag = phoneSessionTag(deviceId);
  if (!tag) {
    return null;
  }
  const stamp = now.toISOString().slice(0, 16).replace(/[-:T]/g, "");
  const suffix = Array.from(random(new Uint8Array(4)), (b) => b.toString(16).padStart(2, "0")).join(
    "",
  );
  return `mobile-${tag}-${stamp}-${suffix}`;
}
