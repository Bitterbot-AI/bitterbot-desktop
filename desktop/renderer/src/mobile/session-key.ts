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

/** `mobile-<tag>-<yyyymmddhhmm>`; null until the phone knows its device id. */
export function newPhoneSessionKey(
  deviceId: string | undefined | null,
  now = new Date(),
): string | null {
  const tag = phoneSessionTag(deviceId);
  if (!tag) {
    return null;
  }
  return `mobile-${tag}-${now.toISOString().slice(0, 16).replace(/[-:T]/g, "")}`;
}
