/**
 * PLAN-52 Phase 0: a scripted model for the runtime contract suite.
 *
 * It is registered as a pi-ai API provider, so everything that reaches the
 * model goes through the real `streamSimple` / `completeSimple` path: the
 * agent loop, and the compaction summary call (which bypasses the agent's
 * stream function). No network.
 *
 * A script is a list of steps, consumed one per model call in call order.
 * Every call is recorded (system prompt, message roles and text, tool names,
 * api key), so a scenario can assert on what the model was sent.
 */

import {
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  createAssistantMessageEventStream,
  type Model,
  registerApiProvider,
  type SimpleStreamOptions,
  type ToolCall,
  type Usage,
} from "@mariozechner/pi-ai";

export const SCRIPTED_API = "bitterbot-contract-scripted";
export const SCRIPTED_PROVIDER = "contract";

export type ScriptStep =
  /** A plain text answer. `usage.input` drives threshold compaction. */
  | { kind: "text"; text: string; inputTokens?: number }
  /** An assistant message that calls tools. */
  | {
      kind: "tools";
      calls: Array<{ id: string; name: string; args: Record<string, unknown> }>;
      text?: string;
    }
  /** A provider error (`stopReason: "error"`). */
  | { kind: "error"; message: string }
  /** Starts streaming, then waits for the abort signal. */
  | { kind: "hang"; partialText?: string }
  /** The stream function itself throws before producing a stream. */
  | { kind: "throw"; message: string };

export type ModelCall = {
  index: number;
  systemPrompt: string;
  /** One line per message: `role: text`. */
  messages: string[];
  tools: string[];
  apiKey: string | undefined;
  maxTokens: number | undefined;
};

const scripts = new Map<string, ScriptedModel>();
let registered = false;
let nextModelId = 0;

