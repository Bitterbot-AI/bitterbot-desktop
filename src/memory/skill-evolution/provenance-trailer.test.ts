/**
 * PLAN-45 Phase 0: the provenance trailer is evidence only when it parses
 * into an accepted, dated record. The marker text alone is not evidence.
 */

import { describe, expect, it } from "vitest";
import {
  PROVENANCE_TRAILER_MARKER,
  RETRACTION_TRAILER_MARKER,
  bindingMismatch,
  bodySha256,
  buildProvenanceTrailer,
  buildRetractionStub,
  parseProvenanceTrailer,
  parseRetractionTrailer,
  stripProvenanceTrailer,
} from "./provenance-trailer.js";
import type { EvolutionMeta } from "./validation-gate.js";

const META = {
  validation: {
    verdict: "accepted",
    mode: "tasks",
    meanDelta: 0.4,
    trials: 3,
    corpusVersion: "canonical-g4-s7",
    model: "anthropic/claude-opus-4-8",
    validatedAt: "2026-09-05T12:00:00.000Z",
  },
} as unknown as EvolutionMeta;

describe("provenance trailer", () => {
  it("round-trips what the publisher writes", () => {
    const body = `---\nname: x\n---\nBody.${buildProvenanceTrailer(META)}`;
    const rec = parseProvenanceTrailer(body);
    expect(rec).toMatchObject({
      origin: "wiki-evolution",
      verdict: "accepted",
      mode: "tasks",
      meanDelta: 0.4,
      trials: 3,
      corpusVersion: "canonical-g4-s7",
      model: "anthropic/claude-opus-4-8",
      validatedAt: "2026-09-05T12:00:00.000Z",
    });
  });

  it("the bare marker string is not evidence", () => {
    expect(
      parseProvenanceTrailer(`Body mentions ${PROVENANCE_TRAILER_MARKER} in prose.`),
    ).toBeNull();
    expect(parseProvenanceTrailer(`<!-- ${PROVENANCE_TRAILER_MARKER} -->`)).toBeNull();
    expect(parseProvenanceTrailer(`<!-- ${PROVENANCE_TRAILER_MARKER} {not json} -->`)).toBeNull();
  });

  it("rejects non-accepted verdicts, unknown modes, missing or bad dates", () => {
    const mk = (o: Record<string, unknown>) =>
      `<!-- ${PROVENANCE_TRAILER_MARKER} ${JSON.stringify(o)} -->`;
    const base = {
      origin: "wiki-evolution",
      verdict: "accepted",
      mode: "tasks",
      validatedAt: "2026-09-05T00:00:00Z",
    };
    expect(parseProvenanceTrailer(mk({ ...base, verdict: "held" }))).toBeNull();
    expect(parseProvenanceTrailer(mk({ ...base, origin: "other" }))).toBeNull();
    expect(parseProvenanceTrailer(mk({ ...base, mode: "vibes" }))).toBeNull();
    expect(parseProvenanceTrailer(mk({ ...base, validatedAt: undefined }))).toBeNull();
    expect(parseProvenanceTrailer(mk({ ...base, validatedAt: "yesterday" }))).toBeNull();
    expect(parseProvenanceTrailer(mk(base))).not.toBeNull();
  });

  it("a stray unterminated opener earlier in the body cannot swallow the real trailer", () => {
    const real = `<!-- ${PROVENANCE_TRAILER_MARKER} ${JSON.stringify({ origin: "wiki-evolution", verdict: "accepted", mode: "tasks", validatedAt: "2026-09-05T00:00:00Z" })} -->`;
    const body = `Prose with <!-- ${PROVENANCE_TRAILER_MARKER} { unterminated\nmore prose\n${real}\n`;
    expect(parseProvenanceTrailer(body)?.mode).toBe("tasks");
  });

  it("takes the last well-formed trailer and drops malformed optional fields", () => {
    const mk = (o: Record<string, unknown>) =>
      `<!-- ${PROVENANCE_TRAILER_MARKER} ${JSON.stringify(o)} -->`;
    const first = mk({
      origin: "wiki-evolution",
      verdict: "accepted",
      mode: "records",
      validatedAt: "2026-09-01T00:00:00Z",
    });
    const second = mk({
      origin: "wiki-evolution",
      verdict: "accepted",
      mode: "tasks",
      validatedAt: "2026-09-05T00:00:00Z",
      meanDelta: "0.9",
      model: "x".repeat(500),
    });
    const rec = parseProvenanceTrailer(`${first}\n\n${second}`);
    expect(rec?.mode).toBe("tasks");
    expect(rec?.meanDelta).toBeUndefined();
    expect(rec?.model).toBeUndefined();
  });
});

