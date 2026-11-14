/** Operator-assisted offline handoff. Does not invoke automatic publication or import qualification. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  PackageSnapshot,
  SkillRelease,
  SkillPackageManifest,
} from "../../../src/agents/skills/collective/contracts.js";
import { root, prior, hash, read, copyJson, write } from "./common.js";
process.env.BITTERBOT_STATE_DIR = path.join(
  root,
  process.argv[2] === "source" ? "source-state" : "state",
);
const [
  { CollectiveSkillStore },
  { verifySnapshot, screenPackage },
  { signRelease, validateRelease },
  { generateKeyPair },
  { learningHash },
] = await Promise.all([
  import("../../../src/agents/skills/collective/store.js"),
  import("../../../src/agents/skills/collective/package.js"),
  import("../../../src/agents/skills/collective/signatures.js"),
  import("../../../src/commerce/envelope.js"),
  import("../../../src/agents/skills/collective/contracts.js"),
]);
type Bundle = {
  release: SkillRelease;
  manifest: SkillPackageManifest;
  files: Array<[string, string]>;
  attribution: { artifact: string; packageHash: string };
};
if (process.argv[2] === "source") {
  const info = await read<{ manifest: SkillPackageManifest; packageHash: string }>(
    path.join(prior, "candidate-package.json"),
  );
  assert.equal(info.packageHash, hash);
  const files = new Map<string, Buffer>();
  for (const f of info.manifest.files)
    files.set(
      f.path,
      await fs.readFile(path.join(prior, "packages/packages", hash, "content", f.path)),
    );
  const snapshot = { ...info, files, omitted: [] };
  verifySnapshot(snapshot);
  screenPackage(snapshot);
  const key = generateKeyPair();
  const release = signRelease(
    {
      protocol: "bitterbot/skill-release/1",
      publisher: "ed25519:" + key.publicKeyHex,
      skillId: info.manifest.name,
      version: 1,
      packageHash: hash,
      requirementsSummary: info.manifest.requirements,
      previousRelease: null,
      parents: [],
      scope: { kind: "private" },
      issuedAt: Date.now(),
    },
    key,
  );
  const bundle: Bundle = {
    release,
    manifest: info.manifest,
    files: [...files].map(([n, b]) => [n, b.toString("base64")]),
    attribution: {
      artifact: "reports/collective-learning/executable-use-20261114-v3/candidate-package.json",
      packageHash: hash,
    },
  };
  await write(path.join(root, "transfer-bundle.json"), bundle);
  await copyJson("source-export.json", {
    pid: process.pid,
    publisher: release.publisher,
    packageHash: hash,
    bundleHash: learningHash(bundle),
    releaseId: learningHash(release),
    files: info.manifest.files,
    method: "operator-assisted offline bundle",
    historicalPublisherClaim: false,
    qualificationExported: false,
    privateModelHistoryExported: false,
    modelCalls: 0,
  });
} else if (process.argv[2] === "recipient") {
  const bytes = await fs.readFile(path.join(root, "transfer-bundle.json"));
  assert(bytes.length < 100000);
  const bundle = JSON.parse(bytes.toString("utf8")) as Bundle;
  const source = await read<{ pid: number; publisher: string; bundleHash: string }>(
    path.join(root, "source-export.json"),
  );
  assert.notEqual(source.pid, process.pid);
  assert.equal(learningHash(bundle), source.bundleHash);
  const release = validateRelease(bundle.release);
  assert.equal(release.publisher, source.publisher);
  assert.equal(release.packageHash, hash);
  const snapshot: PackageSnapshot = {
    packageHash: hash,
    manifest: bundle.manifest,
    files: new Map(bundle.files.map(([n, b]) => [n, Buffer.from(b, "base64")])),
    omitted: [],
  };
  verifySnapshot(snapshot);
  screenPackage(snapshot);
  const tampered = { ...snapshot, files: new Map(snapshot.files) };
  tampered.files.set("helpers/fill_docx.py", Buffer.from("tampered"));
  assert.throws(() => verifySnapshot(tampered));
  assert.throws(() => validateRelease({ ...release, version: 2 }));
  const db = new DatabaseSync(path.join(root, "recipient.sqlite"));
  try {
    const store = new CollectiveSkillStore(db, path.join(root, "recipient-packages"));
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM collective_packages").get()!.n, 0);
    await store.install(snapshot);
    store.addRelease(release);
    store.recordOrigin(hash, { kind: "private" });
    store.audit("operator-authorized-offline-import", hash, {
      source: release.publisher,
      bundleHash: learningHash(bundle),
    });
    assert.equal(store.get(hash)!.state, "candidate");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM collective_receipts").get()!.n, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM collective_active").get()!.n, 0);
    const key = generateKeyPair();
    assert.notEqual(key.publicKeyHex, release.publisher.slice(8));
    await copyJson("recipient-import.json", {
      pid: process.pid,
      sourcePid: source.pid,
      recipient: "ed25519:" + key.publicKeyHex,
      source: release.publisher,
      packageHash: hash,
      manifestUnchanged: true,
      filesVerified: snapshot.files.size,
      localReceiptsImported: 0,
      state: "candidate",
      tamperedFileRejected: true,
      forgedReleaseRejected: true,
      importedAt: Date.now(),
      samePhysicalHost: true,
      transport: "operator-assisted offline; no Circle or mesh publication",
      modelCalls: 0,
    });
    await copyJson("candidate-package.json", { packageHash: hash, manifest: snapshot.manifest });
  } finally {
    db.close();
  }
} else throw new Error("Expected source or recipient");
console.log(JSON.stringify({ operation: process.argv[2], packageHash: hash, modelCalls: 0 }));
