/** Narrow host metadata conversion. No executable bytes or instruction body may change. */
import assert from "node:assert/strict";
import type { PackageSnapshot } from "../../src/agents/skills/collective/contracts.js";
import { packageHash, sha256 } from "../../src/agents/skills/collective/contracts.js";
import { screenPackage, verifySnapshot } from "../../src/agents/skills/collective/package.js";
import { runSkillGate } from "../../src/agents/skills/skill-gate.js";
export function normalizeDescription(source: PackageSnapshot) {
  verifySnapshot(source);
  const original = source.files.get("SKILL.md")!;
  const text = original.toString("utf8");
  const gate = runSkillGate({ skillName: source.manifest.name, stagedContent: text });
  if (gate.outcome === "pass") return { snapshot: source, conversion: null };
  assert.equal(gate.issues.length, 1);
  assert.equal(gate.issues[0].kind, "missing-field");
  assert.equal(gate.issues[0].detail, 'frontmatter is missing required field "description"');
  assert(
    text.startsWith("---\n") && !/\r/.test(text),
    "Only the observed LF frontmatter format is supported",
  );
  const end = text.indexOf("\n---", 4);
  assert(end > 0);
  assert(!/^description\s*:/m.test(text.slice(4, end)), "Never overwrite a declared description");
  const normalized = Buffer.from(
    "---\ndescription: " + JSON.stringify(source.manifest.description) + "\n" + text.slice(4),
  );
  const files = new Map(source.files);
  files.set("SKILL.md", normalized);
  const manifest = {
    ...source.manifest,
    files: source.manifest.files.map((file) =>
      file.path === "SKILL.md"
        ? { ...file, hash: sha256(normalized), size: normalized.length }
        : file,
    ),
  };
  const snapshot = { ...source, manifest, files, packageHash: packageHash(manifest) };
  const normalizedText = normalized.toString("utf8"),
    normalizedEnd = normalizedText.indexOf("\n---", 4);
  assert.equal(normalizedText.slice(normalizedEnd), text.slice(end), "Instruction body changed");
  for (const [name, bytes] of source.files)
    if (name !== "SKILL.md") assert(bytes.equals(snapshot.files.get(name)!));
  screenPackage(snapshot);
  return {
    snapshot,
    conversion: {
      type: "declared-description-frontmatter",
      originalPackageHash: source.packageHash,
      convertedPackageHash: snapshot.packageHash,
      originalSkillHash: sha256(original),
      convertedSkillHash: sha256(normalized),
      description: source.manifest.description,
      executableBytesUnchanged: true,
      instructionBodyUnchanged: true,
      sourceQualificationInherited: false,
    },
  };
}
