# Task Schema and Evaluation

This page explains how a task is scored in τ-bench and — most importantly —
**what `evaluation_criteria.actions` actually does**. If you have looked at
`data/tau2/domains/airline/tasks.json` and assumed those listed actions are
required of the agent, this page is for you.

## TL;DR

- A task's final reward is the **product** of the components listed in
  `evaluation_criteria.reward_basis`.
- The task schema defaults `reward_basis` to `["DB", "COMMUNICATE"]`.
  A task's explicit basis takes precedence; domains can score different components.
- `evaluation_criteria.actions` is **one reference trajectory** that
  solves the task — not the only correct one. It is replayed on a fresh
  "gold" environment to derive a target DB end state, which is then
  compared (by hash) to the predicted environment's DB end state. The
  agent is **not** required to take this specific path; any sequence of
  tool calls that produces an equivalent DB end state passes the DB
  check.
- The agent is required to match `actions` *only* when `RewardType.ACTION`
  is in `reward_basis` (used in a small subset of `banking_knowledge`
  tasks; **not used at all** in airline / retail / telecom). When that
  flag is set, the listed actions are treated as the assumed-unique
  correct trajectory — which is a strong assumption and is why most
  τ-bench tasks deliberately do not use it.
- This was a deliberate design choice (see [issue #224][issue-224] and
  [RFC #129][issue-129] for the discussion). We surface this here so it
  is harder to miss.

[issue-224]: https://github.com/sierra-research/tau2-bench/issues/224
[issue-129]: https://github.com/sierra-research/tau2-bench/issues/129

## The task schema, in plain English

A task's `evaluation_criteria` (see
[`src/tau2/data_model/tasks.py`](../src/tau2/data_model/tasks.py)) has five
fields:

| Field | What it is | When it gates the reward |
|-------|-----------|--------------------------|
| `actions` | A list of `Action`s recording **one** reference trajectory of tool calls that solves the task. Always replayed on a fresh "gold" environment to derive the target DB end state. Other trajectories may produce an equivalent end state and also pass. | Only when `RewardType.ACTION` is in `reward_basis` (then each entry must also appear among the agent's tool calls — i.e., this list is treated as the only acceptable trajectory). |
| `env_assertions` | A list of assertions to run against the predicted environment after the simulation. | Only when `RewardType.ENV_ASSERTION` is in `reward_basis`. |
| `communicate_info` | Required information, checked by substring matching or the configured semantic judge. | Only when `RewardType.COMMUNICATE` is in `reward_basis`. |
| `nl_assertions` | Natural-language assertions judged by an LLM. | Only when `RewardType.NL_ASSERTION` is in `reward_basis`. (Experimental / WIP.) |
| `reward_basis` | The list of `RewardType`s that gate the final reward. | Always. Default is `[DB, COMMUNICATE]`. |

The reward components are evaluated by:

| `RewardType` | Evaluator | What it checks |
|--------------|-----------|----------------|
| `DB` | `EnvironmentEvaluator` | After the simulation, does the predicted environment's DB hash match the target DB hash (target = fresh env + replay of `evaluation_criteria.actions`)? Any agent trajectory that produces an equivalent end state passes. |
| `ENV_ASSERTION` | `EnvironmentEvaluator` | Do all `env_assertions` pass on the predicted environment? |
| `COMMUNICATE` | `CommunicateEvaluator` | Was every required item communicated? Uses the semantic LLM judge by default; substring matching only with `--communicate-scorer substring`. |
| `NL_ASSERTION` | `NLAssertionsEvaluator` | Does an LLM judge return true for every entry in `nl_assertions`? (WIP) |
| `ACTION` | `ActionEvaluator` | For every entry in `actions`, did the agent produce a matching tool call (per `Action.compare_with_tool_call`)? Use this only when you are confident `actions` enumerates the only acceptable trajectory. |

The final reward is the product. So if `reward_basis = [DB, COMMUNICATE]`,
the reward is `db_reward * communicate_reward`. `actions` is consumed
silently by `EnvironmentEvaluator` to set up the target environment, but
the agent's tool-call trajectory is never directly compared to it.

## Communication checks

`CommunicateEvaluator` and its full-duplex variant own both matching modes,
selected by `CommunicateScoring`. By default the pinned semantic judge checks
meaning, including paraphrases and translations, once per expected fact; the
judge's language addendum is added only for cross-lingual calls. With
`scorer="substring"` they use the original case-insensitive substring check,
removing commas from agent text. Full-duplex runs use the same merged agent-message transcript in either mode.
NL assertions remain a separate evaluator.

The default semantic communication judge is `gpt-5.5` with
`reasoning_effort: low`. Explicit model and reasoning overrides are preserved.

Normal `ALL` and `ALL_WITH_NL_ASSERTIONS` scoring runs communication checks only
when `COMMUNICATE` is in the task's `reward_basis`. Otherwise,
`communicate_checks` and its evaluation metadata are `null`, and no communication
reward is added. Explicit `COMMUNICATE` evaluation and both ignore-basis modes
still evaluate it. Missing criteria, `communicate_info: null`, or an empty list
are neutral and make no communication-judge calls.

This does not change task requirements or their reward basis. Communication
success cannot compensate for a failed DB check when both components gate reward.

## Why `actions` looks like a requirement (and isn't)

`evaluation_criteria.actions` records *one* sequence of tool calls that
solves the task — typically how a task author or annotator solved it.
There is generally no claim that this is the only correct sequence, and
in many tasks several distinct trajectories produce an equivalent DB
end state (e.g., looking up a user before or after looking up a
reservation, or skipping a read-only lookup the agent doesn't actually
need). We keep this reference trajectory in the task because, for many
tasks, the target DB state is easier to express as "play these actions
on a fresh env" than to spell out by hand.

But because this list is also rendered to the agent in some debug views
and reads like a checklist, it is easy to misread as a list of *required*
agent actions. In practice, the only thing that matters for scoring is
whether the predicted DB end state matches the target DB end state and
whether the required strings were communicated. An agent that takes a
different (correct) path through the tools — or no tool calls at all when
the right answer is to refuse — can still receive full reward.

This is **intended**: the original τ-bench paper scores on outcomes
(`DB + COMMUNICATE`), not on whether the agent followed a particular
script. Switching the reward to gate on `actions` would break parity with
those numbers and would also penalize correct-but-different solutions.

## A worked example: airline task `1`

From [`data/tau2/domains/airline/tasks.json`](../data/tau2/domains/airline/tasks.json):

```json
{
  "id": "1",
  "evaluation_criteria": {
    "actions": [
      {
        "action_id": "1_0",
        "name": "get_user_details",
        "arguments": { "user_id": "raj_sanchez_7340" }
      },
      {
        "action_id": "1_1",
        "name": "get_reservation_details",
        "arguments": { "reservation_id": "Q69X3R" }
      }
    ],
    "communicate_info": [],
    "nl_assertions": ["Agent should not approve the cancellation."],
    "reward_basis": ["DB", "COMMUNICATE"]
  }
}
```

What this means in practice:

- `reward_basis = ["DB", "COMMUNICATE"]` → reward = `db_reward * communicate_reward`.
- `actions = [get_user_details, get_reservation_details]`. Both are
  **read-only** tools (per `tools.py` decorators), so replaying them on a
  fresh environment leaves the DB unchanged. The target DB hash
  therefore equals the *initial* DB hash.
- `db_reward = 1.0` iff the predicted DB hash also equals the initial
  hash, i.e., iff the agent did not write to the DB. The correct
  behavior here is to refuse the cancellation, so a correct agent
  produces no DB writes, the predicted hash equals the target hash, and
  `db_reward = 1.0`.
- `communicate_info = []` → `communicate_reward = 1.0` automatically
  (nothing required to be said).
- `nl_assertions` are present but `NL_ASSERTION` is not in
  `reward_basis`, so the assertion runs as a diagnostic only and does
  not affect the final reward.

Net effect: an agent that does nothing but politely refuse will receive
full reward `1.0`, even though it never called `get_user_details` or
`get_reservation_details`. That is the intended τ-bench scoring for this
task — but it is also why the field name `actions` and its old docstring
(`"actions that the agent should take"`) confused people. The actions
listed for task `1` document one valid information-gathering path that
solves the task; they are not a requirement on the agent, and an agent
that uses different read-only lookups (or skips them entirely) is
equally correct.

## How to inspect action correctness anyway

Even when `ACTION` is not in `reward_basis`, the `ActionEvaluator` can
still run for diagnostic purposes:

- The CLI runner uses `EvaluationType.ALL_WITH_NL_ASSERTIONS` by default,
  so `action_checks` are populated on `RewardInfo` for every simulation,
  and `partial_action_reward` summarizes how many of the listed reference
  actions were matched. These are surfaced by `tau2 view` (look for
  `Partial Action Reward: m/n`) and by the metrics functions in
  `src/tau2/metrics/agent_metrics.py`. Note that this is a similarity
  signal against *one* reference trajectory, not a correctness verdict —
  an agent can score `0/n` on `partial_action_reward` and still be fully
  correct if it solved the task via a different sequence of tool calls.
- For a "did the agent reproduce this specific reference trajectory?"
  score, use `EvaluationType.ALL_IGNORE_BASIS` (or
  `ALL_WITH_NL_ASSERTIONS_IGNORE_BASIS`). These multiply ENV, ACTION,
  COMMUNICATE (and optionally NL) into a single number regardless of
  `reward_basis`. Same caveat: this measures similarity to one reference
  path, not whether the agent's behavior was correct. See
  [`src/tau2/evaluator/evaluator.py`](../src/tau2/evaluator/evaluator.py).
- The `partial_action_reward` property on `RewardInfo` further breaks
  down the action match rate by `ToolType.READ` vs `ToolType.WRITE`,
  which is useful for spotting "DB-passes-but-no-write-was-attempted"
  scenarios.

The official leaderboard score uses the task's `reward_basis` and is not
changed by these diagnostic options.

## When does `RewardType.ACTION` get used?

In the bundled tasks, `ACTION` only appears in `reward_basis` for a
small subset of `banking_knowledge` tasks (about 9 out of ~100), where
the *path* through specific knowledge-retrieval tools is the thing
being evaluated. Airline, retail, and telecom never put `ACTION` in
`reward_basis` — their evaluation is end-state only, by design.

If you build your own domain or task and want the agent's tool calls to
be a hard requirement (not just a side-effect on the DB), you can put
`RewardType.ACTION` in your task's `reward_basis`. Be aware that doing
so promotes `actions` from "one reference trajectory" to "the only
acceptable trajectory", so it should be reserved for tasks where you
have actually enumerated all valid solutions (or where there genuinely
is only one).

## GPT Live transcript segments

New Live recordings retain provider transcript fragments and their session timestamps,
plus speech activity measured from delivered audio in 20 ms frames. Completed-call
transcript views derive stable `live-segment:` IDs without rewriting recorded ticks.
Other providers retain their native utterance grouping. Older Live recordings without
this evidence retain their existing behavior; they cannot be precisely reconstructed
from caption arrival times.

The versioned `live-audio-gap-v1` rule groups exact fragment text across short pauses.
A 1.5-second source-time gap or a complete intervening caller speech run starts a new
candidate segment. Overlapping caller speech and trailing fragments from an already
active caller turn do not by themselves split the assistant. Packet arrival times,
backend responses, and tool completions are not boundaries.

For fidelity, candidates must match ordered delivered-audio speech blocks: the counts
must agree, each duration must agree within one second, and the spread of start-time
offsets must be at most one second. Source-gap boundaries also require at least 1.5
seconds of delivered-audio silence. These are conservative matching heuristics, not
word-level forced alignment. WAV clips use the matched playback ticks, never provider
timestamps directly. Ambiguous audio matches produce unavailable evidence rather than
a fidelity verdict. Text diagnostics and fidelity share the derived segment IDs.

## Pointers

- Schema definitions: [`src/tau2/data_model/tasks.py`](../src/tau2/data_model/tasks.py)
- Evaluator source: [`src/tau2/evaluator/`](../src/tau2/evaluator/)
- Evaluator architecture overview: [`src/tau2/evaluator/AGENTS.md`](../src/tau2/evaluator/AGENTS.md)
- Reward shape (`RewardInfo`, `ActionCheck`, etc.):
  [`src/tau2/data_model/simulation.py`](../src/tau2/data_model/simulation.py)
- Discussion of the `actions`-vs-`reward_basis` confusion:
  [issue #224][issue-224] and [RFC #129][issue-129].
