import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import type { BitterbotConfig } from "../../../src/config/config.js";
import {
  repo,
  root,
  prior,
  suite,
  exported,
  hash,
  cap,
  settings,
  exec,
  read,
  write,
  copyJson,
  sources,
  sha256,
} from "./common.js";
assert.equal(process.platform, "linux");
const { learningHash } = await import("../../../src/agents/skills/collective/contracts.js");
const { compatibilityIssues } =
  await import("../../../src/agents/skills/collective/compatibility.js");
await fs.mkdir(root, { mode: 0o700 });
const predecessorRoot =
  "/home/vicmg/.local/share/bitterbot-studies/executable-transfer-20261114-v1";
const predecessor = await read<{
  qualified: boolean;
  budget: { knownUsd: number; heldUsd: number };
}>(path.join(predecessorRoot, "validate.json"));
assert(
  !predecessor.qualified && predecessor.budget.knownUsd === 0 && predecessor.budget.heldUsd === 0,
);
for (const platform of ["windows", "linux"]) {
  const audit = await read<{ allAgreed: boolean; checks: number }>(
    path.join(exported, "checker-" + platform + ".json"),
  );
  assert(audit.allAgreed && audit.checks === 72);
  const controlAudit = await read<{ allPassed: boolean; cases: number }>(
    path.join(exported, "control-" + platform + ".json"),
  );
  assert(controlAudit.allPassed && controlAudit.cases === 12);
}
const before = await read<{
  budget: { cumulativeKnownUsd: number; priorReserveUsd: number; remainingUsd: number };
}>(path.join(prior, "comparison-readout.json"));
assert.equal(before.budget.remainingUsd, 101.066537);
const config = await read<BitterbotConfig>(path.join(prior, "state/bitterbot.json"));
const template = config.agents!.list![0],
  sourceAgent = template.agentDir!;
const agentDir = path.join(root, "state/agents/recipient/agent"),
  workspace = path.join(root, "state/workspaces/recipient");
