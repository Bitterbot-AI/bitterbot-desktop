/**
 * PLAN-45 Phase 0: the wiki-evolution provenance trailer as a parsed record,
 * not a substring.
 *
 * The publisher appends `<!-- wiki-evolution-provenance {json} -->` to the
 * SKILL.md it broadcasts (p2p-publish.ts). The receiver used to treat the
 * bare marker text as "carries validation evidence", which let any envelope
 * that merely contained the phrase skip legacy-crystal rejection. Now the
 * trailer must parse into a closed-shape record with an `accepted` verdict
 * and a real timestamp, and the parsed record is stored alongside the
 * envelope so the receiver re-gate (PLAN-45 Phase 4) can read it.
 *
 * Integrity: the envelope signature covers the SKILL.md bytes, so a parsed
 * trailer is bound to the author key. It is still the SENDER's claim; it
 * never substitutes for local measurement.
 */

import crypto from "node:crypto";
import type { EvolutionMeta } from "./validation-gate.js";
import { type KeyPair, pubkeyId } from "../../commerce/envelope.js";
import { canonicalJson, type JsonValue } from "../../commerce/sku.js";

export const PROVENANCE_TRAILER_MARKER = "wiki-evolution-provenance";
/** Domain prefix of the trailer binding preimage (PLAN-45 4.4). */
export const PROVENANCE_BINDING_PROTOCOL = "skill-provenance/v1";

/**
 * PLAN-45 4.4: the DEVICE key's signature over the trailer, binding it to
 * the skill name, the body it describes, and the NODE key that will sign
 * the envelope. The envelope signature (node key, over body + trailer)
 * then covers this block, so the two keys cross-sign each other with no
 * orchestrator change: the node endorses the device's claim, the device
 * names the node.
 */
export interface ProvenanceBinding {
  skillName: string;
  /** sha256 of the SKILL.md body WITHOUT the trailer (the wire hash covers body + trailer). */
  bodySha256: string;
  /** base64 libp2p key = the envelope's author_pubkey. */
  nodePubkey: string;
  /** `ed25519:<hex>` device key (pubkeyId). */
  attesterPubkey: string;
  signedAt: string;
  signature: string;
}

export interface EvolutionProvenanceRecord {
  origin: "wiki-evolution";
  verdict: "accepted";
  /** PLAN-45 2.8: only tasks-mode verdicts are evidence; a records trailer never parses. */
  mode: "tasks";
  validatedAt: string;
  meanDelta?: number;
  ci95Low?: number;
  trials?: number;
  corpusVersion?: string;
  /** The model the sender's gate executed on (alias of validatedOn[0]; kept for pre-4.6 receivers). */
  model?: string;
  /** PLAN-45 4.6 (I8): the model that AUTHORED the candidate (proposer lane). */
  evolverModel?: string;
  /** PLAN-45 4.6 (I8): models the candidate was measured on. */
  validatedOn?: string[];
  notice?: string;
  /** PLAN-45 4.4: present and VERIFIED when the sender signed the trailer with its device key. */
  binding?: ProvenanceBinding;
}

export const RECEIVER_NOTICE =
  "Receiving nodes should re-validate locally; this is the sender's evidence, not a guarantee.";

export function bodySha256(body: string): string {
  return crypto.createHash("sha256").update(Buffer.from(body, "utf-8")).digest("hex");
}

function bindingPreimage(
  record: Record<string, unknown>,
  binding: Omit<ProvenanceBinding, "signature">,
): Buffer {
  const { binding: _omit, notice: _n, ...claims } = record;
  return Buffer.from(
    `${PROVENANCE_BINDING_PROTOCOL}\n${canonicalJson({ ...claims, ...binding } as unknown as JsonValue)}`,
    "utf8",
  );
}

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function verifyBinding(record: Record<string, unknown>, binding: ProvenanceBinding): boolean {
  const m = /^ed25519:([0-9a-f]{64})$/.exec(binding.attesterPubkey);
  if (!m || !/^[0-9a-f]{128}$/.test(binding.signature)) {
    return false;
  }
  try {
    const key = crypto.createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(m[1] ?? "", "hex")]),
      format: "der",
      type: "spki",
    });
    const { signature, ...unsigned } = binding;
    return crypto.verify(
      null,
      bindingPreimage(record, unsigned),
      key,
      Buffer.from(signature, "hex"),
    );
  } catch {
    return false;
  }
}

export interface TrailerSigning {
  skillName: string;
  /** The SKILL.md body the trailer will be appended to. */
  body: string;
  /** The device key (attestation identity). */
  key: KeyPair;
  /** The node key that signs the envelope (envelope.author_pubkey, base64). */
  nodePubkey: string;
  now?: number;
}

/**
 * The trailer line. With `signing`, the record carries a device-key
 * binding (PLAN-45 4.4); without it (no device identity, no node key) the
 * trailer is the legacy unsigned claim.
 */
