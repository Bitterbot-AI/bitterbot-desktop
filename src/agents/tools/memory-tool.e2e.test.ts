import { beforeEach, describe, expect, it, vi } from "vitest";

let backend = "builtin" as const;
let searchImpl: () => Promise<unknown[]> = async () => [
  {
    path: "MEMORY.md",
    startLine: 5,
    endLine: 7,
    score: 0.9,
    snippet: "@@ -5,3 @@\nAssistant: noted",
    source: "memory" as const,
  },
];
let readFileImpl: () => Promise<string> = async () => "";

const stubManager = {
  search: vi.fn(async () => await searchImpl()),
  guestSearch: vi.fn(async () => [] as unknown[]),
  guestMayRead: vi.fn((relPath: string) => relPath === "memory/public.md"),
  readFile: vi.fn(async () => await readFileImpl()),
  status: () => ({
    backend,
    files: 1,
    chunks: 1,
    dirty: false,
    workspaceDir: "/workspace",
    dbPath: "/workspace/.memory/index.sqlite",
    provider: "builtin",
    model: "builtin",
    requestedProvider: "builtin",
    sources: ["memory" as const],
    sourceCounts: [{ source: "memory" as const, files: 1, chunks: 1 }],
  }),
  sync: vi.fn(),
  probeVectorAvailability: vi.fn(async () => true),
  close: vi.fn(),
};

vi.mock("../../memory/index.js", () => {
  return {
    getMemorySearchManager: async () => ({ manager: stubManager }),
  };
});

import {
  createMemoryExpandTool,
  createMemoryGetTool,
  createMemoryPinTool,
  createMemorySearchTool,
} from "./memory-tool.js";

beforeEach(() => {
  backend = "builtin";
  searchImpl = async () => [
    {
      path: "MEMORY.md",
      startLine: 5,
      endLine: 7,
      score: 0.9,
      snippet: "@@ -5,3 @@\nAssistant: noted",
      source: "memory" as const,
    },
  ];
  readFileImpl = async () => "";
  vi.clearAllMocks();
});

describe("memory search citations", () => {
  it("appends source information when citations are enabled", async () => {
    backend = "builtin";
    const cfg = { memory: { citations: "on" }, agents: { list: [{ id: "main", default: true }] } };
    const tool = createMemorySearchTool({ config: cfg });
    if (!tool) {
      throw new Error("tool missing");
    }
    const result = await tool.execute("call_citations_on", { query: "notes" });
    const details = result.details as { results: Array<{ snippet: string; citation?: string }> };
    expect(details.results[0]?.snippet).toMatch(/Source: MEMORY.md#L5-L7/);
    expect(details.results[0]?.citation).toBe("MEMORY.md#L5-L7");
  });

  it("leaves snippet untouched when citations are off", async () => {
    backend = "builtin";
    const cfg = { memory: { citations: "off" }, agents: { list: [{ id: "main", default: true }] } };
    const tool = createMemorySearchTool({ config: cfg });
    if (!tool) {
      throw new Error("tool missing");
    }
    const result = await tool.execute("call_citations_off", { query: "notes" });
    const details = result.details as { results: Array<{ snippet: string; citation?: string }> };
    expect(details.results[0]?.snippet).not.toMatch(/Source:/);
    expect(details.results[0]?.citation).toBeUndefined();
  });

  it("honors auto mode for direct chats", async () => {
    const cfg = {
      memory: { citations: "auto" },
      agents: { list: [{ id: "main", default: true }] },
    };
    const tool = createMemorySearchTool({
      config: cfg,
      agentSessionKey: "agent:main:discord:dm:u123",
    });
    if (!tool) {
      throw new Error("tool missing");
    }
    const result = await tool.execute("auto_mode_direct", { query: "notes" });
    const details = result.details as { results: Array<{ snippet: string }> };
    expect(details.results[0]?.snippet).toMatch(/Source:/);
  });

  it("suppresses citations for auto mode in group chats", async () => {
    backend = "builtin";
    const cfg = {
      memory: { citations: "auto" },
      agents: { list: [{ id: "main", default: true }] },
    };
    const tool = createMemorySearchTool({
      config: cfg,
      agentSessionKey: "agent:main:discord:group:c123",
    });
    if (!tool) {
      throw new Error("tool missing");
    }
    const result = await tool.execute("auto_mode_group", { query: "notes" });
    const details = result.details as { results: Array<{ snippet: string }> };
    expect(details.results[0]?.snippet).not.toMatch(/Source:/);
  });
});

describe("memory tools", () => {
  it("does not throw when memory_search fails (e.g. embeddings 429)", async () => {
    searchImpl = async () => {
      throw new Error("openai embeddings failed: 429 insufficient_quota");
    };

    const cfg = { agents: { list: [{ id: "main", default: true }] } };
    const tool = createMemorySearchTool({ config: cfg });
    expect(tool).not.toBeNull();
    if (!tool) {
      throw new Error("tool missing");
    }

    const result = await tool.execute("call_1", { query: "hello" });
    expect(result.details).toEqual({
      results: [],
      disabled: true,
      error: "openai embeddings failed: 429 insufficient_quota",
    });
  });

  it("does not throw when memory_get fails", async () => {
    readFileImpl = async () => {
      throw new Error("path required");
    };

    const cfg = { agents: { list: [{ id: "main", default: true }] } };
    const tool = createMemoryGetTool({ config: cfg });
    expect(tool).not.toBeNull();
    if (!tool) {
      throw new Error("tool missing");
    }

    const result = await tool.execute("call_2", { path: "memory/NOPE.md" });
    expect(result.details).toEqual({
      path: "memory/NOPE.md",
      text: "",
      disabled: true,
      error: "path required",
    });
  });
});

describe("memory tools for a guest (PLAN-53 G2)", () => {
  const cfg = { agents: { list: [{ id: "main", default: true }] } };

  it("searches through the guest filter, never the full index", async () => {
    const tool = createMemorySearchTool({ config: cfg, memoryGuest: true });
    const result = await tool!.execute("g1", { query: "anything" });
    expect(stubManager.guestSearch).toHaveBeenCalledTimes(1);
    expect(stubManager.search).not.toHaveBeenCalled();
    expect(
      (result.details as { results: unknown[]; canonical?: unknown }).canonical,
    ).toBeUndefined();
  });

  it("reads only files the guest may see", async () => {
    const tool = createMemoryGetTool({ config: cfg, memoryGuest: true });
    const refused = await tool!.execute("g2", { path: "MEMORY.md" });
    expect((refused.details as { error?: string }).error).toMatch(/not the owner/);
    expect(stubManager.readFile).not.toHaveBeenCalled();
    await tool!.execute("g3", { path: "memory/public.md" });
    expect(stubManager.readFile).toHaveBeenCalledTimes(1);
  });

  it("refuses raw transcripts and the facts ledger", async () => {
    const expand = await createMemoryExpandTool({ config: cfg, memoryGuest: true })!.execute("g4", {
      kind: "session",
      path: "s.jsonl",
      line: 1,
    });
    expect((expand.details as { error?: string }).error).toMatch(/not the owner/);
    const pin = await createMemoryPinTool({ config: cfg, memoryGuest: true })!.execute("g5", {
      action: "list",
    });
    expect((pin.details as { error?: string }).error).toMatch(/not the owner/);
  });

  it("leaves the owner's search untouched", async () => {
    await createMemorySearchTool({ config: cfg })!.execute("o1", { query: "notes" });
    expect(stubManager.search).toHaveBeenCalledTimes(1);
    expect(stubManager.guestSearch).not.toHaveBeenCalled();
  });
});
