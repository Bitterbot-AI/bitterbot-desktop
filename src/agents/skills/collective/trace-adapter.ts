export type NormalizedSkillTrace = {
  framework: string;
  taskId: string;
  skillVersion: string;
  sourceHash: string;
  evidence: "unverified" | "reported-outcome";
  environment: Record<string, string>;
  actions: Array<{ id: string; tool: string; argumentsHash: string; resultHash: string | null }>;
  feedbackHash: string | null;
  outcomeProvenance: "external-export-without-trusted-checker";
  costs: { providerUsd: number; toolCalls: number; wallMs: number } | null;
};
export interface SkillTraceAdapter {
  framework: string;
  normalize(
    input: string,
    context: { taskId: string; skillVersion: string; environment?: Record<string, string> },
  ): NormalizedSkillTrace;
}
