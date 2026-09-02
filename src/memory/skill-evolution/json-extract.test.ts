import { describe, expect, it } from "vitest";
import { extractJsonObjectLenient, firstBalancedObject } from "./json-extract.js";

describe("extractJsonObjectLenient", () => {
  it("parses bare, fenced, and prose-wrapped objects", () => {
    expect(extractJsonObjectLenient('{"a":1}')).toEqual({ a: 1 });
    expect(extractJsonObjectLenient('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJsonObjectLenient('Sure! Here:\n```\n{"a":1}\n```\nDone.')).toEqual({ a: 1 });
  });

  it("does not truncate at code fences INSIDE string values", () => {
    const obj = { content: "# T\n\n```bash\necho hi\n```\n\nend", n: 2 };
    const raw = "```json\n" + JSON.stringify(obj) + "\n```";
    expect(extractJsonObjectLenient(raw)).toEqual(obj);
  });

  it("takes the FIRST balanced object when a reply carries several, or trailing prose", () => {
    const raw =
      'Thinking...\n{"tool":"read_file","path":"wiki/index.md"}\nThen I will {"tool":"finish"}';
    expect(extractJsonObjectLenient(raw)).toEqual({ tool: "read_file", path: "wiki/index.md" });
    expect(firstBalancedObject('x {"a":"}{","b":{"c":1}} y {"d":2}')).toBe(
      '{"a":"}{","b":{"c":1}}',
    );
  });

  it("returns null for arrays, scalars, and prose", () => {
    expect(extractJsonObjectLenient("[1,2]")).toBeNull();
    expect(extractJsonObjectLenient("42")).toBeNull();
    expect(extractJsonObjectLenient("no patterns today")).toBeNull();
  });
});
