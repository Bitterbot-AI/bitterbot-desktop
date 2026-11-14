import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type { BitterbotConfig } from "../../../config/config.js";
import { redactSensitiveText } from "../../../logging/redact.js";
import { resolveAgentDir } from "../../agent-scope.js";
import {
  captureArtifacts,
  runBoundedArtifactCheck,
  validArtifactOutputs,
  type ArtifactCheckOutcome,
  type ArtifactOutputSpec,
  type CapturedArtifact,
} from "./artifact-output.js";
import { sha256, type PackageSnapshot } from "./contracts.js";
import { withPackageTrial, type PackageTrialContext } from "./execution-context.js";
import { isolatedPackageConfig, packageHostConfiguration } from "./isolated-config.js";
import {
  RESEARCH_BRIEF_TASK_CONTRACT,
  RESEARCH_BRIEF_TASK_CONTRACT_HASH,
  ResearchBriefPublicationDateSchema,
  researchBriefUtcDate,
} from "./research-brief-contract.js";
import { resolvePackageSandboxImage, type PackageSandboxImage } from "./sandbox-image.js";
import type { PackageExecutionHost, TrialResult, ValidationTask } from "./validation.js";

const SourceSchema = z
  .object({
    id: z.string(),
    publishedAt: ResearchBriefPublicationDateSchema,
    metric: z.string(),
    value: z.number(),
    status: z.enum(["current", "superseded"]),
  })
  .strict();
const InputSchema = z
  .object({ question: z.string(), sources: z.array(SourceSchema), followUpOwner: z.string() })
  .strict();
const BriefSchema = z
  .object({
    question: z.string(),
    findings: z.array(
      z
        .object({ metric: z.string(), value: z.number(), sourceId: z.string(), date: z.string() })
        .strict(),
    ),
    uncertainties: z.array(z.string()),
    recommendation: z.string().min(1),
    followUp: z.object({ owner: z.string(), action: z.string().min(1) }).strict(),
  })
  .strict();
/** Hidden host oracle checks actual task facts; recommendation usefulness needs human ratings. */
export function checkResearchBrief(input: unknown, output: unknown): boolean {
  const task = InputSchema.parse(input),
    parsed = BriefSchema.safeParse(output);
  if (!parsed.success) return false;
  const brief = parsed.data,
    current = task.sources.filter((s) => s.status === "current");
  if (
    brief.question !== task.question ||
    brief.followUp.owner !== task.followUpOwner ||
    brief.findings.length !== current.length
  )
    return false;
  const seen = new Set<string>();
  for (const finding of brief.findings) {
    const source = current.find((s) => s.id === finding.sourceId);
    if (
      !source ||
      seen.has(source.id) ||
      source.value !== finding.value ||
      source.metric !== finding.metric ||
      researchBriefUtcDate(source.publishedAt) !== finding.date
    )
      return false;
    seen.add(source.id);
  }
  const conflict = current.some((a) =>
    current.some((b) => a.id !== b.id && a.metric === b.metric && a.value !== b.value),
  );
  return !conflict || brief.uncertainties.some((u) => /conflict|disagree|inconsistent/i.test(u));
}

export function checkResearchBriefDeliverables(
  input: unknown,
  output: unknown,
  markdown: string | null,
): boolean {
  return Boolean(markdown?.trim()) && checkResearchBrief(input, output);
}

export function researchBriefTasks(seed: string): ValidationTask[] {
  return Array.from({ length: 26 }, (_, i) => {
    if (i >= 20) seed = "fixed-research-regression-v1";
    const n = parseInt(sha256(`${seed}:${i}`).slice(0, 6), 16) % 100;
    return {
      id: `${seed}:${i}`,
      family: `research-source-family-${i}`,
      regression: i >= 20,
      input: {
        question: `What does the evidence establish for project ${seed.slice(0, 8)}-${i}?`,
        followUpOwner: `Owner ${i}`,
        sources: [
          {
            id: `old-${i}`,
            publishedAt: "2025-03-01",
            metric: "completions",
            value: n + 40,
            status: "superseded",
          },
          {
            id: `source-${i}`,
            publishedAt: "2026-03-02T00:00:00Z",
            metric: "completions",
            value: n,
            status: "current",
          },
          {
            id: `other-${i}`,
            publishedAt: "2026-03-03T00:00:00Z",
            metric: i % 2 ? "returns" : "completions",
            value: n + 1,
            status: "current",
          },
        ],
      },
    };
  });
}

