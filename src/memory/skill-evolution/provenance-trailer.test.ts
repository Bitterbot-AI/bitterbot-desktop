/**
 * PLAN-45 Phase 0: the provenance trailer is evidence only when it parses
 * into an accepted, dated record. The marker text alone is not evidence.
 */

import { describe, expect, it } from "vitest";
import type { EvolutionMeta } from "./validation-gate.js";
import {
  buildProvenanceTrailer,
  parseProvenanceTrailer,
  PROVENANCE_TRAILER_MARKER,
  buildRetractionStub,
  parseRetractionTrailer,
  RETRACTION_TRAILER_MARKER,
} from "./provenance-trailer.js";

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
