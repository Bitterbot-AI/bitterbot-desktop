/**
 * PLAN-52 Phase 3: the LLM summary of a compaction.
 *
 * Ported from pi-coding-agent 0.73.1 (MIT, Mario Zechner / pi-mono),
 * `core/compaction/compaction.js` (`generateSummary`, the turn-prefix
 * summary, `compact`, the three summarization prompts) and
 * `core/compaction/utils.js` (`SUMMARIZATION_SYSTEM_PROMPT`). The prompts must
 * stay byte-identical: the runtime contract suite compares the text sent to
 * the model with goldens recorded from pi.
 *
 * Differences from the original:
 *
 * 1. The model call is injectable: `complete` in the options, default pi-ai's
 *    `completeSimple`.
 * 2. `compact` and `generateSummary` take an options object where pi takes
 *    positional arguments. `apiKey` is optional (pi types it as required and
 *    passes it through unchanged, as this port does).
 * 3. `generateTurnPrefixSummary` is exported (private in pi).
 *
 * Kept as in pi, on purpose:
 * - The history summary may use `floor(0.8 * reserveTokens)` output tokens,
 *   the turn-prefix summary `floor(0.5 * reserveTokens)`.
 * - For a split turn both calls start in the same tick, history first, and
 *   run concurrently; the first rejection wins.
 * - `reasoning` is only sent when the model supports reasoning and the level
 *   is set and not "off".
 * - Custom instructions apply to the history summary only, not to the
 *   turn-prefix summary.
 * - Only `stopReason: "error"` throws. An aborted response is not an error
 *   here: its text (usually empty) becomes the summary, and the caller is
 *   expected to check its own abort signal.
 * - A split turn with no earlier history gets the literal "No prior history."
 *   in place of the history summary, without a model call.
 */
import {
  type Api,
  type AssistantMessage,
  completeSimple,
  type Context,
  type Message,
  type Model,
  type SimpleStreamOptions,
  type TextContent,
} from "@mariozechner/pi-ai";
import type { CompactionPreparation } from "./cut.js";
import { convertToLlm, type SessionMessage } from "./messages.js";
import { computeFileLists, formatFileOperations, serializeConversation } from "./serialize.js";

export const SUMMARIZATION_SYSTEM_PROMPT = `You are a context summarization assistant. Your task is to read a conversation between a user and an AI coding assistant, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.`;

export const SUMMARIZATION_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

export const UPDATE_SUMMARIZATION_PROMPT = `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- If something is no longer relevant, you may remove it

Use this EXACT format:

## Goal
[Preserve existing goals, add new ones if the task expanded]

## Constraints & Preferences
- [Preserve existing, add new ones discovered]

## Progress
### Done
- [x] [Include previously done items AND newly completed items]

### In Progress
- [ ] [Current work - update based on progress]

### Blocked
- [Current blockers - remove if resolved]

## Key Decisions
- **[Decision]**: [Brief rationale] (preserve all previous, add new)

## Next Steps
1. [Update based on current state]

## Critical Context
- [Preserve important context, add new if needed]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

export const TURN_PREFIX_SUMMARIZATION_PROMPT = `This is the PREFIX of a turn that was too large to keep. The SUFFIX (recent work) is retained.

Summarize the prefix to provide context for the retained suffix:

## Original Request
[What did the user ask for in this turn?]

## Early Progress
- [Key decisions and work done in the prefix]

## Context for Suffix
- [Information needed to understand the retained recent work]

Be concise. Focus on what's needed to understand the kept suffix.`;

/** Reasoning level of the summary call. "off" (or unset) sends no reasoning option. */
export type SummaryThinkingLevel = "off" | NonNullable<SimpleStreamOptions["reasoning"]>;

/** The model call. Same contract as pi-ai's `completeSimple`, which is the default. */
export type CompleteFn = (
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
) => Promise<AssistantMessage>;

/** What every summary call needs. */
export interface SummaryCallOptions {
  model: Model<Api>;
  apiKey?: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  thinkingLevel?: SummaryThinkingLevel;
  /** Model call; defaults to pi-ai's `completeSimple`. */
  complete?: CompleteFn;
}

export interface GenerateSummaryOptions extends SummaryCallOptions {
  /** `settings.reserveTokens`; the summary may use 80% of it. */
  reserveTokens: number;
  /** Extra focus for the summary, appended to the prompt. */
  customInstructions?: string;
  /** Summary of the previous compaction; switches to the update prompt. */
  previousSummary?: string;
}

export interface GenerateTurnPrefixSummaryOptions extends SummaryCallOptions {
  /** `settings.reserveTokens`; the turn-prefix summary may use 50% of it. */
  reserveTokens: number;
}

export interface CompactOptions extends SummaryCallOptions {
  /** Extra focus for the history summary, appended to the prompt. */
  customInstructions?: string;
}

/** Stored in `CompactionEntry.details`. */
export interface CompactionDetails {
  readFiles: string[];
  modifiedFiles: string[];
}

/** Result of `compact`; the transcript store adds id, parent and timestamp. */
export interface CompactionResult<T = unknown> {
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  details?: T;
}

