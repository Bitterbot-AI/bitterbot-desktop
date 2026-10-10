import { describe, expect, it } from "vitest";
import {
  controlKindFor,
  initialValueFor,
  isLeafHintPath,
  schemaNodeAtPath,
} from "./settings-schema";

const SCHEMA = {
  type: "object",
  properties: {
    update: {
      type: "object",
      properties: {
        checkOnStart: { type: "boolean" },
        channel: { anyOf: [{ const: "stable" }, { const: "beta" }, { const: "dev" }] },
      },
    },
    review: {
      type: "object",
      properties: {
        spend: { anyOf: [{ type: "string", enum: ["ask", "allow"] }, { type: "null" }] },
      },
    },
    usage: {
      anyOf: [
        {
          type: "object",
          properties: {
            budgets: {
              type: "object",
              properties: {
                daily: { type: "object", properties: { usd: { type: "number" } } },
                perModel: { type: "object", additionalProperties: { type: "object" } },
              },
            },
          },
        },
        { type: "null" },
      ],
    },
    agents: {
      type: "object",
      properties: {
        list: {
          type: "array",
          items: { type: "object", properties: { skills: { type: "array", items: {} } } },
        },
      },
    },
    commands: {
      type: "object",
      default: { native: "auto" },
      properties: {
        native: { anyOf: [{ type: "boolean" }, { const: "auto" }], default: "auto" },
        bash: { anyOf: [{ type: "boolean" }, { type: "null" }] },
      },
    },
    loose: { type: "object", additionalProperties: true },
  },
};

describe("schemaNodeAtPath", () => {
  it("walks nested properties", () => {
    expect(schemaNodeAtPath(SCHEMA, "update.checkOnStart")).toEqual({ type: "boolean" });
  });

  it("collapses intermediate anyOf-with-null, keeps the leaf's nullability", () => {
    expect(schemaNodeAtPath(SCHEMA, "usage.budgets.daily.usd")).toEqual({ type: "number" });
    expect(schemaNodeAtPath(SCHEMA, "review.spend")).toEqual({
      anyOf: [{ type: "string", enum: ["ask", "allow"] }, { type: "null" }],
    });
  });

  it("descends into records (*) and arrays ([])", () => {
    expect(schemaNodeAtPath(SCHEMA, "usage.budgets.perModel.*")).toEqual({ type: "object" });
    expect(schemaNodeAtPath(SCHEMA, "agents.list[].skills")?.type).toBe("array");
  });

  it("returns undefined for unknown paths", () => {
    expect(schemaNodeAtPath(SCHEMA, "update.nope")).toBeUndefined();
    expect(schemaNodeAtPath(SCHEMA, "loose.anything")).toBeUndefined();
    expect(schemaNodeAtPath(null, "x")).toBeUndefined();
  });
});

describe("controlKindFor", () => {
  it("boolean -> switch; nullable boolean stays a switch", () => {
    expect(controlKindFor({ type: "boolean" }, undefined).kind).toBe("boolean");
    expect(controlKindFor(schemaNodeAtPath(SCHEMA, "commands.bash"), undefined)).toEqual({
      kind: "boolean",
      nullable: true,
    });
  });

  it("enum from `enum` and from anyOf-of-const, keeping null as an option", () => {
    expect(controlKindFor(schemaNodeAtPath(SCHEMA, "update.channel"), undefined)).toEqual({
      kind: "enum",
      options: ["stable", "beta", "dev"],
      nullable: false,
    });
    const spend = {
      anyOf: [{ type: "string", enum: ["ask", "allow"] }, { type: "null" }],
    };
    expect(controlKindFor(spend, undefined)).toEqual({
      kind: "enum",
      options: ["ask", "allow", null],
      nullable: true,
    });
  });

  it("number/integer -> number, string -> string", () => {
    expect(controlKindFor({ type: "integer" }, undefined).kind).toBe("number");
    expect(controlKindFor({ type: "number" }, undefined).kind).toBe("number");
    expect(controlKindFor({ type: "string" }, undefined).kind).toBe("string");
  });

  it("a boolean-or-'auto' union is a select, not a switch", () => {
    expect(controlKindFor(schemaNodeAtPath(SCHEMA, "commands.native"), undefined)).toEqual({
      kind: "enum",
      options: [true, false, "auto"],
      nullable: false,
    });
  });

  it("falls back to the value's type when the schema says nothing", () => {
    expect(controlKindFor(undefined, true).kind).toBe("boolean");
    expect(controlKindFor(undefined, 3).kind).toBe("number");
    expect(controlKindFor(undefined, "x").kind).toBe("string");
    expect(controlKindFor(undefined, { a: 1 }).kind).toBe("unknown");
    expect(controlKindFor({ type: "object" }, undefined).kind).toBe("unknown");
  });
});

describe("initialValueFor / isLeafHintPath", () => {
  it("uses the schema default when it is a primitive", () => {
    const node = schemaNodeAtPath(SCHEMA, "commands.native");
    expect(initialValueFor(controlKindFor(node, undefined), node)).toBe("auto");
  });

  it("never seeds a row with an object default", () => {
    const node = schemaNodeAtPath(SCHEMA, "commands");
    expect(initialValueFor({ kind: "string" }, node)).toBe("");
  });

  it("picks a sensible empty value per control kind", () => {
    expect(initialValueFor({ kind: "boolean" }, undefined)).toBe(false);
    expect(initialValueFor({ kind: "number" }, undefined)).toBe(0);
    expect(initialValueFor({ kind: "enum", options: [null, "ask"] }, undefined)).toBe("ask");
    expect(initialValueFor({ kind: "string" }, undefined)).toBe("");
  });

  it("leaf paths are dotted and free of wildcards", () => {
    expect(isLeafHintPath("update.checkOnStart")).toBe(true);
    expect(isLeafHintPath("update")).toBe(false);
    expect(isLeafHintPath("plugins.entries.*.enabled")).toBe(false);
    expect(isLeafHintPath("agents.list[].skills")).toBe(false);
  });
});
