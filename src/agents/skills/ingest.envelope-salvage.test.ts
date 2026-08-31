import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BitterbotConfig } from "../../config/config.js";
import { listIncomingSkills, parseEnvelopeJson } from "./ingest.js";

const ENVELOPE = {
  version: 1,
  skill_md: Buffer.from(
    "---\nname: test-crystal\ndescription: Dream-generated skill crystal\n---\nbody",
  ).toString("base64"),
  name: "test-crystal",
  author_peer_id: "12D3KooWTestPeer",
  author_pubkey: "AAAA",
  signature: "BBBB",
  timestamp: 1700000000000,
  content_hash: "cafe",
};

describe("parseEnvelopeJson salvage (concurrent-write corruption)", () => {
  it("parses clean envelopes normally", () => {
    const parsed = parseEnvelopeJson(JSON.stringify(ENVELOPE, null, 2));
    expect(parsed?.name).toBe("test-crystal");
  });

  it("salvages the live corruption shape: valid JSON + trailing garbage", () => {
    // Exactly the on-disk shape found on the pilot node: a complete object
    // with the tail of an older, longer write appended past its EOF.
    const corrupt = `${JSON.stringify(ENVELOPE, null, 2)}se\n}`;
    const parsed = parseEnvelopeJson(corrupt);
    expect(parsed?.name).toBe("test-crystal");
    expect(parsed?.author_peer_id).toBe("12D3KooWTestPeer");
    const corrupt2 = `${JSON.stringify(ENVELOPE, null, 2)}ed": false\n}`;
    expect(parseEnvelopeJson(corrupt2)?.name).toBe("test-crystal");
  });

  it("handles braces inside strings and rejects truly broken files", () => {
    const tricky = { ...ENVELOPE, name: 'has "quo}tes" and {braces}' };
    const parsed = parseEnvelopeJson(`${JSON.stringify(tricky)}GARBAGE}`);
    expect(parsed?.name).toBe('has "quo}tes" and {braces}');
    expect(parseEnvelopeJson("{ definitely not json")).toBeUndefined();
    expect(parseEnvelopeJson("")).toBeUndefined();
  });
});

describe("listIncomingSkills with corrupt envelopes", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ingest-salvage-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("classifies a garbage-tailed envelope by its salvaged content, not as incomplete", async () => {
    const dir = path.join(tmpDir, "test-crystal");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, ".envelope.json"),
      `${JSON.stringify(ENVELOPE, null, 2)}se\n}`,
      "utf-8",
    );
    await fs.writeFile(
      path.join(dir, "SKILL.md"),
      "---\nname: test-crystal\ndescription: Dream-generated skill crystal\n---\nbody",
      "utf-8",
    );
    const config = { skills: { p2p: { quarantineDir: tmpDir } } } as unknown as BitterbotConfig;
    const skills = await listIncomingSkills(config);
    expect(skills).toHaveLength(1);
    expect(skills[0]?.origin).not.toBe("incomplete");
    expect(skills[0]?.author_peer_id).toBe("12D3KooWTestPeer");
  });
});
