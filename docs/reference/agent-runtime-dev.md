---
title: "Agent Runtime Development"
summary: "How to work on the agent runtime: layout, contract suite and goldens, deliberate differences from pi, smoke and soak drivers"
---

# Agent runtime development

Bitterbot's agent runtime under `src/agents/runtime/` replaced the pi-coding-agent session layer and the pi-agent-core loop (PLAN-52). Provider transports and the model catalog stay on `@mariozechner/pi-ai`. The work landed in phases behind an engine flag, each phase checked against the pi engine; Phase 6 removed the pi engine and the flag now selects nothing. [Agent runtime](/reference/agent-runtime) describes the result; this page is about working on it.

## Layout

| Path                                  | What it is                                                                       |
| ------------------------------------- | -------------------------------------------------------------------------------- |
| `src/agents/runtime/transcript/`      | Transcript store: session JSONL v3 reader and writer, entry tree, branches       |
| `src/agents/runtime/loop/`            | Agent loop: stream, tool calls, results, steering, abort                         |
| `src/agents/runtime/session/`         | Session layer: persistence, retry, overflow recovery, compaction, tools, factory |
| `src/agents/runtime/compaction/`      | Compaction policies (summary, offload) and the transcript view                   |
| `src/agents/runtime/context-pruning/` | In-run context budget and tool-output stubs                                      |
| `src/agents/runtime/contract/`        | Contract suite: scripted model, harness, scenarios, goldens                      |
| `src/agents/runtime/models/`          | Model registry and auth storage (models.json, auth.json, request auth)           |
| `src/agents/runtime/tools/coding/`    | The read, write and edit file tools                                              |

`src/agents/runtime/engine.ts` still exports `resolveRuntimeEngine`; it returns `"bitterbot"` and warns once when a config names `"pi"`. The usage ledger keeps its `engine` column.

## Contract suite

`src/agents/runtime/contract/contract.test.ts` drives one agent session per scenario with a scripted model and records four things: the session event sequence, the transcript on disk, the in-memory messages, and what the model was sent (system prompt, messages, tool names, API key). Ids are renamed in order of appearance and clocks are blanked, so results compare line for line.

The scripted model (`scripted-model.ts`) is registered as a pi-ai API provider. Everything goes through the real `streamSimple` and `completeSimple` paths, including the compaction summary call. Nothing touches the network.

The committed goldens under `__snapshots__/` are the contract. They were recorded on the pi engine before it was removed, except for the scenarios in `DELIBERATE_DIFFERENCES` (`abort during a tool call`), whose golden was recorded on the owned engine. Run it:

```bash
npx vitest run --config vitest.unit.config.ts src/agents/runtime/contract
```

Scenarios cover: plain turn, two turns, sequential multi-tool turn, steering that skips the rest of a tool batch, abort while streaming, abort during a tool call, tool failures (throw, unknown tool, invalid arguments, argument coercion), retry on 429 and on a persistent 503, a non-retryable error, overflow recovery (and a second overflow), threshold compaction, manual compaction, compaction disabled, reload from disk, and a prompt while streaming.

Changing a golden is a behaviour change. Regenerate with `-u` only when the change is intended, and say why in the commit.

## Deliberate differences from pi

The runtime was held to pi's behaviour by the contract suite and by differential tests that ran the same operations through both implementations. The differential tests were deleted with the pi dependency; the differences they documented are the ones below, each still covered by a test of its own.

Loop (`loop/agent-loop.ts`, tests in `loop/agent-loop.test.ts`; `agent-loop.differential.test.ts` compares against pi-agent-core, which remains a type-level dependency):

- Tool calls of one assistant message run sequentially by default.
- A queued steering message skips the rest of the tool batch.
- After an abort, tool calls that have not started get an error result and are not executed, and the model is not called again.
- A stream that ends without a final message ends the turn with an error after 100 ms instead of hanging.

Session (`session/session.ts`, tests in `session/session.test.ts` and `session/session.review.test.ts`):

- No extension runner, resource loader, skill or prompt-template expansion, and no settings files.
- `prompt()` resolves when the session has settled: every message is persisted and any retry or post-compaction run has finished.
- A run that fails before producing an assistant message is retried or reported like any other failure.
- `abort()` also cancels a scheduled retry, a post-compaction run and an auto-compaction in flight; nothing starts or is written after a stop.
- A listener that throws does not stop the event from being persisted.
- The compaction summary goes through the session's stream function.
- A transcript write that fails makes `prompt()` reject.

Transcript store (`transcript/store.ts`, tests in `store.test.ts`):

1. It never writes a second header into an existing file.
2. A damaged file is moved aside (`<file>.corrupt.<timestamp>`), not overwritten.
3. An empty file is treated like a missing one.
4. A parent cycle in the entry tree ends the walk instead of hanging.

Compaction is a policy (`compaction/policy.ts`): `summary` is the port of pi's LLM summary (`compaction/summary/`); `offload` is the PLAN-52A horizon cut (`compaction/offload-compaction.ts`).