describe("PLAN-45 2.8: only tasks-mode verdicts are evidence", () => {
  it("a records-mode trailer does not parse", () => {
    const mk = (mode: string) =>
      `<!-- ${PROVENANCE_TRAILER_MARKER} ${JSON.stringify({ origin: "wiki-evolution", verdict: "accepted", mode, validatedAt: "2026-09-05T00:00:00Z" })} -->`;
    expect(parseProvenanceTrailer(mk("records"))).toBeNull();
    expect(parseProvenanceTrailer(mk("tasks"))?.mode).toBe("tasks");
  });
});

describe("PLAN-45 3.4: retraction trailer", () => {
  it("round-trips a retraction stub and refuses malformed records", () => {
    const stub = buildRetractionStub({
      origin: "wiki-evolution",
      name: "curl-timeout-guard",
      contentSha256: "a".repeat(64),
      reason: "canary regression p=0.01",
      retractedAt: "2026-09-06T00:00:00.000Z",
    });
    const rec = parseRetractionTrailer(stub);
    expect(rec).toMatchObject({ name: "curl-timeout-guard", contentSha256: "a".repeat(64) });
    expect(parseProvenanceTrailer(stub)).toBeNull(); // a retraction is never validation evidence
    expect(
      parseRetractionTrailer(
        `<!-- ${RETRACTION_TRAILER_MARKER} {"origin":"wiki-evolution","name":"x","contentSha256":"zz","retractedAt":"2026-09-06T00:00:00Z"} -->`,
      ),
    ).toBeNull();
  });
});

describe("PLAN-45 4.4 / 4.6: signed trailer binding and model tags", () => {
  it("round-trips a device-signed binding, refuses a forged one, and carries evolverModel/validatedOn", async () => {
    const { generateKeyPair } = await import("../../commerce/envelope.js");
    const key = generateKeyPair();
    const meta = {
      origin: "wiki-evolution",
      validation: {
        mode: "tasks" as const,
        verdict: "accepted",
        validatedAt: 1_700_000_000_000,
        model: "openai/gpt-x",
        evolverModel: "anthropic/claude-opus-5",
        validatedOn: ["openai/gpt-x"],
      },
    };
    const body = "---\nname: s\ndescription: d\n---\nbody";
    const trailer = buildProvenanceTrailer(meta, {
      skillName: "s",
      body,
      key,
      nodePubkey: "NODEKEY==",
      now: 1_700_000_001_000,
    });
    const md = `${body}\n${trailer}`;
    const parsed = parseProvenanceTrailer(md);
    expect(parsed).toMatchObject({
      evolverModel: "anthropic/claude-opus-5",
      validatedOn: ["openai/gpt-x"],
      binding: {
        skillName: "s",
        nodePubkey: "NODEKEY==",
        attesterPubkey: `ed25519:${key.publicKeyHex}`,
      },
    });
    expect(parsed?.binding?.bodySha256).toBe(bodySha256(body));
    expect(stripProvenanceTrailer(md)).toBe(body);
    expect(bindingMismatch(parsed!, { author_pubkey: "NODEKEY==", name: "s" }, md)).toBeNull();
    expect(bindingMismatch(parsed!, { author_pubkey: "OTHER==", name: "s" }, md)).toContain(
      "different node key",
    );
    // Tamper with a signed claim: the whole trailer is no trailer.
    const forged = md.replace('"nodePubkey":"NODEKEY=="', '"nodePubkey":"EVIL=="');
    expect(parseProvenanceTrailer(forged)).toBeNull();
    const forgedModel = md.replace('"model":"openai/gpt-x"', '"model":"openai/gpt-z"');
    expect(parseProvenanceTrailer(forgedModel)).toBeNull();
    // An unsigned (pre-4.4) trailer still parses, with no binding.
    const legacy = `${body}\n${buildProvenanceTrailer(meta)}`;
    expect(parseProvenanceTrailer(legacy)?.binding).toBeUndefined();
    expect(parseProvenanceTrailer(legacy)?.evolverModel).toBe("anthropic/claude-opus-5");
  });
});

