import { describe, expect, it } from "vitest";
import type { AnyAgentTool } from "./common.js";
import { applyOwnerOnlyToolPolicy, isOwnerOnlyToolName } from "../tool-policy.js";
import { __testing } from "./code-interpreter-tool.js";

const { executeJavaScript } = __testing;

let session = 0;
const freshSession = () => `test-${Date.now()}-${session++}`;

describe("code_interpreter JS sandbox hardening (security/code-interpreter-vm-escape)", () => {
  const escapePayloads = [
    `console.log.constructor.constructor('return process')()`,
    `this.constructor.constructor('return process')()`,
    `Math.constructor.constructor('return process')()`,
    `JSON.parse.constructor('return process')()`,
    `JSON.parse.constructor('return '+String.fromCharCode(112,114,111,99,101,115,115))()`,
    `[].constructor.constructor('return process')()`,
    `(async () => {}).constructor('return process')()`,
  ];

  for (const payload of escapePayloads) {
    it(`blocks the constructor-chain escape: ${payload.slice(0, 40)}...`, async () => {
      const r = await executeJavaScript(`return ${payload}`, freshSession());
      // Code generation is disabled, so Function(string)/eval throw at runtime.
      expect(r.error).toBeTruthy();
      expect(String(r.error)).toMatch(/[Cc]ode generation/);
      // And nothing that looks like the host process leaked into any channel.
      const blob = `${r.stdout}\n${r.stderr}\n${r.returnValue ?? ""}`;
      expect(blob).not.toMatch(/child_process|getBuiltinModule|\bprocess\b.*version/);
    });
  }

  it("blocks eval() directly", async () => {
    const r = await executeJavaScript(`return eval('1+1')`, freshSession());
    expect(r.error).toBeTruthy();
    expect(String(r.error)).toMatch(/[Cc]ode generation/);
  });

  it("does not expose Node host globals", async () => {
    const r = await executeJavaScript(
      `return [typeof process, typeof require, typeof globalThis.process, typeof Buffer].join(',')`,
      freshSession(),
    );
    expect(r.error).toBeNull();
    expect(r.returnValue).toBe("undefined,undefined,undefined,undefined");
  });

  it("still runs ordinary JavaScript (realm built-ins intact)", async () => {
    const r = await executeJavaScript(
      `
      const xs = [3, 1, 2].sort((a, b) => a - b);
      const obj = JSON.parse('{"n":' + Math.sqrt(16) + '}');
      const m = new Map([["k", 42]]);
      console.log("hello");
      return JSON.stringify({ xs, n: obj.n, k: m.get("k"), d: new Date(0).getTime() });
      `,
      freshSession(),
    );
    expect(r.error).toBeNull();
    expect(r.stdout).toBe("hello");
    expect(r.returnValue).toBe(JSON.stringify({ xs: [1, 2, 3], n: 4, k: 42, d: 0 }));
  });

  it("persists variables across calls in one session", async () => {
    const sid = freshSession();
    await executeJavaScript(`globalThis.__v = 7;`, sid);
    const r = await executeJavaScript(`return globalThis.__v * 6`, sid);
    expect(r.error).toBeNull();
    expect(r.returnValue).toBe("42");
  });
});

describe("owner-only gating of high-privilege tools", () => {
  const names = ["code_interpreter", "computer_use", "browser"];

  it("marks the high-privilege tools owner-only", () => {
    for (const n of names) {
      expect(isOwnerOnlyToolName(n)).toBe(true);
    }
  });

  const mk = (name: string): AnyAgentTool =>
    ({
      name,
      label: name,
      description: "",
      parameters: {},
      execute: async () => ({}),
    }) as unknown as AnyAgentTool;

  it("removes them for non-owner senders", () => {
    const tools = [...names.map(mk), mk("web_search")];
    const filtered = applyOwnerOnlyToolPolicy(tools, false).map((t) => t.name);
    for (const n of names) {
      expect(filtered).not.toContain(n);
    }
    expect(filtered).toContain("web_search");
  });

  it("keeps them for the owner", () => {
    const tools = names.map(mk);
    const kept = applyOwnerOnlyToolPolicy(tools, true).map((t) => t.name);
    for (const n of names) {
      expect(kept).toContain(n);
    }
  });
});