function completionOptions(options: SummaryCallOptions, maxTokens: number): SimpleStreamOptions {
  const { model, apiKey, headers, signal, thinkingLevel } = options;
  return model.reasoning && thinkingLevel && thinkingLevel !== "off"
    ? { maxTokens, signal, apiKey, headers, reasoning: thinkingLevel }
    : { maxTokens, signal, apiKey, headers };
}

function summarizationRequest(promptText: string): Context {
  const messages: Message[] = [
    {
      role: "user",
      content: [{ type: "text", text: promptText }],
      timestamp: Date.now(),
    },
  ];
  return { systemPrompt: SUMMARIZATION_SYSTEM_PROMPT, messages };
}

function responseText(response: AssistantMessage): string {
  return response.content
    .filter((c): c is TextContent => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

/**
 * Summarize messages with the model. With `previousSummary` the update prompt
 * is used, so the model merges the new messages into the existing summary.
 * Throws "Summarization failed: ..." when the model reports an error.
 */
export async function generateSummary(
  currentMessages: readonly SessionMessage[],
  options: GenerateSummaryOptions,
): Promise<string> {
  const { model, reserveTokens, customInstructions, previousSummary } = options;
  const complete: CompleteFn = options.complete ?? completeSimple;
  const maxTokens = Math.floor(0.8 * reserveTokens);

  let basePrompt = previousSummary ? UPDATE_SUMMARIZATION_PROMPT : SUMMARIZATION_PROMPT;
  if (customInstructions) {
    basePrompt = `${basePrompt}\n\nAdditional focus: ${customInstructions}`;
  }

  // The conversation is sent as text inside tags so the model does not try to
  // continue it.
  const conversationText = serializeConversation(convertToLlm(currentMessages));
  let promptText = `<conversation>\n${conversationText}\n</conversation>\n\n`;
  if (previousSummary) {
    promptText += `<previous-summary>\n${previousSummary}\n</previous-summary>\n\n`;
  }
  promptText += basePrompt;

  const response = await complete(
    model,
    summarizationRequest(promptText),
    completionOptions(options, maxTokens),
  );
  if (response.stopReason === "error") {
    throw new Error(`Summarization failed: ${response.errorMessage || "Unknown error"}`);
  }
  return responseText(response);
}

/**
 * Summarize the start of a turn whose end is kept (a split turn). Throws
 * "Turn prefix summarization failed: ..." when the model reports an error.
 */
export async function generateTurnPrefixSummary(
  messages: readonly SessionMessage[],
  options: GenerateTurnPrefixSummaryOptions,
): Promise<string> {
  const complete: CompleteFn = options.complete ?? completeSimple;
  const maxTokens = Math.floor(0.5 * options.reserveTokens);
  const conversationText = serializeConversation(convertToLlm(messages));
  const promptText = `<conversation>\n${conversationText}\n</conversation>\n\n${TURN_PREFIX_SUMMARIZATION_PROMPT}`;

  const response = await complete(
    options.model,
    summarizationRequest(promptText),
    completionOptions(options, maxTokens),
  );
  if (response.stopReason === "error") {
    throw new Error(
      `Turn prefix summarization failed: ${response.errorMessage || "Unknown error"}`,
    );
  }
  return responseText(response);
}

/**
 * Run the summary calls for a prepared compaction and assemble the result:
 * history summary, the turn context for a split turn, then the file lists.
 * The caller persists it (for example `TranscriptStore.appendCompaction`).
 */
export async function compact(
  preparation: CompactionPreparation,
  options: CompactOptions,
): Promise<CompactionResult<CompactionDetails>> {
  const {
    firstKeptEntryId,
    messagesToSummarize,
    turnPrefixMessages,
    isSplitTurn,
    tokensBefore,
    previousSummary,
    fileOps,
    settings,
  } = preparation;
  const { model, apiKey, headers, signal, thinkingLevel, complete, customInstructions } = options;
  const call: SummaryCallOptions = { model, apiKey, headers, signal, thinkingLevel, complete };
  const reserveTokens = settings.reserveTokens;

  let summary: string;
  if (isSplitTurn && turnPrefixMessages.length > 0) {
    // Both calls start here, history first, and run concurrently.
    const [historyResult, turnPrefixResult] = await Promise.all([
      messagesToSummarize.length > 0
        ? generateSummary(messagesToSummarize, {
            ...call,
            reserveTokens,
            customInstructions,
            previousSummary,
          })
        : Promise.resolve("No prior history."),
      generateTurnPrefixSummary(turnPrefixMessages, { ...call, reserveTokens }),
    ]);
    summary = `${historyResult}\n\n---\n\n**Turn Context (split turn):**\n\n${turnPrefixResult}`;
  } else {
    summary = await generateSummary(messagesToSummarize, {
      ...call,
      reserveTokens,
      customInstructions,
      previousSummary,
    });
  }

  const { readFiles, modifiedFiles } = computeFileLists(fileOps);
  summary += formatFileOperations(readFiles, modifiedFiles);

  if (!firstKeptEntryId) {
    throw new Error("First kept entry has no UUID - session may need migration");
  }

  return {
    summary,
    firstKeptEntryId,
    tokensBefore,
    details: { readFiles, modifiedFiles },
  };
}
