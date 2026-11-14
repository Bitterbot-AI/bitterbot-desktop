import type { createResearchBriefHost } from "../../src/agents/skills/collective/research-brief.js";
import type { PackageExecutionHost } from "../../src/agents/skills/collective/validation.js";
import type { BitterbotConfig } from "../../src/config/config.js";
import type { DeploymentSpec, StudyCorpus } from "./deployment-contract.js";
import type { Charge } from "./study-ledger.js";
import type { PairedObservation, CONDITIONS } from "./study.js";

export type NodeDescriptor = {
  node: "a" | "b";
  publisher: string;
  url: string;
  environment: PackageExecutionHost["environment"];
  packageHash: string;
  pid: number;
};
export type StudyAccounting = {
  reserve(charge: Charge): Promise<void>;
  finish(id: string, row: PairedObservation, artifact: unknown): Promise<void>;
};
export type NodeOptions = {
  directory: string;
  node: "a" | "b";
  condition: (typeof CONDITIONS)[number];
  spec: DeploymentSpec;
  config: BitterbotConfig;
  corpus: StudyCorpus;
  accounting: StudyAccounting;
  hostFactory?: typeof createResearchBriefHost;
};

export function assertRetentionReady(
  state: { learningEndedAt: string | null; finalRanAt: string | null },
  hours: number,
  now = Date.now(),
): void {
  if (!state.finalRanAt) throw new Error("Initial final evaluation must precede retention");
  if (!state.learningEndedAt || now - Number(state.learningEndedAt) < hours * 3600000)
    throw new Error("Retention is not due; 24 real hours and fresh sessions are required");
}
