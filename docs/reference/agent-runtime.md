---
title: "Agent Runtime"
summary: "How an agent turn runs: transcript store, agent loop, session layer, compaction policies, tool pipeline, model registry, and what still comes from pi-ai"
---

# Agent runtime

Every agent turn in Bitterbot runs on the runtime under `src/agents/runtime/`. It owns the transcript on disk, the loop that streams the model and executes tools, the session that persists, retries and compacts, and the model registry that resolves credentials. Provider transports (the HTTP and streaming code per model API) and the model catalog come from `@mariozechner/pi-ai`.

This page describes the runtime as it is in the code. For how to work on it (contract suite, goldens, smoke and soak drivers) see [Agent runtime development](/reference/agent-runtime-dev).

## Layers

| Layer               | Path                                  | Owns                                                                          |
| ------------------- | ------------------------------------- | ----------------------------------------------------------------------------- |
| Transcript store    | `src/agents/runtime/transcript/`      | Session JSONL v3 on disk: header, entry tree, branches, compaction entries    |
| Agent loop          | `src/agents/runtime/loop/`            | One turn: stream, tool calls, results, steering and follow-up queues, abort   |
| Session             | `src/agents/runtime/session/`         | Persistence, retry, overflow recovery, compaction, tool wrapping, the factory |
| Compaction policies | `src/agents/runtime/compaction/`      | `summary` and `offload`, the transcript view, the offload ledger and recall   |
| In-run budget       | `src/agents/runtime/context-pruning/` | Tool-output stubs applied between tool calls of one turn                      |
| Model registry      | `src/agents/runtime/models/`          | `models.json`, `auth.json`, request auth (key and headers) per model          |
| File tools          | `src/agents/runtime/tools/coding/`    | `read`, `write`, `edit`                                                       |
| Contract suite      | `src/agents/runtime/contract/`        | Scripted model, harness, scenarios, committed goldens                         |

The embedded runner (`src/agents/embedded-runner/`) sits on top: it builds the system prompt and the tool set for a run, opens the transcript, creates the session, installs the stream function stack, drives the prompt, and subscribes to the session's events for replies, hooks and usage accounting.

## Transcript store

`TranscriptStore` (`transcript/store.ts`) reads and writes one JSONL file per session (`agents/<agentId>/sessions/<timestamp>_<sessionId>.jsonl`). The first line is the header (`type: "session"`, `version: 3`, `id`, `timestamp`, `cwd`, optional `parentSession`). Every later line is an entry with an `id`, a `parentId` and a `timestamp`; the entries form a tree, and the branch from the root to the current leaf is the conversation the model sees. Entry types (`transcript/types.ts`):

- `message`: a user, assistant, tool-result or custom message.
- `compaction`: a summary that replaces everything before `firstKeptEntryId`, with `tokensBefore` and policy details.
- `custom`: data an extension or the runtime records (offload ledger entries, tool-output stubs, cache-TTL marks).
- `model_change`, `thinking_level_change`, `session_info`, `label`, `custom_message`, `branch_summary`.

`buildSessionContext()` (`transcript/context.ts`) turns the current branch into the messages for a request: entries before the latest compaction are replaced by its summary. Older files are migrated to v3 on open (`transcript/migrations.ts`).

Rules the store follows (each with a test in `store.test.ts`): it never writes a second header into an existing file; a damaged file is moved aside as `<file>.corrupt.<timestamp>` instead of being overwritten; an empty file is treated like a missing one; a parent cycle ends the walk instead of hanging; lines before the first valid header are skipped; a torn last line is closed before the next append.

Outside a run, `openTranscriptForAgent` (`runtime/open-transcript.ts`) is the one entry point for the delivery mirror, chat inject and thread fork.

## Agent loop

`loop/agent-loop.ts` runs one turn: stream an assistant response through the stream function, execute the tool calls it contains, append the results, and repeat until the model stops calling tools and both queues are empty. `loop/agent.ts` is the stateful wrapper (`state.messages`, `state.tools`, `streamFn`, `waitForIdle`) the session and the runner use.

- Tool calls of one assistant message run **sequentially** by default (`toolExecution`); a tool can still declare `executionMode`.
- A **steering** message queued while tools run skips the rest of the batch: each remaining call gets the result "Skipped due to queued user message." and the steering message is injected at the next poll.
- After an **abort**, tool calls that have not started get an error result and are not executed, and the model is not called again.
- A stream that ends without a final message ends the turn with an error after 100 ms instead of hanging.
- Argument validation (`loop/validation-hints.ts`) names the allowed values when an enum string is wrong.

## Session

`AgentSession` (`session/session.ts`) wires the loop to a transcript store and is the surface the embedded runner and its subscriber use: `prompt`, `steer`, `abort`, `compact`, `subscribe`, `dispose`, `messages`, `isStreaming`, `isCompacting`, `agent`.

