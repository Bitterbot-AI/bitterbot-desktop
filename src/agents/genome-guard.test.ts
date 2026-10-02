import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AnyAgentTool } from "./agent-tools.types.js";
import {
  GENOME_READ_ONLY_MESSAGE,
  GENOME_RESTORED_NOTICE,
  genomeWriteRefusal,
  targetsGenome,
  wrapToolWithGenomeGuard,
} from "./genome-guard.js";

const ORIGINAL = "# GENOME\n\n- Never deceive the user.\n";

let workspace = "";
let stateDir = "";
let previousStateDir: string | undefined;

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "genome-guard-ws-"));
  stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "genome-guard-state-"));
  previousStateDir = process.env.BITTERBOT_STATE_DIR;
  process.env.BITTERBOT_STATE_DIR = stateDir;
  await fs.writeFile(path.join(workspace, "GENOME.md"), ORIGINAL);
});

afterEach(async () => {
  if (previousStateDir === undefined) {
    delete process.env.BITTERBOT_STATE_DIR;
  } else {
    process.env.BITTERBOT_STATE_DIR = previousStateDir;
  }
  await fs.rm(workspace, { recursive: true, force: true });
  await fs.rm(stateDir, { recursive: true, force: true });
});

function tool(name: string, run: (params: Record<string, unknown>) => Promise<void>): AnyAgentTool {
  return {
    name,
    label: name,
    description: name,
    parameters: {},
    execute: async (_id: string, params: Record<string, unknown>) => {
      await run(params);
      return { content: [{ type: "text", text: "done" }], details: { ok: true } };
    },
  } as unknown as AnyAgentTool;
}

const genome = () => fs.readFile(path.join(workspace, "GENOME.md"), "utf8");
const text = (result: unknown) =>
  (result as { content: Array<{ text?: string }> }).content.map((block) => block.text).join("\n");

describe("targetsGenome", () => {
  it("matches the workspace Genome however the path is spelled", () => {
    expect(targetsGenome("GENOME.md", workspace)).toBe(true);
    expect(targetsGenome("./GENOME.md", workspace)).toBe(true);
    expect(targetsGenome("sub/../GENOME.md", workspace)).toBe(true);
    expect(targetsGenome(path.join(workspace, "GENOME.md"), workspace)).toBe(true);
    expect(targetsGenome("@GENOME.md", workspace)).toBe(true);
  });

  it("does not match other files", () => {
    expect(targetsGenome("MEMORY.md", workspace)).toBe(false);
    expect(targetsGenome("notes/GENOME.md", workspace)).toBe(false);
    expect(targetsGenome("GENOME.md.bak", workspace)).toBe(false);
    expect(targetsGenome("", workspace)).toBe(false);
  });
});

describe("genomeWriteRefusal", () => {
  it("refuses write and edit by path", () => {
    expect(genomeWriteRefusal("write", { path: "GENOME.md", content: "x" }, workspace)).toBe(
      GENOME_READ_ONLY_MESSAGE,
    );
    expect(genomeWriteRefusal("edit", { file_path: "./GENOME.md" }, workspace)).toBe(
      GENOME_READ_ONLY_MESSAGE,
    );
    expect(genomeWriteRefusal("write", { path: "MEMORY.md" }, workspace)).toBeUndefined();
  });

  it("refuses a patch that adds, updates, deletes or moves onto the Genome", () => {
    for (const marker of ["Add File", "Update File", "Delete File"]) {
      const input = `*** Begin Patch\n*** ${marker}: GENOME.md\n+x\n*** End Patch`;
      expect(genomeWriteRefusal("apply_patch", { input }, workspace)).toBe(
        GENOME_READ_ONLY_MESSAGE,
      );
    }
    const move =
      "*** Begin Patch\n*** Update File: notes.md\n*** Move to: GENOME.md\n*** End Patch";
    expect(genomeWriteRefusal("apply_patch", { input: move }, workspace)).toBe(
      GENOME_READ_ONLY_MESSAGE,
    );
    const other = "*** Begin Patch\n*** Update File: MEMORY.md\n+x\n*** End Patch";
    expect(genomeWriteRefusal("apply_patch", { input: other }, workspace)).toBeUndefined();
  });

  it("leaves read tools alone", () => {
    expect(genomeWriteRefusal("read", { path: "GENOME.md" }, workspace)).toBeUndefined();
  });
});

