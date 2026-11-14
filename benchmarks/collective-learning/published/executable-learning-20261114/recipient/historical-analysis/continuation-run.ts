/** Paired ordinary-agent feasibility study; no forced SKILL read or production activation. */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Cost } from "../executable-transfer-v2/study.js";
const operation = process.argv[2];
const phase = process.argv[3] ?? "evaluation";
assert(["evaluation", "retention"].includes(phase));
process.argv[2] = "library";
const study = await import("../executable-transfer-v2/study.js");
const {
  root,
  repo,
  exported,
  suite,
  read,
  write,
  copyJson,
  config,
  frozen,
  fixtures,
  contract,
  db,
  ledger,
  packages,
  budget,
  settle,
  abort,
  cleanContainers,
  recipientConfig,
} = study;
const amendment = await read<{runnerHash:string; allowedInterruptedId:string; originalRecordHash:string; auditHash:string}>(path.join(exported, "continuation-amendment.json"));
assert.equal(crypto.createHash("sha256").update(await fs.readFile(fileURLToPath(import.meta.url))).digest("hex"), amendment.runnerHash);
const receipt = await read<{hash:string}>(path.join(exported, "interruption-audit.json"));
assert.equal(receipt.hash, amendment.auditHash);
const [
  { learningHash, sha256 },
  { withPackageTrial },
  { copyInputs, inputHashes, gradeOutput },
  { loadSkillsFromDir, formatSkillsForPrompt },
  { runEmbeddedPiAgent },
  { resolveModel },
] = await Promise.all([
  import("../../../src/agents/skills/collective/contracts.js"),
  import("../../../src/agents/skills/collective/execution-context.js"),
  import("../../../benchmarks/collective-learning/executable-runtime.js"),
  import("@mariozechner/pi-coding-agent"),
  import("../../../src/agents/pi-embedded-runner/run.js"),
  import("../../../src/agents/pi-embedded-runner/model.js"),
]);
const spec = config.skills!.collective!.validationModel!;
const slash = spec.indexOf("/"),
  provider = spec.slice(0, slash),
  modelId = spec.slice(slash + 1);
const model = resolveModel(provider, modelId, config.agents!.list![0].agentDir!, config).model;
assert(model?.cost && Object.values(model.cost).every((n) => Number.isFinite(n) && n >= 0));
const rates = model.cost;
const quote = { ...frozen.quote, toolCalls: 21, wallMs: 450000 };
const info = await read<{ packageHash: string }>(path.join(root, "candidate-package.json"));
const snapshot = await packages.read(info.packageHash);
const qualified = await read<{ qualified: boolean }>(path.join(root, "validate.json"));
assert(qualified.qualified);
const taskPrompt =
  contract.instructions +
  " Complete inputs/offer_letter_template.docx using inputs/employee_data.json and save output/offer_letter_filled.docx. Do not modify the inputs. Use the available tools and finish with a concise completion message.";
const evaluationSchedule = fixtures
  .filter((f) => f.partition === "evaluation")
  .flatMap((f, i) =>
    (i % 2 ? ["learned", "frozen"] : ["frozen", "learned"]).map((arm) => ({
      id: `agent-${f.id}-${arm}`,
      caseId: f.id,
      arm,
    })),
  );
const retentionSchedule = fixtures
  .filter((f) => f.partition === "retention")
  .map((f) => ({ id: "retention-" + f.id + "-learned", caseId: f.id, arm: "learned" }));
