import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { BitterbotConfig } from "../../../config/config.js";
import { redactSensitiveText } from "../../../logging/redact.js";
import { resolveAgentDir } from "../../agent-scope.js";
import type { PackageSnapshot } from "./contracts.js";
import type { PackageProposalHost } from "./evidence.js";
import { withPackageTrial, type PackageTrialContext } from "./execution-context.js";
import { isolatedPackageConfig } from "./isolated-config.js";
import { snapshotPackage } from "./package.js";
import {
  CompletedProposalError,
  proposalContext,
  type PublicTaskContract,
} from "./proposal-context.js";
import { resolvePackageSandboxImage } from "./sandbox-image.js";

export type PackageProposalExecution = {
  runId: string;
  outcome: "completed" | "interrupted" | "infrastructure" | "invalid-package";
  timeoutMs: number;
  wallMs: number;
  toolCalls: number;
  accessedFiles: string[];
  observedUsage: { input: number; output: number; cacheRead: number; cacheWrite: number } | null;
  /** Partial observed usage must never settle an interrupted reservation. */
  cost: { providerUsd: number; toolCalls: number; wallMs: number } | null;
  diagnostic: { kind: string; message: string } | null;
  /** A bounded byte copy for host quarantine only; no execution qualification implied. */
  candidate: PackageSnapshot | null;
  candidateQualification: "unvalidated";
};

/** Trusted host instrumentation, never accepted from an agent, package or RPC payload. */
export type PackageProposalHostOptions = {
  publicContract?: PublicTaskContract;
  agentTimeoutMs?: number;
  /** Store only in a dedicated private audit/quarantine, never conversational memory.
   * No raw transcript, environment variables, credentials or checker content is supplied. */
  onExecution?: (execution: PackageProposalExecution) => Promise<void>;
};

