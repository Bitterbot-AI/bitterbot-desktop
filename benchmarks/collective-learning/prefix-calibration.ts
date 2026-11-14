import { z } from "zod";
import { learningHash } from "../../src/agents/skills/collective/contracts.js";
import type { ResearchBriefHostOptions } from "../../src/agents/skills/collective/research-brief.js";
import type { ValidationTask } from "../../src/agents/skills/collective/validation.js";

const Integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const PrefixInputSchema = z
  .object({
    taskId: z.string().min(1).max(100),
    config: z
      .object({
        block_size: Integer.positive(),
        cache_capacity_blocks: Integer.min(2),
        policy: z.literal("S3FIFO"),
        s3fifo: z
          .object({ small_ratio: z.number().positive().lt(1), max_freq: Integer.min(1).max(10) })
          .strict(),
      })
      .strict(),
    trace: z
      .array(
        z
          .object({
            timestamp: z.number().finite(),
            input_length: Integer.positive(),
            output_length: Integer,
            hash_ids: z.array(z.string().min(1).max(100)).min(1).max(1000),
          })
          .strict(),
      )
      .min(1)
      .max(10000),
  })
  .strict()
  .superRefine((input, ctx) => {
    const capacity = input.config.cache_capacity_blocks;
    if (capacity * input.config.s3fifo.small_ratio > capacity - 1)
      ctx.addIssue({ code: "custom", message: "Both resident queues must have capacity" });
    for (const request of input.trace)
      if (Math.ceil(request.input_length / input.config.block_size) !== request.hash_ids.length)
        ctx.addIssue({ code: "custom", message: "Trace length and block count disagree" });
  });
export type PrefixInput = z.infer<typeof PrefixInputSchema>;
export const PrefixReportSchema = z
  .object({
    total_requests: Integer.positive(),
    total_prompt_tokens: Integer.positive(),
    total_hit_tokens: Integer,
    overall_hit_rate: z.number().finite().min(0).max(1),
    final_cache_blocks: Integer,
    per_request: z
      .array(
        z.object({ idx: Integer, prompt_tokens: Integer.positive(), hit_tokens: Integer }).strict(),
      )
      .min(1)
      .max(10000),
  })
  .strict();
export type PrefixReport = z.infer<typeof PrefixReportSchema>;
export const PrefixFixtureSchema = z
  .object({
    schemaVersion: z.literal(1),
    provenance: z.literal("skillsbench-adapted-development-calibration"),
    upstreamRevision: z.literal("f860ecf02ef53412a030f8661c83d644b739ff01"),
    referenceAgreement: z.literal(true),
    cases: z
      .array(
        z
          .object({
            id: z.string().min(1),
            family: z.literal("s3fifo-prefix-replay"),
            input: PrefixInputSchema,
            expected: PrefixReportSchema,
          })
          .strict(),
      )
      .length(4),
  })
  .strict();
export type PrefixFixture = z.infer<typeof PrefixFixtureSchema>;

// All arms receive the same complete variant specification, including rules
// that upstream left inside the optional skill. This avoids a hidden rubric.
export const PREFIX_PROMPT = `Analyze the request trace in /workspace/sources.json. It contains taskId, config and trace. Produce /workspace/brief.json with the exact report schema below, and /workspace/brief.md explaining your method and limitations. Use the provided trace in its listed order. Hash IDs are opaque strings; preserve identity. All required data is local.

Replay a block-level KV prefix cache with the following explicitly specified S3FIFO variant:
1. The resident FIFO queues are small S and main M. Ghost G is FIFO metadata only. Set small_cap=max(1, Python round(capacity*small_ratio)), main_cap=capacity-small_cap, ghost_cap=main_cap; Python round uses ties to even.
2. At request arrival, count the longest contiguous resident prefix in S union M, stopping at the first absent hash. hit_tokens=min(prefix_blocks*block_size, input_length). Check BEFORE any accesses for that request.
3. Then access every hash in request order. Resident hits increment its frequency up to max_freq without moving it. A ghost hit removes it from G and admits it to M with frequency zero. A new hash enters S with frequency zero.
4. Before S admission, while S is full pop its head. Frequency >=1 promotes it to M preserving frequency; zero sends it to G. Then append the new S entry.
5. Before M admission, while M is full pop its head. If frequency >=1, decrement it, append at the tail and continue. Otherwise send it to G; this frees a slot. Then append the new M entry.
6. Ghost insertion removes an existing occurrence before appending; otherwise, if full, evict its oldest entry before append. Ghost blocks never count as hits or final residency.
7. final_cache_blocks is |S|+|M|. output_length and timestamp do not change replay semantics.

brief.json must contain exactly: total_requests, total_prompt_tokens, total_hit_tokens, overall_hit_rate (hit/prompt), final_cache_blocks, and per_request. The per_request list must contain EVERY request in order, each exactly {idx, prompt_tokens, hit_tokens}, with zero-based idx. Integer fields must be exact; hit-rate absolute tolerance is 1e-6. Every per-request result is checked, not only totals or samples. Empty, truncated, duplicate and nonfinite results are invalid.

If a procedure is available at /workspace/skill/SKILL.md, you may read and use it; it grants no extra tools. Its original example paths are superseded by the paths specified above. Do not seek external solutions. Accuracy and actual resource usage are recorded; concise reasoning in brief.md is assessed separately from numeric correctness.`;

