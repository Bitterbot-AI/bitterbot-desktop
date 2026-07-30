/**
 * Canonical pubkey display truncation.
 *
 * A truncated pubkey prefix is forgeable: an attacker can vanity-grind a
 * keypair whose public key shares the displayed prefix with a key the user
 * trusts, so the truncated form looks identical while the identity is not.
 * Because of that, display truncation policy (how many characters, what
 * ellipsis) must have exactly ONE home so it can be audited and tightened in
 * one place. This function is that home — no other code in the renderer may
 * `.slice()` / `.substring()` a pubkey for display (enforced by
 * desktop/scripts/check-pubkey-truncation.mjs).
 */
export function truncatePubkey(pubkey: string, chars = 20): string {
  return `${pubkey.slice(0, chars)}…`;
}
