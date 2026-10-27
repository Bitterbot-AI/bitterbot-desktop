/**
 * PLAN-58 Phase B: the applicability profile is built from names, hashes and
 * counts only; it parses as a closed shape on the receiver; and fit is a soft
 * signal that can only tighten.
 */
import { describe, expect, it } from "vitest";
import {
  APPLICABILITY_MAX_BYTES,
  assessApplicabilityFit,
  buildApplicabilityProfile,
  fitTakesStrictCanary,
  parseApplicabilityProfile,
  type ReceiverFacts,
  type SkillApplicabilityProfile,
  traceSequenceHash,
} from "./applicability-profile.js";
import type { SkillReadEvent } from "./skill-reads.js";
import type { ReconstructedTrace, TraceToolStep } from "./types.js";
import type { EvolutionMeta } from "./validation-gate.js";

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;
const SKILL = "acme-deploy";

function ev(over: Partial<SkillReadEvent>): SkillReadEvent {
  return {
    runId: "r1",
    skill: SKILL,
    ts: NOW - DAY,
    success: true,
    label: "pass",
    outcomeLevel: 3,
    model: "anthropic/claude-opus-4-8",
    completedExplicitly: false,
    toolErrors: 0,
    origin: "human",
    sessionKey: "agent:main:main",
    credited: true,
    ...over,
  };
}

function tool(name: string, over: Partial<TraceToolStep> = {}): TraceToolStep {
  return {
    kind: "tool",
    name,
    args: '{"path":"/home/victor/secret.txt","token":"sk-live-ABC"}',
    result: "ok /home/victor/out.txt vic@example.com 10.0.0.7",
    isError: false,
    ...over,
  };
}

function trace(
  runId: string,
  steps: TraceToolStep[],
  over: Partial<ReconstructedTrace> = {},
): ReconstructedTrace {
  return {
    runId,
    taskId: null,
    task: {
      text: "Deploy the acme service for vic@example.com using /home/victor/.ssh/id",
      chars: 60,
      origin: "human",
      isHeartbeat: false,
      channel: null,
    },
    model: "anthropic/claude-opus-4-8",
    sessionKey: "agent:main:main",
    startedAt: NOW - DAY,
    steps,
    endedWithError: false,
    errorText: null,
    completedExplicitly: true,
    toolCallCount: steps.length,
    toolErrorCount: steps.filter((s) => s.isError).length,
    toolPendingCount: 0,
    ...over,
  } as ReconstructedTrace;
}

const SKILL_MD = `---
name: ${SKILL}
description: Use when the task asks to deploy acme; not for local files.
bitterbot:
  os: [linux, darwin]
  requires:
    bins: [docker]
    anyBins: [kubectl, helm]
    env: [ACME_TOKEN]
  capabilities:
    network:
      outbound: [api.acme.example]
    shell: true
---
Body.
`;

const META = {
  origin: "wiki-evolution",
  validation: {
    mode: "tasks",
    verdict: "accepted",
    validatedAt: NOW - 3 * DAY,
    model: "anthropic/claude-opus-4-8",
    validatedOn: ["anthropic/claude-opus-4-8", "openai/gpt-5"],
    trials: 9,
    meanDelta: 0.22,
    ci95Low: 0.05,
    corpusVersion: "canonical-g5-s1",
  },
} as unknown as EvolutionMeta;

function build(over: Partial<Parameters<typeof buildApplicabilityProfile>[0]> = {}) {
  return buildApplicabilityProfile({
    name: SKILL,
    events: [
      ev({ runId: "r1" }),
      ev({ runId: "r2", label: "fail", success: false, outcomeLevel: 2 }),
      ev({
        runId: "r3",
        label: "env-fail",
        success: false,
        outcomeLevel: 1,
        model: "openai/gpt-5",
      }),
      ev({ runId: "old", ts: NOW - 40 * DAY }), // outside the window
      ev({ runId: "x", skill: "other-skill" }), // another skill
      ev({ runId: "u", credited: false }), // uncredited
    ],
    meta: META,
    skillMd: SKILL_MD,
    traces: [
      { trace: trace("r1", [tool("read"), tool("exec"), tool("exec")]), label: "pass" },
      {
        trace: trace(
          "r2",
          [
            tool("read"),
            tool("exec", { isError: true, result: "exit 1: command not found: kubectl" }),
          ],
          {
            endedWithError: true,
            errorText: "command not found",
            completedExplicitly: false,
          },
        ),
        label: "fail",
      },
    ],
    platform: "linux",
    now: NOW,
    ...over,
  });
}

