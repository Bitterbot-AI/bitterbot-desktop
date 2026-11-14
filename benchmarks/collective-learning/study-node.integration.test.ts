import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { learningHash, sha256 } from "../../src/agents/skills/collective/contracts.js";
import { snapshotPackage } from "../../src/agents/skills/collective/package.js";
import type { ResearchBriefHostOptions } from "../../src/agents/skills/collective/research-brief.js";
import { signRecord } from "../../src/agents/skills/collective/signatures.js";
import type { PackageExecutionHost } from "../../src/agents/skills/collective/validation.js";
import type { DeploymentSpec } from "./deployment-contract.js";
import { createPilotCorpus } from "./pilot-corpus.js";
import { qualify } from "./study-node-learning.js";
import { StudyNode } from "./study-node.js";
import type { PairedObservation } from "./study.js";

const nodes: StudyNode[] = [],
  roots: string[] = [];
afterEach(async () => {
  for (const node of nodes.splice(0)) await node.close();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
const environment = {
  model: "fixture/model",
  tools: { read: "1", write: "1", python3: "3" },
  runtime: { platform: "linux", fixture: "isolated-test" },
  checkerHash: sha256("host-checker"),
};
describe("deployment nodes over authenticated Circle HTTP", () => {
  it("persists independent identities, shares only permitted evidence, and refuses duplicate execution", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "bb-study-nodes-"));
    roots.push(root);
    const spec: DeploymentSpec = {
      schemaVersion: 1,
      id: "integration",
      purpose: "development-pilot",
      baseConfig: "unused",
      authAgentDirectory: "unused",
      model: "fixture/model",
      sandboxImage: "fixture",
      initialPackageDirectory: path.resolve("test/fixtures/collective-learning/research-brief"),
      corpusFile: "unused",
      seed: 1,
      conditions: ["pooled"],
      groupCeiling: { providerUsd: 100, toolCalls: 10000, wallMs: 1000000 },
      maxCanaryBatches: 5,
      retentionHours: 24,
    };
    const observed: PairedObservation[] = [];
    const corpus = createPilotCorpus();
    for (const id of ["a", "b"] as const) {
      const directory = path.join(root, id);
      await fs.mkdir(directory);
      let options: ResearchBriefHostOptions | undefined;
      const node = new StudyNode({
        directory,
        node: id,
        condition: "pooled",
        spec,
        config: {},
        corpus,
        accounting: {
          reserve: async () => {},
          finish: async (_, row) => {
            observed.push(row);
          },
        },
        hostFactory: async (
          _config,
          _agent,
          publisher,
          _seed,
          _image,
          hostOptions,
        ): Promise<PackageExecutionHost> => {
          options = hostOptions;
          return {
            node: publisher,
            environment,
            tasks: options!.tasks!,
            selectionTasks: options!.selectionTasks,
            acquisitionTaskHashes: options!.acquisitionTaskHashes!,
            quote: () => ({ providerUsd: 0, toolCalls: 1, wallMs: 10 }),
            execute: async (task, snapshot) => {
              const result = {
                outcome: snapshot?.files.has("guard.txt")
                  ? ("pass" as const)
                  : ("task-failure" as const),
                cost: { providerUsd: 0, toolCalls: 1, wallMs: 1 },
                accessedFiles: ["SKILL.md"],
              };
              await options!.onExecution!({
                runId: task.id,
                task,
                packageHash: snapshot?.packageHash ?? null,
                result,
                tokens: 11,
                latencyMs: 1,
                brief: { fixture: true },
                markdown: "Fixture brief",
                diagnostic: { kind: "fixture", message: "private-host-diagnostic" },
              });
              return result;
            },
          };
        },
      });
      node.db.exec("PRAGMA synchronous=NORMAL");
      nodes.push(node);
    }
    const descriptors = await Promise.all(nodes.map((n) => n.start()));
    process.stderr.write("[study fixture] nodes started\n");
    expect(descriptors[0].publisher).not.toBe(descriptors[1].publisher);
    const joined = await nodes[0].configurePeers(descriptors);
    await nodes[1].configurePeers(descriptors, joined.circleId);
    await nodes[1].join(joined.invite!);
    for (const node of nodes) {
      await node.configurePeers(descriptors, joined.circleId);
      node.setupPolicy(descriptors);
    }
    const signal = AbortSignal.timeout(120000);
    for (const node of nodes)
      await node.commandRun(
        `${node.options.node}-acquire`,
        "tasks",
        { partition: "acquisition", limit: 1 },
        signal,
      );
    expect(observed.filter((o) => o.phase === "acquisition")).toHaveLength(2);
    await nodes[0].commandRun("a-acquire", "tasks", { partition: "acquisition", limit: 1 }, signal);
    expect(observed.filter((o) => o.phase === "acquisition")).toHaveLength(2);
    await expect(
      nodes[0].commandRun("a-acquire", "tasks", { partition: "acquisition", limit: 2 }, signal),
    ).rejects.toThrow("collision");
    await nodes[0].commandRun("a-evidence", "evidence", {}, signal);
    const received = nodes[1].runtime.evidence.select(nodes[1].currentRelease());
    expect(new Set(received.map((e) => e.evidence.origin)).size).toBe(2);
    expect(received.every((e) => !JSON.stringify(e).includes("Fixture brief"))).toBe(true);
    expect(received.every((e) => !JSON.stringify(e).includes("private-host-diagnostic"))).toBe(
      true,
    );
    expect(observed.filter((o) => o.phase === "transfer")).toHaveLength(1);
    // Scripted host outcomes test orchestration, not model efficacy. Both nodes must execute
    // their own paired panels and canaries; no stable state or receipt is manufactured.
    const candidateDir = path.join(root, "candidate");
    await fs.cp(spec.initialPackageDirectory, candidateDir, { recursive: true });
    await fs.writeFile(path.join(candidateDir, "guard.txt"), "Host fixture improvement marker\n");
    const candidate = await snapshotPackage(candidateDir, {
      name: "research-brief",
      description: "Frozen research brief procedure",
      requirements: nodes[0].initial.manifest.requirements,
    });
    await nodes[0].store.install(candidate);
    const release = nodes[0].store.release(
      nodes[0].release(candidate.packageHash, [nodes[0].initial.packageHash]),
    )!;
    nodes[0].command = "source-qualification";
    process.stderr.write("[study fixture] qualifying source\n");
    expect(await qualify(nodes[0], release, signal)).toMatchObject({ status: "stable" });
    process.stderr.write("[study fixture] publishing qualified source\n");
    const ids = (await nodes[0].commandRun("a-publish", "publish", {}, signal)) as string[];
    expect(ids).toHaveLength(1);
    process.stderr.write("[study fixture] qualifying recipient\n");
    expect(await nodes[1].commandRun("b-receive", "receive", { ids }, signal)).toMatchObject([
      { status: "stable" },
    ]);
    expect(nodes[1].currentHash()).toBe(candidate.packageHash);
    expect(nodes[1].store.get(candidate.packageHash)?.state).toBe("stable");
    expect(
      nodes[1].db
        .prepare("SELECT COUNT(*) AS n FROM collective_receipts WHERE hash=?")
        .get(candidate.packageHash)?.n,
    ).toBeGreaterThanOrEqual(26);
    expect(observed.some((o) => o.phase === "validation" && o.node === "a")).toBe(true);
    expect(observed.some((o) => o.phase === "validation" && o.node === "b")).toBe(true);
    nodes[0].policies.revoke("study-grant");
    await expect(nodes[0].commandRun("a-evidence-revoked", "evidence", {}, signal)).rejects.toThrow(
      "Approval",
    );
    await nodes[1].commandRun("freeze", "freeze-learning", {}, signal);
    await expect(
      nodes[1].commandRun("late-acquire", "tasks", { partition: "acquisition", limit: 1 }, signal),
    ).rejects.toThrow("closed");
    await expect(
      nodes[1].commandRun(
        "early-retention",
        "tasks",
        { partition: "final", retention: true },
        signal,
      ),
    ).rejects.toThrow("precede retention");
    const privateRows = nodes[1].db.prepare("SELECT COUNT(*) AS n FROM chunks").get();
    expect(privateRows?.n).toBe(0);
    const forged = { ...received[0].evidence, outcome: "pass" };
    expect(() => nodes[1].runtime.evidence.import(forged)).toThrow("Invalid");
    expect(learningHash(signRecord("fixture", { value: true }, nodes[0].key))).toHaveLength(64);
    const originalGrant = nodes[0].policies.list()[0];
    const restartOptions = nodes[0].options;
    await nodes[0].close();
    nodes[0] = new StudyNode(restartOptions);
    await nodes[0].start();
    nodes[0].setupPolicy(descriptors);
    expect(nodes[0].policies.list()[0]).toEqual(originalGrant);
    expect(() => nodes[0].policies.authorize("main", release, "publish", "skill-package")).toThrow(
      "Approval",
    );
    nodes[0].db.prepare("DELETE FROM collective_policies WHERE id=?").run("study-grant");
    expect(() => nodes[0].setupPolicy(descriptors)).toThrow("removed");
    nodes[0].service.store.removeMember(nodes[0].meta("circle")!, nodes[0].publisher);
    await expect(nodes[0].join(joined.invite!)).rejects.toThrow("restart cannot restore");
    await expect(nodes[0].configurePeers(descriptors)).rejects.toThrow("restart cannot restore");
  }, 180000);
});
