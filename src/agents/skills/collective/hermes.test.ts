import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sha256 } from "./contracts.js";
import {
  HERMES_CONTRACT_PIN,
  exportHermesDirectory,
  importHermesDirectory,
  importHermesTrace,
} from "./hermes.js";
import { snapshotPackage } from "./package.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-package-"));
  roots.push(root);
  const source = path.join(root, "source");
  await fs.cp(path.resolve("test/fixtures/collective-learning/hermes"), source, {
    recursive: true,
  });
  return { root, source };
}
describe("pinned Hermes interoperability", () => {
  it("exports portable native packages and refuses to drop runtime constraints", async () => {
    const f = await fixture();
    await fs.unlink(path.join(f.source, "skill.manifest.json"));
    const native = await snapshotPackage(f.source, {
      name: "hermes-fixture",
      description: "Portable test procedure.",
      requirements: {
        platforms: ["linux"],
        tools: { python3: "3" },
        capabilities: ["shell"],
        runtime: {},
      },
    });
    const destination = path.join(f.root, "native-export");
    expect((await exportHermesDirectory(native, destination)).generatedManifest).toBe(true);
    const converted = await importHermesDirectory(destination);
    for (const [file, bytes] of native.files)
      expect(converted.snapshot.files.get(file)?.equals(bytes)).toBe(true);
    expect(converted.snapshot.manifest.requirements.tools).toEqual({ python3: "3" });
    const unsupported = await snapshotPackage(f.source, {
      ...native.manifest,
      requirements: { ...native.manifest.requirements, runtime: { "bitterbot-hook": "1" } },
    });
    await expect(
      exportHermesDirectory(unsupported, path.join(f.root, "unsupported")),
    ).rejects.toThrow("runtime:bitterbot-hook");
  });
  it("round-trips complete exact bytes and keeps the original hash separate", async () => {
    const f = await fixture(),
      imported = await importHermesDirectory(f.source);
    expect(HERMES_CONTRACT_PIN.pluginCommit).toBe("c443c14dbbf3c8a4d90d613a0456911e087e30a7");
    const canonical = imported.snapshot.manifest.files
      .map((file) => `${file.path} ${file.executable ? "exec" : "file"} sha256:${file.hash}\n`)
      .toSorted()
      .join("");
    expect(imported.report.sourceHash).toBe(`sha256:${sha256(canonical)}`);
    expect(imported.report.sourceHash).not.toBe(`sha256:${imported.report.convertedHash}`);
    const target = path.join(f.root, "export");
    await exportHermesDirectory(imported.snapshot, target);
    const roundtrip = await importHermesDirectory(target);
    expect(roundtrip.report.sourceHash).toBe(imported.report.sourceHash);
    for (const [file, bytes] of imported.snapshot.files)
      expect((await fs.readFile(path.join(target, file))).equals(bytes)).toBe(true);
    expect(roundtrip.snapshot.files.get("SKILL.md")?.toString()).toContain("author: Bitterbot");
  });
  it("retains unsupported requirements and setup commands without executing them", async () => {
    const f = await fixture();
    const manifest = JSON.parse(
      await fs.readFile(path.join(f.source, "skill.manifest.json"), "utf8"),
    );
    manifest.requirements.credentials = ["provider-token"];
    manifest.requirements.tools = [
      { name: "custom-tool", minimum_version: null, requires_admin: true },
    ];
    await fs.writeFile(path.join(f.source, "skill.manifest.json"), JSON.stringify(manifest));
    await fs.writeFile(path.join(f.source, "setup.sh"), "touch SHOULD_NOT_EXIST\n");
    const result = await importHermesDirectory(f.source);
    expect(result.report.compatible).toBe(false);
    expect(result.report.issues.join(" ")).toMatch(/credentials.*Administrative.*Unpinned.*Setup/);
    expect(result.snapshot.files.has("setup.sh")).toBe(true);
    expect(await fs.stat(path.join(f.source, "SHOULD_NOT_EXIST")).catch(() => null)).toBeNull();
  });
  it("keeps unverified traces separate and strips raw tool arguments and feedback", () => {
    const trace = importHermesTrace(
      JSON.stringify([
        {
          role: "assistant",
          tool_calls: [
            {
              id: "call-1",
              type: "function",
              function: { name: "fetch", arguments: "private document" },
            },
          ],
        },
        { role: "tool", tool_call_id: "call-1", content: "private result" },
        { role: "user", content: "reported success" },
      ]),
      "task",
      "source-version",
    );
    expect(trace.evidence).toBe("unverified");
    expect(trace.costs).toBeNull();
    expect(trace.actions[0].resultHash).toHaveLength(64);
    expect(JSON.stringify(trace)).not.toContain("private");
    expect(() =>
      importHermesTrace(
        '[{"role":"tool","tool_call_id":"invented","content":"pass"}]',
        "task",
        "version",
      ),
    ).toThrow("Unmatched");
  });
});
