import { Type } from "@sinclair/typebox";
import { describe, expect, it, vi } from "vitest";
import type { AnyAgentTool } from "./common.js";
import { wrapToolWithCapabilityEnforcer } from "../skills/capability-enforcer.js";
import {
  createListToolsTool,
  createUseToolTool,
  LIST_TOOLS_NAME,
  oneLineDescription,
  USE_TOOL_NAME,
} from "./tool-dispatcher-tool.js";

type Result = { content: Array<{ type: string; text?: string }>; details?: unknown };

function stub(
  name: string,
  description: string,
  parameters: unknown = Type.Object({ path: Type.String() }),
): AnyAgentTool {
  return {
    name,
    label: name,
    description,
    parameters,
    execute: vi.fn(async (_id: string, params: unknown) => ({
      content: [{ type: "text", text: `${name}:${JSON.stringify(params)}` }],
      details: { ok: true, echoed: params },
    })),
  } as unknown as AnyAgentTool;
}

const hot = [stub("read", "Read a file"), stub("exec", "Run a shell command")];
const deferred = [
  stub("message", "Send a message.\nSecond line that must not appear."),
  stub(
    "wallet",
    "Move money around",
    Type.Object({ action: Type.String(), amount: Type.Number() }),
  ),
  stub("browser", "Drive a browser"),
];
const registry = [...hot, ...deferred];

const details = (r: unknown) => (r as Result).details as Record<string, unknown>;

describe("meta-tool schemas", () => {
  it("list_tools: optional query/name; use_tool: required name + object input", () => {
    const list = createListToolsTool({ lane: "chat", hot, deferred });
    const use = createUseToolTool({ registry });
    expect(list.name).toBe(LIST_TOOLS_NAME);
    expect(use.name).toBe(USE_TOOL_NAME);
    const listSchema = list.parameters as {
      type: string;
      properties: Record<string, unknown>;
      required?: string[];
    };
    expect(listSchema.type).toBe("object");
    expect(Object.keys(listSchema.properties).toSorted()).toEqual(["name", "query"]);
    expect(listSchema.required ?? []).toEqual([]);
    const useSchema = use.parameters as {
      properties: Record<string, { type?: string }>;
      required?: string[];
    };
    expect(Object.keys(useSchema.properties).toSorted()).toEqual(["input", "name"]);
    expect(useSchema.required?.toSorted()).toEqual(["input", "name"]);
    expect(useSchema.properties.input.type).toBe("object");
    // Both definitions together stay small (they replace ~49 deferred schemas).
    const chars = JSON.stringify(
      [list, use].map((t) => ({ n: t.name, d: t.description, p: t.parameters })),
    ).length;
    expect(chars).toBeLessThan(2000);
  });
});

describe("list_tools", () => {
  const list = createListToolsTool({ lane: "chat", hot, deferred });

  it("lists every deferred tool (not the hot ones) with a one-line description, sorted", async () => {
    const out = details(await list.execute("c1", {}));
    expect(out.lane).toBe("chat");
    expect(out.hot).toEqual(["read", "exec"]);
    expect(out.tools).toEqual([
      { name: "message", description: "Send a message." },
      { name: "wallet", description: "Move money around" },
      { name: "browser", description: "Drive a browser" },
    ]);
    expect(out.count).toBe(3);
  });

  it("filters by substring and by regex, case-insensitively", async () => {
    const sub = details(await list.execute("c2", { query: "MONEY" })) as {
      tools: Array<{ name: string }>;
    };
    expect(sub.tools.map((t) => t.name)).toEqual(["wallet"]);
    const re = details(await list.execute("c3", { query: "^(br|wa)" })) as {
      tools: Array<{ name: string }>;
    };
    expect(re.tools.map((t) => t.name)).toEqual(["wallet", "browser"]);
    const bad = details(await list.execute("c4", { query: "[" })) as { tools: unknown[] };
    expect(bad.tools).toEqual([]);
  });

  it("returns the full schema for one tool by name (hot or deferred)", async () => {
    const out = details(await list.execute("c5", { name: "wallet" }));
    expect(out.name).toBe("wallet");
    expect(out.hot).toBe(false);
    expect(out.parameters).toEqual(deferred[1].parameters);
    const hotOut = details(await list.execute("c6", { name: "READ" }));
    expect(hotOut.hot).toBe(true);
    const missing = details(await list.execute("c7", { name: "nope" }));
    expect(missing.ok).toBe(false);
  });

  it("oneLineDescription trims to the first line and 140 chars", () => {
    expect(oneLineDescription("  a\nb ")).toBe("a");
    expect(oneLineDescription("x".repeat(200))).toHaveLength(140);
    expect(oneLineDescription(undefined)).toBe("");
  });
});