export function buildProvenanceTrailer(meta: EvolutionMeta, signing?: TrailerSigning): string {
  const v = meta.validation;
  const record: Record<string, unknown> = {
    origin: "wiki-evolution",
    verdict: v?.verdict,
    mode: v?.mode,
    ...(typeof v?.meanDelta === "number" ? { meanDelta: v.meanDelta } : {}),
    ...(typeof v?.ci95Low === "number" ? { ci95Low: v.ci95Low } : {}),
    ...(typeof v?.trials === "number" ? { trials: v.trials } : {}),
    ...(v?.corpusVersion ? { corpusVersion: v.corpusVersion } : {}),
    ...(v?.model ? { model: v.model } : {}),
    ...(v?.evolverModel ? { evolverModel: v.evolverModel } : {}),
    ...(v?.validatedOn?.length ? { validatedOn: v.validatedOn.slice(0, 4) } : {}),
    validatedAt: v?.validatedAt,
  };
  if (signing) {
    const unsigned: Omit<ProvenanceBinding, "signature"> = {
      skillName: signing.skillName,
      bodySha256: bodySha256(signing.body.replace(/\n+$/, "")),
      nodePubkey: signing.nodePubkey,
      attesterPubkey: pubkeyId(signing.key),
      signedAt: new Date(signing.now ?? Date.now()).toISOString(),
    };
    const signature = crypto
      .sign(null, bindingPreimage(record, unsigned), signing.key.privateKey)
      .toString("hex");
    record.binding = { ...unsigned, signature };
  }
  record.notice = RECEIVER_NOTICE;
  return `\n<!-- ${PROVENANCE_TRAILER_MARKER} ${JSON.stringify(record)} -->\n`;
}

/** The SKILL.md body with every provenance trailer line removed (what `binding.bodySha256` commits to). */
export function stripProvenanceTrailer(md: string): string {
  return md
    .replace(/[ \t]*<!--[ \t]*wiki-evolution-provenance[ \t]+\{[^\n]*\}[ \t]*-->[ \t]*\n?/g, "")
    .replace(/\n+$/, "");
}

// The publisher emits single-line JSON. Confining the capture to one line
// means a stray unterminated opener earlier in the body cannot swallow the
// real trailer, and a "-->" inside a string breaks only that trailer.
// Greedy inside the line: the record nests a `binding` object (4.4), so the
// capture must run to the LAST brace before the closer, not the first.
const TRAILER_RE = /<!--[ \t]*wiki-evolution-provenance[ \t]+(\{[^\n]*\})[ \t]*-->/g;

function optionalNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
function optionalString(v: unknown, max = 200): string | undefined {
  return typeof v === "string" && v.length > 0 && v.length <= max ? v : undefined;
}

/**
 * The LAST well-formed trailer in the body, or null. Only an `accepted`
 * verdict with a parseable `validatedAt` counts as evidence; anything else
 * (bare marker, malformed JSON, held/rejected verdicts, unknown mode) is
 * treated exactly like no trailer at all.
 */
export function parseProvenanceTrailer(md: string): EvolutionProvenanceRecord | null {
  let last: EvolutionProvenanceRecord | null = null;
  for (const match of md.matchAll(TRAILER_RE)) {
    let raw: unknown;
    try {
      raw = JSON.parse(match[1] ?? "");
    } catch {
      continue;
    }
    if (!raw || typeof raw !== "object") {
      continue;
    }
    const r = raw as Record<string, unknown>;
    if (r.origin !== "wiki-evolution" || r.verdict !== "accepted") {
      continue;
    }
    if (r.mode !== "tasks") {
      continue;
    }
    // The publisher writes `validatedAt` as epoch milliseconds
    // (EvolutionMeta.validation.validatedAt); hand-written trailers use ISO
    // strings. Both parse (PLAN-45 4.4 fix: the string-only check rejected
    // every real published trailer, so receivers never saw the evidence).
    const validatedAt =
      typeof r.validatedAt === "number" && Number.isFinite(r.validatedAt) && r.validatedAt > 0
        ? new Date(r.validatedAt).toISOString()
        : optionalString(r.validatedAt, 64);
    if (!validatedAt || Number.isNaN(Date.parse(validatedAt))) {
      continue;
    }
    // PLAN-45 4.4: a present binding must verify; a trailer whose binding
    // is malformed or forged is no trailer at all (never "unsigned").
    let binding: ProvenanceBinding | undefined;
    if (r.binding !== undefined) {
      const b = r.binding as Record<string, unknown> | null;
      const candidate: ProvenanceBinding | null =
        b && typeof b === "object"
          ? {
              skillName: optionalString(b.skillName, 128) ?? "",
              bodySha256: optionalString(b.bodySha256, 64) ?? "",
              nodePubkey: optionalString(b.nodePubkey, 128) ?? "",
              attesterPubkey: optionalString(b.attesterPubkey, 80) ?? "",
              signedAt: optionalString(b.signedAt, 64) ?? "",
              signature: optionalString(b.signature, 128) ?? "",
            }
          : null;
      if (
        !candidate ||
        !candidate.skillName ||
        !/^[0-9a-f]{64}$/.test(candidate.bodySha256) ||
        !candidate.nodePubkey ||
        Number.isNaN(Date.parse(candidate.signedAt)) ||
        !verifyBinding(r, candidate)
      ) {
        continue;
      }
      binding = candidate;
    }
    last = {
      origin: "wiki-evolution",
      verdict: "accepted",
      mode: "tasks",
      validatedAt,
      meanDelta: optionalNumber(r.meanDelta),
      ci95Low: optionalNumber(r.ci95Low),
      trials: optionalNumber(r.trials),
      corpusVersion: optionalString(r.corpusVersion),
      model: optionalString(r.model),
      evolverModel: optionalString(r.evolverModel),
      ...(Array.isArray(r.validatedOn) &&
      r.validatedOn.length <= 4 &&
      r.validatedOn.every((m) => typeof m === "string" && m.length > 0 && m.length <= 200)
        ? { validatedOn: r.validatedOn as string[] }
        : {}),
      notice: optionalString(r.notice, 400),
      ...(binding ? { binding } : {}),
    };
  }
  return last;
}