function zeroUsage(input = 0, output = 0): Usage {
  return {
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: input + output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function describeContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  const parts: string[] = [];
  for (const block of content) {
    const b = block as { type?: string; text?: string; name?: string; id?: string };
    if (b.type === "text" && typeof b.text === "string") {
      parts.push(b.text);
    } else if (b.type === "toolCall") {
      parts.push(`<call ${b.name ?? "?"}#${b.id ?? "?"}>`);
    } else if (b.type === "image") {
      parts.push("<image>");
    } else if (b.type === "thinking") {
      parts.push("<thinking>");
    }
  }
  return parts.join("");
}

export class ScriptedModel {
  readonly calls: ModelCall[] = [];
  readonly model: Model<Api>;
  private steps: ScriptStep[];

  constructor(steps: ScriptStep[], options?: { contextWindow?: number; maxTokens?: number }) {
    ensureRegistered();
    this.steps = [...steps];
    nextModelId += 1;
    this.model = {
      // One id for every script, so transcripts compare across runs; the
      // script is found through the (unrecorded) base URL.
      id: "scripted",
      name: "scripted",
      api: SCRIPTED_API,
      provider: SCRIPTED_PROVIDER,
      baseUrl: `https://contract.invalid/${nextModelId}`,
      reasoning: false,
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: options?.contextWindow ?? 200_000,
      maxTokens: options?.maxTokens ?? 8_000,
    };
    scripts.set(this.model.baseUrl, this);
  }

  /** Steps not consumed yet; a finished scenario should leave none. */
  get remaining(): number {
    return this.steps.length;
  }

  push(...steps: ScriptStep[]): void {
    this.steps.push(...steps);
  }

  dispose(): void {
    scripts.delete(this.model.baseUrl);
  }

  private baseMessage(): AssistantMessage {
    return {
      role: "assistant",
      content: [],
      api: this.model.api,
      provider: this.model.provider,
      model: this.model.id,
      usage: zeroUsage(),
      stopReason: "stop",
      // A real clock: the session compares message times with compaction
      // times. The harness blanks timestamps before comparing.
      timestamp: Date.now(),
    };
  }

  respond(context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream {
    this.calls.push({
      index: this.calls.length,
      systemPrompt: context.systemPrompt ?? "",
      messages: context.messages.map(
        (m) => `${m.role}: ${describeContent((m as { content?: unknown }).content)}`,
      ),
      tools: (context.tools ?? []).map((t) => t.name),
      apiKey: options?.apiKey,
      maxTokens: options?.maxTokens,
    });
    if (options?.signal?.aborted) {
      // What a real provider does with an already-aborted signal; no step is consumed.
      const stream = createAssistantMessageEventStream();
      const aborted: AssistantMessage = {
        ...this.baseMessage(),
        stopReason: "aborted",
        errorMessage: "Request was aborted",
      };
      queueMicrotask(() => {
        stream.push({ type: "start", partial: aborted });
        stream.push({ type: "error", reason: "aborted", error: aborted });
        stream.end();
      });
      return stream;
    }
    const step: ScriptStep = this.steps.shift() ?? {
      kind: "error",
      message: "contract script exhausted",
    };
    if (step.kind === "throw") {
      throw new Error(step.message);
    }
    const stream = createAssistantMessageEventStream();
    const message = this.baseMessage();

    if (step.kind === "hang") {
      const text = step.partialText ?? "";
      queueMicrotask(() => {
        stream.push({ type: "start", partial: message });
        if (text) {
          message.content = [{ type: "text", text }];
          stream.push({ type: "text_start", contentIndex: 0, partial: message });
          stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
        }
        const finish = () => {
          const aborted: AssistantMessage = {
            ...message,
            stopReason: "aborted",
            errorMessage: "Request was aborted",
          };
          stream.push({ type: "error", reason: "aborted", error: aborted });
          stream.end();
        };
        const signal = options?.signal;
        if (!signal) {
          return;
        }
        if (signal.aborted) {
          finish();
        } else {
          signal.addEventListener("abort", finish, { once: true });
        }
      });
      return stream;
    }

    queueMicrotask(() => {
      stream.push({ type: "start", partial: message });
      if (step.kind === "error") {
        const failed: AssistantMessage = {
          ...message,
          stopReason: "error",
          errorMessage: step.message,
        };
        stream.push({ type: "error", reason: "error", error: failed });
        stream.end();
        return;
      }
      const text = step.kind === "text" ? step.text : (step.text ?? "");
      let index = 0;
      if (text) {
        message.content = [...message.content, { type: "text", text }];
        stream.push({ type: "text_start", contentIndex: index, partial: message });
        stream.push({ type: "text_delta", contentIndex: index, delta: text, partial: message });
        stream.push({ type: "text_end", contentIndex: index, content: text, partial: message });
        index += 1;
      }
      if (step.kind === "tools") {
        for (const call of step.calls) {
          const toolCall: ToolCall = {
            type: "toolCall",
            id: call.id,
            name: call.name,
            arguments: call.args,
          };
          message.content = [...message.content, toolCall];
          stream.push({ type: "toolcall_start", contentIndex: index, partial: message });
          stream.push({ type: "toolcall_end", contentIndex: index, toolCall, partial: message });
          index += 1;
        }
        message.stopReason = "toolUse";
        message.usage = zeroUsage(10, 5);
        stream.push({ type: "done", reason: "toolUse", message });
      } else {
        message.usage = zeroUsage(step.inputTokens ?? 10, 5);
        stream.push({ type: "done", reason: "stop", message });
      }
      stream.end();
    });
    return stream;
  }
}

function ensureRegistered(): void {
  if (registered) {
    return;
  }
  registered = true;
  const run = (
    model: Model<Api>,
    context: Context,
    options?: SimpleStreamOptions,
  ): AssistantMessageEventStream => {
    const script = scripts.get(model.baseUrl);
    if (!script) {
      throw new Error(`no contract script registered for ${model.baseUrl}`);
    }
    return script.respond(context, options);
  };
  registerApiProvider({ api: SCRIPTED_API, stream: run, streamSimple: run }, "bitterbot-contract");
}
