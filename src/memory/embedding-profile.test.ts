import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CHUNKER_VERSION,
  buildEmbeddingProfile,
  compareEmbeddingProfiles,
  digestFromOllama,
  digestOfFile,
  embeddingProfileKey,
  poolProfileFromExecution,
  poolResultParityFailure,
} from "./embedding-profile.js";

const chunking = { tokens: 400, overlap: 80 };
const base = buildEmbeddingProfile({
  provider: "local",
  model: "hf:x/y.gguf",
  chunking,
  modelDigest: "sha256:aaaa",
  dimensions: 768,
});

describe("embedding profile", () => {
  it("builds a local profile with l2 normalisation and the chunker version", () => {
    expect(base).toMatchObject({
      normalise: "l2",
      truncation: "client",
      chunkerVersion: CHUNKER_VERSION,
      dimensions: 768,
    });
    expect(buildEmbeddingProfile({ provider: "openai", model: "m", chunking }).normalise).toBe(
      "provider",
    );
    expect(embeddingProfileKey(base)).toBe("local|hf:x/y.gguf|sha256:aaaa|768|l2|client|400/80|c1");
  });

  it("treats a missing stored profile and unknown fields as compatible", () => {
    expect(compareEmbeddingProfiles(undefined, base)).toEqual({ same: true });
    const noDigest = { ...base, modelDigest: undefined, dimensions: undefined };
    expect(compareEmbeddingProfiles(noDigest, base)).toEqual({ same: true });
    expect(compareEmbeddingProfiles(base, noDigest)).toEqual({ same: true });
  });

  it("classifies a provider or model change as `model` (the automatic reindex path)", () => {
    const cmp = compareEmbeddingProfiles(base, { ...base, model: "other" });
    expect(cmp).toMatchObject({ same: false, kind: "model" });
  });

  it("classifies digest, dimension, normalisation and chunker changes as `parity` (the hold path)", () => {
    for (const change of [
      { modelDigest: "sha256:bbbb" },
      { dimensions: 1024 },
      { normalise: "provider" as const },
      { chunkerVersion: CHUNKER_VERSION + 1 },
    ]) {
      const cmp = compareEmbeddingProfiles(base, { ...base, ...change });
      expect(cmp.same).toBe(false);
      if (!cmp.same) {
        expect(cmp.kind).toBe("parity");
        expect(cmp.conflicts).toHaveLength(1);
      }
    }
  });

  it("hashes a file once and reuses the digest while the fingerprint matches", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-profile-"));
    const file = path.join(dir, "model.gguf");
    fs.writeFileSync(file, "weights");
    try {
      const first = await digestOfFile(file);
      expect(first?.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
      const second = await digestOfFile(file, {
        fingerprint: first!.fingerprint,
        digest: "sha256:cached",
      });
      expect(second?.digest).toBe("sha256:cached");
      const stale = await digestOfFile(file, { fingerprint: "nope", digest: "sha256:cached" });
      expect(stale?.digest).toBe(first!.digest);
      expect(await digestOfFile(path.join(dir, "missing"))).toBeUndefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads the Ollama manifest digest for a model with or without :latest", async () => {
    const fetchImpl = (async (url: string) => {
      expect(url).toBe("http://127.0.0.1:11434/api/tags");
      return {
        ok: true,
        json: async () => ({
          models: [
            { name: "nomic-embed-text:latest", digest: "0a109f422b47" },
            { name: "llama3:8b", digest: "deadbeef" },
          ],
        }),
      };
    }) as unknown as typeof fetch;
    const r = await digestFromOllama({
      baseUrl: "http://127.0.0.1:11434/v1",
      model: "nomic-embed-text",
      fetchImpl,
    });
    expect(r).toEqual({
      digest: "sha256:0a109f422b47",
      fingerprint: "ollama|http://127.0.0.1:11434|nomic-embed-text:latest",
    });
    const failing = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    expect(
      await digestFromOllama({
        baseUrl: "http://127.0.0.1:11434/v1",
        model: "x",
        fetchImpl: failing,
      }),
    ).toBeUndefined();
  });

  it("reads Soapbox execution evidence tolerantly", () => {
    expect(poolProfileFromExecution(null)).toEqual({});
    expect(
      poolProfileFromExecution({
        model: "nomic-embed-text",
        model_digest: "aaaa",
        dimensions: 768,
        truncate: false,
      }),
    ).toEqual({
      model: "nomic-embed-text",
      modelDigest: "sha256:aaaa",
      dimensions: 768,
      truncation: "client",
      normalise: undefined,
    });
  });

  it("refuses a pool result on count, digest, dimension or processing mismatch", () => {
    const vectors = [
      [1, 0, 0],
      [0, 1, 0],
    ];
    const local = { ...base, dimensions: 3 };
    const good = { modelDigest: "sha256:aaaa", dimensions: 3 };
    expect(poolResultParityFailure({ local, remote: good, vectors, expectedCount: 2 })).toBeNull();
    expect(
      poolResultParityFailure({ local, remote: good, vectors, expectedCount: 3 })?.reason,
    ).toBe("count_mismatch");
    expect(
      poolResultParityFailure({
        local,
        remote: { ...good, modelDigest: "sha256:bbbb" },
        vectors,
        expectedCount: 2,
      })?.reason,
    ).toBe("digest_mismatch");
    expect(poolResultParityFailure({ local, remote: {}, vectors, expectedCount: 2 })?.reason).toBe(
      "digest_mismatch",
    );
    expect(
      poolResultParityFailure({
        local: { ...local, dimensions: 4 },
        remote: good,
        vectors,
        expectedCount: 2,
      })?.reason,
    ).toBe("dimension_mismatch");
    expect(
      poolResultParityFailure({
        local,
        remote: good,
        vectors: [
          [1, 0, 0],
          [0, 1],
        ],
        expectedCount: 2,
      })?.reason,
    ).toBe("dimension_mismatch");
    expect(
      poolResultParityFailure({
        local,
        remote: { ...good, truncation: "provider" },
        vectors,
        expectedCount: 2,
      })?.reason,
    ).toBe("processing_mismatch");
    expect(
      poolResultParityFailure({
        local,
        remote: { ...good, normalise: "l2" },
        vectors,
        expectedCount: 2,
      })?.reason,
    ).toBe("processing_mismatch");
    // Local dimensions unknown: nothing can be verified, so nothing is written.
    expect(
      poolResultParityFailure({
        local: { ...local, dimensions: undefined },
        remote: good,
        vectors,
        expectedCount: 2,
      })?.reason,
    ).toBe("dimension_mismatch");
  });
});