describe("use_tool", () => {
  const use = createUseToolTool({ registry });

  it("bad input -> error result (ok:false, status error), NOT a throw; target never runs", async () => {
    const result = await use.execute("call-1", { name: "wallet", input: { action: "send" } });
    const out = details(result);
    expect(out.ok).toBe(false);
    expect(out.status).toBe("error");
    expect(String(out.error)).toMatch(/Validation failed for tool "wallet"/);
    expect(String(out.error)).toMatch(/amount/);
    expect((result as Result).content[0]?.text).toMatch(/Validation failed/);
    expect(deferred[1].execute).not.toHaveBeenCalled();
  });

  it("unknown tool and missing name are error results", async () => {
    expect(details(await use.execute("call-2", { name: "nope", input: {} })).ok).toBe(false);
    expect(details(await use.execute("call-3", { input: {} })).ok).toBe(false);
    expect(details(await use.execute("call-4", "junk")).ok).toBe(false);
  });

  it("valid input dispatches to the real implementation and returns its result verbatim", async () => {
    const signal = new AbortController().signal;
    const onUpdate = () => {};
    const result = await use.execute(
      "call-5",
      { name: "wallet", input: { action: "send", amount: 5 } },
      signal,
      onUpdate,
    );
    expect(deferred[1].execute).toHaveBeenCalledWith(
      "call-5",
      { action: "send", amount: 5 },
      signal,
      onUpdate,
    );
    expect(result).toEqual(
      await (deferred[1].execute as ReturnType<typeof vi.fn>).mock.results[0]!.value,
    );
    // Hot tools are reachable too (the registry is the whole session list).
    const viaHot = details(await use.execute("call-6", { name: "Read", input: { path: "/x" } }));
    expect(viaHot.echoed).toEqual({ path: "/x" });
  });

  it("a throwing target propagates (same as a direct call: pi-agent marks isError)", async () => {
    const boom = {
      ...stub("boom", "throws", Type.Object({})),
      execute: async () => {
        throw new Error("exec denied: security=deny");
      },
    } as unknown as AnyAgentTool;
    const useBoom = createUseToolTool({ registry: [boom] });
    await expect(useBoom.execute("call-7", { name: "boom", input: {} })).rejects.toThrow(
      /exec denied/,
    );
  });
});

describe("use_tool preserves the gates wrapped around the target", () => {
  it("a policy/approval wrapper on the target runs before the implementation", async () => {
    const gate = vi.fn();
    const raw = stub("wallet", "money", Type.Object({ action: Type.String() }));
    const gated = {
      ...raw,
      execute: async (id: string, params: unknown, signal?: AbortSignal, onUpdate?: unknown) => {
        gate(params);
        if ((params as { action: string }).action === "drain") {
          return {
            content: [{ type: "text", text: "approval-pending" }],
            details: { status: "approval-pending" },
          };
        }
        return raw.execute(id, params as never, signal, onUpdate as never);
      },
    } as unknown as AnyAgentTool;
    const use = createUseToolTool({ registry: [gated] });
    const pending = details(
      await use.execute("c1", { name: "wallet", input: { action: "drain" } }),
    );
    expect(gate).toHaveBeenCalledWith({ action: "drain" });
    expect(pending.status).toBe("approval-pending");
    expect(raw.execute).not.toHaveBeenCalled();
    await use.execute("c2", { name: "wallet", input: { action: "balance" } });
    expect(gate).toHaveBeenCalledTimes(2);
    expect(raw.execute).toHaveBeenCalledTimes(1);
  });

  it("the capability enforcer denial reaches the caller through use_tool (same as a direct call)", async () => {
    const raw = stub("wallet", "money", Type.Object({ action: Type.String() }));
    const denials: unknown[] = [];
    const enforced = wrapToolWithCapabilityEnforcer(raw, {
      // One active P2P skill whose profile grants nothing: wallet is refused.
      activeP2PProfiles: () => [
        {
          network: { outbound: [] },
          fs: { read: [], write: [] },
          wallet: false,
          shell: false,
          process: false,
        },
      ],
      recordDenial: (denial) => denials.push(denial),
    });
    const use = createUseToolTool({ registry: [enforced] });
    await expect(use.execute("c3", { name: "wallet", input: { action: "send" } })).rejects.toThrow(
      /wallet/,
    );
    expect(raw.execute).not.toHaveBeenCalled();
    expect(denials).toEqual([expect.objectContaining({ tool: "wallet" })]);
  });
});