## Runner tests

`src/agents/embedded-runner.engine.test.ts` runs the full runner (`runEmbeddedPiAgent` and the explicit compaction path) with a scripted model and checks the replies, the model inputs and the transcript. `src/agents/embedded-runner.engine-hooks.test.ts` registers every agent plugin hook (`before_agent_start`, `llm_input`, `llm_output`, `before_tool_call`, `after_tool_call`, `tool_result_persist`, `before_compaction`, `after_compaction`, `agent_end`) and checks which fire, in what order and with what payloads, for a tool turn, an explicit compaction and a threshold compaction. Both sets of expectations were fixed while the pi engine still ran the same scenarios. `src/agents/embedded-runner.engine.review.test.ts` holds the adversarial findings.

Type-only imports of `@mariozechner/pi-agent-core` (message, tool and event types) remain across the tree; they are replaced by the loop's own types in a follow-up.

## Live smoke check

`benchmarks/runtime-smoke/smoke.ts` drives the real runner against the Anthropic API, without the gateway. It points `BITTERBOT_STATE_DIR` at a scratch directory, creates its own workspace and agent directory there, and reads only the API key from the real install. It asserts on the transcript, not on what the agent says about itself.

```bash
node --import tsx benchmarks/runtime-smoke/smoke.ts \
  --model claude-opus-4-8 --compact --think high
```

Checks: a turn with a tool call (the reply must contain a random token that exists only in a workspace file), a follow-up turn on the same session, and with `--compact` the explicit compaction path. On 2026-10-01 all checks passed with Haiku 4.5 and with Opus 4.8; with `--think high` on Opus 4.8 the pi engine's compaction failed with the provider's 400 (`thinking.type.enabled is not supported for this model`) while the owned runtime's succeeded.

`--overflow` replaces those checks with an overflow recovery: it seeds the session with a history that fits (72% of `--window`, sized with the provider's token counter), then sends one prompt whose paste takes the request over the window. The provider must refuse the request, a compaction entry must follow, and the run must still answer with a token that exists only in the compacted part.

```bash
node --import tsx benchmarks/runtime-smoke/smoke.ts \
  --model claude-opus-4-8 --overflow --window 1000000 --think high
```

On 2026-10-01 this passed with Haiku 4.5 (200k window, refused at 219,587 tokens) and with Opus 4.8 with thinking on (1M window, refused at 1,067,928 tokens, recovered in 39 s). The Opus run costs about $6: one summary call over the seeded history and one retry. Opus 4.8 is resolved from the Opus 4.6 catalogue entry, so its window is 1M; a request of 220k tokens is accepted and no compaction runs.

## Soak driver

`benchmarks/runtime-soak/drive.ts` sends real traffic to test agents through the running gateway and checks every turn on disk. Use it only with test agents: it talks to the live gateway as an operator.

```bash
node --import tsx benchmarks/runtime-soak/drive.ts \
  --agents drill-haiku,learning-eval-20260905:every=6 \
  --rounds 60 --sleep-minutes 5 --max-usd 18
```

Per round and agent, in a fresh session: write and read a file, run a shell pipeline whose output only the tool can produce, edit, a failing read, a three-file chain, an answer from the conversation, `/compact` through `chat.send` and an answer from the compacted part, an abort, a sub-agent (every third round), and one turn through `chat.send` with the event stream counted. In one long-lived session per agent it reads a generated log in chunks and is asked for the oldest marked id without reading again, so that session crosses the compaction thresholds every few rounds. Rows go to `~/.bitterbot/eval/runtime-soak/results.jsonl`; spend is read from the usage ledger and capped per agent. `node benchmarks/runtime-soak/report.mjs [tag]` summarises them.

Do not run type checks or test suites on the same machine while it runs: on a small box they starve the gateway's event loop and the latencies mean nothing.

On 2026-10-02 the long session of an agent with `compaction.policy: offload` crossed the turn-end trigger through the gateway for the first time: turns 1 to 4 (35 messages, about 53k tokens) were replaced by a ledger, and the next probe answered with the value from the offloaded part.

Keep prompts under the complexity gate (PLAN-22): a "read, then write" wording scored in its gray band and the gateway opened a goal task for it on every round.

What it found on its first day (2026-10-02), all fixed: a shell command that printed after its turn had ended crashed the gateway on the pi engine (pi-agent-core rejected a progress update outside a run, and nothing awaited it); file reads were served from a process-wide five-minute cache with no invalidation and no agent in the key. The cache now holds only `web_search` and `web_fetch` by default, sits inside every gate, and is keyed by agent, workspace, session and sandbox state.

## Rules

- A change to the runtime is done when the contract suite is green against the committed goldens, CI is green on the three platforms, and a separate adversarial pass has been run.
- Verify live behaviour on test agents by asserting on disk, the database, or the usage ledger. Do not ask the live agent: its answers are extracted into memory.
- Ported code keeps an MIT attribution header naming pi-mono and its author.