describe("buildApplicabilityProfile", () => {
  it("summarises reads, models, declared requirements, run shape and failures", () => {
    const p = build();
    expect(p.v).toBe(1);
    expect(p.outcomes).toMatchObject({
      runs: 3,
      pass: 1,
      fail: 1,
      indeterminate: 1,
      maxEvidenceLevel: 3,
    });
    expect(p.outcomes.successRate).toBe(0.5);
    expect(p.outcomes.gate).toEqual({ trials: 9, meanDelta: 0.22, ci95Low: 0.05 });
    expect(p.measured.models).toEqual(["anthropic/claude-opus-4-8", "openai/gpt-5"]);
    expect(p.measured.validatedOn).toEqual(["anthropic/claude-opus-4-8", "openai/gpt-5"]);
    expect(p.measured.os).toEqual(["linux"]);
    expect(p.measured.corpusVersion).toBe("canonical-g5-s1");
    expect(p.declared).toEqual({
      os: ["darwin", "linux"],
      bins: ["docker"],
      anyBins: ["helm", "kubectl"],
      env: ["ACME_TOKEN"],
      capabilities: ["network", "shell"],
    });
    expect(p.shape.tools).toEqual([
      { name: "exec", runs: 2 },
      { name: "read", runs: 2 },
    ]);
    expect(p.shape.sequenceHashes).toHaveLength(2);
    expect(p.failures.length).toBe(1);
    expect(p.failures[0]?.count).toBe(1);
  });

  it("never carries task text, paths, emails, IPs, env values, run ids or session keys", () => {
    const json = JSON.stringify(build());
    for (const forbidden of [
      "Deploy the acme",
      "/home/victor",
      "vic@example.com",
      "10.0.0.7",
      "sk-live",
      "agent:main:main",
      '"r1"',
      "secret.txt",
      "command not found",
    ]) {
      expect(json).not.toContain(forbidden);
    }
  });

  it("is empty but well-formed with no reads, no meta and no frontmatter", () => {
    const p = buildApplicabilityProfile({
      name: SKILL,
      events: [],
      meta: null,
      skillMd: null,
      traces: [],
      platform: "win32",
      now: NOW,
    });
    expect(p.outcomes).toEqual({
      runs: 0,
      pass: 0,
      fail: 0,
      indeterminate: 0,
      successRate: null,
      maxEvidenceLevel: 0,
      gate: null,
    });
    expect(p.measured).toEqual({ models: [], validatedOn: [], os: ["win32"] });
    expect(p.declared).toEqual({});
    expect(p.shape).toEqual({ tools: [], sequenceHashes: [] });
    expect(p.failures).toEqual([]);
    expect(parseApplicabilityProfile(JSON.parse(JSON.stringify(p)))).toEqual(p);
  });

  it("stays under the size ceiling and marks truncation", () => {
    const manyTools = Array.from({ length: 200 }, (_, i) => tool(`tool-${"x".repeat(80)}-${i}`));
    const traces = Array.from({ length: 60 }, (_, i) => ({
      trace: trace(`r${i}`, manyTools.slice(i, i + 40)),
      label: "pass" as const,
    }));
    const p = build({ traces });
    expect(Buffer.byteLength(JSON.stringify(p), "utf-8")).toBeLessThanOrEqual(
      APPLICABILITY_MAX_BYTES,
    );
    expect(p.shape.tools.length).toBeLessThanOrEqual(8);
    expect(p.shape.sequenceHashes.length).toBeLessThanOrEqual(4);
  });

  it("traceSequenceHash is stable, hex, and distinguishes error from success on the same tools", () => {
    const ok = trace("a", [tool("read"), tool("exec")]);
    const bad = trace("b", [tool("read"), tool("exec", { isError: true })]);
    expect(traceSequenceHash(ok)).toMatch(/^[0-9a-f]{12}$/);
    expect(traceSequenceHash(ok)).toBe(traceSequenceHash(trace("c", [tool("read"), tool("exec")])));
    expect(traceSequenceHash(ok)).not.toBe(traceSequenceHash(bad));
  });
});

describe("parseApplicabilityProfile", () => {
  it("round-trips a built profile", () => {
    const p = build();
    expect(parseApplicabilityProfile(JSON.parse(JSON.stringify(p)))).toEqual(p);
  });

  it("rejects the wrong version, missing blocks, bad numbers, unknown mechanisms and non-hex hashes", () => {
    const p = JSON.parse(JSON.stringify(build())) as Record<string, unknown>;
    const mutate = (fn: (o: Record<string, unknown>) => void) => {
      const o = JSON.parse(JSON.stringify(p)) as Record<string, unknown>;
      fn(o);
      return parseApplicabilityProfile(o);
    };
    expect(mutate((o) => (o.v = 2))).toBeNull();
    expect(mutate((o) => delete o.measured)).toBeNull();
    expect(mutate((o) => ((o.outcomes as Record<string, unknown>).runs = -1))).toBeNull();
    expect(mutate((o) => ((o.outcomes as Record<string, unknown>).successRate = 7))).toBeNull();
    expect(
      mutate((o) => ((o.outcomes as Record<string, unknown>).maxEvidenceLevel = 9)),
    ).toBeNull();
    expect(mutate((o) => (o.failures = [{ mechanism: "aliens", count: 1 }]))).toBeNull();
    expect(
      mutate((o) => ((o.shape as Record<string, unknown>).sequenceHashes = ["not hex!"])),
    ).toBeNull();
    expect(mutate((o) => (o.generatedAt = "yesterday"))).toBeNull();
    expect(parseApplicabilityProfile(null)).toBeNull();
    expect(parseApplicabilityProfile("string")).toBeNull();
  });

  it("drops unknown declared keys and caps arrays instead of failing", () => {
    const p = JSON.parse(JSON.stringify(build())) as Record<string, unknown>;
    (p.declared as Record<string, unknown>).secretPath = "/home/x";
    (p.measured as Record<string, unknown>).models = Array.from({ length: 50 }, (_, i) => `m/${i}`);
    const parsed = parseApplicabilityProfile(p)!;
    expect(parsed).not.toBeNull();
    expect("secretPath" in parsed.declared).toBe(false);
    expect(parsed.measured.models).toHaveLength(6);
  });
});

