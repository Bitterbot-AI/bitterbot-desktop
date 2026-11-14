import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import type { AnyAgentTool } from "../../agent-tools.types.js";
import { carryToolMarkers } from "../../agent-tools.types.js";

export type PackageTrialContext = {
  workspace: string;
  packageFiles: ReadonlySet<string>;
  reads: Set<string>;
  toolCalls: number;
  maxToolCalls: number;
  skillLines?: number;
  /** Host-owned cancellation prevents model retries from spinning after tool exhaustion. */
  onBudgetExceeded?: () => void;
};
const context = new AsyncLocalStorage<PackageTrialContext>();
export function isPackageTrialActive(): boolean {
  return context.getStore() !== undefined;
}
export function withPackageTrial<T>(trial: PackageTrialContext, run: () => Promise<T>): Promise<T> {
  return context.run(trial, run);
}
export function observePackageTrialTools(
  tools: AnyAgentTool[],
  sandboxEnabled: boolean,
): AnyAgentTool[] {
  const trial = context.getStore();
  if (!trial) return tools;
  if (!sandboxEnabled) throw new Error("Package validation requires an enabled sandbox");
  return tools
    .filter((t) => ["read", "write", "edit", "exec", "process"].includes(t.name))
    .map((tool) =>
      carryToolMarkers(tool, {
        ...tool,
        execute: async (...args: Parameters<AnyAgentTool["execute"]>) => {
          if (++trial.toolCalls > trial.maxToolCalls) {
            trial.onBudgetExceeded?.();
            throw new Error("Package trial tool budget exhausted");
          }
          const params = args[1] as Record<string, unknown>;
          const raw =
            typeof params.path === "string"
              ? params.path
              : typeof params.file_path === "string"
                ? params.file_path
                : null;
          const relative = raw?.startsWith("/workspace/")
            ? raw.slice("/workspace/".length)
            : raw
              ? path
                  .relative(trial.workspace, path.resolve(trial.workspace, raw))
                  .replaceAll("\\", "/")
              : null;
          if (relative?.startsWith("skill/") && ["write", "edit"].includes(tool.name))
            throw new Error("Validation package files are immutable");
          const result = await tool.execute(...args);
          if (
            tool.name === "read" &&
            relative?.startsWith("skill/") &&
            !("isError" in result && result.isError === true)
          ) {
            const file = relative.slice(6);
            const details = result.details as { truncation?: { truncated?: boolean } } | undefined;
            const wholeInstruction =
              file !== "SKILL.md" ||
              ((params.offset === undefined || params.offset === 1) &&
                (params.limit === undefined ||
                  (typeof params.limit === "number" &&
                    params.limit >= (trial.skillLines ?? Infinity))) &&
                !details?.truncation?.truncated);
            if (trial.packageFiles.has(file) && wholeInstruction) trial.reads.add(file);
          }
          return result;
        },
      }),
    );
}
