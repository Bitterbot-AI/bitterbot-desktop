import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getModel } from "@mariozechner/pi-ai";
import {
  AuthStorage,
  createAgentSession,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from "@mariozechner/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createGlobalOnlySettingsStorage,
  createGuardedPiResourceLoader,
  createGuardedPiSettingsManager,
} from "./guarded-resources.js";

/**
 * A workspace laid out the way pi's defaults would pick it up: an extension in
 * each auto-discovered directory, a project settings file naming a third, and
 * a skill, a prompt template, and context files. Each extension writes a
 * marker file when its module is imported.
 */
function plantWorkspace(root: string) {
  const ws = path.join(root, "ws");
  const agentDir = path.join(root, "agent");
  const marker = path.join(root, "MARKER");
  const ext = (label: string) =>
    `import fs from "node:fs";\nfs.appendFileSync(${JSON.stringify(marker)}, ${JSON.stringify(`${label}\n`)});\nexport default function () {}\n`;
  fs.mkdirSync(path.join(ws, ".pi", "extensions"), { recursive: true });
  fs.mkdirSync(path.join(ws, ".pi", "skills", "planted"), { recursive: true });
  fs.mkdirSync(path.join(ws, ".pi", "prompts"), { recursive: true });
  fs.mkdirSync(path.join(agentDir, "extensions"), { recursive: true });
  fs.writeFileSync(path.join(ws, ".pi", "extensions", "auto.ts"), ext("workspace-auto"));
  fs.writeFileSync(path.join(ws, "named.ts"), ext("workspace-settings"));
  fs.writeFileSync(path.join(agentDir, "extensions", "auto.ts"), ext("agentdir-auto"));
  fs.writeFileSync(
    path.join(ws, ".pi", "settings.json"),
    JSON.stringify({ extensions: [path.join(ws, "named.ts")], compaction: { reserveTokens: 7 } }),
  );
  fs.writeFileSync(
    path.join(ws, ".pi", "skills", "planted", "SKILL.md"),
    "---\nname: planted\ndescription: planted skill\n---\nplanted\n",
  );
  fs.writeFileSync(path.join(ws, ".pi", "prompts", "planted.md"), "planted template\n");
  fs.writeFileSync(path.join(ws, ".pi", "SYSTEM.md"), "planted system prompt\n");
  fs.writeFileSync(path.join(ws, "AGENTS.md"), "planted context file\n");
  return { ws, agentDir, marker };
}

async function openSession(ws: string, agentDir: string, guarded: boolean) {
  const authStorage = AuthStorage.inMemory();
  const modelRegistry = ModelRegistry.inMemory(authStorage);
  const settingsManager = guarded
    ? createGuardedPiSettingsManager(agentDir)
    : SettingsManager.create(ws, agentDir);
  const resourceLoader = guarded
    ? await createGuardedPiResourceLoader({ cwd: ws, agentDir, settingsManager })
    : undefined;
  const { session } = await createAgentSession({
    cwd: ws,
    agentDir,
    authStorage,
    modelRegistry,
    model: getModel("anthropic", "claude-haiku-4-5"),
    thinkingLevel: "off",
    tools: [],
    customTools: [],
    sessionManager: SessionManager.inMemory(ws),
    settingsManager,
    ...(resourceLoader ? { resourceLoader } : {}),
  });
  return { session, settingsManager, resourceLoader };
}

describe("guarded pi resources", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "bb-pi-guard-"));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("control: pi's default loader imports workspace and agentDir extensions", async () => {
    // If this fails after a pi upgrade, pi's discovery changed; re-check what
    // the guard has to cover before touching it.
    const { ws, agentDir, marker } = plantWorkspace(root);
    const { session } = await openSession(ws, agentDir, false);
    session.dispose();
    const loaded = fs.existsSync(marker) ? fs.readFileSync(marker, "utf-8") : "";
    expect(loaded).toContain("workspace-auto");
    expect(loaded).toContain("workspace-settings");
    expect(loaded).toContain("agentdir-auto");
  }, 60_000);

  it("imports no extension from the workspace, its settings, or agentDir", async () => {
    const { ws, agentDir, marker } = plantWorkspace(root);
    const { session, resourceLoader } = await openSession(ws, agentDir, true);
    session.dispose();
    expect(fs.existsSync(marker)).toBe(false);
    expect(resourceLoader?.getExtensions().extensions).toEqual([]);
  }, 60_000);

  it("discovers no skills, prompt templates, context files, or SYSTEM.md", async () => {
    const { ws, agentDir } = plantWorkspace(root);
    const settingsManager = createGuardedPiSettingsManager(agentDir);
    const loader = await createGuardedPiResourceLoader({ cwd: ws, agentDir, settingsManager });
    expect(loader.getSkills().skills).toEqual([]);
    expect(loader.getPrompts().prompts).toEqual([]);
    expect(loader.getAgentsFiles().agentsFiles).toEqual([]);
    expect(loader.getSystemPrompt()).toBeUndefined();
    expect(loader.getAppendSystemPrompt()).toEqual([]);
  }, 60_000);

  it("ignores project settings and still reads and writes global settings", () => {
    const { ws, agentDir } = plantWorkspace(root);
    fs.writeFileSync(
      path.join(agentDir, "settings.json"),
      JSON.stringify({ compaction: { reserveTokens: 4321 } }),
    );
    const guarded = createGuardedPiSettingsManager(agentDir);
    expect(guarded.getProjectSettings()).toEqual({});
    expect(guarded.getCompactionReserveTokens()).toBe(4321);
    // The unguarded manager lets the workspace file win.
    expect(SettingsManager.create(ws, agentDir).getCompactionReserveTokens()).toBe(7);

    const before = fs.readFileSync(path.join(ws, ".pi", "settings.json"), "utf-8");
    const storage = createGlobalOnlySettingsStorage(agentDir);
    let seen: string | undefined = "unset";
    storage.withLock("project", (current) => {
      seen = current;
      return JSON.stringify({ written: true });
    });
    expect(seen).toBeUndefined();
    expect(fs.readFileSync(path.join(ws, ".pi", "settings.json"), "utf-8")).toBe(before);

    storage.withLock("global", () => JSON.stringify({ compaction: { reserveTokens: 99 } }));
    expect(createGuardedPiSettingsManager(agentDir).getCompactionReserveTokens()).toBe(99);
  });

  it("works when agentDir has no settings file", () => {
    const agentDir = path.join(root, "empty-agent");
    const manager = createGuardedPiSettingsManager(agentDir);
    expect(manager.getGlobalSettings()).toEqual({});
    expect(fs.existsSync(agentDir)).toBe(false);
  });
});
