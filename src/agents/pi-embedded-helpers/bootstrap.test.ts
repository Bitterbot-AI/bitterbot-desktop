import { describe, it, expect } from "vitest";
import {
  resolveMemoryMdBudgetChars,
  buildBootstrapContextFiles,
} from "./bootstrap.js";
import type { WorkspaceBootstrapFile } from "../workspace.js";

describe("resolveMemoryMdBudgetChars", () => {
  it("should return 8000 for 200K+ context windows", () => {
    expect(resolveMemoryMdBudgetChars(200_000)).toBe(8000);
    expect(resolveMemoryMdBudgetChars(1_000_000)).toBe(8000);
  });

  it("should return 6000 for 128K context windows", () => {
    expect(resolveMemoryMdBudgetChars(128_000)).toBe(6000);
  });

  it("should return 4000 for 64K context windows", () => {
    expect(resolveMemoryMdBudgetChars(64_000)).toBe(4000);
  });

  it("should return 3200 for 32K context windows", () => {
    expect(resolveMemoryMdBudgetChars(32_000)).toBe(3200);
  });

  it("should return 3200 for small context windows", () => {
    expect(resolveMemoryMdBudgetChars(8_000)).toBe(3200);
  });

  it("should return 8000 when no context window provided", () => {
    expect(resolveMemoryMdBudgetChars(undefined)).toBe(8000);
    expect(resolveMemoryMdBudgetChars(0)).toBe(8000);
  });
});

describe("buildBootstrapContextFiles", () => {
  it("should inject scratch.md with unsynthesized notes header", () => {
    const files: WorkspaceBootstrapFile[] = [
      {
        name: "MEMORY.md",
        path: "/workspace/memory/scratch.md",
        content: "# Scratch Buffer\n\n- [2026-03-12] Important note",
        missing: false,
      },
    ];
    const result = buildBootstrapContextFiles(files);
    expect(result.length).toBe(1);
    expect(result[0]!.content).toContain("## Unsynthesized Notes (pending dream consolidation)");
  });

  it("should add truncation note for large MEMORY.md", () => {
    const longContent = "A".repeat(10_000);
    const files: WorkspaceBootstrapFile[] = [
      {
        name: "MEMORY.md",
        path: "/workspace/MEMORY.md",
        content: longContent,
        missing: false,
      },
    ];
    const result = buildBootstrapContextFiles(files, { contextWindowTokens: 32_000 });
    // With 32K context, budget is 3200 chars, so 10K content should be truncated
    expect(result.length).toBe(1);
    expect(result[0]!.content).toContain("[Full working memory available via memory_search]");
  });

  it("should not add truncation note for short MEMORY.md", () => {
    const files: WorkspaceBootstrapFile[] = [
      {
        name: "MEMORY.md",
        path: "/workspace/MEMORY.md",
        content: "Short content",
        missing: false,
      },
    ];
    const result = buildBootstrapContextFiles(files);
    expect(result.length).toBe(1);
    expect(result[0]!.content).not.toContain("[Full working memory available via memory_search]");
  });
});
