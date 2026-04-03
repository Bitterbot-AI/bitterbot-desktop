/**
 * BioMemEval Report Generator
 *
 * Reads vitest JSON output and produces the BioMemEval structured report
 * with per-suite weighted scores and a composite.
 *
 * Usage: node --import tsx benchmarks/biomemeval/generate-report.ts
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const inputPath = path.join(dir, "results", "vitest-results.json");
const outputPath = path.join(dir, "results", "biomemeval-report.json");

const SUITE_META: Record<string, { name: string; weight: number }> = {
  "01-zeigarnik-proactivity": { name: "Zeigarnik Proactivity", weight: 20 },
  "02-mood-congruent": { name: "Mood-Congruent Retrieval", weight: 20 },
  "03-reconsolidation": { name: "Reconsolidation Accuracy", weight: 20 },
  "04-temporal-reasoning": { name: "Temporal Reasoning", weight: 15 },
  "05-identity-continuity": { name: "Identity Continuity", weight: 15 },
  "06-prospective-memory": { name: "Prospective Memory", weight: 10 },
};

function extractSuiteId(filename: string): string {
  const match = filename.match(/(\d{2}-[\w-]+)\.test/);
  return match?.[1] ?? "unknown";
}

try {
  const raw = JSON.parse(fs.readFileSync(inputPath, "utf-8"));
  const testResults = raw.testResults ?? [];

  const suites = testResults.map((file: any) => {
    const suiteId = extractSuiteId(file.name ?? "");
    const meta = SUITE_META[suiteId] ?? { name: suiteId, weight: 0 };

    const scenarios = (file.assertionResults ?? []).map((test: any) => ({
      name: test.title ?? test.fullName ?? "unknown",
      status: test.status,
      duration: test.duration,
    }));

    const passed = scenarios.filter((s: any) => s.status === "passed").length;
    const failed = scenarios.filter((s: any) => s.status === "failed").length;
    const total = passed + failed;
    const percentage = total > 0 ? (passed / total) * 100 : 0;

    return {
      suiteId,
      suiteName: meta.name,
      weight: meta.weight,
      scenarios: total,
      passed,
      failed,
      percentage: Math.round(percentage * 100) / 100,
    };
  });

  const totalWeight = suites.reduce((s: number, suite: any) => s + suite.weight, 0);
  const composite = totalWeight > 0
    ? suites.reduce((s: number, suite: any) => s + suite.percentage * suite.weight, 0) / totalWeight
    : 0;

  const report = {
    benchmark: "BioMemEval",
    version: "1.0.0",
    system: "Bitterbot",
    systemVersion: "2026.2.15-beta",
    timestamp: new Date().toISOString(),
    suites,
    compositeScore: Math.round(composite * 100) / 100,
    metadata: {
      nodeVersion: process.version,
      platform: process.platform,
      totalDurationMs: raw.startTime && raw.endTime
        ? raw.endTime - raw.startTime
        : null,
    },
  };

  fs.writeFileSync(outputPath, JSON.stringify(report, null, 2) + "\n");

  // Print summary table
  console.log("");
  console.log("=".repeat(72));
  console.log("  BioMemEval — Biological Agent Memory Benchmark");
  console.log("=".repeat(72));
  console.log("");
  console.log(
    "  " +
    "Suite".padEnd(30) +
    "Weight".padEnd(10) +
    "Pass".padEnd(8) +
    "Fail".padEnd(8) +
    "Score",
  );
  console.log("  " + "-".repeat(64));

  for (const s of suites) {
    console.log(
      "  " +
      s.suiteName.padEnd(30) +
      (s.weight + "%").padEnd(10) +
      String(s.passed).padEnd(8) +
      String(s.failed).padEnd(8) +
      Math.round(s.percentage) + "%",
    );
  }

  console.log("  " + "-".repeat(64));
  console.log(
    "  " +
    "COMPOSITE".padEnd(30) +
    "100%".padEnd(10) +
    "".padEnd(16) +
    Math.round(composite) + "%",
  );
  console.log("");
  console.log(`  System: ${report.system} v${report.systemVersion}`);
  console.log(`  Report: ${outputPath}`);
  console.log("=".repeat(72));
  console.log("");
} catch (err) {
  console.error("Failed to generate BioMemEval report:", err);
  process.exit(1);
}
