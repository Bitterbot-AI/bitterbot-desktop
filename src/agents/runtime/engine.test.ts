import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BitterbotConfig } from "../../config/config.js";
import { BitterbotSchema } from "../../config/zod-schema.js";
import {
  __resetRuntimeEngineWarningsForTest,
  DEFAULT_RUNTIME_ENGINE,
  resolveRuntimeEngine,
} from "./engine.js";
import { openTranscript, openTranscriptForAgent } from "./open-transcript.js";
import { TranscriptStore } from "./transcript/store.js";

const warnSpy = vi.hoisted(() => vi.fn());
vi.mock("../../logging/subsystem.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../logging/subsystem.js")>();
  return {
    ...actual,
    createSubsystemLogger: () => ({
      ...actual.createSubsystemLogger("test"),
      warn: warnSpy,
    }),
  };
});

describe("resolveRuntimeEngine", () => {
  beforeEach(() => {
    warnSpy.mockClear();
    __resetRuntimeEngineWarningsForTest();
  });

  it("is always the owned runtime", () => {
    expect(DEFAULT_RUNTIME_ENGINE).toBe("bitterbot");
    expect(resolveRuntimeEngine(undefined)).toBe("bitterbot");
    expect(resolveRuntimeEngine({}, "main")).toBe("bitterbot");
    const cfg: BitterbotConfig = {
      agents: {
        defaults: { runtime: { engine: "bitterbot" } },
        list: [{ id: "main" }],
      },
    };
    expect(resolveRuntimeEngine(cfg, "main")).toBe("bitterbot");
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("warns once per scope when a config still says pi, and ignores it", () => {
    const cfg: BitterbotConfig = {
      agents: {
        defaults: { runtime: { engine: "pi" } },
        list: [{ id: "Drill-Haiku", runtime: { engine: "pi" } }, { id: "main" }],
      },
    };
    expect(resolveRuntimeEngine(cfg)).toBe("bitterbot");
    expect(resolveRuntimeEngine(cfg, "main")).toBe("bitterbot");
    expect(resolveRuntimeEngine(cfg, "drill-haiku")).toBe("bitterbot");
    expect(resolveRuntimeEngine(cfg, "drill-haiku")).toBe("bitterbot");
    expect(resolveRuntimeEngine(cfg)).toBe("bitterbot");
    expect(warnSpy.mock.calls.map((call) => call[0])).toEqual([
      "the pi engine was removed; agents.defaults runs the owned runtime",
      "the pi engine was removed; agent drill-haiku runs the owned runtime",
    ]);
  });

  it("ignores values that are not an engine name", () => {
    const cfg = {
      agents: { defaults: { runtime: { engine: "rust" } }, list: [{ id: "a", runtime: {} }] },
    } as unknown as BitterbotConfig;
    expect(resolveRuntimeEngine(cfg, "a")).toBe("bitterbot");
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("the config schema still accepts the key in both places and rejects other values", () => {
    const ok = BitterbotSchema.safeParse({
      agents: {
        defaults: { runtime: { engine: "bitterbot" } },
        list: [{ id: "a", runtime: { engine: "pi" } }],
      },
    });
    expect(ok.success).toBe(true);
    expect(
      BitterbotSchema.safeParse({ agents: { defaults: { runtime: { engine: "rust" } } } }).success,
    ).toBe(false);
    expect(
      BitterbotSchema.safeParse({ agents: { list: [{ id: "a", runtime: { extra: 1 } }] } }).success,
    ).toBe(false);
  });
});

describe("openTranscript", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("opens the owned store, and a reopen sees what was appended", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-open-"));
    dirs.push(dir);
    const file = path.join(dir, "s.jsonl");
    const ours = openTranscript(file);
    expect(ours).toBeInstanceOf(TranscriptStore);
    ours.appendMessage({ role: "user", content: "hi", timestamp: 1 });
    ours.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "hello" }],
      provider: "p",
      model: "m",
      timestamp: 2,
    } as never);
    const again = openTranscriptForAgent(file, { config: {}, agentId: "main" });
    expect(again).toBeInstanceOf(TranscriptStore);
    expect(again.getEntries()).toHaveLength(2);
    again.appendMessage({ role: "user", content: "again", timestamp: 3 });
    expect(openTranscript(file).getBranch()).toHaveLength(3);
  });
});
