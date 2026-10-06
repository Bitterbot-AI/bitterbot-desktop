/**
 * First-device pairing for a fresh remote gateway (PLAN-53 F1).
 *
 * A gateway deployed to a cloud host has no local browser, so the first
 * Control UI connection used to stop at "pairing required" with only a CLI
 * inside the container to approve it. The first Control UI device that
 * proves the gateway token or password is paired on the spot, but only while
 * the gateway has no paired device at all. From then on, every new device
 * needs an approval as before.
 */

export function bootstrapPairingAllowed(params: {
  isControlUi: boolean;
  /** The connection proved the shared gateway token or password. */
  sharedAuthOk: boolean;
  /** gateway.controlUi.bootstrapPairing; on unless false. */
  enabled: boolean | undefined;
  /** Why pairing is needed: only a brand-new device, never a scope or role upgrade. */
  reason: string;
  pairedCount: number;
}): boolean {
  return (
    params.enabled !== false &&
    params.isControlUi &&
    params.sharedAuthOk &&
    params.reason === "not-paired" &&
    params.pairedCount === 0
  );
}
