---
title: "Agent Runtime Development"
summary: "How to work on the owned agent runtime: engine flag, contract suite, goldens, and the transcript differential test"
---

# Agent runtime development

Bitterbot is replacing the pi-coding-agent session layer and the pi-agent-core loop with its own runtime under `src/agents/runtime/`. Provider transports and the model catalog stay on `@mariozechner/pi-ai`. The work lands in phases behind an engine flag, and every phase is checked against the pi engine before it is switched on.

## Engine flag

`agents.defaults.runtime.engine` (`"pi"` by default, or `"bitterbot"`), with a per-agent override at `agents.list[].runtime.engine`. `resolveRuntimeEngine` in `src/agents/runtime/engine.ts` is the only place that reads it.

The session file format (JSONL v3) is the same on both engines. Switching an agent between turns is safe.

## Layout

| Path                                  | What it is                                                                 |
| ------------------------------------- | -------------------------------------------------------------------------- |
| `src/agents/runtime/transcript/`      | Transcript store: session JSONL v3 reader and writer, entry tree, branches |
| `src/agents/runtime/loop/`            | Agent loop: stream, tool calls, results, steering, abort                   |
| `src/agents/runtime/session/`         | Session layer: persistence, retry, overflow recovery, compaction, factory  |
| `src/agents/runtime/compaction/`      | Compaction policies (summary, offload) and the transcript view             |
| `src/agents/runtime/context-pruning/` | In-run context budget and tool-output stubs                                |
| `src/agents/runtime/contract/`        | Contract suite: scripted model, harness, scenarios, goldens                |
| `src/agents/runtime/engines/pi/`      | Adapter code that exists only to talk to pi                                |

## Contract suite

`src/agents/runtime/contract/contract.test.ts` drives one agent session per scenario with a scripted model and records four things: the session event sequence, the transcript on disk, the in-memory messages, and what the model was sent (system prompt, messages, tool names, API key). Ids are renamed in order of appearance and clocks are blanked, so results compare line for line.

The scripted model (`scripted-model.ts`) is registered as a pi-ai API provider. Everything goes through the real `streamSimple` and `completeSimple` paths, including the compaction summary call. Nothing touches the network.

Variants:

- `pi`: pi session, loop, and `SessionManager`. Its result is the golden, committed under `__snapshots__/`.
- `pi-owned-store`: pi session and loop over the owned transcript store. Must equal `pi` exactly.
- `bitterbot`: the owned session, loop, and store. Must equal `pi` exactly, except for the scenarios listed in `DELIBERATE_DIFFERENCES`, which carry their own golden.

Run it:

```bash
npx vitest run --config vitest.unit.config.ts src/agents/runtime/contract
```

Select variants with `BITTERBOT_CONTRACT_VARIANTS=pi,bitterbot`.

Scenarios cover: plain turn, two turns, sequential multi-tool turn, steering that skips the rest of a tool batch, abort while streaming, abort during a tool call, tool failures (throw, unknown tool, invalid arguments, argument coercion), retry on 429 and on a persistent 503, a non-retryable error, overflow recovery (and a second overflow), threshold compaction, manual compaction, compaction disabled, reload from disk, and a prompt while streaming.

Changing a golden is a behaviour change. Regenerate with `-u` only when the change is intended, and say why in the commit.

## What the owned engine does differently

The contract suite holds the owned engine to pi's behaviour. The differences below are deliberate, each with a test.

Loop (`loop/agent-loop.ts`, tests in `loop/agent-loop.test.ts`; `agent-loop.differential.test.ts` proves parity with pi-agent-core when the options are set to pi's values):

- Tool calls of one assistant message run sequentially by default.
- A queued steering message skips the rest of the tool batch.
- After an abort, tool calls that have not started get an error result and are not executed, and the model is not called again.
- A stream that ends without a final message ends the turn with an error after 100 ms instead of hanging.

Session (`session/session.ts`, tests in `session/session.test.ts`):

- No extension runner, resource loader, skill or prompt-template expansion, and no settings files.
- `prompt()` resolves when the session has settled: every message is persisted and any retry or post-compaction run has finished.
- A run that fails before producing an assistant message is retried or reported like any other failure. On pi a pending retry wait is never resolved in that case.
- `abort()` also cancels a scheduled retry or post-compaction run.
- A listener that throws does not stop the event from being persisted.
- The compaction summary goes through the session's stream function.

Compaction is a policy (`compaction/policy.ts`): `summary` is the port of pi's LLM summary (`compaction/summary/`, checked against pi by `summary.differential.test.ts`); `offload` is the PLAN-52A horizon cut (`compaction/offload-compaction.ts`).

`src/agents/embedded-runner.engine.test.ts` runs the full runner (`runEmbeddedPiAgent` and the explicit compaction path) on both engines and requires the same replies, model inputs, and transcript.

## Transcript differential test

`src/agents/runtime/transcript/store.differential.test.ts` runs the same operations through pi's `SessionManager` and the owned `TranscriptStore` on copies of the same file and compares the bytes written (key order included) and every read result.

To compare every real session on a machine (copies are opened; the originals are never touched):

```bash
BITTERBOT_TRANSCRIPT_CORPUS=~/.bitterbot/agents \
  npx vitest run --config vitest.unit.config.ts src/agents/runtime/transcript -t corpus
```

The owned store differs from pi on purpose in four places, each with a test in `store.test.ts`:

1. It never writes a second header into an existing file.
2. A damaged file is moved aside (`<file>.corrupt.<timestamp>`), not overwritten.
3. An empty file is treated like a missing one.
4. A parent cycle in the entry tree ends the walk instead of hanging.

## Rules

- A phase is done when the contract suite is green for its variant, CI is green on the three platforms, and a separate adversarial pass has been run.
- Verify live behaviour on test agents by asserting on disk, the database, or the usage ledger. Do not ask the live agent: its answers are extracted into memory.
- Ported code keeps an MIT attribution header naming pi-mono and its author.