export type ResearchBriefExecution = {
  runId: string;
  task: ValidationTask;
  packageHash: string | null;
  result: TrialResult;
  tokens: number;
  latencyMs: number;
  brief: unknown;
  markdown: string | null;
  artifacts?: CapturedArtifact[];
  diagnostic?: { kind: string; message: string } | null;
};
/** Trusted study instrumentation. Never exposed as an agent tool or package callback. */
export type ResearchBriefHostOptions = {
  tasks?: readonly ValidationTask[];
  selectionTasks?: () => readonly ValidationTask[];
  acquisitionTaskHashes?: ReadonlySet<string>;
  onExecution?: (execution: ResearchBriefExecution) => Promise<void>;
  /** Trusted host extension for separately frozen research task contracts.
   * Never accepted from a package, peer message, agent tool or gateway request.
   * Input remains sources.json. Default outputs are brief.json + brief.md;
   * artifact protocols instead declare exact bounded output filenames. */
  protocol?: {
    id: string;
    version: string;
    prompt: string;
    checkerHash: string;
    maxOutputBytes?: number;
    /** Trusted operator task limit; never supplied by packages or agent tools. */
    agentTimeoutMs?: number;
    /** Fingerprint of all permitted auxiliary inputs, supplied by trusted host code. */
    inputFilesHash?: string;
    inputFiles?: (
      task: ValidationTask,
    ) => Promise<readonly { name: string; bytes: Uint8Array; sha256: string }[]>;
    artifacts?: {
      files: readonly ArtifactOutputSpec[];
      /** Host verification time is reserved separately from the model's task deadline. */
      timeoutMs: number;
      check: (
        task: ValidationTask,
        files: readonly CapturedArtifact[],
        signal: AbortSignal,
      ) => ArtifactCheckOutcome | Promise<ArtifactCheckOutcome>;
    };
    acceptsInput: (input: unknown) => boolean;
    checkDeliverables: (
      task: ValidationTask,
      output: unknown,
      markdown: string | null,
    ) => boolean | Promise<boolean>;
  };
};

