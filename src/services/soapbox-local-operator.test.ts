import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { prepareLocalOperator, readLocalOperator } from "./soapbox-local-operator.js";

it("creates distinct local credentials and isolated scopes without payment or wallet configuration", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "local-operator-test-"));
  try {
    const worker = path.join(root, "template.json"),
      directory = path.join(root, "operator");
    await writeFile(
      worker,
      JSON.stringify({ sandbox: { image: "pinned" }, memory_mib: 1024, allow_unsafe_host: false }),
    );
    const local = await prepareLocalOperator(directory, {
      worker,
      binary: path.join(root, "soapbox"),
    });
    expect(await readLocalOperator(directory)).toEqual(local);
    expect(local.admin).not.toBe(local.worker);
    expect(local.chain_id).toBe(84532);
    const config = JSON.parse(await readFile(path.join(directory, "coordinator.json"), "utf8"));
    expect(config.payments).toBeUndefined();
    expect(config.principals.map((p: { roles: string[] }) => p.roles)).toEqual([
      ["admin", "submitter"],
      ["worker"],
    ]);
    const prepared = JSON.parse(await readFile(path.join(directory, "worker.json"), "utf8"));
    expect(prepared).toMatchObject({
      modes: ["private", "collective"],
      pools: ["private"],
      projects: ["community"],
      memory_mib: 2048,
    });
    if (process.platform === "linux")
      expect((await stat(path.join(directory, "mesh-operator.json"))).mode & 0o777).toBe(0o600);
    await writeFile(
      path.join(directory, "mesh-operator.json"),
      JSON.stringify({ ...local, url: "https://external.example" }),
    );
    await expect(readLocalOperator(directory)).rejects.toThrow("Invalid local");
    await writeFile(
      path.join(directory, "mesh-operator.json"),
      JSON.stringify({ ...local, chain_id: 8453 }),
    );
    await expect(readLocalOperator(directory)).rejects.toThrow("Invalid local");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