describe("assessApplicabilityFit", () => {
  /** Six credited runs at L3: enough evidence for full credit. */
  const deep = () =>
    build({
      events: Array.from({ length: 6 }, (_, i) =>
        ev({ runId: `d${i}`, label: i === 5 ? "fail" : "pass", success: i !== 5, outcomeLevel: 3 }),
      ),
    });
  const linuxBox: ReceiverFacts = {
    platform: "linux",
    model: "anthropic/claude-opus-4-8",
    hasBinary: (b) => ["docker", "kubectl"].includes(b),
    hasEnv: (n) => n === "ACME_TOKEN",
  };

  it("is unknown with no profile and takes the strict canary", () => {
    const fit = assessApplicabilityFit(null, linuxBox);
    expect(fit).toEqual({
      score: null,
      level: "unknown",
      mismatches: ["sender shipped no applicability profile"],
    });
    expect(fitTakesStrictCanary(fit.level)).toBe(true);
    expect(fitTakesStrictCanary(undefined)).toBe(true);
  });

  it("is good when measured on this model and platform with the declared tools present", () => {
    const fit = assessApplicabilityFit(deep(), linuxBox);
    expect(fit.level).toBe("good");
    expect(fit.score).toBe(1);
    expect(fit.mismatches).toEqual([]);
    expect(fitTakesStrictCanary(fit.level)).toBe(false);
  });

  it("thin sender evidence (under five runs) costs credit and says so", () => {
    const fit = assessApplicabilityFit(build(), linuxBox);
    expect(fit.score).toBe(0.86);
    expect(fit.level).toBe("good");
    expect(fit.mismatches).toEqual(["sender has 3 credited runs in 14 days"]);
  });

  it("caps at partial on a hard mismatch even when everything else is perfect", () => {
    const noDocker = { ...linuxBox, hasBinary: (b: string) => b === "kubectl" };
    const fit = assessApplicabilityFit(deep(), noDocker);
    expect(fit.level).toBe("partial");
    expect(fit.mismatches[0]).toContain("missing required binary: docker");
    const wrongOs = { ...linuxBox, platform: "win32" };
    const fit2 = assessApplicabilityFit(deep(), wrongOs);
    expect(fit2.level).toBe("partial");
    expect(fit2.mismatches.some((m) => m.includes("excludes win32"))).toBe(true);
  });

  it("is poor for a weaker-tier or unknown sender model with thin evidence, and strict", () => {
    const thin = build({
      events: [ev({ runId: "only", model: "mystery/model-z", outcomeLevel: 1 })],
      meta: {
        ...META,
        validation: {
          ...(META.validation as object),
          validatedOn: ["mystery/model-z"],
          model: "mystery/model-z",
        },
      } as EvolutionMeta,
    });
    const fit = assessApplicabilityFit(thin, { ...linuxBox, hasBinary: () => false });
    expect(fit.level).toBe("poor");
    expect(fitTakesStrictCanary(fit.level)).toBe(true);
    expect(fit.mismatches.length).toBeGreaterThanOrEqual(3);
  });

  it("treats a missing env name as soft and an unknown receiver model as half credit", () => {
    const fit = assessApplicabilityFit(deep(), { ...linuxBox, hasEnv: () => false, model: null });
    expect(fit.level).toBe("good");
    expect(fit.score).toBe(0.8);
    expect(fit.mismatches).toEqual(
      expect.arrayContaining(["receiver model unknown", "env not set here: ACME_TOKEN"]),
    );
    expect(fit.score).toBeLessThan(1);
  });

  it("is a pure function of its inputs (same profile + facts, same fit)", () => {
    const p: SkillApplicabilityProfile = build();
    expect(assessApplicabilityFit(p, linuxBox)).toEqual(assessApplicabilityFit(p, linuxBox));
  });
});
