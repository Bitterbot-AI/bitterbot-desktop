import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  expandEvidenceRef,
  parseEvidenceRefs,
  tokenSupportScore,
  verifyAgainstEvidence,
} from "./evidence-expand.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "evidence-expand-"));
});
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function writeSession(lines: Array<{ role: "user" | "assistant"; text: string }>): string {
  const p = path.join(tmpDir, "session.jsonl");
  const jsonl = lines
    .map((l) => JSON.stringify({ type: "message", message: { role: l.role, content: l.text } }))
    .join("\n");
  writeFileSync(p, jsonl, "utf-8");
  return p;
}

describe("parseEvidenceRefs", () => {
  it("parses well-formed session and journal refs, drops garbage", () => {
    const raw = JSON.stringify([
      { kind: "session", path: "/s.jsonl", line: 3 },
      { kind: "journal", runId: "run-1", seq: 42 },
      { kind: "session", path: "/s.jsonl" }, // missing line
      { kind: "bogus" },
      null,
      7,
    ]);
    expect(parseEvidenceRefs(raw)).toEqual([
      { kind: "session", path: "/s.jsonl", line: 3 },
      { kind: "journal", runId: "run-1", seq: 42 },
    ]);
  });
  it("tolerates null / malformed JSON", () => {
    expect(parseEvidenceRefs(null)).toEqual([]);
    expect(parseEvidenceRefs("not json")).toEqual([]);
    expect(parseEvidenceRefs("{}")).toEqual([]);
  });
});

describe("tokenSupportScore", () => {
  it("scores a fully grounded claim at 1", () => {
    expect(tokenSupportScore("Postgres port 5432", "we set Postgres port 5432 today")).toBe(1);
  });
  it("flags paraphrase drift with a low score", () => {
    // None of the salient claim tokens appear in the evidence.
    expect(
      tokenSupportScore("deployed to Frankfurt region", "the server lives in Singapore"),
    ).toBeLessThan(0.5);
  });
  it("treats a claim with no content tokens as grounded", () => {
    expect(tokenSupportScore("the a of to", "anything")).toBe(1);
  });
});

describe("expandEvidenceRef — session", () => {
  it("round-trips a session line back to verbatim source", async () => {
    const p = writeSession([
      { role: "user", text: "alpha question" },
      { role: "assistant", text: "beta answer" },
      { role: "user", text: "gamma followup" },
    ]);
    // Built content lines: 1='User: alpha question', 2='Assistant: beta answer', 3='User: gamma followup'
    const res = await expandEvidenceRef({ kind: "session", path: p, line: 2 }, 0);
    expect(res.found).toBe(true);
    expect(res.text).toBe("Assistant: beta answer");
    expect(res.location).toContain("#L2-L2");
  });

  it("returns a context window around the cited line", async () => {
    const p = writeSession([
      { role: "user", text: "one" },
      { role: "assistant", text: "two" },
      { role: "user", text: "three" },
      { role: "assistant", text: "four" },
    ]);
    const res = await expandEvidenceRef({ kind: "session", path: p, line: 3 }, 1);
    expect(res.found).toBe(true);
    expect(res.text).toBe("Assistant: two\nUser: three\nAssistant: four");
  });

  it("degrades gracefully on a missing file or out-of-range line", async () => {
    const missing = await expandEvidenceRef(
      { kind: "session", path: path.join(tmpDir, "nope.jsonl"), line: 1 },
      0,
    );
    expect(missing.found).toBe(false);

    const p = writeSession([{ role: "user", text: "only one" }]);
    const oob = await expandEvidenceRef({ kind: "session", path: p, line: 99 }, 0);
    expect(oob.found).toBe(false);
  });
});

describe("expandEvidenceRef — journal", () => {
  it("returns not-found when no journal is active", async () => {
    const res = await expandEvidenceRef({ kind: "journal", runId: "run-x", seq: 1 });
    expect(res.found).toBe(false);
  });
});

describe("verifyAgainstEvidence (faithfulness)", () => {
  it("does not block when there are no refs", async () => {
    const v = await verifyAgainstEvidence([], "anything");
    expect(v).toEqual({ supported: true, score: 1, evidenceFound: false });
  });

  it("does not block when refs cannot resolve", async () => {
    const v = await verifyAgainstEvidence(
      [{ kind: "session", path: path.join(tmpDir, "gone.jsonl"), line: 1 }],
      "claim",
    );
    expect(v.evidenceFound).toBe(false);
    expect(v.supported).toBe(true);
  });

  it("supports a grounded rewrite and rejects a drifted one", async () => {
    const p = writeSession([
      { role: "user", text: "the database is Postgres version 16 on port 5432" },
    ]);
    const refs = [{ kind: "session" as const, path: p, line: 1 }];

    const grounded = await verifyAgainstEvidence(refs, "Postgres 16 listens on port 5432");
    expect(grounded.evidenceFound).toBe(true);
    expect(grounded.supported).toBe(true);

    const drifted = await verifyAgainstEvidence(refs, "the cache is Redis on a Frankfurt host");
    expect(drifted.evidenceFound).toBe(true);
    expect(drifted.supported).toBe(false);
  });
});
