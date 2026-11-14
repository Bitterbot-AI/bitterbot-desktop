import crypto from "node:crypto";
import type { KeyPair } from "../../../commerce/envelope.js";
import { canonicalJson, type JsonValue } from "../../../commerce/sku.js";
import { ReleaseSchema, type SkillRelease } from "./contracts.js";

export function signRecord<T extends object>(
  domain: string,
  record: T,
  key: KeyPair,
): T & { signature: string } {
  const bytes = Buffer.from(`${domain}\n${canonicalJson(record as JsonValue)}`);
  return { ...record, signature: crypto.sign(null, bytes, key.privateKey).toString("hex") };
}
export function verifyRecord(
  domain: string,
  record: object & { signature: string },
  publisher: string,
): boolean {
  if (!/^ed25519:[a-f0-9]{64}$/.test(publisher) || !/^[a-f0-9]{128}$/.test(record.signature))
    return false;
  const { signature, ...unsigned } = record;
  try {
    const key = crypto.createPublicKey({
      key: Buffer.concat([
        Buffer.from("302a300506032b6570032100", "hex"),
        Buffer.from(publisher.slice(8), "hex"),
      ]),
      format: "der",
      type: "spki",
    });
    return crypto.verify(
      null,
      Buffer.from(`${domain}\n${canonicalJson(unsigned as JsonValue)}`),
      key,
      Buffer.from(signature, "hex"),
    );
  } catch {
    return false;
  }
}
export function signRelease(release: Omit<SkillRelease, "signature">, key: KeyPair): SkillRelease {
  if (release.publisher !== `ed25519:${key.publicKeyHex}`)
    throw new Error("Publisher does not own signing key");
  const { signature: _oldSignature, ...unsigned } = release as SkillRelease;
  return ReleaseSchema.parse(signRecord(release.protocol, unsigned, key));
}
export function validateRelease(input: unknown): SkillRelease {
  const release = ReleaseSchema.parse(input);
  if (!verifyRecord(release.protocol, release, release.publisher))
    throw new Error("Invalid release signature");
  if (
    new Set(release.parents).size !== release.parents.length ||
    release.parents.includes(release.packageHash)
  )
    throw new Error("Invalid package ancestry");
  if ((release.version === 1) !== (release.previousRelease === null))
    throw new Error("Invalid release ancestry");
  return release;
}
