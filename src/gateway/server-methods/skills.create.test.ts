import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let tmpDir: string;

vi.mock("../../utils.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../utils.js")>();
  return {
    ...original,
    get CONFIG_DIR() {
      return tmpDir;
    },
  };
});

vi.mock("../../config/config.js", () => {
  return {
    loadConfig: () => ({}),
    writeConfigFile: async () => {},
  };
});

const { skillsHandlers } = await import("./skills.js");

const VALID_CONTENT = `---
name: hello
description: A test skill
---

# Hello

Body.
`;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "skills-create-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("skills.create", () => {
  it("writes a managed SKILL.md and reports success", async () => {
    let ok: boolean | null = null;
    let result: { skillName?: string; skillPath?: string; target?: string } | null = null;
    await skillsHandlers["skills.create"]({
      params: { name: "Hello World", content: VALID_CONTENT },
      respond: (success, payload) => {
        ok = success;
        result = payload as typeof result;
      },
    });
    expect(ok).toBe(true);
    expect(result?.skillName).toBe("hello-world");
    expect(result?.target).toBe("managed");
    const onDisk = await fs.readFile(
      path.join(tmpDir, "skills", "hello-world", "SKILL.md"),
      "utf-8",
    );
    expect(onDisk).toBe(VALID_CONTENT);
  });

  it("rejects content that is not valid YAML frontmatter", async () => {
    let ok: boolean | null = null;
    let error: { message?: string } | undefined;
    await skillsHandlers["skills.create"]({
      params: { name: "broken", content: "no frontmatter here" },
      respond: (success, _payload, err) => {
        ok = success;
        error = err;
      },
    });
    expect(ok).toBe(false);
    expect(error?.message).toMatch(/frontmatter/i);
  });

  it("refuses to overwrite an existing skill unless overwrite=true", async () => {
    await skillsHandlers["skills.create"]({
      params: { name: "dup", content: VALID_CONTENT },
      respond: () => {},
    });

    let ok: boolean | null = null;
    let error: { message?: string } | undefined;
    await skillsHandlers["skills.create"]({
      params: { name: "dup", content: VALID_CONTENT },
      respond: (success, _payload, err) => {
        ok = success;
        error = err;
      },
    });
    expect(ok).toBe(false);
    expect(error?.message).toMatch(/already exists/);

    let ok2: boolean | null = null;
    await skillsHandlers["skills.create"]({
      params: { name: "dup", content: VALID_CONTENT, overwrite: true },
      respond: (success) => {
        ok2 = success;
      },
    });
    expect(ok2).toBe(true);
  });

  it("rejects names that normalize to empty", async () => {
    let ok: boolean | null = null;
    await skillsHandlers["skills.create"]({
      params: { name: "!!!", content: VALID_CONTENT },
      respond: (success) => {
        ok = success;
      },
    });
    expect(ok).toBe(false);
  });
});
