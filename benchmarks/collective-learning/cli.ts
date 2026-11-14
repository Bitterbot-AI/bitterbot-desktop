import fs from "node:fs/promises";
import { z } from "zod";
import { analyzeStudy, freezeStudy, planSample, type PairedObservation } from "./study.js";

const [action, source, extra] = process.argv.slice(2);
async function read(file: string): Promise<unknown> {
  const stat = await fs.stat(file);
  if (stat.size > 10 * 1024 * 1024) throw new Error("Study input exceeds 10 MiB");
  return JSON.parse(await fs.readFile(file, "utf8"));
}
if (action === "freeze") {
  const frozen = freezeStudy(await read(source));
  if (!extra) throw new Error("Provide a new output path for the frozen manifest");
  await fs.writeFile(extra, JSON.stringify(frozen, null, 2) + "\n", { flag: "wx" });
  process.stdout.write(`${frozen.hash}\n`);
} else if (action === "pilot") {
  const pilot = z
    .object({
      familyDeltas: z.array(z.number().finite()).min(20).max(100000),
      usdPerFamily: z.number().finite().nonnegative(),
      authorizedUsd: z.number().finite().nonnegative(),
    })
    .strict()
    .parse(await read(source));
  process.stdout.write(
    JSON.stringify(
      planSample(pilot.familyDeltas, pilot.usdPerFamily, pilot.authorizedUsd),
      null,
      2,
    ) + "\n",
  );
} else if (action === "analyze") {
  const frozen = (await read(source)) as ReturnType<typeof freezeStudy>;
  if (freezeStudy(frozen.manifest).hash !== frozen.hash)
    throw new Error("Frozen manifest hash mismatch");
  const rows = (await read(extra)) as PairedObservation[];
  if (!Array.isArray(rows) || rows.length > 100000) throw new Error("Invalid study records");
  process.stdout.write(JSON.stringify(analyzeStudy(rows, frozen.manifest), null, 2) + "\n");
} else
  throw new Error(
    "Usage: cli.ts pilot pilot.json | freeze plan.json frozen.json | analyze frozen.json results.json",
  );
