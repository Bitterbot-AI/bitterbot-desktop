import { describe, expect, it } from "vitest";
import { createCompleteTool, createPlanTool } from "./workflow-tools.js";

describe("createCompleteTool", () => {
  const tool = createCompleteTool();

  it("has correct metadata", () => {
    expect(tool.name).toBe("complete");
    expect(tool.label).toBe("Complete");
    expect(tool.description).toContain("Signal that all tasks are finished");
  });

  it("returns structured result with summary, tasks, and attachments", async () => {
    const result = await tool.execute("tc-1", {
      summary: "Built the feature",
      tasks_completed: ["Created module", "Wrote tests"],
      attachments: ["/src/feature.ts", "/src/feature.test.ts"],
    });

    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");
    const payload = JSON.parse(result.content[0].text as string);
    expect(payload.status).toBe("complete");
    expect(payload.summary).toBe("Built the feature");
    expect(payload.tasks_completed).toEqual(["Created module", "Wrote tests"]);
    expect(payload.attachments).toEqual(["/src/feature.ts", "/src/feature.test.ts"]);
  });

  it("returns empty arrays when optional params are omitted", async () => {
    const result = await tool.execute("tc-2", {
      summary: "Done",
    });

    const payload = JSON.parse(result.content[0].text as string);
    expect(payload.status).toBe("complete");
    expect(payload.summary).toBe("Done");
    expect(payload.tasks_completed).toEqual([]);
    expect(payload.attachments).toEqual([]);
  });

  it("trims summary whitespace", async () => {
    const result = await tool.execute("tc-3", {
      summary: "  trimmed summary  ",
    });

    const payload = JSON.parse(result.content[0].text as string);
    expect(payload.summary).toBe("trimmed summary");
  });

  it("throws when summary is missing", async () => {
    await expect(tool.execute("tc-4", {})).rejects.toThrow(/summary required/i);
  });

  it("throws when summary is empty string", async () => {
    await expect(tool.execute("tc-5", { summary: "" })).rejects.toThrow(/summary required/i);
  });

  it("filters non-string entries from tasks_completed", async () => {
    const result = await tool.execute("tc-6", {
      summary: "Done",
      tasks_completed: ["valid", 42, null, "also valid", ""],
    });

    const payload = JSON.parse(result.content[0].text as string);
    // readStringArrayParam filters non-strings and empty strings
    expect(payload.tasks_completed).toEqual(["valid", "also valid"]);
  });

  it("handles single string as tasks_completed", async () => {
    const result = await tool.execute("tc-7", {
      summary: "Done",
      tasks_completed: "single task",
    });

    const payload = JSON.parse(result.content[0].text as string);
    expect(payload.tasks_completed).toEqual(["single task"]);
  });

  it("handles single string as attachments", async () => {
    const result = await tool.execute("tc-8", {
      summary: "Done",
      attachments: "/path/to/file.ts",
    });

    const payload = JSON.parse(result.content[0].text as string);
    expect(payload.attachments).toEqual(["/path/to/file.ts"]);
  });

  it("populates details in the result", async () => {
    const result = await tool.execute("tc-9", {
      summary: "Done",
    });

    expect(result.details).toBeDefined();
    const details = result.details as Record<string, unknown>;
    expect(details.status).toBe("complete");
  });
});

describe("createPlanTool", () => {
  const tool = createPlanTool();

  it("has correct metadata", () => {
    expect(tool.name).toBe("plan");
    expect(tool.label).toBe("Plan");
    expect(tool.description).toContain("structured task plan");
  });

  it("returns normalized tasks", async () => {
    const result = await tool.execute("tc-10", {
      tasks: [
        { id: "1", label: "Research" },
        { id: "2", label: "Implement", parent_id: "1" },
        { id: "3", label: "Test" },
      ],
    });

    const payload = JSON.parse(result.content[0].text as string);
    expect(payload.ok).toBe(true);
    expect(payload.action).toBe("plan");
    expect(payload.tasks).toHaveLength(3);
    expect(payload.tasks[0]).toEqual({ id: "1", label: "Research", parent_id: undefined });
    expect(payload.tasks[1]).toEqual({ id: "2", label: "Implement", parent_id: "1" });
    expect(payload.tasks[2]).toEqual({ id: "3", label: "Test", parent_id: undefined });
  });

  it("returns error when tasks array is empty", async () => {
    const result = await tool.execute("tc-11", {
      tasks: [],
    });

    const payload = JSON.parse(result.content[0].text as string);
    expect(payload.ok).toBe(false);
    expect(payload.error).toContain("At least one task");
  });

  it("returns error when tasks is not an array", async () => {
    const result = await tool.execute("tc-12", {
      tasks: "not-an-array",
    });

    const payload = JSON.parse(result.content[0].text as string);
    expect(payload.ok).toBe(false);
    expect(payload.error).toContain("At least one task");
  });

  it("returns error when tasks is missing", async () => {
    const result = await tool.execute("tc-13", {});

    const payload = JSON.parse(result.content[0].text as string);
    expect(payload.ok).toBe(false);
  });

  it("coerces non-string id/label to strings", async () => {
    const result = await tool.execute("tc-14", {
      tasks: [{ id: 42, label: true }],
    });

    const payload = JSON.parse(result.content[0].text as string);
    expect(payload.ok).toBe(true);
    expect(payload.tasks[0].id).toBe("42");
    expect(payload.tasks[0].label).toBe("true");
  });

  it("drops non-string parent_id values", async () => {
    const result = await tool.execute("tc-15", {
      tasks: [{ id: "1", label: "Task", parent_id: 99 }],
    });

    const payload = JSON.parse(result.content[0].text as string);
    expect(payload.tasks[0].parent_id).toBeUndefined();
  });

  it("handles missing id/label gracefully", async () => {
    const result = await tool.execute("tc-16", {
      tasks: [{}],
    });

    const payload = JSON.parse(result.content[0].text as string);
    expect(payload.ok).toBe(true);
    // String(undefined) === "undefined", but we use ?? ""
    expect(payload.tasks[0].id).toBe("");
    expect(payload.tasks[0].label).toBe("");
  });
});
