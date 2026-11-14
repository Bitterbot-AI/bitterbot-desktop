import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { checkResearchBrief, researchBriefTasks } from "./research-brief.js";
import { resolvePackageSandboxImage } from "./sandbox-image.js";

it.runIf(process.env.BITTERBOT_COLLECTIVE_DOCKER_TEST === "1")(
  "executes the complete helper in a networkless container while rejecting package writes",
  async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "collective-sandbox-"));
    const imageName = process.env.BITTERBOT_COLLECTIVE_DOCKER_IMAGE ?? "node:22-bookworm-slim";
    const config = { agents: { defaults: { sandbox: { docker: { image: imageName } } } } };
    const name = `bitterbot-package-test-${randomUUID()}`;
    const execute = promisify(execFile);
    try {
      const image = await resolvePackageSandboxImage(config, "main");
      await fs.cp(
        path.resolve("test/fixtures/collective-learning/research-brief"),
        path.join(workspace, "skill"),
        { recursive: true },
      );
      const task = researchBriefTasks("docker-fixture")[0];
      await fs.writeFile(path.join(workspace, "sources.json"), JSON.stringify(task.input));
      const command = `const fs = require('node:fs'); let refused = false; try { fs.writeFileSync('/workspace/skill/SKILL.md', 'tamper'); } catch (e) { refused = e.code === 'EROFS'; } if (!refused) throw new Error('Package was writable'); fs.readFileSync('/workspace/skill/SKILL.md'); process.argv = ['node', '/workspace/skill/scripts/build_brief.cjs', '/workspace/sources.json', '/workspace/brief.json', '/workspace/brief.md']; require('/workspace/skill/scripts/build_brief.cjs');`;
      await execute(
        "docker",
        [
          "run",
          "--rm",
          "--pull=never",
          "--name",
          name,
          "--network",
          "none",
          "--user",
          `${process.getuid!()}:${process.getgid!()}`,
          "--read-only",
          "--cap-drop",
          "ALL",
          "--pids-limit",
          "64",
          "--memory",
          "128m",
          "--cpus",
          "1",
          "-v",
          `${workspace}:/workspace:rw`,
          "-v",
          `${path.join(workspace, "skill")}:/workspace/skill:ro`,
          image.id,
          "node",
          "-e",
          command,
        ],
        { timeout: 60000, maxBuffer: 100000 },
      );
      expect(
        checkResearchBrief(
          task.input,
          JSON.parse(await fs.readFile(path.join(workspace, "brief.json"), "utf8")),
        ),
      ).toBe(true);
      expect(await fs.readFile(path.join(workspace, "brief.md"), "utf8")).toContain("Follow-up");
      await expect(
        resolvePackageSandboxImage(
          {
            agents: {
              defaults: { sandbox: { docker: { image: `missing-package-image-${randomUUID()}` } } },
            },
          },
          "main",
        ),
      ).rejects.toThrow("will not install");
    } finally {
      await execute("docker", ["rm", "-f", name], { timeout: 10000 }).catch(() => {});
      await fs.rm(workspace, { recursive: true, force: true });
    }
  },
  90000,
);