describe("wrapToolWithGenomeGuard", () => {
  it("refuses a file tool aimed at the Genome before it runs", async () => {
    let ran = false;
    const guarded = wrapToolWithGenomeGuard(
      tool("write", async () => {
        ran = true;
      }),
      workspace,
    );
    await expect(
      guarded.execute!("call-1", { path: "GENOME.md", content: "hacked" }, undefined, undefined),
    ).rejects.toThrow(GENOME_READ_ONLY_MESSAGE);
    expect(ran).toBe(false);
    expect(await genome()).toBe(ORIGINAL);
  });

  it("undoes a change made by any other tool and says so in the result", async () => {
    const guarded = wrapToolWithGenomeGuard(
      tool("exec", async () => {
        await fs.writeFile(path.join(workspace, "GENOME.md"), "# GENOME\n\n- Anything goes.\n");
      }),
      workspace,
    );
    const result = await guarded.execute!("call-1", { command: "echo" }, undefined, undefined);
    expect(await genome()).toBe(ORIGINAL);
    expect(text(result)).toContain("done");
    expect(text(result)).toContain(GENOME_RESTORED_NOTICE);
    const kept = await fs.readdir(path.join(stateDir, "genome-guard"));
    expect(kept).toHaveLength(1);
    expect(await fs.readFile(path.join(stateDir, "genome-guard", kept[0]!), "utf8")).toContain(
      "Anything goes",
    );
  });

  it("puts the file back when a tool deletes or renames it", async () => {
    const guarded = wrapToolWithGenomeGuard(
      tool("exec", async () => {
        await fs.rename(path.join(workspace, "GENOME.md"), path.join(workspace, "old.md"));
      }),
      workspace,
    );
    const result = await guarded.execute!("call-1", {}, undefined, undefined);
    expect(await genome()).toBe(ORIGINAL);
    expect(text(result)).toContain(GENOME_RESTORED_NOTICE);
  });

  it("removes a Genome a tool created where there was none", async () => {
    await fs.rm(path.join(workspace, "GENOME.md"));
    const guarded = wrapToolWithGenomeGuard(
      tool("exec", async () => {
        await fs.writeFile(path.join(workspace, "GENOME.md"), "- Planted.\n");
      }),
      workspace,
    );
    await guarded.execute!("call-1", {}, undefined, undefined);
    await expect(genome()).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("undoes the change when the tool also throws", async () => {
    const guarded = wrapToolWithGenomeGuard(
      {
        ...tool("exec", async () => {}),
        execute: async () => {
          await fs.writeFile(path.join(workspace, "GENOME.md"), "changed then failed");
          throw new Error("boom");
        },
      } as unknown as AnyAgentTool,
      workspace,
    );
    await expect(guarded.execute!("call-1", {}, undefined, undefined)).rejects.toThrow("boom");
    expect(await genome()).toBe(ORIGINAL);
  });

  it("returns the result untouched when the Genome did not change", async () => {
    const guarded = wrapToolWithGenomeGuard(
      tool("exec", async () => {
        await fs.writeFile(path.join(workspace, "MEMORY.md"), "fine");
      }),
      workspace,
    );
    const result = await guarded.execute!("call-1", {}, undefined, undefined);
    expect(result).toEqual({ content: [{ type: "text", text: "done" }], details: { ok: true } });
    await expect(fs.readdir(path.join(stateDir, "genome-guard"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("accepts an edit the user made between tool calls", async () => {
    const guarded = wrapToolWithGenomeGuard(
      tool("exec", async () => {}),
      workspace,
    );
    await guarded.execute!("call-1", {}, undefined, undefined);
    await fs.writeFile(path.join(workspace, "GENOME.md"), "# GENOME\n\n- Edited by the user.\n");
    await guarded.execute!("call-2", {}, undefined, undefined);
    expect(await genome()).toContain("Edited by the user");
  });

  it("does not wrap twice and passes through without a workspace", () => {
    const base = tool("exec", async () => {});
    const once = wrapToolWithGenomeGuard(base, workspace);
    expect(wrapToolWithGenomeGuard(once, workspace)).toBe(once);
    expect(wrapToolWithGenomeGuard(base, undefined)).toBe(base);
  });
});