describe("PLAN-58: applicability profile inside the signed trailer", () => {
  const profile = {
    v: 1 as const,
    generatedAt: "2026-10-26T00:00:00.000Z",
    windowDays: 14,
    measured: { models: ["openai/gpt-x"], validatedOn: ["openai/gpt-x"], os: ["linux"] },
    declared: { bins: ["docker"] },
    shape: { tools: [{ name: "exec", runs: 3 }], sequenceHashes: ["0123456789ab"] },
    outcomes: {
      runs: 6,
      pass: 5,
      fail: 1,
      indeterminate: 0,
      successRate: 5 / 6,
      maxEvidenceLevel: 3,
      gate: { trials: 9, meanDelta: 0.2, ci95Low: 0.01 },
    },
    failures: [{ mechanism: "unresolved-tool-error" as const, count: 1 }],
  };
  const meta = {
    origin: "wiki-evolution",
    validation: {
      mode: "tasks" as const,
      verdict: "accepted",
      validatedAt: 1_700_000_000_000,
      model: "openai/gpt-x",
      validatedOn: ["openai/gpt-x"],
    },
  };
  const body = "---\nname: s\ndescription: d\n---\nbody";

  it("round-trips unsigned and signed, and the binding covers the profile", async () => {
    const unsigned = parseProvenanceTrailer(
      `${body}\n${buildProvenanceTrailer(meta, undefined, { applicability: profile })}`,
    );
    expect(unsigned?.applicability).toEqual(profile);
    const { generateKeyPair } = await import("../../commerce/envelope.js");
    const key = generateKeyPair();
    const md = `${body}\n${buildProvenanceTrailer(
      meta,
      { skillName: "s", body, key, nodePubkey: "NODEKEY==", now: 1_700_000_001_000 },
      { applicability: profile },
    )}`;
    const parsed = parseProvenanceTrailer(md);
    expect(parsed?.applicability).toEqual(profile);
    expect(parsed?.binding?.nodePubkey).toBe("NODEKEY==");
    // One byte of the profile changed under the signature: no trailer at all.
    const forged = md.replace('"runs":6', '"runs":60');
    expect(forged).not.toBe(md);
    expect(parseProvenanceTrailer(forged)).toBeNull();
  });

  it("a malformed profile drops the profile and keeps the verdict", () => {
    const md = `${body}\n${buildProvenanceTrailer(meta, undefined, {
      applicability: { ...profile, v: 2 } as unknown as typeof profile,
    })}`;
    const parsed = parseProvenanceTrailer(md);
    expect(parsed?.verdict).toBe("accepted");
    expect(parsed?.applicability).toBeUndefined();
  });

  it("a trailer without a profile parses exactly as before", () => {
    const parsed = parseProvenanceTrailer(`${body}\n${buildProvenanceTrailer(meta)}`);
    expect(parsed?.applicability).toBeUndefined();
    expect("applicability" in (parsed ?? {})).toBe(false);
  });
});