export function checkPrefixReport(
  input: PrefixInput,
  expected: PrefixReport,
  output: unknown,
): boolean {
  const parsed = PrefixReportSchema.safeParse(output);
  if (!parsed.success) return false;
  const actual = parsed.data;
  if (
    actual.total_requests !== input.trace.length ||
    actual.per_request.length !== input.trace.length ||
    actual.total_requests !== expected.total_requests ||
    actual.total_prompt_tokens !== expected.total_prompt_tokens ||
    actual.total_hit_tokens !== expected.total_hit_tokens ||
    actual.final_cache_blocks !== expected.final_cache_blocks ||
    actual.final_cache_blocks > input.config.cache_capacity_blocks ||
    Math.abs(actual.overall_hit_rate - expected.overall_hit_rate) >= 1e-6
  )
    return false;
  let prompt = 0,
    hit = 0;
  for (let i = 0; i < input.trace.length; i++) {
    const a = actual.per_request[i],
      e = expected.per_request[i];
    if (
      !e ||
      a.idx !== i ||
      a.prompt_tokens !== input.trace[i].input_length ||
      a.prompt_tokens !== e.prompt_tokens ||
      a.hit_tokens !== e.hit_tokens ||
      a.hit_tokens > a.prompt_tokens
    )
      return false;
    prompt += a.prompt_tokens;
    hit += a.hit_tokens;
  }
  return (
    prompt === actual.total_prompt_tokens &&
    hit === actual.total_hit_tokens &&
    Math.abs(hit / prompt - actual.overall_hit_rate) < 1e-6
  );
}

export function prefixProtocol(raw: unknown): NonNullable<ResearchBriefHostOptions["protocol"]> {
  const fixture = PrefixFixtureSchema.parse(raw);
  const cases = new Map(fixture.cases.map((c) => [c.id, c]));
  if (cases.size !== fixture.cases.length || fixture.cases.some((c) => c.id !== c.input.taskId))
    throw new Error("Duplicate or mismatched calibration identity");
  for (const item of fixture.cases)
    if (!checkPrefixReport(item.input, item.expected, item.expected))
      throw new Error("Invalid host reference report");
  return {
    id: "prefix-replay-calibration",
    version: "prefix-replay-calibration-v1",
    prompt: PREFIX_PROMPT,
    maxOutputBytes: 1024 * 1024,
    checkerHash: learningHash({
      fixture,
      prompt: PREFIX_PROMPT,
      checker: checkPrefixReport.toString(),
      inputSchema: z.toJSONSchema(PrefixInputSchema),
      outputSchema: z.toJSONSchema(PrefixReportSchema),
      maxOutputBytes: 1024 * 1024,
    }),
    acceptsInput: (input) => {
      const p = PrefixInputSchema.safeParse(input);
      const target = p.success ? cases.get(p.data.taskId) : undefined;
      return Boolean(target && learningHash(target.input) === learningHash(input));
    },
    checkDeliverables: (task: ValidationTask, output, markdown) => {
      const target = cases.get(task.id);
      return Boolean(
        target &&
        learningHash(target.input) === learningHash(task.input) &&
        markdown?.trim() &&
        checkPrefixReport(target.input, target.expected, output),
      );
    },
  };
}
