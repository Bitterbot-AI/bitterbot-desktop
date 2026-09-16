/**
 * PLAN-50 Phase 5: OpenTelemetry export of usage-ledger rows.
 *
 * Emits the per-modality monotonic counters proposed in
 * open-telemetry/semantic-conventions-genai#374 (input, output, cache read, cache write,
 * reasoning; keyed by `gen_ai.token.modality`) alongside the histogram the current convention
 * still defines (`gen_ai.client.token.usage` split by `gen_ai.token.type`), plus a USD cost
 * counter. No-op unless OTel is enabled (`OTEL_EXPORTER_OTLP_ENDPOINT` / `OTEL_TRACES_EXPORTER`).
 */

import type { UsageEventRow } from "../infra/usage-ledger.types.js";
import { onUsageEvent } from "../infra/usage-ledger.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { isOtelEnabled } from "./otel.js";

const log = createSubsystemLogger("observability/usage-metrics");

type Counter = { add: (value: number, attrs?: Record<string, string | number | boolean>) => void };
type Histogram = {
  record: (value: number, attrs?: Record<string, string | number | boolean>) => void;
};

type Instruments = {
  input: Counter;
  output: Counter;
  cacheRead: Counter;
  cacheWrite: Counter;
  reasoning: Counter;
  tokenUsage: Histogram;
  costUsd: Counter;
  operationInput: Histogram;
  operationOutput: Histogram;
};

let instruments: Instruments | null | undefined;
let instrumentsPromise: Promise<Instruments | null> | null = null;

function ensureInstruments(): Promise<Instruments | null> {
  if (instruments !== undefined) {
    return Promise.resolve(instruments);
  }
  instrumentsPromise ??= createInstruments();
  return instrumentsPromise;
}

async function createInstruments(): Promise<Instruments | null> {
  try {
    const api = await import("@opentelemetry/api" as string);
    const meter = api.metrics.getMeter("bitterbot.usage", "1.0.0");
    const counter = (name: string, description: string): Counter =>
      meter.createCounter(name, { unit: "{token}", description });
    instruments = {
      input: counter(
        "gen_ai.client.inference.usage.input_tokens",
        "Input tokens (all types, incl. cached)",
      ),
      output: counter(
        "gen_ai.client.inference.usage.output_tokens",
        "Output tokens (incl. reasoning)",
      ),
      cacheRead: counter(
        "gen_ai.client.inference.usage.cache_read.input_tokens",
        "Input tokens read from cache",
      ),
      cacheWrite: counter(
        "gen_ai.client.inference.usage.cache_write.input_tokens",
        "Input tokens written to cache",
      ),
      reasoning: counter(
        "gen_ai.client.inference.usage.reasoning.output_tokens",
        "Reasoning output tokens",
      ),
      tokenUsage: meter.createHistogram("gen_ai.client.token.usage", {
        unit: "{token}",
        description: "Token usage per call (current convention; split by gen_ai.token.type)",
      }),
      operationInput: meter.createHistogram("gen_ai.client.inference.operation.input_tokens", {
        unit: "{token}",
        description: "Input tokens per operation",
      }),
      operationOutput: meter.createHistogram("gen_ai.client.inference.operation.output_tokens", {
        unit: "{token}",
        description: "Output tokens per operation",
      }),
      costUsd: meter.createCounter("bitterbot.usage.cost", {
        unit: "USD",
        description: "Model spend in USD",
      }),
    };
  } catch (err) {
    log.debug(`usage metrics unavailable: ${err instanceof Error ? err.message : String(err)}`);
    instruments = null;
  }
  return instruments;
}

function operationName(kind: UsageEventRow["kind"]): string {
  switch (kind) {
    case "embedding":
      return "embeddings";
    case "vision":
    case "chat":
      return "chat";
    case "audio":
      return "transcription";
    case "tts":
      return "speech";
    case "search":
      return "search";
    default:
      return kind;
  }
}

export function usageRowToMetricAttributes(row: UsageEventRow): Record<string, string> {
  return {
    "gen_ai.provider.name": row.provider ?? "unknown",
    "gen_ai.request.model": row.model ?? "unknown",
    "gen_ai.operation.name": operationName(row.kind),
    "gen_ai.token.modality": "text",
    "bitterbot.feature": row.feature,
    "bitterbot.kind": row.kind,
    "bitterbot.cost_source": row.costSource,
  };
}

export function recordUsageMetrics(row: UsageEventRow, inst: Instruments): void {
  const attrs = usageRowToMetricAttributes(row);
  if (row.kind === "tts") {
    // Characters, not tokens: only the cost counter applies.
    if (row.cost.total > 0) {
      inst.costUsd.add(row.cost.total, attrs);
    }
    return;
  }
  const inputTotal = row.usage.input + row.usage.cacheRead + row.usage.cacheWrite;
  if (inputTotal > 0) {
    inst.input.add(inputTotal, attrs);
    inst.tokenUsage.record(inputTotal, { ...attrs, "gen_ai.token.type": "input" });
    inst.operationInput.record(inputTotal, attrs);
  }
  if (row.usage.output > 0) {
    inst.output.add(row.usage.output, attrs);
    inst.tokenUsage.record(row.usage.output, { ...attrs, "gen_ai.token.type": "output" });
    inst.operationOutput.record(row.usage.output, attrs);
  }
  if (row.usage.cacheRead > 0) {
    inst.cacheRead.add(row.usage.cacheRead, attrs);
  }
  if (row.usage.cacheWrite > 0) {
    inst.cacheWrite.add(row.usage.cacheWrite, attrs);
  }
  if (row.usage.reasoning > 0) {
    inst.reasoning.add(row.usage.reasoning, attrs);
  }
  if (row.cost.total > 0) {
    inst.costUsd.add(row.cost.total, attrs);
  }
}

/** Subscribe the ledger to OTel metrics. Returns an unsubscribe; no-op when OTel is off. */
export function startUsageMetricsExport(): () => void {
  if (!isOtelEnabled()) {
    return () => {};
  }
  const unsub = onUsageEvent((row) => {
    void ensureInstruments().then((inst) => {
      if (inst) {
        recordUsageMetrics(row, inst);
      }
    });
  });
  log.info("usage metrics export enabled (gen_ai.client.inference.usage.* counters)");
  return unsub;
}

export function resetUsageMetricsForTest(): void {
  instruments = undefined;
  instrumentsPromise = null;
}
