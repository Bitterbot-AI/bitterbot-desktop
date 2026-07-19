/**
 * PLAN-36 §5.6 petname layer — the name-safety flags the UI shows per member.
 *
 * Pure + unit-tested because this is the anti-impersonation payoff and it is
 * easy to get subtly wrong (the first cut keyed collisions on the RESOLVED
 * name, which let petnaming a friend BLIND the cue to an impostor copying that
 * friend's display name — review F1). The rules:
 *
 *  - `unverified`: you have no petname for this key yet — you haven't vouched
 *    for who it is. Only un-vetted peers carry the affordances; a member you
 *    petnamed is identified, so their badge is suppressed (review F2).
 *  - `nameCollision`: an un-vetted peer is presenting a `displayName` (the
 *    SPOOFABLE field) that you associate with a DIFFERENT key — either another
 *    key also self-asserts it, or you privately gave that name to someone else.
 *    That is the impersonation signal.
 */

const MAX_NAME = 80;

export type NameFlagInput = {
  memberPubkey: string;
  displayName: string | null;
  isSelf: boolean;
};

export type NameFlags = { unverified: boolean; nameCollision: boolean };

function norm(s: string | null | undefined): string {
  return (s ?? "").trim().slice(0, MAX_NAME).toLowerCase();
}

/**
 * Flags per DISTINCT non-self pubkey. `members` may span every circle the
 * viewer is in (duplicates by pubkey are fine — deduped here). `petnames` is
 * pubkey -> your private label.
 */
export function computeNameFlags(
  members: NameFlagInput[],
  petnames: Record<string, string>,
): Map<string, NameFlags> {
  // Every self-asserted display name → the keys that assert it, and every name
  // YOU privately assigned → the keys you gave it to. Both over non-self keys.
  const displayNameKeys = new Map<string, Set<string>>();
  const petnameKeys = new Map<string, Set<string>>();
  const seen = new Set<string>();
  for (const m of members) {
    if (m.isSelf || seen.has(m.memberPubkey)) continue;
    seen.add(m.memberPubkey);
    const dn = norm(m.displayName);
    if (dn)
      (displayNameKeys.get(dn) ?? displayNameKeys.set(dn, new Set()).get(dn)!).add(m.memberPubkey);
    const pn = norm(petnames[m.memberPubkey]);
    if (pn) (petnameKeys.get(pn) ?? petnameKeys.set(pn, new Set()).get(pn)!).add(m.memberPubkey);
  }

  const hasOther = (map: Map<string, Set<string>>, name: string, self: string): boolean => {
    const set = map.get(name);
    if (!set) return false;
    for (const k of set) if (k !== self) return true;
    return false;
  };

  const flags = new Map<string, NameFlags>();
  for (const pubkey of seen) {
    const petname = petnames[pubkey];
    if (petname && petname.trim()) {
      // Identified — no affordances (you know who this is).
      flags.set(pubkey, { unverified: false, nameCollision: false });
      continue;
    }
    const dn = norm(members.find((m) => m.memberPubkey === pubkey)?.displayName);
    const nameCollision =
      !!dn && (hasOther(displayNameKeys, dn, pubkey) || hasOther(petnameKeys, dn, pubkey));
    flags.set(pubkey, { unverified: true, nameCollision });
  }
  return flags;
}