await fs.mkdir(agentDir, { recursive: true, mode: 0o700 });
await fs.mkdir(workspace, { recursive: true, mode: 0o700 });
config.agents!.list = [{ ...template, id: "recipient", agentDir, workspace }];
config.skills!.collective!.budget = cap;
for (const name of ["auth-profiles.json", "auth.json", "models.json"]) {
  const file = path.join(sourceAgent, name),
    stat = await fs.lstat(file).catch(() => null);
  if (!stat) continue;
  assert(
    stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size < 4 * 1024 * 1024,
  );
  await fs.writeFile(path.join(agentDir, name), await fs.readFile(file), {
    flag: "wx",
    mode: 0o600,
  });
}
await write(path.join(root, "state/bitterbot.json"), config);
for (const operation of ["source", "recipient"]) {
  const result = await exec(
    process.execPath,
    ["--import", "tsx", path.join(suite, "transfer.ts"), operation],
    { timeout: 120000, maxBuffer: 4000 },
  );
  console.log(result.stdout.trim());
}
const candidate = await read<{
  manifest: import("../../../src/agents/skills/collective/contracts.js").SkillPackageManifest;
}>(path.join(root, "candidate-package.json"));
const image = candidate.manifest.requirements.runtime.image;
const imageInfo = JSON.parse(
  (await exec("docker", ["image", "inspect", image], { maxBuffer: 1024 * 1024 })).stdout,
)[0];
assert.equal(imageInfo.Id, image);
const probe = await exec(
  "docker",
  [
    "run",
    "--rm",
    "--pull",
    "never",
    "--network",
    "none",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--memory",
    settings.memory,
    "--cpus",
    String(settings.cpus),
    "--env",
    "TZ=" + settings.env.TZ,
    "--env",
    "LANG=" + settings.env.LANG,
    "--entrypoint",
    "python3",
    image,
    "-I",
    "-c",
    'import json,platform,docx,os; print(json.dumps(dict(python=platform.python_version(),docx=docx.__version__,timezone=os.environ.get("TZ"),locale=os.environ.get("LANG"))))',
  ],
  { timeout: 60000 },
);
const environment = {
  model: config.skills!.collective!.validationModel!,
  tools: { python3: "3", read: "1", write: "1", exec: "1" },
  runtime: {
    platform: "linux",
    image,
    cpus: String(settings.cpus),
    memory: settings.memory,
    ...JSON.parse(probe.stdout),
  },
  checkerHash: learningHash(
    Object.fromEntries(
      await Promise.all(
        ["checker.py", "oracle/check_offer.py", "oracle/check_common.py"].map(async (name) => [
          name,
          sha256(await fs.readFile(path.join(suite, name))),
        ]),
      ),
    ),
  ),
};
assert.deepEqual(compatibilityIssues(candidate.manifest, environment), []);
const drift = compatibilityIssues(candidate.manifest, {
  ...environment,
  runtime: { ...environment.runtime, image: "different-runtime" },
});
assert(drift.some((v) => v.startsWith("runtime-unavailable:image:")));
await copyJson("environment.json", {
  environment,
  settings,
  changedFromSource: {
    cpus: "1 -> 0.75",
    memory: "512m -> 384m",
    timezone: "explicit America/Toronto",
  },
  runtimeMismatchBlocked: drift,
  pinnedImageUnchanged: true,
  independentPhysicalMachine: false,
  pairedRemoteNodes: 0,
});
const contract = (
  await read<{ publicDocxContractForNextRepair: unknown }>(
    path.join(repo, "research/collective-learning/next-wins-plan.json"),
  )
).publicDocxContractForNextRepair;
const pinned = await sources();
await fs.writeFile(path.join(root, "source-files.txt"), Object.keys(pinned).join("\n") + "\n", {
  flag: "wx",
});
await exec(
  "tar",
  [
    "-czf",
    path.join(root, "execution-source.tar.gz"),
    "-C",
    repo,
    "-T",
    path.join(root, "source-files.txt"),
  ],
  { timeout: 120000 },
);
const recipient = await read<{ importedAt: number }>(path.join(root, "recipient-import.json"));
const body = {
  schemaVersion: 1,
  predecessor: {
    root: predecessorRoot,
    qualificationPassed: false,
    newModelChargesUsd: 0,
    reason:
      "Host control emitted KeyError tracebacks rejected by the stricter diagnostic gate. Frozen outcome preserved; host control now emits a clear missing-field diagnostic. Package unchanged; new fixture identities.",
  },
  createdAt: new Date().toISOString(),
  sources: pinned,
  image,
  configHash: learningHash(config),
  packageHash: hash,
  model: environment.model,
  environment,
  settings,
  contract,
  cap,
  quote: { providerUsd: 7.2, toolCalls: 21, wallMs: 450000 },
  inherited: {
    knownUsd: before.budget.cumulativeKnownUsd,
    reserveUsd: before.budget.priorReserveUsd,
    remainingUsd: before.budget.remainingUsd,
  },
  archiveHash: sha256(await fs.readFile(path.join(root, "execution-source.tar.gz"))),
  retentionNotBefore: recipient.importedAt + 86400000,
  design: {
    authorization:
      "User said proceed after the transfer/retention proposal. $20 maximum new work within existing $250 authority.",
    qualification:
      "Six fresh valid and six invalid recipient cases plus 12 original regression cases; control and unchanged helper must both pass before paid work.",
    evaluation:
      "Twelve paired fresh cases across three document genres; same bounded DOCX mechanism. Alternate arm order, equal model/tools/configuration. No forced helper read.",
    primary:
      "At least 50% lower provider cost per verified completion with zero new paired failures, all 12 pairs complete and verified helper use in all 12 learned runs. Baseline perfection is not required.",
    retention:
      "Six new learned-arm cases in a new recipient process, no earlier than 24 hours after import. No timed result is inferred before that deadline.",
    accounting:
      "All arms share StudyLedger condition local; charge once; unknown costs retain full reservations and stop admissions. Source learning costs remain $3.07113425 known plus $14.40 unresolved holds. No new learning generation.",
    scope:
      "Operator-assisted signed offline package handoff to isolated recipient processes, same physical host, changed resource/timezone settings but same pinned dependency image. No automatic Circle distribution, production promotion or pooled-evidence claim.",
  },
};
await copyJson("frozen.json", { ...body, hash: learningHash(body) });
console.log(
  JSON.stringify({
    prepared: true,
    hash: learningHash(body),
    modelCalls: 0,
    cap,
    retentionNotBefore: new Date(body.retentionNotBefore).toISOString(),
  }),
);