/** Host orchestration supplies bounded evidence, never Circle tables or held-out tasks. */
export async function createPackageProposalHost(
  config: BitterbotConfig,
  agent: string,
  options: PackageProposalHostOptions = {},
): Promise<PackageProposalHost> {
  const preflightStarted = Date.now();
  const agentTimeoutMs = options.agentTimeoutMs ?? 120000;
  if (!Number.isInteger(agentTimeoutMs) || agentTimeoutMs < 1000 || agentTimeoutMs > 600000)
    throw new Error("Invalid host-owned proposal timeout");
  const specification = proposalContext(options.publicContract);
  const spec = config.skills?.collective?.validationModel;
  if (!spec?.includes("/")) throw new Error("Proposal model not configured");
  const slash = spec.indexOf("/"),
    provider = spec.slice(0, slash),
    modelId = spec.slice(slash + 1);
  const { resolveModel } = await import("../../embedded-runner/model.js");
  const resolved = resolveModel(provider, modelId, resolveAgentDir(config, agent), config);
  const rates = resolved.model?.cost;
  if (!rates || Object.values(rates).some((n) => !Number.isFinite(n) || n < 0))
    throw new Error("Proposal model needs known cost rates");
  const image = await resolvePackageSandboxImage(config, agent);
  // Cold module loading is preflight, not part of the reserved model task. It
  // previously consumed the 120-second wall quote before the runner even began.
  const { runEmbeddedPiAgent } = await import("../../embedded-runner/run.js");
  return {
    taskContractHash: specification.taskContractHash,
    preflightWallMs: Date.now() - preflightStarted,
    quote: {
      providerUsd: (rates.input + rates.cacheRead + rates.cacheWrite) * 0.4 + rates.output * 0.1,
      toolCalls: 20,
      wallMs: agentTimeoutMs + 30000,
    },
    async propose({ parent, evidence }, signal) {
      if (
        evidence.length > 32 ||
        JSON.stringify(evidence).length > 16000 ||
        new Set(evidence.map((e) => e.evidence.origin)).size > 8
      )
        throw new Error("Proposal evidence exceeds bounds");
      const workspace = await fs.realpath(
        await fs.mkdtemp(path.join(os.tmpdir(), "bitterbot-package-proposal-")),
      );
      const runId = randomUUID(),
        started = Date.now();
      const toolBudget = new AbortController();
      const runSignal = AbortSignal.any([signal, toolBudget.signal]);
      const context: PackageTrialContext = {
        workspace,
        packageFiles: new Set(parent.files.keys()),
        reads: new Set(),
        toolCalls: 0,
        maxToolCalls: 20,
        onBudgetExceeded: () => toolBudget.abort(),
        skillLines: parent.files.get("SKILL.md")?.toString("utf8").split("\n").length,
      };
      let completedCost: { providerUsd: number; toolCalls: number; wallMs: number } | null = null;
      let observedUsage: PackageProposalExecution["observedUsage"] = null;
      let diagnostic: PackageProposalExecution["diagnostic"] = null;
      let outcome: PackageProposalExecution["outcome"] = "infrastructure";
      let candidate: PackageSnapshot | null = null;
      let reported = false;
      const cleanup = async () => {
        try {
          await fs.rm(workspace, { recursive: true, force: true });
        } catch (error) {
          // A cleanup failure prevents publication without losing settled usage.
          if (completedCost)
            throw new CompletedProposalError(
              { ...completedCost, wallMs: Date.now() - started },
              "cleanup-failed",
            );
          throw error;
        }
      };
      const captureCandidate = () =>
        snapshotPackage(path.join(workspace, "candidate"), {
          name: parent.manifest.name,
          description: parent.manifest.description,
          requirements: parent.manifest.requirements,
        });
      const observe = async () => {
        if (!options.onExecution || reported) return;
        reported = true;
        // The callback cannot mutate the proposal that will be returned for screening.
        const copy = candidate
          ? {
              ...candidate,
              manifest: structuredClone(candidate.manifest),
              omitted: structuredClone(candidate.omitted),
              files: new Map(
                [...candidate.files].map(([name, bytes]) => [name, Buffer.from(bytes)]),
              ),
            }
          : null;
        await options.onExecution({
          runId,
          outcome,
          timeoutMs: agentTimeoutMs,
          wallMs: Date.now() - started,
          toolCalls: context.toolCalls,
          accessedFiles: [...context.reads],
          observedUsage,
          cost: completedCost ? { ...completedCost } : null,
          diagnostic,
          candidate: copy,
          candidateQualification: "unvalidated",
        });
      };
      try {
        for (const [name, bytes] of parent.files)
          for (const folder of ["skill", "candidate"]) {
            const target = path.join(workspace, folder, name);
            await fs.mkdir(path.dirname(target), { recursive: true });
            await fs.writeFile(target, bytes, {
              mode: parent.manifest.files.find((f) => f.path === name)?.executable ? 0o700 : 0o600,
            });
          }
        await fs.writeFile(path.join(workspace, "observations.json"), JSON.stringify(evidence));
        const cfg = isolatedPackageConfig(config, agent, workspace, spec, true, image.id);
        const result = await withPackageTrial(context, () =>
          runEmbeddedPiAgent({
            agentId: agent,
            agentDir: resolveAgentDir(config, agent),
            sessionId: runId,
            sessionKey: `agent:${agent}:package-proposal:${runId}`,
            sessionFile: path.join(workspace, "session.jsonl"),
            workspaceDir: workspace,
            config: cfg,
            provider,
            model: modelId,
            runId,
            timeoutMs: agentTimeoutMs,
            abortSignal: runSignal,
            disableMessageTool: true,
            senderIsOwner: false,
            skillsSnapshot: { prompt: "", skills: [], resolvedSkills: [] },
            prompt: specification.prompt,
          }),
        );
        const usage = result.meta.agentMeta?.usage;
        if (usage)
          observedUsage = {
            input: usage.input ?? 0,
            output: usage.output ?? 0,
            cacheRead: usage.cacheRead ?? 0,
            cacheWrite: usage.cacheWrite ?? 0,
          };
        if (result.meta.error)
          diagnostic = {
            kind: result.meta.error.kind,
            message: redactSensitiveText(result.meta.error.message).slice(0, 512),
          };
        if (result.meta.aborted || runSignal.aborted) outcome = "interrupted";
        if (
          !usage ||
          result.meta.agentMeta?.provider !== provider ||
          result.meta.agentMeta?.model !== modelId ||
          result.meta.aborted ||
          runSignal.aborted
        )
          throw new Error("Proposal cost unresolved or interrupted");
        const cost = {
          providerUsd:
            ((usage.input ?? 0) * rates.input +
              (usage.output ?? 0) * rates.output +
              (usage.cacheRead ?? 0) * rates.cacheRead +
              (usage.cacheWrite ?? 0) * rates.cacheWrite) /
            1000000,
          toolCalls: context.toolCalls,
          wallMs: Date.now() - started,
        };
        completedCost = cost;
        if (result.meta.error || result.meta.providerFailed)
          throw new Error("Proposal runner failed; candidate remains unvalidated");
        outcome = "invalid-package";
        const snapshot = await captureCandidate();
        candidate = snapshot;
        outcome = "completed";
        await observe();
        return {
          snapshot,
          cost: { ...cost, wallMs: Date.now() - started },
          tokens:
            (usage.input ?? 0) +
            (usage.output ?? 0) +
            (usage.cacheRead ?? 0) +
            (usage.cacheWrite ?? 0),
        };
      } catch (error) {
        if (runSignal.aborted && !completedCost) outcome = "interrupted";
        diagnostic ??= {
          kind: error instanceof Error ? error.name : "proposal-error",
          message: redactSensitiveText(
            error instanceof Error ? error.message : "Proposal failed",
          ).slice(0, 512),
        };
        if (options.onExecution && !reported) {
          candidate ??= await captureCandidate().catch(() => null);
          try {
            await observe();
          } catch {
            /* Preserve original outcome and cost; cleanup still runs. */
          }
        }
        if (completedCost)
          throw new CompletedProposalError({ ...completedCost, wallMs: Date.now() - started });
        throw error;
      } finally {
        await cleanup();
      }
    },
  };
}
