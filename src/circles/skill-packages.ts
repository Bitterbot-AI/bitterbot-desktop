import type { DatabaseSync } from "node:sqlite";
import { PeerEvidenceSchema } from "../agents/skills/collective/evidence.js";
import {
  getCollectiveRuntime,
  registerCollectiveMembership,
  type CollectiveRuntime,
} from "../agents/skills/collective/runtime.js";
import { validateRelease } from "../agents/skills/collective/signatures.js";
import { withdrawRelease } from "../agents/skills/collective/transport.js";
import { keyPairFromPrivateKeyPem } from "../commerce/envelope.js";
import { loadConfig } from "../config/config.js";
import { authorizeCircleEnvelope } from "../gateway/a2a/circles.js";
import { loadOrCreateDeviceIdentity } from "../infra/device-identity.js";
import { CirclesStore } from "../memory/circles-store.js";
import {
  openBox,
  sealToBox,
  loadOrCreateBoxKeys,
  type BoxKeyPair,
  type SealedBlob,
} from "./box-crypto.js";

export function bindCollectiveCircles(db: DatabaseSync, self?: string): void {
  const circles = new CirclesStore(db);
  const selfIdentity =
    self ??
    `ed25519:${keyPairFromPrivateKeyPem(loadOrCreateDeviceIdentity().privateKeyPem).publicKeyHex}`;
  registerCollectiveMembership(
    (id, publisher) =>
      circles.getCircle(id)?.status === "active" &&
      circles.getMember(id, selfIdentity)?.status === "active" &&
      circles.getMember(id, publisher)?.status === "active",
  );
}
export async function handleCirclePackage(
  method: string,
  params: unknown,
  db: DatabaseSync,
  now: number,
  keys?: BoxKeyPair,
  injected?: CollectiveRuntime,
) {
  const auth = authorizeCircleEnvelope(
    db,
    (params as { envelope?: unknown })?.envelope,
    method === "circle/skill.object" ? "ledger.read" : "ledger.append",
    { now, expectedType: "event", rateClass: "package" },
  );
  if (!auth.ok) return auth;
  try {
    const runtime = injected ?? getCollectiveRuntime(loadConfig());
    if (!runtime) throw new Error("Complete skill packages are disabled");
    if (!injected) bindCollectiveCircles(db);
    const body = auth.envelope.body;
    if (body.operation !== method) throw new Error("Package operation binding mismatch");
    const plaintext = openBox(keys ?? loadOrCreateBoxKeys(), body.sealed as unknown as SealedBlob);
    if (!plaintext || plaintext.length > 65536)
      throw new Error("Invalid encrypted package request");
    const input: unknown = JSON.parse(plaintext);
    if (typeof body.box_pubkey === "string") {
      const bytes = Buffer.from(body.box_pubkey, "base64");
      if (bytes.length !== 32 || bytes.toString("base64") !== body.box_pubkey)
        throw new Error("Invalid sender encryption key");
      auth.store.updateMemberEndpoints(
        auth.envelope.circle_id,
        auth.envelope.author_pubkey,
        { boxPubkey: body.box_pubkey },
        now,
      );
    }
    if (method === "circle/skill.withdraw") {
      const id = (input as { releaseId?: string })?.releaseId;
      const row = id
        ? (runtime.store.db.prepare("SELECT body FROM collective_releases WHERE id=?").get(id) as
            | { body: string }
            | undefined)
        : undefined;
      const release = row ? validateRelease(JSON.parse(row.body)) : null;
      if (
        !release ||
        release.publisher !== auth.envelope.author_pubkey ||
        release.scope.kind !== "circle" ||
        release.scope.circleId !== auth.envelope.circle_id
      )
        throw new Error("Withdrawal scope mismatch");
      withdrawRelease(runtime.store, input);
      return { ok: true as const, result: { withdrawn: true } };
    }
    if (method === "circle/skill.evidence") {
      const evidence = PeerEvidenceSchema.parse(input);
      if (
        evidence.origin !== auth.envelope.author_pubkey ||
        evidence.scope.kind !== "circle" ||
        evidence.scope.circleId !== auth.envelope.circle_id
      )
        throw new Error("Evidence scope mismatch");
      return { ok: true as const, result: { evidenceId: runtime.evidence.import(evidence) } };
    }
    if (method === "circle/skill.announce") {
      const release = validateRelease(input);
      if (
        release.publisher !== auth.envelope.author_pubkey ||
        release.scope.kind !== "circle" ||
        release.scope.circleId !== auth.envelope.circle_id
      )
        throw new Error("Release does not belong to this Circle publisher");
      return { ok: true as const, result: { releaseId: runtime.store.addRelease(release) } };
    }
    if (method === "circle/skill.object") {
      const requester = auth.store.getMember(auth.envelope.circle_id, auth.envelope.author_pubkey);
      if (!requester?.boxPubkey) throw new Error("Recipient encryption key unavailable");
      const chunk = await runtime.distribution.serve(
        input,
        auth.envelope.author_pubkey,
        auth.envelope.circle_id,
      );
      return {
        ok: true as const,
        result: { sealed: sealToBox(requester.boxPubkey, JSON.stringify(chunk)) },
      };
    }
    throw new Error("Unsupported package operation");
  } catch (error) {
    return { ok: false as const, error: { code: -32602, message: String(error) } };
  }
}
