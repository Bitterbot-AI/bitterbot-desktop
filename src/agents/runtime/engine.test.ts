import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import type { BitterbotConfig } from "../../config/config.js";
import { BitterbotSchema } from "../../config/zod-schema.js";
import { DEFAULT_RUNTIME_ENGINE, resolveRuntimeEngine } from "./engine.js";
import { openTranscript } from "./open-transcript.js";
import { TranscriptStore } from "./transcript/store.js";

describe("resolveRuntimeEngine", () => {
  it("defaults to pi", () => {
    expect(DEFAULT_RUNTIME_ENGINE).toBe("pi");
    expect(resolveRuntimeEngine(undefined)).toBe("pi");
    expect(resolveRuntimeEngine({}, "main")).toBe("pi");
  });

  it("uses agents.defaults.runtime.engine, overridden per agent", () => {
    const cfg: BitterbotConfig = {
      agents: {
        defaults: { runtime: { engine: "bitterbot" } },
        list: [{ id: "Drill-Haiku", runtime: { engine: "pi" } }, { id: "main" }],
      },
    };
    expect(resolveRuntimeEngine(cfg)).toBe("bitterbot");
    expect(resolveRuntimeEngine(cfg, "main")).toBe("bitterbot");
    expect(resolveRuntimeEngine(cfg, "drill-haiku")).toBe("pi");
    expect(resolveRuntimeEngine(cfg, "unknown-agent")).toBe("bitterbot");
  });

  it("ignores values that are not an engine name", () => {
    const cfg = {
      agents: { defaults: { runtime: { engine: "rust" } }, list: [{ id: "a", runtime: {} }] },
    } as unknown as BitterbotConfig;
    expect(resolveRuntimeEngine(cfg, "a")).toBe("pi");
  });

  it("the config schema accepts the key in both places and rejects other values", () => {
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

  it("returns the store the engine selects, over the same file format", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-open-"));
    dirs.push(dir);
    const file = path.join(dir, "s.jsonl");
    const ours = openTranscript(file, "bitterbot");
    expect(ours).toBeInstanceOf(TranscriptStore);
    ours.appendMessage({ role: "user", content: "hi", timestamp: 1 });
    ours.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "hello" }],
      provider: "p",
      model: "m",
      timestamp: 2,
    } as never);
    const pi = openTranscript(file, "pi");
    expect(pi).toBeInstanceOf(SessionManager);
    expect(pi.getEntries()).toHaveLength(2);
    pi.appendMessage({ role: "user", content: "again", timestamp: 3 });
    expect(openTranscript(file, "bitterbot").getBranch()).toHaveLength(3);
  });
});
