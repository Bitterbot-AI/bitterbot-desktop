import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import {
  copyInputs,
  inputHashes,
  gradeOutput,
} from "../../../benchmarks/collective-learning/executable-runtime.js";
import { hash, sha256 } from "./common.js";
import { dockerPython } from "./runtime.js";
import {
  root,
  suite,
  fixtures,
  packages,
  frozen,
  read,
  write,
  copyJson,
  budget,
  abort,
  db,
} from "./study.js";
const lock = await fs.open(path.join(root, "run.lock"), "wx", 0o600);
try {
  const records = [];
  for (const arm of ["control", "candidate"])
    for (const f of fixtures.filter((f) =>
      ["qualification", "qualification-invalid", "regression"].includes(f.partition),
    )) {
      const runRoot = path.join(root, "runs", arm, f.id),
        recordFile = path.join(runRoot, "record.json");
      const old = await read<Record<string, unknown>>(recordFile).catch(() => null);
      if (old) {
        records.push(old);
        continue;
      }
      await fs.mkdir(runRoot, { recursive: true });
      await copyInputs(f.directory, path.join(runRoot, "inputs"));
      await fs.mkdir(path.join(runRoot, "output"));
      const before = await inputHashes(path.join(runRoot, "inputs"));
      const directory = arm === "control" ? suite : path.join(packages.directory(hash), "content");
      const entry = arm === "control" ? "deterministic_control.py" : "helpers/fill_docx.py";
      const result = await dockerPython(
        frozen.image,
        [
          {
            source: arm === "control" ? path.join(directory, entry) : directory,
            target: arm === "control" ? "/program.py" : "/skill",
          },
          { source: path.join(runRoot, "inputs"), target: "/inputs" },
          { source: path.join(runRoot, "output"), target: "/output", write: true },
        ],
        [
          arm === "control" ? "/program.py" : "/skill/" + entry,
          "--template",
          "/inputs/offer_letter_template.docx",
          "--data",
          "/inputs/employee_data.json",
          "--output",
          "/output/offer_letter_filled.docx",
        ],
        abort.signal,
      );
      assert.deepEqual(await inputHashes(path.join(runRoot, "inputs")), before);
      await packages.read(hash);
      assert(
        ![124, 125, 126, 127, 137, 143].includes(result.exitCode),
        "Infrastructure, not task result",
      );
      const output = path.join(runRoot, "output/offer_letter_filled.docx");
      const rejected =
        result.exitCode !== 0 &&
        (result.stdout + result.stderr).includes(f.missing ?? "") &&
        !/Traceback \(most recent call last\)/.test(result.stderr);
      const checked = f.missing
        ? {
            grade: {
              status: rejected ? "pass" : "task-failure",
              issues: rejected ? [] : ["missing-requirement-not-rejected"],
              details: { missing: f.missing },
            },
            wallMs: 0,
          }
        : await gradeOutput(frozen.image, suite, f.directory, output, abort.signal);
      assert.notEqual(checked.grade.status, "checker-invalid");
      if (result.exitCode !== 0 && !f.missing) {
        checked.grade.status = "task-failure";
        checked.grade.issues.push("helper-nonzero-exit");
      }
      const record = {
        arm,
        caseId: f.id,
        partition: f.partition,
        packageHash: arm === "candidate" ? hash : null,
        helperHash: sha256(await fs.readFile(path.join(directory, entry))),
        inputHashes: before,
        outputHash: await fs
          .readFile(output)
          .then(sha256)
          .catch(() => null),
        ...result,
        grade: checked.grade,
        checkerWallMs: checked.wallMs,
      };
      await write(recordFile, record);
      records.push(record);
      console.log(JSON.stringify({ arm, caseId: f.id, status: checked.grade.status }));
    }
  const qualified = records.every((r) => (r.grade as { status: string }).status === "pass");
  await copyJson("validate.json", {
    records,
    qualified,
    packageHash: hash,
    budget: budget(),
    modelCalls: 0,
    qualificationScope: "study-only; no activation or lifecycle state promotion",
  });
  assert(qualified, "Recipient qualification failed; no paid comparison");
} finally {
  await lock.close();
  await fs.unlink(path.join(root, "run.lock"));
  db.close();
}