const schedule = phase === "retention" ? retentionSchedule : evaluationSchedule;
if (phase === "retention") {
  assert(operation !== "prepare");
  assert(Date.now() >= frozen.retentionNotBefore, "24-hour retention deadline has not arrived");
  const completed = await read<{ attemptedPairs: number }>(
    path.join(root, "comparison-readout.json"),
  );
  assert.equal(completed.attemptedPairs, 12);
  assert.equal(ledger.unresolved(), 0);
}
async function comparisonSources() {
  const dir = suite; // Verify the original frozen driver suite unchanged.
  const result: Record<string, string> = {};
  for (const name of await fs.readdir(dir))
    if (name.endsWith(".ts"))
      result[path.relative(repo, path.join(dir, name)).split(path.sep).join("/")] = sha256(
        await fs.readFile(path.join(dir, name)),
      );
  return result;
}
const lock = await fs.open(path.join(root, "run.lock"), "wx", 0o600);
type ModelRecord = {
  id: string;
  caseId: string;
  arm: string;
  runId: string;
  cost: Cost | null;
  tokens: number;
  outcome: string;
  reads: string[];
  helperInvocations: unknown[];
  toolActions: unknown[];
  inputUnchanged: boolean;
  packageUnchanged: boolean;
  outputHash: string | null;
  latencyMs: number;
  checkerWallMs: number;
  diagnostic: unknown;
  usage: unknown;
  modelMessages: number;
  sessionHash: string;
  grade: unknown;
};
try {
  if (operation === "prepare") {
    assert.equal(schedule.length, 24);
    const loaded = loadSkillsFromDir({
      dir: path.join(packages.directory(info.packageHash), "content"),
      source: "bitterbot-study-shadow",
    });
    assert.equal(loaded.skills.length, 1);
    assert.equal(loaded.skills[0].name, snapshot.manifest.name);
    const body = {
      schemaVersion: 1,
      repairFreeze: frozen.hash,
      createdAt: new Date().toISOString(),
      sources: await comparisonSources(),
      packageHash: info.packageHash,
      model: spec,
      modelDefinition: learningHash(model),
      rates,
      quote,
      taskPrompt,
      schedule,
      retentionSchedule,
      retentionNotBefore: frozen.retentionNotBefore,
      budgetBefore: budget(),
      maxTaskRuns: 24,
      concurrency: 1,
      maximumStageProviderUsd: 20,
      admission:
        "All evaluation and later retention jobs share one $20 stage ledger. Reserve the full quote before each serial run and retain unresolved costs. Previous overall holds of $28.80 remain separate. Stop admissions before any ceiling is exceeded.",
      claim:
        "Recipient use of the unchanged signed package after operator-assisted offline import and fresh local checking. Separate recipient state/process; same physical host and pinned image with changed resources/timezone. No automatic Circle publication or production activation.",
      primary:
        "Provider cost per independently verified completion. Target at least 50% reduction, with no added failures on this finite panel.",
      secondary: [
        "checked success",
        "SKILL.md whole-file read",
        "successful helper command observed",
        "tool calls",
        "model messages (not exact provider request count)",
        "tokens including cache",
        "agent latency excluding cold preflight",
        "verification latency",
      ],
      learningAccounting:
        "Inherited source learning cost $3.07113425 plus $14.40 unresolved learning holds; no new repair. Transfer/local-verification wall time is separate. Group ledger counts each provider charge once, including all failed tasks.",
      interpretation:
        "Twelve authored pairs across three document genres share one DOCX mechanism and are a development transfer pilot. No powered general efficacy claim. Model caching may carry across fresh sessions; order alternates.",
      instrumentation:
        "Read tracking requires successful whole SKILL.md read. Helper evidence uses successful exec results with a command containing the exact immutable helper path, input and output arguments; it is invocation evidence, not OS-level file-access tracing.",
    };
    await copyJson("comparison-frozen.json", { ...body, hash: learningHash(body) });
    console.log(
      JSON.stringify({
        prepared: true,
        hash: learningHash(body),
        quote,
        maxRuns: 24,
        budget: budget(),
      }),
    );
  } else {
    const plan = await read<{
      hash: string;
      sources: Record<string, string>;
      modelDefinition: string;
      packageHash: string;
      taskPrompt: string;
      schedule: typeof schedule;
      retentionSchedule: typeof retentionSchedule;
    }>(path.join(root, "comparison-frozen.json"));
    const { hash, ...body } = plan;
    assert.equal(learningHash(body), hash);
    assert.deepEqual(plan.sources, await comparisonSources());
    assert.equal(plan.modelDefinition, learningHash(model));
    assert.equal(plan.packageHash, info.packageHash);
    assert.equal(plan.taskPrompt, taskPrompt);
    assert.deepEqual(plan.schedule, evaluationSchedule);
    assert.deepEqual(plan.retentionSchedule, retentionSchedule);
    if (operation === "run") {
      for (const job of schedule) {
        const recordPath = path.join(root, "agent-records", job.id + ".json");
        if (await fs.stat(recordPath).catch(() => null)) {
          const record = await read<ModelRecord>(recordPath);
          if (job.id === amendment.allowedInterruptedId) {
            assert.equal(record.outcome, "interrupted");
            assert.equal(record.cost, null);
            assert.equal(crypto.createHash("sha256").update(await fs.readFile(recordPath)).digest("hex"), amendment.originalRecordHash);
            const reconciled = db.prepare("SELECT receipt FROM study_cost_reconciliations WHERE id=?").get(job.id) as {receipt:string}|undefined;
            assert(reconciled);
            assert.equal((JSON.parse(reconciled.receipt) as {hash:string}).hash, amendment.auditHash);
            const charge = db.prepare("SELECT state,cost FROM study_charges WHERE id=?").get(job.id) as {state:string;cost:string};
            assert.equal(charge.state, "settled"); assert(charge.cost);
          } else assert(record.cost && ["pass", "task-failure"].includes(record.outcome));
          continue;
        }
        assert.equal(ledger.unresolved(), 0);
        if (budget().stageRemainingUsd < quote.providerUsd) {
          console.log(JSON.stringify({ stopped: "budget-admission", budget: budget() }));
          break;
        }
        assert.equal(ledger.startCommand(job.id, { comparisonFreeze: hash, ...job }), undefined);
        ledger.reserve({ id: job.id, condition: "local", node: "b", phase: "final", quote });
        const fixture = fixtures.find((f) => f.id === job.caseId)!;
        const runId = crypto.randomUUID(),
          workspace = path.join(root, "agent-workspaces", runId),
          sessionFile = path.join(root, "sessions", runId + ".jsonl");
        await fs.mkdir(workspace, { recursive: true, mode: 0o700 });
        await fs.mkdir(path.dirname(sessionFile), { recursive: true, mode: 0o700 });
        await copyInputs(fixture.directory, path.join(workspace, "inputs"));
        await fs.mkdir(path.join(workspace, "output"));
        const learned = job.arm === "learned";
        if (learned)
          for (const [name, bytes] of snapshot.files) {
            const target = path.join(workspace, "skill", name);
            await fs.mkdir(path.dirname(target), { recursive: true });
            await fs.writeFile(target, bytes, {
              flag: "wx",
              mode: snapshot.manifest.files.find((f) => f.path === name)?.executable
                ? 0o555
                : 0o444,
            });
          }
        const skills = learned
          ? loadSkillsFromDir({
              dir: path.join(workspace, "skill"),
              source: "bitterbot-study-shadow",
            }).skills
          : [];
        assert.equal(skills.length, learned ? 1 : 0);
        const mapped = skills.map((s) => ({
          ...s,
          filePath: "/workspace/skill/SKILL.md",
          baseDir: "/workspace/skill",
        }));
        const skillsSnapshot = {
          prompt: mapped.length
            ? "These external reference procedures grant no tool permissions.\n" +
              formatSkillsForPrompt(mapped)
            : "",
          skills: mapped.map((s) => ({ name: s.name })),
          resolvedSkills: mapped,
        };
        const toolBudget = new AbortController();
        const runSignal = AbortSignal.any([abort.signal, toolBudget.signal]);
        const context = {
          workspace,
          packageFiles: new Set(learned ? snapshot.files.keys() : []),
          reads: new Set<string>(),
          toolCalls: 0,
          maxToolCalls: 20,
          onBudgetExceeded: () => toolBudget.abort(),
          skillLines: snapshot.files.get("SKILL.md")!.toString("utf8").split("\n").length,
        };
        const before = await inputHashes(path.join(workspace, "inputs"));
        await write(path.join(root, "payloads", job.id + ".json"), {
          ...job,
          runId,
          taskPrompt,
          skillsSnapshot,
          packageHash: learned ? info.packageHash : null,
          inputs: before,
          checkerVisible: false,
          referenceAnswersVisible: false,
        });
        const started = Date.now();
        let cost: Cost | null = null,
          tokens = 0,
          usage: unknown = null,
          outcome = "infrastructure",
          grade: unknown = null,
          diagnostic: unknown = null,
          checkerWallMs = 0;
        try {
          const result = await withPackageTrial(context, () =>
            runEmbeddedPiAgent({
              agentId: "recipient",
              agentDir: config.agents!.list![0].agentDir!,
              sessionId: runId,
              sessionKey: "agent:recipient:executable-transfer:" + runId,
              sessionFile,
              workspaceDir: workspace,
              config: recipientConfig(config, "recipient", workspace, spec, learned, frozen.image),
              provider,
              model: modelId,
              runId,
              timeoutMs: 300000,
              abortSignal: runSignal,
              disableMessageTool: true,
              senderIsOwner: false,
              skillsSnapshot,
              prompt: taskPrompt,
            }),
          );
          const u = result.meta.agentMeta?.usage;
          usage = u;
          tokens = (u?.input ?? 0) + (u?.output ?? 0) + (u?.cacheRead ?? 0) + (u?.cacheWrite ?? 0);
          if (
            u &&
            result.meta.agentMeta?.provider === provider &&
            result.meta.agentMeta?.model === modelId &&
            !result.meta.aborted &&
            !runSignal.aborted
          )
            cost = {
              providerUsd:
                ((u.input ?? 0) * rates.input +
                  (u.output ?? 0) * rates.output +
                  (u.cacheRead ?? 0) * rates.cacheRead +
                  (u.cacheWrite ?? 0) * rates.cacheWrite) /
                1000000,
              toolCalls: context.toolCalls,
              wallMs: Date.now() - started,
            };
          if (result.meta.aborted || runSignal.aborted) outcome = "interrupted";
          else if (result.meta.error || result.meta.providerFailed) {
            outcome = "infrastructure";
            diagnostic = { error: result.meta.error, providerFailed: result.meta.providerFailed };
          } else {
            const checked = await gradeOutput(
              frozen.image,
              suite,
              fixture.directory,
              path.join(workspace, "output/offer_letter_filled.docx"),
              abort.signal,
            );
            grade = checked.grade;
            outcome = checked.grade.status;
            checkerWallMs = checked.wallMs;
            if (cost) {
              cost.toolCalls += 1;
              cost.wallMs += checked.wallMs;
            }
          }
        } catch (error) {
          diagnostic = {
            name: (error as Error).name,
            message: (error as Error).message.slice(0, 300),
          };
        }
        const inputUnchanged =
          learningHash(before) === learningHash(await inputHashes(path.join(workspace, "inputs")));
        let packageUnchanged = true;
        if (learned)
          for (const [name, bytes] of snapshot.files)
            if (!(await fs.readFile(path.join(workspace, "skill", name))).equals(bytes))
              packageUnchanged = false;
        if (!inputUnchanged || !packageUnchanged) outcome = "task-failure";
        const session = await fs.readFile(sessionFile, "utf8").catch(() => "");
        type Message = {
          role?: string;
          content?: Array<{
            type: string;
            id?: string;
            name?: string;
            arguments?: Record<string, unknown>;
          }>;
          toolCallId?: string;
          isError?: boolean;
          details?: { status?: string; exitCode?: number };
        };
        const messages = session
          .split("\n")
          .filter(Boolean)
          .map((line) => (JSON.parse(line) as { message?: Message }).message)
          .filter((m): m is Message => Boolean(m));
        const calls = messages.flatMap((m) =>
          m.role === "assistant" ? (m.content ?? []).filter((c) => c.type === "toolCall") : [],
        );
        const results = messages.filter((m) => m.role === "toolResult");
        const toolActions = calls.map((call) => ({
          name: call.name,
          id: call.id,
          arguments: call.arguments,
          result: results
            .filter((r) => r.toolCallId === call.id)
            .map((r) => ({
              isError: r.isError,
              status: r.details?.status,
              exitCode: r.details?.exitCode,
            })),
        }));
        const helperInvocations = toolActions.filter(
          (a) =>
            a.name === "exec" &&
            typeof a.arguments?.command === "string" &&
            /(?:^|\s)(?:\/workspace\/)?skill\/helpers\/fill_docx\.py(?:\s|$)/.test(
              a.arguments.command,
            ) &&
            /--template\s/.test(a.arguments.command) &&
            /--data\s/.test(a.arguments.command) &&
            /--output\s/.test(a.arguments.command) &&
            a.result.some((r) => !r.isError && r.status === "completed" && r.exitCode === 0),
        );
        const outputHash = await fs
          .readFile(path.join(workspace, "output/offer_letter_filled.docx"))
          .then(sha256)
          .catch(() => null);
        const record: ModelRecord = {
          ...job,
          runId,
          cost,
          tokens,
          outcome,
          grade,
          reads: [...context.reads],
          helperInvocations,
          toolActions,
          inputUnchanged,
          packageUnchanged,
          outputHash,
          latencyMs: Date.now() - started,
          checkerWallMs,
          diagnostic,
          usage,
          modelMessages: messages.filter((m) => m.role === "assistant").length,
          sessionHash: sha256(session),
        };
        settle(
          job.id,
          cost,
          tokens,
          record,
          ["pass", "task-failure"].includes(outcome) ? outcome === "pass" : null,
          "final",
        );
        await write(recordPath, record);
        await write(path.join(exported, "agent-records", job.id + ".json"), record);
        if (outputHash) {
          const target = path.join(exported, "agent-outputs", job.id + ".docx");
          await fs.mkdir(path.dirname(target), { recursive: true });
          await fs.copyFile(path.join(workspace, "output/offer_letter_filled.docx"), target);
        }
        ledger.finishCommand(job.id, { outcome, cost });
        await cleanContainers();
        console.log(
          JSON.stringify({
            id: job.id,
            outcome,
            wholeSkillRead: context.reads.has("SKILL.md"),
            helperInvocations: helperInvocations.length,
            cost,
            tokens,
            budget: budget(),
          }),
        );
        assert(
          cost &&
            cost.providerUsd <= quote.providerUsd &&
            ["pass", "task-failure"].includes(outcome),
          "Incomplete run, unknown cost, invalid checker or overrun: inspect before proceeding",
        );
      }
    } else if (operation === "report" && phase === "retention") {
      const records = [];
      for (const job of schedule)
        records.push(await read<ModelRecord>(path.join(root, "agent-records", job.id + ".json")));
      await copyJson("retention-readout.json", {
        packageHash: info.packageHash,
        notBefore: frozen.retentionNotBefore,
        completedAt: Date.now(),
        runs: records.length,
        passes: records.filter((r) => r.outcome === "pass").length,
        reads: records.filter((r) => r.reads.includes("SKILL.md")).length,
        helperUse: records.filter((r) => r.helperInvocations.length).length,
        providerUsd: records.reduce((n, r) => n + (r.cost?.providerUsd ?? 0), 0),
        budget: budget(),
        scope:
          "Fresh recipient process and sessions after at least 24 hours; six new authored inputs, learned arm only. Not a new paired efficacy comparison.",
      });
    } else if (operation === "report") {
      const records: ModelRecord[] = [];
      for (const job of schedule) {
        const r = await read<ModelRecord>(path.join(root, "agent-records", job.id + ".json")).catch(
          () => null,
        );
        if (r) records.push(r);
      }
      const arms = ["frozen", "learned"].map((arm) => {
        const rs = records.filter((r) => r.arm === arm),
          cost = rs.reduce((n, r) => n + (r.cost?.providerUsd ?? 0), 0),
          passes = rs.filter((r) => r.outcome === "pass").length;
        return {
          arm,
          runs: rs.length,
          passes,
          providerUsd: cost,
          costPerVerifiedCompletion: passes ? cost / passes : null,
          wholeSkillReads: rs.filter((r) => r.reads.includes("SKILL.md")).length,
          observedHelperInvocations: rs.filter((r) => r.helperInvocations.length).length,
          tokens: rs.reduce((n, r) => n + r.tokens, 0),
          toolCalls: rs.reduce((n, r) => n + (r.cost?.toolCalls ?? 0), 0),
          modelMessages: rs.reduce((n, r) => n + r.modelMessages, 0),
          latencyMs: rs.reduce((n, r) => n + r.latencyMs, 0),
          checkerWallMs: rs.reduce((n, r) => n + r.checkerWallMs, 0),
        };
      });
      const pairs = fixtures
        .filter((f) => f.partition === "evaluation")
        .map((f) => ({
          caseId: f.id,
          frozen: records.find((r) => r.caseId === f.id && r.arm === "frozen"),
          learned: records.find((r) => r.caseId === f.id && r.arm === "learned"),
        }));
      const complete = pairs.filter((p) => p.frozen && p.learned),
        newFailures = complete.filter(
          (p) => p.frozen!.outcome === "pass" && p.learned!.outcome !== "pass",
        ).length;
      const saving =
        arms[0].costPerVerifiedCompletion !== null && arms[1].costPerVerifiedCompletion !== null
          ? arms[0].costPerVerifiedCompletion - arms[1].costPerVerifiedCompletion
          : null;
      const learningUsd = 3.07113425;
      const result = {
        schemaVersion: 1,
        comparisonFreeze: hash,
        repairFreeze: frozen.hash,
        packageHash: info.packageHash,
        arms,
        completePairs: complete.length,
        newFailures,
        pairedProviderCostDeltas: complete.map((p) => ({
          caseId: p.caseId,
          frozenUsd: p.frozen!.cost?.providerUsd ?? null,
          learnedUsd: p.learned!.cost?.providerUsd ?? null,
          savingsUsd:
            p.frozen!.cost && p.learned!.cost
              ? p.frozen!.cost.providerUsd - p.learned!.cost.providerUsd
              : null,
        })),
        finitePanelEfficiencyTargetMet:
          complete.length === 12 &&
          newFailures === 0 &&
          arms[1].passes >= arms[0].passes &&
          arms[1].wholeSkillReads === 12 &&
          arms[1].observedHelperInvocations === 12 &&
          saving !== null &&
          arms[0].costPerVerifiedCompletion !== null &&
          saving >= arms[0].costPerVerifiedCompletion * 0.5,
        relativeCostReduction:
          saving !== null && arms[0].costPerVerifiedCompletion
            ? saving / arms[0].costPerVerifiedCompletion
            : null,
        learningUsd,
        learningUsdIsKnownCostLowerBound: true,
        priorUnresolvedLearningReserveUsd: 14.4,
        learningUsdIncludingFullPriorHold: learningUsd + 14.4,
        newRepairUsd: 0,
        breakEvenCompletionsFromKnownCosts:
          saving !== null && saving > 0 ? Math.ceil(learningUsd / saving) : null,
        breakEvenCompletionsIncludingFullPriorHold:
          saving !== null && saving > 0 ? Math.ceil((learningUsd + 14.4) / saving) : null,
        amortizedKnownCostPerCompletionAtObservedSample: arms[1].passes
          ? (learningUsd + arms[1].providerUsd) / arms[1].passes
          : null,
        amortizedCostPerCompletionIncludingFullPriorHold: arms[1].passes
          ? (learningUsd + 14.4 + arms[1].providerUsd) / arms[1].passes
          : null,
        budget: budget(),
        unstarted: schedule.filter((j) => !records.some((r) => r.id === j.id)).map((j) => j.id),
        claimLimits: [
          "Twelve authored pairs across three document genres; one bounded DOCX mechanism, no population noninferiority claim.",
          "Operator-assisted offline signed-package transfer; separate recipient process/store, no production promotion or mesh publication.",
          "Same physical host, pinned image, and model; changed resource/timezone settings. Pooled-evidence benefit remains unproven.",
          "24-hour retention is separately time-gated and reported; no visual-fidelity rating.",
          "Provider charges are usage-derived; prior unresolved reserve remains held.",
        ],
      };
      await copyJson("comparison-readout.json", result);
      console.log(JSON.stringify(result));
    } else throw new Error("Unknown comparison operation");
  }
} finally {
  await lock.close();
  await fs.unlink(path.join(root, "run.lock"));
  db.close();
}
