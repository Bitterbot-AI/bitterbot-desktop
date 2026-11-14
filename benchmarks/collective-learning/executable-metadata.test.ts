import { describe, expect, it } from "vitest";
import { normalizeDescription } from "../../research/collective-learning/executable-metadata.js";
import {
  packageHash,
  sha256,
  type PackageSnapshot,
} from "../../src/agents/skills/collective/contracts.js";
function fixture(skill: string): PackageSnapshot {
  const files = new Map([
    ["SKILL.md", Buffer.from(skill)],
    ["helpers/fill.py", Buffer.from("print('unchanged')\n")],
  ]);
  const manifest = {
    schemaVersion: 1 as const,
    name: "docx-placeholder-workflow",
    description: "Fill a bounded template",
    entrypoint: "SKILL.md" as const,
    requirements: { platforms: ["linux"], tools: {}, capabilities: [], runtime: {} },
    files: [...files].map(([name, bytes]) => ({
      path: name,
      hash: sha256(bytes),
      size: bytes.length,
      executable: false,
    })),
  };
  return { manifest, files, packageHash: packageHash(manifest), omitted: [] };
}
describe("description-only package metadata conversion", () => {
  it("changes the full package identity while preserving helper and instruction body", () => {
    const original = fixture(
      "---\nname: docx-placeholder-workflow\n---\n\nFill the supplied template.\n",
    );
    const result = normalizeDescription(original);
    expect(result.snapshot.packageHash).not.toBe(original.packageHash);
    expect(result.snapshot.files.get("helpers/fill.py")).toEqual(
      original.files.get("helpers/fill.py"),
    );
    expect(
      result.snapshot.files
        .get("SKILL.md")!
        .toString()
        .endsWith("---\n\nFill the supplied template.\n"),
    ).toBe(true);
    expect(result.conversion?.instructionBodyUnchanged).toBe(true);
  });
  it("leaves an already valid package unchanged", () => {
    const original = fixture(
      "---\nname: docx-placeholder-workflow\ndescription: Already declared\n---\n\nFill the template.\n",
    );
    expect(normalizeDescription(original)).toEqual({ snapshot: original, conversion: null });
  });
  it("cannot fill missing names or bypass a second blocking issue", () => {
    expect(() =>
      normalizeDescription(fixture("---\nversion: 1\n---\n\nFill the template.\n")),
    ).toThrow();
    expect(() =>
      normalizeDescription(fixture("---\nname: docx-placeholder-workflow\n---\n")),
    ).toThrow();
  });
});
