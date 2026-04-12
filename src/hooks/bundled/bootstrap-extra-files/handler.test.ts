import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { BitterbotConfig } from "../../../config/config.js";
import type { AgentBootstrapHookContext } from "../../hooks.js";
import { makeTempWorkspace, writeWorkspaceFile } from "../../../test-helpers/workspace.js";
import { createHookEvent } from "../../hooks.js";
import handler from "./handler.js";

describe("bootstrap-extra-files hook", () => {
  it("appends extra bootstrap files from configured patterns", async () => {
    const tempDir = await makeTempWorkspace("bitterbot-bootstrap-extra-");
    const extraDir = path.join(tempDir, "packages", "core");
    await fs.mkdir(extraDir, { recursive: true });
    await fs.writeFile(path.join(extraDir, "TOOLS.md"), "extra agents", "utf-8");

    const cfg: BitterbotConfig = {
      hooks: {
        internal: {
          entries: {
            "bootstrap-extra-files": {
              enabled: true,
              paths: ["packages/*/TOOLS.md"],
            },
          },
        },
      },
    };

    const context: AgentBootstrapHookContext = {
      workspaceDir: tempDir,
      bootstrapFiles: [
        {
          name: "TOOLS.md",
          path: await writeWorkspaceFile({
            dir: tempDir,
            name: "TOOLS.md",
            content: "root agents",
          }),
          content: "root agents",
          missing: false,
        },
      ],
      cfg,
      sessionKey: "agent:main:main",
    };

    const event = createHookEvent("agent", "bootstrap", "agent:main:main", context);
    await handler(event);

    const injected = context.bootstrapFiles.filter((f) => f.name === "TOOLS.md");
    expect(injected).toHaveLength(2);
    expect(injected.some((f) => f.path.endsWith(path.join("packages", "core", "TOOLS.md")))).toBe(
      true,
    );
  });

  it("re-applies subagent bootstrap allowlist after extras are added", async () => {
    const tempDir = await makeTempWorkspace("bitterbot-bootstrap-extra-subagent-");
    const extraDir = path.join(tempDir, "packages", "persona");
    await fs.mkdir(extraDir, { recursive: true });
    await fs.writeFile(path.join(extraDir, "GENOME.md"), "evil", "utf-8");

    const cfg: BitterbotConfig = {
      hooks: {
        internal: {
          entries: {
            "bootstrap-extra-files": {
              enabled: true,
              paths: ["packages/*/GENOME.md"],
            },
          },
        },
      },
    };

    const context: AgentBootstrapHookContext = {
      workspaceDir: tempDir,
      bootstrapFiles: [
        {
          name: "PROTOCOLS.md",
          path: await writeWorkspaceFile({
            dir: tempDir,
            name: "PROTOCOLS.md",
            content: "root protocols",
          }),
          content: "root protocols",
          missing: false,
        },
        {
          name: "TOOLS.md",
          path: await writeWorkspaceFile({ dir: tempDir, name: "TOOLS.md", content: "root tools" }),
          content: "root tools",
          missing: false,
        },
      ],
      cfg,
      sessionKey: "agent:main:subagent:abc",
    };

    const event = createHookEvent("agent", "bootstrap", "agent:main:subagent:abc", context);
    await handler(event);

    expect(context.bootstrapFiles.map((f) => f.name).toSorted()).toEqual([
      "GENOME.md",
      "PROTOCOLS.md",
      "TOOLS.md",
    ]);
  });
});
