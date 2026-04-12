/**
 * BioMemEval Custom Reporter: collects test results and outputs a structured
 * JSON report with per-suite scores and a weighted composite.
 *
 * Results are written to benchmarks/biomemeval/results/biomemeval-report.json
 * and a summary table is printed to stdout.
 */

import type { Reporter, File, Task } from "vitest";
import fs from "node:fs";
import path from "node:path";

interface SuiteScore {
  name: string;
  weight: number;
  total: number;
  passed: number;
  failed: number;
  percentage: number;
}

const SUITE_WEIGHTS: Record<string, number> = {
  "01-zeigarnik": 20,
  "02-mood-congruent": 20,
  "03-reconsolidation": 20,
  "04-temporal": 15,
  "05-identity": 15,
  "06-prospective": 10,
};

function extractSuiteId(filename: string): string {
  const match = filename.match(/(\d{2}-[\w-]+)\.test/);
  return match?.[1] ?? "unknown";
}

export default class BioMemEvalReporter implements Reporter {
  private startTime = Date.now();

  onInit(): void {
    this.startTime = Date.now();
  }

  onFinished(files?: File[]): void {
    if (!files) {
      return;
    }

    const suites: SuiteScore[] = [];

    for (const file of files) {
      const suiteId = extractSuiteId(file.name);
      const weight = SUITE_WEIGHTS[suiteId] ?? 0;

      let passed = 0;
      let failed = 0;

      const countTasks = (tasks: Task[]) => {
        for (const task of tasks) {
          if (task.type === "test") {
            if (task.result?.state === "pass") {
              passed++;
            } else if (task.result?.state === "fail") {
              failed++;
            }
          } else if (task.type === "suite" && task.tasks) {
            countTasks(task.tasks);
          }
        }
      };

      countTasks(file.tasks);
      const total = passed + failed;
      const percentage = total > 0 ? (passed / total) * 100 : 0;

      suites.push({
        name: suiteId,
        weight,
        total,
        passed,
        failed,
        percentage,
      });
    }

    const totalWeight = suites.reduce((s, suite) => s + suite.weight, 0);
    const composite =
      totalWeight > 0
        ? suites.reduce((s, suite) => s + suite.percentage * suite.weight, 0) / totalWeight
        : 0;

    const report = {
      system: "Bitterbot",
      version: "2026.2.15-beta",
      timestamp: new Date().toISOString(),
      suites: suites.map((s) => ({
        suiteId: s.name,
        weight: s.weight,
        scenarios: s.total,
        passed: s.passed,
        failed: s.failed,
        percentage: Math.round(s.percentage * 100) / 100,
      })),
      compositeScore: Math.round(composite * 100) / 100,
      metadata: {
        runDurationMs: Date.now() - this.startTime,
        nodeVersion: process.version,
        platform: process.platform,
      },
    };

    // Write JSON report
    const outDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), "results");
    try {
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(
        path.join(outDir, "biomemeval-report.json"),
        JSON.stringify(report, null, 2) + "\n",
      );
    } catch {
      // Results dir may not be writable in CI
    }

    // Print summary table
    console.log("\n" + "=".repeat(70));
    console.log("  BioMemEval — Biological Agent Memory Benchmark");
    console.log("=".repeat(70));
    console.log("");
    console.log(
      "  Suite".padEnd(30) + "Weight".padEnd(10) + "Pass".padEnd(8) + "Fail".padEnd(8) + "Score",
    );
    console.log("  " + "-".repeat(62));

    for (const s of suites) {
      const scorePct = `${Math.round(s.percentage)}%`;
      console.log(
        `  ${s.name.padEnd(28)}${String(s.weight + "%").padEnd(10)}${String(s.passed).padEnd(8)}${String(s.failed).padEnd(8)}${scorePct}`,
      );
    }

    console.log("  " + "-".repeat(62));
    console.log(
      `  ${"COMPOSITE".padEnd(28)}${"100%".padEnd(10)}${"".padEnd(16)}${Math.round(composite)}%`,
    );
    console.log("");
    console.log(`  System: ${report.system} v${report.version}`);
    console.log(`  Duration: ${report.metadata.runDurationMs}ms`);
    console.log(`  Report: benchmarks/biomemeval/results/biomemeval-report.json`);
    console.log("=".repeat(70) + "\n");
  }
}
