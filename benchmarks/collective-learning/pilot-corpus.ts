import { sha256 } from "../../src/agents/skills/collective/contracts.js";
import {
  NODE_IDS,
  validateCorpus,
  type StudyCorpus,
  type StudyTask,
} from "./deployment-contract.js";

/** Authored fixtures for development feasibility, never evidence of real-user efficacy. */
export function createPilotCorpus(seed = 20261111): StudyCorpus {
  const tasks: StudyTask[] = [];
  const metrics = [
    "completion rate",
    "weekly retention",
    "response latency",
    "energy consumption",
    "delivery failures",
    "support resolution",
    "trial enrollment",
    "inventory errors",
    "training completion",
    "water use",
    "inspection findings",
    "travel time",
    "library attendance",
    "backlog",
    "defect rate",
    "response count",
    "availability",
    "cost per unit",
    "recovery time",
    "survey participation",
  ];
  for (const partition of ["acquisition", "selection", "final"] as const) {
    for (const node of NODE_IDS) {
      const count = partition === "selection" ? 406 : partition === "final" ? 40 : 20;
      for (let i = 0; i < count; i++) {
        const id = `${partition}-${node}-${i}`;
        const n = parseInt(sha256(`${seed}:${id}`).slice(0, 6), 16) % 500;
        const date = node === "a" ? "2026-02-04T09:00:00Z" : "2026-02-04T23:30:00-05:00";
        const metric = metrics[i % metrics.length];
        const input: StudyTask["input"] = {
          question: `Assess ${metric} for ${partition} project ${node}-${i}, distinguishing current evidence, uncertainty and follow-up.`,
          followUpOwner: `${partition === "final" && i % 2 ? "New" : "Existing"} owner ${node}-${i}`,
          sources: [
            {
              id: `${id}-old`,
              publishedAt: "2025-11-03",
              metric,
              value: n + 100,
              status: "superseded",
            },
            {
              id: `${id}-current`,
              publishedAt: date,
              metric,
              value: n / ((i % 3) + 1),
              status: "current",
            },
            ...Array.from({ length: (i % 5) + 1 }, (_, j) => ({
              id: `${id}-support-${j}`,
              publishedAt: `2026-02-${String(6 + j).padStart(2, "0")}`,
              metric: i % 2 ? `${metric} subgroup ${j}` : metric,
              value: n + j,
              status: "current" as const,
            })),
          ],
        };
        tasks.push({
          id,
          family: `${partition}-family-${partition === "final" ? Math.floor(i / 2) : i % 20}`,
          corpus: `${partition}-corpus-${i}`,
          partition,
          node,
          user: `${partition === "final" && i % 2 ? "unseen" : "known"}-${node}`,
          environment: node === "a" ? "utc-source-dates" : "offset-source-dates",
          newUser: partition === "final" && i % 2 === 1,
          regression: partition === "selection" && i >= 400,
          selectionPanel: partition === "selection" ? Math.floor(i / 20) : 0,
          input,
        });
      }
    }
  }
  return validateCorpus({ schemaVersion: 1, provenance: "authored-development-fixtures", tasks });
}
