/** Unpaid integration qualification of the exact Docker bridge used by task runs. */
import fs from "node:fs/promises";
import path from "node:path";
import { learningHash, sha256 } from "../../src/agents/skills/collective/contracts.js";
import {
  CHECKER_FILES,
  PRACTICAL_ROOT,
  checkPractical,
  practicalCases,
  practicalProtocol,
} from "./practical-learning.js";

const runtime = JSON.parse(
  await fs.readFile(path.join(PRACTICAL_ROOT, "runtime.json"), "utf8"),
) as { id: string };
const cases = await practicalCases();
const records = [];
for (const item of cases) {
  const protocol = await practicalProtocol([item], runtime.id);
  const files = await Promise.all(
    protocol.artifacts!.files.map(async (file) => {
      const bytes = await fs.readFile(path.join(PRACTICAL_ROOT, "witnesses", item.id, file.name));
      return { name: file.name, bytes, sha256: sha256(bytes) };
    }),
  );
  const started = Date.now();
  const grade = await checkPractical(item, files, runtime.id, new AbortController().signal);
  records.push({
    id: item.id,
    grade,
    elapsedMs: Date.now() - started,
    outputs: files.map((f) => ({ name: f.name, sha256: f.sha256, bytes: f.bytes.length })),
  });
  console.log(JSON.stringify({ id: item.id, ...grade }));
}
const checkerSources = Object.fromEntries(
  await Promise.all(
    CHECKER_FILES.map(async (file) => [
      file,
      sha256(await fs.readFile(path.join(PRACTICAL_ROOT, file))),
    ]),
  ),
);
const body = {
  schemaVersion: 1,
  createdAt: new Date().toISOString(),
  modelCalls: 0,
  image: runtime.id,
  casesHash: learningHash(cases),
  checkerSources,
  records,
};
await fs.writeFile(
  path.join(PRACTICAL_ROOT, "bridge-qualification.json"),
  JSON.stringify({ ...body, hash: learningHash(body) }, null, 2) + "\n",
);
console.log(
  JSON.stringify({
    cases: records.length,
    passed: records.filter((r) => r.grade.status === "pass").length,
  }),
);
if (records.some((r) => r.grade.status !== "pass")) process.exitCode = 1;
