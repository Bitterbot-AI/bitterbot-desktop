import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { parse } from "yaml";

const workflow = parse(
  fs.readFileSync(
    fileURLToPath(new URL("../../.github/workflows/release-tarball.yml", import.meta.url)),
    "utf8",
  ),
) as {
  jobs: { publish: { steps: Array<{ name?: string; run?: string }> } };
};

it.skipIf(process.platform === "win32").each(["1.10.0-beta.1", "1.10.0"])(
  "publishes %s with the correct GitHub release channel",
  (version) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bitterbot-release-channel-"));
    try {
      const log = path.join(directory, "calls");
      fs.writeFileSync(
        path.join(directory, "gh"),
        `#!/bin/sh
printf '%s\\n' "$*" >> "$RELEASE_TEST_LOG"
case "$1:$2" in
  release:view) echo true ;;
  api:*) echo v1.9.0 ;;
esac
`,
        { mode: 0o755 },
      );
      fs.writeFileSync(path.join(directory, "curl"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      const run = workflow.jobs.publish.steps.find((step) =>
        step.name?.startsWith("Publish the release"),
      )?.run;
      expect(run).toBeTruthy();
      const result = spawnSync("bash", ["-c", run!], {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${directory}:${process.env.PATH}`,
          VERSION: version,
          REPO: "test/repo",
          RELEASE_TEST_LOG: log,
        },
      });
      expect(result.status, result.stderr).toBe(0);
      const calls = fs.readFileSync(log, "utf8");
      if (version.includes("-beta.")) {
        expect(calls).toContain("--draft=false --prerelease --latest=false");
        expect(calls).not.toMatch(/--latest(?:\s|$)/);
      } else {
        expect(calls).toContain("--draft=false --latest");
        expect(calls).not.toContain("--prerelease");
      }
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  },
);
