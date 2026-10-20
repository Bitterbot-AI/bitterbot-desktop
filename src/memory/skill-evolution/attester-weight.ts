/**
 * PLAN-43 Phase 3: how much an attester's verdict counts in the aggregate.
 *
 * Honest v1: attestations are signed with DEVICE identities while the P2P
 * reputation graph is keyed on orchestrator node pubkeys, and there is no
 * cross-signature binding the two yet. So weighting is explicit:
 *   - our own attester key: 1
 *   - operator-trusted attesters (a2a.attestation.trustedAttesters): 1
 *   - blocked attesters (a2a.attestation.blockedAttesters): 0 (ignored)
 *   - everyone else: DEFAULT_UNKNOWN_ATTESTER_WEIGHT
 * Device identities are free to mint, so the unknown weight alone is not a
 * defense (at 0.2 thirteen minted keys overturned three trusted nodes in
 * the 3b adversarial pass). Two layers hold the line: this low default,
 * and the aggregate's UNKNOWN_MASS_CAP (all unknown attesters together
 * weigh at most 25% of the trusted weight present).
 */

import { keyPairFromPrivateKeyPem, pubkeyId } from "../../commerce/envelope.js";
import { loadDeviceIdentity } from "../../infra/device-identity.js";

export const DEFAULT_UNKNOWN_ATTESTER_WEIGHT = 0.05;

export interface AttesterWeightPolicy {
  ownAttesterPubkey?: string;
  trustedAttesters?: readonly string[];
  blockedAttesters?: readonly string[];
  unknownWeight?: number;
}

export function makeAttesterWeight(
  policy: AttesterWeightPolicy,
): (attesterPubkey: string) => number {
  const trusted = new Set(policy.trustedAttesters ?? []);
  const blocked = new Set(policy.blockedAttesters ?? []);
  const unknown = Math.max(0, Math.min(1, policy.unknownWeight ?? DEFAULT_UNKNOWN_ATTESTER_WEIGHT));
  return (pk: string) => {
    if (blocked.has(pk)) {
      return 0;
    }
    if (pk === policy.ownAttesterPubkey || trusted.has(pk)) {
      return 1;
    }
    return unknown;
  };
}

/**
 * This node's attester pubkey (`ed25519:<hex>` of the device identity), or
 * undefined when the identity file is unreadable. Load-only: never mints.
 */
export function resolveOwnAttesterPubkey(): string | undefined {
  try {
    const identity = loadDeviceIdentity();
    return identity ? pubkeyId(keyPairFromPrivateKeyPem(identity.privateKeyPem)) : undefined;
  } catch {
    return undefined;
  }
}
