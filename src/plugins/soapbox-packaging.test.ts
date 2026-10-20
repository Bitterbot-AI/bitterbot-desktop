import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createJiti } from "jiti";
import { expect, it } from "vitest";

it("loads the Compute plugin from an installed layout without private source files", async () => {
  const root = path.resolve(import.meta.dirname, "../..");
  const stage = await mkdtemp(path.join(tmpdir(), "bitterbot-compute-package-"));
  try {
    const directory = path.join(stage, "extensions/soapbox-compute");
    await mkdir(path.dirname(directory), { recursive: true });
    await cp(path.join(root, "extensions/soapbox-compute"), directory, { recursive: true });
    const jiti = createJiti(import.meta.url, {
      interopDefault: true,
      alias: { "bitterbot/plugin-sdk": path.join(root, "src/plugin-sdk/index.ts") },
    });
    const loaded = await jiti.import<{ id?: string; default?: { id?: string } }>(
      path.join(directory, "index.ts"),
    );
    expect((loaded.default ?? loaded).id).toBe("soapbox-compute");
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
});
