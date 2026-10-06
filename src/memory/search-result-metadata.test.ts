import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { attachResultMetadata } from "./search-result-metadata.js";

describe("attachResultMetadata", () => {
  it("adds type, layer and creation time to merged search results", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(
      "CREATE TABLE chunks (id TEXT PRIMARY KEY, semantic_type TEXT, epistemic_layer TEXT, created_at INTEGER)",
    );
    db.prepare("INSERT INTO chunks VALUES ('a', 'relationship', 'world_fact', 1000)").run();
    db.prepare("INSERT INTO chunks VALUES ('b', 'goal', 'directive', NULL)").run();
    const merged: Array<Record<string, unknown> & { id: string; updatedAt: number }> = [
      { id: "a", updatedAt: 5000 },
      { id: "b", updatedAt: 6000 },
      { id: "missing", updatedAt: 7000 },
    ];

    attachResultMetadata(db, merged);

    expect(merged[0]).toMatchObject({
      semanticType: "relationship",
      epistemicLayer: "world_fact",
      createdAt: 1000,
    });
    // No creation time stored: fall back to the last update, never "now".
    expect(merged[1]).toMatchObject({
      semanticType: "goal",
      epistemicLayer: "directive",
      createdAt: 6000,
    });
    expect(merged[2]).not.toHaveProperty("semanticType");
  });

  it("leaves results alone on an index without the columns", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE chunks (id TEXT PRIMARY KEY)");
    const merged = [{ id: "a", updatedAt: 1 }];
    expect(() => attachResultMetadata(db, merged)).not.toThrow();
    expect(merged[0]).toEqual({ id: "a", updatedAt: 1 });
  });
});
