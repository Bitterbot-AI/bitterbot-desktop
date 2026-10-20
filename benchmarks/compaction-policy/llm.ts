/**
 * Model calls for the eval: Anthropic SDK, sequential, with cost accounting
 * into the eval's own usage ledger (the harness runs under an isolated
 * BITTERBOT_STATE_DIR, so the live ledger is never touched) and a running
 * spend total the runner checks against its budget.
 */

import Anthropic from "@anthropic-ai/sdk";
import { recordUsage } from "../../src/infra/usage-ledger.js";

export type EvalModel = "claude-haiku-4-5" | "claude-opus-4-8" | "claude-sonnet-5";

/** List prices per million tokens (Anthropic first-party, 2026-06 cache). */
export const PRICES: Record<
  EvalModel,
  { input: number; output: number; cacheRead: number; cacheWrite: number }
> = {
  "claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  "claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
};

export type CallUsage = { input: number; output: number; cacheRead: number; cacheWrite: number };

export function costOf(model: EvalModel, u: CallUsage): number {
  const p = PRICES[model];
  return (
    (u.input * p.input +
      u.output * p.output +
      u.cacheRead * p.cacheRead +
      u.cacheWrite * p.cacheWrite) /
    1_000_000
  );
}

export class Spend {
  total = 0;
  byFeature = new Map<string, number>();
  add(feature: string, usd: number) {
    this.total += usd;
    this.byFeature.set(feature, (this.byFeature.get(feature) ?? 0) + usd);
  }
}

export type CallResult = {
  message: Anthropic.Message;
  text: string;
  usage: CallUsage;
  costUsd: number;
  durationMs: number;
};

let client: Anthropic | null = null;
export function initClient(apiKey: string): void {
  client = new Anthropic({ apiKey, maxRetries: 3, timeout: 180_000 });
}

export async function callModel(params: {
  model: EvalModel;
  system?: string | Anthropic.TextBlockParam[];
  messages: Anthropic.MessageParam[];
  tools?: Anthropic.Tool[];
  maxTokens: number;
  feature: string;
  spend: Spend;
  sessionId?: string;
}): Promise<CallResult> {
  if (!client) {
    throw new Error("llm client not initialised");
  }
  const started = Date.now();
  const message = await client.messages.create({
    model: params.model,
    max_tokens: params.maxTokens,
    ...(params.system ? { system: params.system } : {}),
    messages: params.messages,
    ...(params.tools && params.tools.length ? { tools: params.tools } : {}),
  });
  const durationMs = Date.now() - started;
  const u = message.usage;
  const usage: CallUsage = {
    input: u.input_tokens ?? 0,
    output: u.output_tokens ?? 0,
    cacheRead: u.cache_read_input_tokens ?? 0,
    cacheWrite: u.cache_creation_input_tokens ?? 0,
  };
  const costUsd = costOf(params.model, usage);
  params.spend.add(params.feature, costUsd);
  recordUsage({
    kind: "chat",
    feature: params.feature,
    provider: "anthropic",
    model: params.model,
    agentId: "eval",
    sessionId: params.sessionId ?? null,
    usage: {
      input: usage.input,
      output: usage.output,
      cacheRead: usage.cacheRead,
      cacheWrite: usage.cacheWrite,
    },
    cost: { total: costUsd },
    costSource: "estimated",
    durationMs,
    status: "ok",
    stopReason: message.stop_reason ?? null,
  });
  const text = message.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
  return { message, text, usage, costUsd, durationMs };
}

export function sumUsage(a: CallUsage, b: CallUsage): CallUsage {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
  };
}

export const ZERO_USAGE: CallUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
