import { describe, expect, it } from "vitest";
import {
  DEFAULT_MEMORY_EXCLUDE_PATHS,
  isExcludedMemoryPath,
  resolveMemorySearchConfig,
} from "./memory-search.js";

describe("memorySearch.excludePaths (token-efficiency pass)", () => {
  it("excludes the dream journal and working-memory snapshots by default", () => {
    const resolved = resolveMemorySearchConfig({}, "main");
    expect(resolved?.excludePaths).toEqual(DEFAULT_MEMORY_EXCLUDE_PATHS);
    expect(isExcludedMemoryPath("memory/dream-journal.md", resolved!.excludePaths)).toBe(true);
    expect(
      isExcludedMemoryPath("memory/memory-snapshots/2026-09-18T10-00.md", resolved!.excludePaths),
    ).toBe(true);
    expect(
      isExcludedMemoryPath("memory/memory-snapshots/deep/nested.md", resolved!.excludePaths),
    ).toBe(true);
  });

  it("keeps MEMORY.md, handover briefs and ordinary memory notes", () => {
    const patterns = DEFAULT_MEMORY_EXCLUDE_PATHS;
    expect(isExcludedMemoryPath("MEMORY.md", patterns)).toBe(false);
    expect(isExcludedMemoryPath("memory/handover/2026-09-18-10.md", patterns)).toBe(false);
    expect(isExcludedMemoryPath("memory/notes/dream-journal.md", patterns)).toBe(false);
    expect(isExcludedMemoryPath("memory/scratch.md", patterns)).toBe(false);
  });

  it("is config-overridable (empty list indexes everything; custom globs honoured)", () => {
    const none = resolveMemorySearchConfig(
      { agents: { defaults: { memorySearch: { excludePaths: [] } } } },
      "main",
    );
    expect(none?.excludePaths).toEqual([]);
    expect(isExcludedMemoryPath("memory/dream-journal.md", none!.excludePaths)).toBe(false);

    const custom = resolveMemorySearchConfig(
      { agents: { defaults: { memorySearch: { excludePaths: ["memory/private/*.md"] } } } },
      "main",
    );
    expect(isExcludedMemoryPath("memory/private/a.md", custom!.excludePaths)).toBe(true);
    expect(isExcludedMemoryPath("memory/private/sub/a.md", custom!.excludePaths)).toBe(false);
    expect(isExcludedMemoryPath("memory/dream-journal.md", custom!.excludePaths)).toBe(false);
  });

  it("normalises Windows separators and leading ./", () => {
    expect(isExcludedMemoryPath("./memory\\dream-journal.md", DEFAULT_MEMORY_EXCLUDE_PATHS)).toBe(
      true,
    );
  });
});
