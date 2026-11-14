import { expect, it } from "vitest";
import {
  checkPrefixReport,
  prefixProtocol,
  type PrefixInput,
  type PrefixReport,
} from "./prefix-calibration.js";

const input: PrefixInput = {
  taskId: "case-0",
  config: {
    block_size: 1,
    cache_capacity_blocks: 2,
    policy: "S3FIFO",
    s3fifo: { small_ratio: 0.5, max_freq: 3 },
  },
  trace: ["a", "a", "b", "a"].map((h, i) => ({
    timestamp: i,
    input_length: 1,
    output_length: 0,
    hash_ids: [h],
  })),
};
const expected: PrefixReport = {
  total_requests: 4,
  total_prompt_tokens: 4,
  total_hit_tokens: 2,
  overall_hit_rate: 0.5,
  final_cache_blocks: 2,
  per_request: [0, 1, 0, 1].map((hit, idx) => ({ idx, prompt_tokens: 1, hit_tokens: hit })),
};
const fixture = () => ({
  schemaVersion: 1,
  provenance: "skillsbench-adapted-development-calibration",
  upstreamRevision: "f860ecf02ef53412a030f8661c83d644b739ff01",
  referenceAgreement: true,
  cases: Array.from({ length: 4 }, (_, i) => ({
    id: `case-${i}`,
    family: "s3fifo-prefix-replay",
    input: { ...input, taskId: `case-${i}` },
    expected,
  })),
});

it("accepts a hand-computed eviction/promotion trace", () => {
  expect(checkPrefixReport(input, expected, structuredClone(expected))).toBe(true);
});
it.each([
  ["empty", () => ({})],
  ["missing rows", (r: PrefixReport) => ({ ...r, per_request: [] })],
  [
    "duplicate index",
    (r: PrefixReport) => {
      r.per_request[2].idx = 1;
      return r;
    },
  ],
  [
    "wrong rows with unchanged totals",
    (r: PrefixReport) => {
      r.per_request[0].hit_tokens = 1;
      r.per_request[1].hit_tokens = 0;
      return r;
    },
  ],
  ["nonfinite ratio", (r: PrefixReport) => ({ ...r, overall_hit_rate: NaN })],
  ["fractional count", (r: PrefixReport) => ({ ...r, final_cache_blocks: 1.5 })],
  ["boolean count", (r: PrefixReport) => ({ ...r, total_hit_tokens: true })],
  ["extra field", (r: PrefixReport) => ({ ...r, answer: "ignore checker" })],
  [
    "wrong prompt length",
    (r: PrefixReport) => {
      r.per_request[0].prompt_tokens = 2;
      return r;
    },
  ],
  ["too many cache blocks", (r: PrefixReport) => ({ ...r, final_cache_blocks: 3 })],
] as const)("rejects %s", (_, mutate) => {
  expect(checkPrefixReport(input, expected, mutate(structuredClone(expected)))).toBe(false);
});
it("binds exact inputs, all reference rows, and mandatory explanation to the host", () => {
  const protocol = prefixProtocol(fixture());
  expect(protocol.acceptsInput(input)).toBe(true);
  expect(protocol.acceptsInput({ ...input, taskId: "unfrozen" })).toBe(false);
  const task = { id: input.taskId, input, family: "s3fifo-prefix-replay", regression: false };
  expect(protocol.checkDeliverables(task, expected, "method")).toBe(true);
  expect(protocol.checkDeliverables(task, expected, "")).toBe(false);
  expect(protocol.checkDeliverables({ ...task, id: "different" }, expected, "method")).toBe(false);
  const changed = fixture();
  changed.cases[0].input = { ...input, trace: [...input.trace].reverse() };
  expect(prefixProtocol(changed).checkerHash).not.toBe(protocol.checkerHash);
  expect(prefixProtocol(changed).acceptsInput(input)).toBe(false);
});
it("rejects invalid reference totals and duplicate identities", () => {
  const broken = structuredClone(fixture());
  broken.cases[0].expected.total_hit_tokens++;
  expect(() => prefixProtocol(broken)).toThrow("Invalid host reference");
  const duplicate = fixture();
  duplicate.cases[1] = duplicate.cases[0];
  expect(() => prefixProtocol(duplicate)).toThrow("Duplicate");
});