export async function createResearchBriefHost(
  config: BitterbotConfig,
  agentId: string,
  node: string,
  seed: string,
  pinnedImage?: PackageSandboxImage,
  options: ResearchBriefHostOptions = {},
): Promise<PackageExecutionHost> {
  const protocol = options.protocol;
  if (
    protocol &&
    (!/^[a-z][a-z0-9-]{0,79}$/.test(protocol.id) ||
      !protocol.version ||
      !protocol.prompt.trim() ||
      !/^[a-f0-9]{64}$/.test(protocol.checkerHash) ||
      Boolean(protocol.inputFiles) !== Boolean(protocol.inputFilesHash) ||
      (protocol.inputFilesHash !== undefined && !/^[a-f0-9]{64}$/.test(protocol.inputFilesHash)) ||
      (protocol.agentTimeoutMs !== undefined &&
        (!Number.isInteger(protocol.agentTimeoutMs) ||
          protocol.agentTimeoutMs < 1000 ||
          protocol.agentTimeoutMs > 600000)) ||
      (protocol.artifacts !== undefined &&
        (!validArtifactOutputs(protocol.artifacts.files) ||
          !Number.isInteger(protocol.artifacts.timeoutMs) ||
          protocol.artifacts.timeoutMs < 1000 ||
          protocol.artifacts.timeoutMs > 180000 ||
          typeof protocol.artifacts.check !== "function")) ||
      (protocol.maxOutputBytes !== undefined &&
        (!Number.isInteger(protocol.maxOutputBytes) ||
          protocol.maxOutputBytes < 1 ||
          protocol.maxOutputBytes > 2 * 1024 * 1024)))
  )
    throw new Error("Invalid host-owned research protocol");
  const agentTimeoutMs = protocol?.agentTimeoutMs ?? 120000;
  const spec = config.skills?.collective?.validationModel;
  if (!spec || !spec.includes("/"))
    throw new Error("Configure skills.collective.validationModel before paid validation");
  const slash = spec.indexOf("/"),
    provider = spec.slice(0, slash),
    modelId = spec.slice(slash + 1);
  const { resolveModel } = await import("../../embedded-runner/model.js");
  const resolved = resolveModel(provider, modelId, resolveAgentDir(config, agentId), config);
  if (!resolved.model) throw new Error("Validation model unavailable");
  const rates = resolved.model.cost;
  if (!rates || Object.values(rates).some((n) => !Number.isFinite(n) || n < 0))
    throw new Error("Validation model needs pinned cost rates");
  const image = pinnedImage ?? (await resolvePackageSandboxImage(config, agentId));
  return {
    node,
    publicContract: {
      id: protocol?.id ?? "research-brief",
      version: protocol?.version ?? RESEARCH_BRIEF_TASK_CONTRACT.version,
      instructions: protocol?.prompt ?? RESEARCH_BRIEF_TASK_CONTRACT.prompt,
    },
    environment: {
      model: spec,
      tools: {
        "research-brief": "1",
        read: "1",
        write: "1",
        edit: "1",
        exec: "1",
        process: "1",
        python3: "3",
      },
      runtime: {
        sandbox: "docker-network-none",
        checker: protocol?.version ?? RESEARCH_BRIEF_TASK_CONTRACT.version,
        dateBasis: protocol ? "protocol-defined" : RESEARCH_BRIEF_TASK_CONTRACT.dateBasis,
        taskContract: protocol
          ? sha256(
              JSON.stringify({
                id: protocol.id,
                version: protocol.version,
                prompt: protocol.prompt,
                maxOutputBytes: protocol.maxOutputBytes ?? 100000,
                ...(protocol.agentTimeoutMs !== undefined ? { agentTimeoutMs } : {}),
                ...(protocol.inputFilesHash ? { inputFilesHash: protocol.inputFilesHash } : {}),
                ...(protocol.artifacts
                  ? {
                      artifactOutputs: protocol.artifacts.files,
                      artifactCheckerTimeoutMs: protocol.artifacts.timeoutMs,
                    }
                  : {}),
              }),
            )
          : RESEARCH_BRIEF_TASK_CONTRACT_HASH,
        platform: "linux",
        hostConfiguration: packageHostConfiguration(config, agentId),
        modelDefinition: sha256(JSON.stringify(resolved.model)),
        sandboxImage: image.id,
        architecture: image.architecture,
      },
      checkerHash:
        protocol?.checkerHash ??
        sha256(
          JSON.stringify({
            taskContract: RESEARCH_BRIEF_TASK_CONTRACT,
            inputSchema: z.toJSONSchema(InputSchema),
            outputSchema: z.toJSONSchema(BriefSchema),
            dateConversion: researchBriefUtcDate.toString(),
            facts: checkResearchBrief.toString(),
            deliverables: checkResearchBriefDeliverables.toString(),
          }),
        ),
    },
    tasks: options.tasks ?? researchBriefTasks(seed),
    acquisitionTaskHashes: options.acquisitionTaskHashes ?? new Set(),
    selectionTasks: options.selectionTasks ?? (() => researchBriefTasks(randomUUID())),
    quote: () => ({
      providerUsd: (rates.input + rates.cacheRead + rates.cacheWrite) * 0.4 + rates.output * 0.1,
      toolCalls: protocol?.artifacts ? 21 : 20,
      wallMs: agentTimeoutMs + (protocol?.artifacts?.timeoutMs ?? 0),
    }),
    async execute(task, snapshot: PackageSnapshot | null, signal) {
      const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "bitterbot-package-trial-"));
      const runId = randomUUID(),
        started = Date.now();
      const trial: PackageTrialContext = {
        workspace,
        reads: new Set(),
        packageFiles: new Set(snapshot?.files.keys() ?? []),
        skillLines: snapshot?.files.get("SKILL.md")?.toString("utf8").split("\n").length,
        toolCalls: 0,
        maxToolCalls: 20,
      };
      let recorded: TrialResult = { outcome: "infrastructure", cost: null, accessedFiles: [] };
      let runnerInvoked = false;
      let tokens = 0;
      let brief: unknown = null;
      let markdown: string | null = null;
      let artifacts: CapturedArtifact[] | undefined;
      let verificationInvoked = false;
      let diagnostic: ResearchBriefExecution["diagnostic"] = null;
      const diagnose = (kind: string, message: string) => {
        diagnostic = {
          kind,
          message: redactSensitiveText(message, { mode: "tools" }).slice(0, 4096),
        };
      };
      const readOutput = async (name: "brief.json" | "brief.md") => {
        const filename = path.join(workspace, name),
          stat = await fs.lstat(filename);
        if (
          !stat.isFile() ||
          stat.isSymbolicLink() ||
          stat.nlink !== 1 ||
          stat.size > (protocol?.maxOutputBytes ?? 100000) ||
          (await fs.realpath(filename)) !== filename
        )
          throw new Error("Invalid brief output");
        return fs.readFile(filename, "utf8");
      };
      const finish = (value: TrialResult): TrialResult => {
        if (protocol?.artifacts && value.cost) {
          value.cost = {
            ...value.cost,
            wallMs: Date.now() - started,
            toolCalls: trial.toolCalls + Number(verificationInvoked),
          };
        }
        recorded = value;
        return value;
      };
      try {
        if (signal.aborted)
          return finish({
            outcome: "interrupted",
            cost: { providerUsd: 0, toolCalls: 0, wallMs: Date.now() - started },
            accessedFiles: [],
          });
        if (
          !(protocol
            ? protocol.acceptsInput(task.input)
            : InputSchema.safeParse(task.input).success)
        ) {
          diagnose(
            "task-input-invalid",
            protocol
              ? `Task input does not satisfy the host-owned ${protocol.id} contract`
              : "Task input must satisfy the research-brief contract, including valid date-only values or timestamps with an explicit timezone",
          );
          return finish({
            outcome: "checker-invalid",
            cost: { providerUsd: 0, toolCalls: 0, wallMs: Date.now() - started },
            accessedFiles: [],
          });
        }
        await fs.writeFile(path.join(workspace, "sources.json"), JSON.stringify(task.input));
        if (protocol?.inputFiles) {
          // Flat names avoid traversal, platform aliases and collisions with host outputs.
          // Auxiliary inputs never include checkers or expected answers.
          const files = await protocol.inputFiles(task);
          const names = new Set([
            "sources.json",
            "brief.json",
            "brief.md",
            "session.jsonl",
            "skill",
          ]);
          let totalBytes = 0;
          if (files.length > 32) throw new Error("Too many host input files");
          for (const file of files) {
            totalBytes += file.bytes.byteLength;
            if (
              !/^[a-z][a-z0-9_-]{0,63}\.[a-z0-9]{1,12}$/.test(file.name) ||
              /^(con|prn|aux|nul|com[0-9]|lpt[0-9])\./.test(file.name) ||
              names.has(file.name) ||
              totalBytes > 1024 * 1024 * 1024 ||
              sha256(file.bytes) !== file.sha256
            )
              throw new Error("Invalid host input file");
            names.add(file.name);
          }
          for (const file of files)
            await fs.writeFile(path.join(workspace, file.name), file.bytes, {
              flag: "wx",
              mode: 0o444,
            });
        }
        if (snapshot)
          for (const [name, bytes] of snapshot.files) {
            const target = path.join(workspace, "skill", name);
            await fs.mkdir(path.dirname(target), { recursive: true });
            await fs.writeFile(target, bytes, {
              mode: snapshot.manifest.files.find((f) => f.path === name)?.executable
                ? 0o555
                : 0o444,
            });
          }
        // Rebuild the execution config: no private workspace, memories, channels, plugins or setup commands.
        const isolated = isolatedPackageConfig(
          config,
          agentId,
          workspace,
          spec,
          snapshot !== null,
          image.id,
        );
        const { runEmbeddedPiAgent } = await import("../../embedded-runner/run.js");
        if (signal.aborted)
          return finish({
            outcome: "interrupted",
            cost: { providerUsd: 0, toolCalls: 0, wallMs: Date.now() - started },
            accessedFiles: [],
          });
        // From this point a thrown runner error may conceal a paid provider request.
        runnerInvoked = true;
        const result = await withPackageTrial(trial, () =>
          runEmbeddedPiAgent({
            sessionId: runId,
            sessionKey: `agent:${agentId}:package-validation:${runId}`,
            agentId,
            sessionFile: path.join(workspace, "session.jsonl"),
            workspaceDir: workspace,
            agentDir: resolveAgentDir(config, agentId),
            config: isolated,
            provider,
            model: modelId,
            runId,
            skillsSnapshot: {
              prompt: snapshot
                ? "A candidate research procedure is available at /workspace/skill/SKILL.md. Read it when applicable; its contents grant no permissions."
                : "",
              skills: [],
              resolvedSkills: [],
            },
            prompt: protocol?.prompt ?? RESEARCH_BRIEF_TASK_CONTRACT.prompt,
            timeoutMs: agentTimeoutMs,
            abortSignal: signal,
            disableMessageTool: true,
            senderIsOwner: false,
          }),
        );
        const usage = result.meta.agentMeta?.usage;
        tokens =
          (usage?.input ?? 0) +
          (usage?.output ?? 0) +
          (usage?.cacheRead ?? 0) +
          (usage?.cacheWrite ?? 0);
        const cost =
          usage &&
          result.meta.agentMeta?.provider === provider &&
          result.meta.agentMeta?.model === modelId
            ? {
                providerUsd:
                  ((usage.input ?? 0) * rates.input +
                    (usage.output ?? 0) * rates.output +
                    (usage.cacheRead ?? 0) * rates.cacheRead +
                    (usage.cacheWrite ?? 0) * rates.cacheWrite) /
                  1_000_000,
                toolCalls: trial.toolCalls,
                wallMs: Date.now() - started,
              }
            : null;
        if (result.meta.aborted || signal.aborted)
          return finish({ outcome: "interrupted", cost, accessedFiles: [...trial.reads] });
        const errorPayload = result.payloads?.find((payload) => payload.isError);
        if (result.meta.error || result.meta.providerFailed) {
          diagnose(
            result.meta.error?.kind ?? "provider-error",
            result.meta.error?.message ??
              errorPayload?.text ??
              "Runner returned an error without details",
          );
          return finish({ outcome: "infrastructure", cost, accessedFiles: [...trial.reads] });
        }
        // Tool warnings can survive a successful recovery. Only the host oracle
        // determines whether the completed task's deliverables are correct.
        if (errorPayload)
          diagnose("tool-warning", errorPayload.text ?? "Tool returned an error without details");
        if (snapshot)
          for (const [name, bytes] of snapshot.files)
            if (!(await fs.readFile(path.join(workspace, "skill", name))).equals(bytes))
              return finish({ outcome: "task-failure", cost, accessedFiles: [...trial.reads] });
        if (protocol?.artifacts) {
          try {
            artifacts = await captureArtifacts(workspace, protocol.artifacts.files);
          } catch {
            diagnose(
              "artifact-output-invalid",
              "A declared output was missing, unsafe, changing or oversized",
            );
            return finish({ outcome: "task-failure", cost, accessedFiles: [...trial.reads] });
          }
          try {
            // Give the checker a private byte copy; preserve the captured bytes for the audit trail.
            verificationInvoked = true;
            const checker = protocol.artifacts;
            const checkerFiles = artifacts.map((file) => ({
              ...file,
              bytes: Buffer.from(file.bytes),
            }));
            const checked = await runBoundedArtifactCheck(
              (checkerSignal) => checker.check(task, checkerFiles, checkerSignal),
              checker.timeoutMs,
              signal,
            );
            return finish({
              outcome: signal.aborted
                ? "interrupted"
                : checked === true
                  ? "pass"
                  : checked === false
                    ? "task-failure"
                    : checked === "infrastructure"
                      ? "infrastructure"
                      : "checker-invalid",
              cost,
              accessedFiles: [...trial.reads],
            });
          } catch {
            return finish({
              outcome: signal.aborted ? "interrupted" : "checker-invalid",
              cost,
              accessedFiles: [...trial.reads],
            });
          }
        }
        let output: unknown;
        markdown = await readOutput("brief.md").catch(() => null);
        try {
          output = JSON.parse(await readOutput("brief.json"));
          brief = output;
        } catch {
          return finish({ outcome: "task-failure", cost, accessedFiles: [...trial.reads] });
        }
        try {
          const correct = protocol
            ? await protocol.checkDeliverables(task, output, markdown)
            : checkResearchBriefDeliverables(task.input, output, markdown);
          return finish({
            outcome: signal.aborted ? "interrupted" : correct ? "pass" : "task-failure",
            cost,
            accessedFiles: [...trial.reads],
          });
        } catch {
          return finish({
            outcome: signal.aborted ? "interrupted" : "checker-invalid",
            cost,
            accessedFiles: [...trial.reads],
          });
        }
      } catch (error) {
        if (signal.aborted) recorded = { ...recorded, outcome: "interrupted" };
        if (!runnerInvoked)
          recorded = {
            ...recorded,
            cost: { providerUsd: 0, toolCalls: 0, wallMs: Date.now() - started },
          };
        diagnose("execution-error", error instanceof Error ? error.message : String(error));
        throw error;
      } finally {
        try {
          if (options.onExecution) {
            await options.onExecution({
              runId,
              task,
              packageHash: snapshot?.packageHash ?? null,
              result: recorded,
              tokens,
              latencyMs: Date.now() - started,
              brief,
              markdown,
              ...(artifacts ? { artifacts } : {}),
              diagnostic,
            });
          }
        } finally {
          await fs.rm(workspace, { recursive: true, force: true });
        }
      }
    },
  };
}
