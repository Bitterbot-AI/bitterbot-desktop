import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseGenomeTemperament, parsePhenotypeConstraints } from "../memory/genome-parser.js";
import { genomeFileOf, withGenomeGuard } from "./genome-guard.js";
import {
  addTemperament,
  applySetupVibe,
  readTemperamentStatus,
  setTemperamentLevel,
  templateTemperamentSection,
  writeGenomeAsOwner,
} from "./genome-temperament.js";

const OLD_GENOME = [
  "# Genome",
  "",
  "## Safety Axioms",
  "",
  "- Never exfiltrate private data",
  "",
  "## Phenotype Constraints",
  "",
  "- Maintain honesty",
  "",
  "## Core Values",
  "",
  "- Earn trust through competence",
  "",
].join("\n");

let dir: string;
let workspace: string;
let savedStateDir: string | undefined;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "bb-temperament-"));
  workspace = path.join(dir, "workspace");
  await fs.mkdir(workspace);
  savedStateDir = process.env.BITTERBOT_STATE_DIR;
  process.env.BITTERBOT_STATE_DIR = path.join(dir, "state");
});

afterEach(async () => {
  if (savedStateDir === undefined) {
    delete process.env.BITTERBOT_STATE_DIR;
  } else {
    process.env.BITTERBOT_STATE_DIR = savedStateDir;
  }
  await fs.rm(dir, { recursive: true, force: true });
});

const genome = () => fs.readFile(genomeFileOf(workspace), "utf-8");
const backups = async () =>
  (await fs.readdir(path.join(dir, "state", "genome-guard")).catch(() => [])).filter((f) =>
    f.startsWith("owner-previous-"),
  );

describe("the Temperament offer for an existing agent", () => {
  it("shows the section that would be added, without writing anything", async () => {
    await fs.writeFile(genomeFileOf(workspace), OLD_GENOME);
    const status = await readTemperamentStatus(workspace, { previewLevel: "playful" });
    expect(status).toMatchObject({ genomeExists: true, present: false });
    expect(status.preview).toMatch(/^## Temperament\n/);
    expect(status.preview).toContain("level: playful");
    expect(await genome()).toBe(OLD_GENOME);
    expect(await backups()).toEqual([]);
  });

  it("adds only the Temperament section and backs up the previous Genome", async () => {
    await fs.writeFile(genomeFileOf(workspace), OLD_GENOME);
    const result = await addTemperament(workspace, "calm");
    expect(result.changed).toBe(true);
    expect(result.status).toMatchObject({ present: true, level: "calm" });
    const after = await genome();
    expect(after.startsWith(OLD_GENOME.trimEnd())).toBe(true);
    expect(after.slice(OLD_GENOME.trimEnd().length)).toBe(
      `\n\n${await templateTemperamentSection("calm")}\n`,
    );
    expect(parsePhenotypeConstraints(after)).toEqual(["Maintain honesty"]);
    expect(await fs.readFile(result.backupPath!, "utf-8")).toBe(OLD_GENOME);
    expect(await backups()).toHaveLength(1);

    // Adding again changes nothing.
    const again = await addTemperament(workspace, "irreverent");
    expect(again.changed).toBe(false);
    expect(await genome()).toBe(after);
  });

  it("changes the level of an existing section and refuses one that is missing", async () => {
    await fs.writeFile(genomeFileOf(workspace), OLD_GENOME);
    await expect(setTemperamentLevel(workspace, "calm")).rejects.toThrow(/--add/);
    await addTemperament(workspace);
    expect(parseGenomeTemperament(await genome())?.level).toBe("irreverent");
    const result = await setTemperamentLevel(workspace, "playful");
    expect(result).toMatchObject({ changed: true, status: { level: "playful" } });
    expect(parseGenomeTemperament(await genome())?.level).toBe("playful");
    expect((await setTemperamentLevel(workspace, "playful")).changed).toBe(false);
  });

  it("says when there is no Genome at all", async () => {
    expect((await readTemperamentStatus(workspace)).genomeExists).toBe(false);
    await expect(addTemperament(workspace)).rejects.toThrow(/No GENOME.md/);
  });

  it("an owner write is kept by the guard even with a tool call in flight", async () => {
    await fs.writeFile(genomeFileOf(workspace), OLD_GENOME);
    const file = genomeFileOf(workspace);
    const { undone } = await withGenomeGuard([file], "test", async () => {
      await writeGenomeAsOwner(file, OLD_GENOME, `${OLD_GENOME}\n## Temperament\n\nlevel: calm\n`);
    });
    expect(undone).toBe(false);
    expect(parseGenomeTemperament(await genome())?.level).toBe("calm");
  });
});

describe("setup's vibe pick", () => {
  it("sets the level of a fresh workspace's Genome", async () => {
    const { ensureAgentWorkspace } = await import("./workspace.js");
    await ensureAgentWorkspace({ dir: workspace, ensureBootstrapFiles: true });
    expect(parseGenomeTemperament(await genome())?.level).toBe("irreverent");
    expect(await applySetupVibe(workspace, "calm")).toBe("set");
    expect(parseGenomeTemperament(await genome())?.level).toBe("calm");
    expect(await applySetupVibe(workspace, "calm")).toBe("unchanged");
  });

  it("never rewrites a Genome that predates the section", async () => {
    await fs.writeFile(genomeFileOf(workspace), OLD_GENOME);
    expect(await applySetupVibe(workspace, "calm")).toBe("missing");
    expect(await genome()).toBe(OLD_GENOME);
  });
});
