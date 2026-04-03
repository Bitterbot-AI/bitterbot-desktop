/**
 * BioMemEval scoring: suite-level and composite scoring with partial credit.
 */

export interface AssertionResult {
  description: string;
  passed: boolean;
  points: number;
  maxPoints: number;
}

export interface ScenarioResult {
  name: string;
  maxPoints: number;
  earnedPoints: number;
  passed: boolean;
  assertions: AssertionResult[];
}

export interface SuiteResult {
  suiteName: string;
  suiteId: string;
  weight: number;
  maxPoints: number;
  earnedPoints: number;
  percentage: number;
  scenarios: ScenarioResult[];
}

export interface BioMemEvalReport {
  system: string;
  version: string;
  timestamp: string;
  suites: SuiteResult[];
  compositeScore: number;
  metadata: {
    runDurationMs: number;
    nodeVersion: string;
    platform: string;
  };
}

/** Accumulator used within test files to track assertions. */
export class ScenarioScorer {
  private assertions: AssertionResult[] = [];
  readonly maxPoints: number;

  constructor(readonly name: string, maxPoints: number) {
    this.maxPoints = maxPoints;
  }

  /** Award points if condition is true. Returns earned points. */
  score(description: string, condition: boolean, points: number): number {
    const earned = condition ? points : 0;
    this.assertions.push({ description, passed: condition, points: earned, maxPoints: points });
    return earned;
  }

  result(): ScenarioResult {
    const earned = this.assertions.reduce((sum, a) => sum + a.points, 0);
    return {
      name: this.name,
      maxPoints: this.maxPoints,
      earnedPoints: earned,
      passed: earned === this.maxPoints,
      assertions: this.assertions,
    };
  }
}

export class SuiteScorer {
  private scenarios: ScenarioResult[] = [];

  constructor(
    readonly suiteName: string,
    readonly suiteId: string,
    readonly weight: number,
    readonly maxPoints: number,
  ) {}

  addScenario(result: ScenarioResult): void {
    this.scenarios.push(result);
  }

  result(): SuiteResult {
    const earned = this.scenarios.reduce((sum, s) => sum + s.earnedPoints, 0);
    return {
      suiteName: this.suiteName,
      suiteId: this.suiteId,
      weight: this.weight,
      maxPoints: this.maxPoints,
      earnedPoints: earned,
      percentage: this.maxPoints > 0 ? (earned / this.maxPoints) * 100 : 0,
      scenarios: this.scenarios,
    };
  }
}

export function computeComposite(suites: SuiteResult[]): number {
  const totalWeight = suites.reduce((sum, s) => sum + s.weight, 0);
  if (totalWeight === 0) return 0;
  return suites.reduce((sum, s) => sum + s.percentage * s.weight, 0) / totalWeight;
}

export function buildReport(
  system: string,
  version: string,
  suites: SuiteResult[],
  startTime: number,
): BioMemEvalReport {
  return {
    system,
    version,
    timestamp: new Date().toISOString(),
    suites,
    compositeScore: computeComposite(suites),
    metadata: {
      runDurationMs: Date.now() - startTime,
      nodeVersion: process.version,
      platform: process.platform,
    },
  };
}