/**
 * Receiver-side cross-check of a verified binding against the envelope it
 * arrived in: the device key named THIS node key, and described THIS body.
 * Returns the reason a bound trailer does not belong to the envelope, or
 * null when it does (or when the trailer carries no binding).
 */
export function bindingMismatch(
  record: EvolutionProvenanceRecord,
  envelope: { author_pubkey: string; name: string },
  md: string,
): string | null {
  const b = record.binding;
  if (!b) {
    return null;
  }
  if (b.nodePubkey !== envelope.author_pubkey) {
    return "trailer binding names a different node key than the envelope author";
  }
  if (
    b.skillName !==
    envelope.name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64)
  ) {
    return "trailer binding names a different skill than the envelope";
  }
  if (b.bodySha256 !== bodySha256(stripProvenanceTrailer(md))) {
    return "trailer binding does not match the SKILL.md body";
  }
  return null;
}

// ---------------------------------------------------------------------------
// PLAN-45 Phase 3.4: RETRACTION trailer. A rolled-back evolved skill is
// retracted on the mesh with a signed stub envelope from the same author
// key whose SKILL.md carries this trailer; receivers drop or disable the
// matching content and never store the stub as a skill.
// ---------------------------------------------------------------------------

export const RETRACTION_TRAILER_MARKER = "wiki-evolution-retraction";

export interface EvolutionRetractionRecord {
  origin: "wiki-evolution";
  /** Name of the retracted skill. */
  name: string;
  /** SHA-256 of the SKILL.md bytes that were published (the envelope content_hash). */
  contentSha256: string;
  reason: string;
  retractedAt: string;
}

export function buildRetractionStub(record: EvolutionRetractionRecord): string {
  const body = [
    "---",
    `name: ${record.name}`,
    `description: Retraction notice for ${record.name}; not a skill.`,
    "---",
    "",
    `This skill was retracted by its publisher (${record.reason}).`,
    "",
    `<!-- ${RETRACTION_TRAILER_MARKER} ${JSON.stringify(record)} -->`,
    "",
  ];
  return body.join("\n");
}

const RETRACTION_RE = /<!--[ \t]*wiki-evolution-retraction[ \t]+(\{[^\n]*?\})[ \t]*-->/g;

export function parseRetractionTrailer(md: string): EvolutionRetractionRecord | null {
  let last: EvolutionRetractionRecord | null = null;
  for (const match of md.matchAll(RETRACTION_RE)) {
    let raw: unknown;
    try {
      raw = JSON.parse(match[1] ?? "");
    } catch {
      continue;
    }
    if (!raw || typeof raw !== "object") {
      continue;
    }
    const r = raw as Record<string, unknown>;
    const name = optionalString(r.name, 128);
    const sha = optionalString(r.contentSha256, 64);
    const retractedAt = optionalString(r.retractedAt, 64);
    if (
      r.origin !== "wiki-evolution" ||
      !name ||
      !sha ||
      !/^[0-9a-f]{64}$/.test(sha) ||
      !retractedAt ||
      Number.isNaN(Date.parse(retractedAt))
    ) {
      continue;
    }
    last = {
      origin: "wiki-evolution",
      name,
      contentSha256: sha,
      reason: optionalString(r.reason, 300) ?? "",
      retractedAt,
    };
  }
  return last;
}