- **Persistence**: every loop event is processed in order and each message is appended to the store before the next event is handled. A write that fails is reported (`onPersistenceError`) and makes `prompt()` reject.
- **Settling**: `prompt()` resolves only when the event queue is drained and any retry or post-compaction run has finished.
- **Retry**: a transient provider error (rate limit, 5xx, network, timeout; the regex is pi's) is retried with exponential backoff, `maxRetries` 3 by default. A failure before any assistant message is retried the same way.
- **Overflow recovery**: a context-overflow error triggers one compaction and one retry; a second overflow after that is reported, not retried.
- **Stop semantics**: `abort()` cancels a scheduled retry, a post-compaction run and an auto-compaction in flight; a prompt still in its preflight when `abort()` or `dispose()` arrives does not start a run; a disposed session writes nothing.
- **Request auth**: `resolveRequestAuth` is checked before a prompt and passed to the compaction summary. For turns, the embedded runner wraps the stream function with `withSessionRequestAuth` (`embedded-runner/session-auth.ts`), which resolves the key and headers from the model registry on every call.

`createOwnedSession` (`session/create.ts`) builds the session from the gateway config: compaction reserve floor (`agents.defaults.compaction.reserveTokensFloor`, default 20,000 tokens, `session/compaction-reserve.ts`), the compaction policy for the agent, and the log sink.

### Compaction policies

Compaction is a `CompactionPolicy` (`compaction/policy.ts`); the session asks it after each turn, before a turn, and on overflow or `/compact`.

- **`summary`** (`compaction/summary-policy.ts`, `compaction/summary/`): the port of pi's LLM summary. It triggers when the context plus the reserve exceeds the window (`reserveTokens`, at least the floor above) and keeps the most recent `keepRecentTokens` (20,000) verbatim. The summary request goes through the session's stream function, so the same provider path, auth and usage accounting apply as for turns.
- **`offload`** (`compaction/offload-compaction.ts`, `compaction/offload-policy.ts`): the PLAN-52A horizon cut. After a turn at 55% of the window and before a turn at 70% (`triggerTurnEndFraction`, `triggerTurnStartFraction`), the older part of the dialogue is replaced by a deterministic ledger (`custom` entries plus a short cheap-model summary by default) and stays recoverable through `recall_range` and `deep_recall`. Bare heartbeat pairs are elided; the summary policy is the fallback.

Selection is `agents.defaults.compaction.policy` with a per-agent override; see [Compaction](/concepts/compaction) and the [configuration reference](/gateway/configuration-reference#agents-defaults-compaction).

### In-run budget

Between the tool calls of one turn the loop's `transformContext` hook runs the in-run budget (`context-pruning/in-run-budget.ts`): at 80% of the window (`triggerMidTurnFraction`) large tool outputs already in the context are replaced by stubs, recorded as `custom` entries so later turns re-apply them, with progressive compression as the fallback. The embedded runner installs it in `embedded-runner/run/attempt.ts`.

## Tool pipeline

1. `createBitterbotCodingTools` (`src/agents/agent-tools.ts`) builds the tool set for the run from the tool policy, the sandbox, the channel and the sender (owner-only tools, message tool hints).
2. Provider adjustments: `sanitizeToolsForGoogle` and the active harness policy's description overrides.
3. **Hot set** (`src/agents/tools/tool-registry-hot-set.ts`): the model does not receive all tool schemas. On Anthropic API-key auth with tool search enabled the full registry is sent with every tool outside the hot set flagged `defer_loading`; elsewhere the hot tools are sent with full schemas plus `list_tools` and `use_tool`, which dispatch to the same wrapped tool objects.
4. `toRuntimeTools` (`session/tools.ts`, `session/tool-definition-adapter.ts`) wraps each tool for the loop: the `before_tool_call` plugin hook runs, arguments are prepared and enum-checked, and a thrown error becomes a JSON error result (`{status: "error", tool, error}`) so the model sees the failure and the turn continues. Client (hosted) tools are recorded and answered with a pending result.
5. The loop executes the wrapped tool; the subscriber (`src/agents/embedded-subscribe*.ts`) fires `after_tool_call`, records the usage row and emits the tool result to the channel.

## System prompt

`buildEmbeddedSystemPrompt` (`embedded-runner/system-prompt.ts`) assembles the prompt once per run: bootstrap files (GENOME, PROTOCOLS, TOOLS, MEMORY), the skills index, runtime info, channel hints, endocrine state, canonical facts and research findings, with a `minimal` mode for sub-agents, cron, heartbeats and remote task turns. The session receives it as its one `systemPrompt`; nothing rebuilds it per prompt or per tool change. See [System prompt](/concepts/system-prompt).

## Model registry and auth

`ModelRegistry` and `AuthStorage` (`runtime/models/`) are the owned ports of pi-coding-agent's classes:

- `models.json` under the agent directory lists the models (written by `ensureBitterbotModelsJson` from `models.providers` in the config and the pi-ai catalog).
- `auth.json` holds API keys and OAuth credentials per provider; `auth-json.ts` bridges OAuth profiles from `auth-profiles.json` (openai-codex today) so the registry sees the provider as authenticated.
- `getApiKeyAndHeaders(model)` resolves, in order, a runtime key set for the process, stored credentials, and `apiKey` / `headers` / `authHeader` from `models.json`.

`resolveModel` (`embedded-runner/model.ts`) picks the `Model` for a run, with failover and the retired-provider list.

## What comes from pi-ai

`@mariozechner/pi-ai` provides the provider transports (`streamSimple`, `completeSimple` and the per-API implementations) and the built-in model catalog with context windows, costs and capabilities. The in-tree Anthropic provider (`src/agents/providers/anthropic/`) replaces pi-ai's Anthropic transport when `agents.defaults.anthropic.runtime` is `native` (the default) and adds tool search, the cache layout and the `<runtime-state>` placement. Ollama uses its own stream function (`src/agents/ollama-stream.ts`).

Type-only imports of `@mariozechner/pi-agent-core` (message, tool and event types) remain across the tree; replacing them with the loop's own types is a follow-up.

## Configuration keys that no longer select anything

- `agents.defaults.runtime.engine` and `agents.list[].runtime.engine`: accepted and ignored. `"pi"` logs one warning per process.
- `agents.defaults.compaction.mode: "safeguard"` and `agents.defaults.contextPruning`: accepted, no effect (see `LIMITATIONS.md`).
