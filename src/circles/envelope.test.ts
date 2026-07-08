import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { generateKeyPair, pubkeyId, signEnvelope, AUBAINE_PROTOCOL } from "../commerce/envelope.js";
import {
  CIRCLE_PROTOCOL,
  CLOCK_SKEW_SECONDS,
  MAILBOX_MAX_AGE_SECONDS,
  MAX_CIRCLE_ENVELOPE_BYTES,
  makeCircleEnvelope,
  signCircleEnvelope,
  validateCircleEnvelope,
  verifyCircleEnvelope,
  type CircleEnvelope,
} from "./envelope.js";

const NOW = 1_700_000_000;

describe("circle/v1 envelope", () => {
  it("signs and verifies a round trip", () => {
    const key = generateKeyPair();
    const env = makeCircleEnvelope("message", "circle-1", { text: "hola" }, key, NOW);
    expect(env.protocol).toBe(CIRCLE_PROTOCOL);
    expect(verifyCircleEnvelope(env)).toBe(true);
    expect(validateCircleEnvelope(env, { now: NOW }).ok).toBe(true);
  });

  it("rejects any tampered field (body, type, circle_id, author, ts)", () => {
    const key = generateKeyPair();
    const env = makeCircleEnvelope("message", "circle-1", { text: "hola" }, key, NOW);
    const tampered: CircleEnvelope[] = [
      { ...env, body: { text: "robada" } },
      { ...env, type: "event" },
      { ...env, circle_id: "circle-2" },
      { ...env, author_pubkey: pubkeyId(generateKeyPair()) },
      { ...env, ts: NOW + 1 },
    ];
    for (const t of tampered) {
      expect(verifyCircleEnvelope(t)).toBe(false);
    }
  });

  it("is domain-separated from aubaine/v1 (cross-protocol signatures never verify)", () => {
    const key = generateKeyPair();
    // Sign the *identical* field set under the aubaine domain prefix, then
    // present it as a circle envelope. Must fail: this is the confusion
    // attack the domain prefix exists to kill.
    const unsigned = {
      protocol: CIRCLE_PROTOCOL,
      type: "message" as const,
      id: crypto.randomUUID(),
      circle_id: "circle-1",
      author_pubkey: pubkeyId(key),
      ts: NOW,
      body: { text: "hola" },
    };
    const aubaineSigned = signEnvelope(
      // aubaine's Envelope shape tolerates extra fields through JCS
      unsigned as never,
      key,
    );
    const forged: CircleEnvelope = { ...unsigned, signature: aubaineSigned.signature };
    expect(verifyCircleEnvelope(forged)).toBe(false);
  });

  it("rejects wrong protocol, missing circle_id, and circle mismatch", () => {
    const key = generateKeyPair();
    const env = makeCircleEnvelope("presence", "circle-1", {}, key, NOW);
    expect(validateCircleEnvelope({ ...env, protocol: AUBAINE_PROTOCOL }, { now: NOW }).ok).toBe(
      false,
    );
    expect(validateCircleEnvelope({ ...env, circle_id: "" }, { now: NOW }).error).toMatch(
      /protocol|circle_id|signature/,
    );
    const mismatch = validateCircleEnvelope(env, { now: NOW, expectedCircleId: "circle-2" });
    expect(mismatch.ok).toBe(false);
    expect(mismatch.error).toMatch(/different circle/);
  });

  it("enforces the tight skew window for direct calls", () => {
    const key = generateKeyPair();
    const env = makeCircleEnvelope("ask", "circle-1", { q: "dentist?" }, key, NOW);
    expect(validateCircleEnvelope(env, { now: NOW + CLOCK_SKEW_SECONDS + 1 }).ok).toBe(false);
    expect(validateCircleEnvelope(env, { now: NOW + CLOCK_SKEW_SECONDS - 1 }).ok).toBe(true);
  });

  it("accepts old mailbox envelopes up to the 30d ceiling and clamps beyond it", () => {
    const key = generateKeyPair();
    const env = makeCircleEnvelope("message", "circle-1", { text: "delayed" }, key, NOW);
    const tenDaysLater = NOW + 10 * 24 * 3600;
    expect(
      validateCircleEnvelope(env, { now: tenDaysLater, maxSkewSeconds: MAILBOX_MAX_AGE_SECONDS })
        .ok,
    ).toBe(true);
    // A caller asking for a wider window than the mailbox TTL gets clamped.
    const fortyDaysLater = NOW + 40 * 24 * 3600;
    expect(
      validateCircleEnvelope(env, {
        now: fortyDaysLater,
        maxSkewSeconds: MAILBOX_MAX_AGE_SECONDS * 10,
      }).ok,
    ).toBe(false);
  });

  it("enforces the size cap and expectedType", () => {
    const key = generateKeyPair();
    const big = makeCircleEnvelope(
      "message",
      "circle-1",
      { text: "x".repeat(MAX_CIRCLE_ENVELOPE_BYTES) },
      key,
      NOW,
    );
    expect(validateCircleEnvelope(big, { now: NOW }).error).toMatch(/size/);
    const env = makeCircleEnvelope("vote", "circle-1", { poll: "p1", choice: 0 }, key, NOW);
    expect(validateCircleEnvelope(env, { now: NOW, expectedType: "poll" }).ok).toBe(false);
    expect(validateCircleEnvelope(env, { now: NOW, expectedType: "vote" }).ok).toBe(true);
  });

  it("rejects unsigned envelopes and malformed signatures", () => {
    const key = generateKeyPair();
    const unsigned = {
      protocol: CIRCLE_PROTOCOL,
      type: "message" as const,
      id: "id-1",
      circle_id: "circle-1",
      author_pubkey: pubkeyId(key),
      ts: NOW,
      body: {},
    };
    expect(verifyCircleEnvelope(unsigned as CircleEnvelope)).toBe(false);
    const signed = signCircleEnvelope(unsigned, key);
    expect(verifyCircleEnvelope({ ...signed, signature: "zz".repeat(64) })).toBe(false);
    expect(verifyCircleEnvelope({ ...signed, signature: "abcd" })).toBe(false);
  });
});
