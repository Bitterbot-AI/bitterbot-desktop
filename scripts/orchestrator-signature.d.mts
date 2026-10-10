/**
 * Types for scripts/orchestrator-signature.mjs (the postinstall fetcher's
 * minisign policy). The runtime stays plain JS because it runs before any
 * build; this declaration gives the unit test and type-aware lint the real
 * shapes.
 */

export declare const ORCHESTRATOR_MINISIGN_PUBKEY: string;
export declare const MINISIGN_PUBKEY_ENV: "BITTERBOT_ORCHESTRATOR_MINISIGN_PUBKEY";

export declare function resolvePinnedMinisignPubkey(env?: Record<string, string | undefined>): string;

export declare function verifyMinisign(input: {
  pubkeyB64: string;
  message: string | Buffer;
  minisig: string;
}): { trustedComment: string };

export type ChecksumsSignatureResult = {
  /** false means REFUSE the install (fail closed). */
  ok: boolean;
  verified: boolean;
  reason?: string;
};

export declare function checkChecksumsSignature(input: {
  pubkeyB64: string;
  version: string;
  checksumsBody: string;
  fetchMinisig: () => Promise<string>;
  log?: (msg: string) => void;
  warn?: (msg: string) => void;
}): Promise<ChecksumsSignatureResult>;
