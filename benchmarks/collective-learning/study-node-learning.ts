import {
  learningHash,
  lineageId,
  ReceiptSchema,
  type SkillRelease,
} from "../../src/agents/skills/collective/contracts.js";
import { proposeFromEvidence } from "../../src/agents/skills/collective/evidence.js";
import { createPackageProposalHost } from "../../src/agents/skills/collective/proposal-host.js";
import { receivePackage } from "../../src/agents/skills/collective/transport.js";
import {
  PackageValidator,
  isCanaryExposed,
  type PackageExecutionHost,
  type TrialResult,
} from "../../src/agents/skills/collective/validation.js";
import type { StudyTask } from "./deployment-contract.js";
import type { StudyNode } from "./study-node.js";
export async function runTasks(
  node: StudyNode,
  partition: StudyTask["partition"],
  signal: AbortSignal,
  retention = false,
  limit?: number,
): Promise<{ runs: number }> {
  node.phase = partition;
  node.retention = retention;
  if (partition === "acquisition" && node.meta("learning-ended-at"))
    throw new Error("Acquisition is closed after freezing learning");
  if (retention && !node.meta("final-ran-at"))
    throw new Error("Initial final evaluation must precede retention");
  if (
    retention &&
    Date.now() - Number(node.meta("learning-ended-at") ?? Date.now()) <
      node.options.spec.retentionHours * 3600000
  )
    throw new Error("Retention is not due; 24 real hours and fresh sessions are required");
  const snapshot = await node.store.read(node.currentHash());
  const tasks = node
    .tasks(partition)
    .filter(
      (t) =>
        !t.regression &&
        (partition !== "selection" || t.selectionPanel === 19) &&
        (!retention || !t.newUser),
    );
  const selected = limit === undefined ? tasks : tasks.slice(0, limit);
  for (const task of selected) {
    const result = await node.host.execute(task, snapshot, signal);
    if (partition === "acquisition") {
      const id = learningHash({
        command: node.command,
        task: task.id,
        hash: snapshot.packageHash,
      });
      const receipt = ReceiptSchema.parse({
        id,
        runId: id,
        packageHash: snapshot.packageHash,
        node: node.publisher,
        taskHash: learningHash({ family: task.family, input: task.input }),
        family: task.family,
        environment: node.host.environment,
        partition: "acquisition",
        occurredAt: Date.now(),
        ...result,
      });
      node.db
        .prepare("INSERT OR IGNORE INTO collective_receipts VALUES (?,?,?)")
        .run(id, snapshot.packageHash, JSON.stringify(receipt));
      const summary = node.runtime.evidence.export(
        "main",
        node.currentRelease(),
        id,
        node.policies,
        node.key,
        {
          failure:
            result.outcome === "task-failure" ? "host-brief-contract-failure" : result.outcome,
          conditions: { taskFamily: task.family, sourceFormat: task.environment },
        },
      );
      node.runtime.evidence.import(summary);
    }
  }
  if (partition === "final" && !retention) node.setMeta("final-ran-at", String(Date.now()));
  return { runs: selected.length };
}
export async function qualify(
  node: StudyNode,
  release: SkillRelease,
  signal: AbortSignal,
): Promise<unknown> {
  node.phase = "validation";
  node.retention = false;
  const before = node.currentHash();
  if (release.packageHash === before) return { status: "unchanged" };
  await node.store.screen(release.packageHash);
  const authorizedHost: PackageExecutionHost = {
    ...node.host,
    execute: async (...args) => {
      if (release.publisher !== node.publisher)
        node.policies.authorize("main", release, "evaluate", "skill-package");
      return node.host.execute(...args);
    },
  };
  const validator = new PackageValidator(
    node.store,
    authorizedHost,
    node.options.spec.groupCeiling,
  );
  const verdict = await validator.validate(release, before, signal);
  if (!verdict.passed) return { status: "unqualified", verdict };
  if (release.publisher !== node.publisher)
    node.policies.authorize("main", release, "adopt", "skill-package");
  node.store.activate("main", release, learningHash(node.host.environment));
  const snapshot = await node.store.read(release.packageHash),
    baseline = await node.store.read(before);
  for (
    let batch = 0;
    batch < node.options.spec.maxCanaryBatches &&
    node.store.get(snapshot.packageHash)?.state === "canary";
    batch++
  ) {
    for (const task of node.nextPanel(true).filter((t) => !t.regression)) {
      const runId = learningHash({ command: node.command, canary: batch, task: task.id });
      if (!isCanaryExposed(runId, snapshot.packageHash)) continue;
      const result = await authorizedHost.execute(task, snapshot, signal);
      let regression = false;
      if (result.outcome === "task-failure") {
        const control = await authorizedHost.execute(task, baseline, signal);
        if (control.outcome === "pass")
          regression =
            (await authorizedHost.execute(task, snapshot, signal)).outcome === "task-failure";
      }
      validator.observeCanary(
        "main",
        lineageId(release),
        {
          id: runId,
          runId,
          packageHash: snapshot.packageHash,
          node: node.publisher,
          taskHash: learningHash({ family: task.family, input: task.input }),
          family: task.family,
          environment: node.host.environment,
          partition: "canary",
          occurredAt: Date.now(),
          ...result,
        },
        regression,
      );
      if (node.store.get(snapshot.packageHash)?.state !== "canary") break;
    }
  }
  const state = node.store.get(snapshot.packageHash)!.state;
  if (state === "stable") {
    if (release.publisher !== node.publisher)
      node.policies.authorize("main", release, "adopt", "skill-package");
    node.setMeta("current", snapshot.packageHash);
    node.setMeta("current-release", learningHash(release));
  }
  return { status: state, verdict };
}
export async function learn(
  node: StudyNode,
  signal: AbortSignal,
  pooled = false,
): Promise<unknown> {
  if (node.meta("learning-ended-at")) throw new Error("Learning is frozen before final evaluation");
  if (node.options.condition === "frozen" || (pooled && node.options.condition !== "pooled"))
    throw new Error("Condition forbids this learning operation");
  node.phase = "proposal";
  node.retention = false;
  const parent = node.currentRelease();
  // Pooled evidence arrives before the same single daily proposal opportunity.
  const selected = node.runtime.evidence.select(parent);
  if (pooled && new Set(selected.map((e) => e.evidence.origin)).size < 2)
    return { status: "waiting-independent-evidence" };
  if (
    !pooled &&
    !selected.some(
      (e) => e.evidence.origin === node.publisher && e.evidence.outcome === "task-failure",
    )
  )
    return { status: "no-local-failure" };
  const proposal = await createPackageProposalHost(node.options.config, "main");
  const id = learningHash({ command: node.command, proposal: parent.packageHash });
  try {
    const hash = await proposeFromEvidence(
      node.store,
      parent,
      node.runtime.evidence,
      {
        ...proposal,
        propose: async (input, abort) => {
          await node.options.accounting.reserve({
            id,
            condition: node.options.condition,
            node: node.options.node,
            phase: "proposal",
            quote: proposal.quote,
          });
          const started = Date.now();
          let cost: TrialResult["cost"] = null;
          let tokens = 0;
          try {
            const value = await proposal.propose(input, abort);
            cost = value.cost;
            tokens = value.tokens ?? 0;
            return value;
          } finally {
            const task = node.tasks("acquisition")[0];
            await node.options.accounting.finish(
              id,
              {
                ...node.row(
                  task,
                  { outcome: "infrastructure", accessedFiles: [], cost },
                  id,
                  tokens,
                  Date.now() - started,
                ),
                taskId: `proposal:${id}`,
              },
              {
                evidenceIds: input.evidence.map((e) => e.id),
                parentHash: input.parent.packageHash,
              },
            );
          }
        },
      },
      node.options.spec.groupCeiling,
      signal,
    );
    return await qualify(
      node,
      node.store.release(node.release(hash, [parent.packageHash]))!,
      signal,
    );
  } catch (error) {
    node.store.audit("study-proposal-waiting", parent.packageHash, { reason: String(error) });
    return { status: "proposal-waiting", reason: String(error) };
  }
}
export async function publish(node: StudyNode): Promise<string[]> {
  if (!["exchange", "pooled"].includes(node.options.condition))
    throw new Error("Condition forbids package exchange");
  const rows = node.db
    .prepare("SELECT id,body FROM collective_releases WHERE lineage=? ORDER BY version")
    .all(`${node.publisher}/research-brief`) as { id: string; body: string }[];
  const published: string[] = [];
  for (const row of rows) {
    const release = JSON.parse(row.body) as SkillRelease;
    if (node.store.get(release.packageHash)?.state !== "stable") continue;
    await transferCost(node, `publish:${row.id}`, () =>
      node.runtime.distribution.publish(
        "main",
        release,
        node.service.createSkillPackageTransport(node.meta("circle")!, node.publisher),
      ),
    );
    published.push(row.id);
  }
  return published;
}
export async function receive(
  node: StudyNode,
  ids: string[],
  signal: AbortSignal,
): Promise<unknown[]> {
  if (!["exchange", "pooled"].includes(node.options.condition))
    throw new Error("Condition forbids package exchange");
  const result: unknown[] = [];
  for (const id of ids) {
    const release = node.store.release(id);
    if (!release) throw new Error("Missing authenticated release announcement");
    await transferCost(node, `receive:${id}`, () =>
      receivePackage(
        node.store,
        release,
        node.service.createSkillPackageTransport(node.meta("circle")!, release.publisher),
        () => {
          const grant = node.policies.list().find((p) => p.enabled && p.expiresAt > Date.now());
          if (
            !grant?.operations.includes("evaluate") ||
            !node.policies.member(node.meta("circle")!, release.publisher)
          )
            throw new Error("Study evaluation grant revoked");
        },
        signal,
      ),
    );
    node.policies.authorize("main", release, "evaluate", "skill-package");
    node.policies.authorize("main", release, "adopt", "skill-package");
    result.push(await qualify(node, release, signal));
  }
  return result;
}
export async function shareEvidence(node: StudyNode): Promise<number> {
  if (node.options.condition !== "pooled") throw new Error("Condition forbids pooled evidence");
  const rows = node.db
    .prepare("SELECT body FROM collective_evidence WHERE origin=? ORDER BY id")
    .all(node.publisher) as { body: string }[];
  const transport = node.service.createSkillPackageTransport(node.meta("circle")!, node.publisher);
  for (const row of rows) {
    const summary = JSON.parse(row.body);
    node.policies.authorize("main", node.currentRelease(), "evidence", "execution-summary");
    await transferCost(node, `evidence:${learningHash(summary)}`, () =>
      transport.evidence!(summary),
    );
  }
  return rows.length;
}
export async function transferCost<T>(
  node: StudyNode,
  operation: string,
  execute: () => Promise<T>,
): Promise<T> {
  const id = learningHash({ command: node.command, operation }),
    started = Date.now();
  await node.options.accounting.reserve({
    id,
    condition: node.options.condition,
    node: node.options.node,
    phase: "transfer",
    quote: { providerUsd: 0, toolCalls: 0, wallMs: 300000 },
  });
  try {
    return await execute();
  } finally {
    const task = node.tasks("acquisition")[0],
      priorPhase = node.phase;
    node.phase = "transfer";
    const row = node.row(
      task,
      {
        outcome: "infrastructure",
        accessedFiles: [],
        cost: { providerUsd: 0, toolCalls: 0, wallMs: Date.now() - started },
      },
      id,
      0,
      Date.now() - started,
    );
    node.phase = priorPhase;
    await node.options.accounting.finish(
      id,
      { ...row, taskId: `${operation}:${id.slice(0, 12)}`.slice(0, 200) },
      { operation },
    );
  }
}
