---
summary: "The `compute` tool: what the agent knows about compute pools, what it can ask, and what it can never do (fund a paid job)"
read_when:
  - You want to know what the agent sees about Soapbox compute pools
  - You are deciding whether to turn the compute surface off
  - You are writing a plugin that provides compute to the agent
title: "compute"
---

# compute

The `compute` tool is how the agent knows that this node can run batches of
work on compute pools, and what those pools are doing right now. It is the
agent-facing half of PLAN-57 (compute awareness): the agent can look,
estimate, report, start work and be told when it finishes. The node-facing
half, memory embeddings routed to a pool under an egress policy, is described
at the end of this page.

## When the tool exists

Two conditions, both required:

- `compute.enabled` is not `false` (default: on).
- A compute backend is loaded. The Soapbox compute plugin registers one when
  it starts in pilot, participant or local-operator mode (anything with a
  coordinator client). Setup-only mode, the default on a fresh install before
  a role is chosen, registers nothing. Without a backend there is no tool and
  no prompt section, so a node with no pool spends no tokens on compute
  awareness. Operator-role nodes get a read-only backend: the agent can see
  jobs and workers but never submits paid work or funds a job from them.

Turn the whole surface off with:

```json5
{ compute: { enabled: false } }
```

## Actions

| action     | what it returns                                                                                                                                                                                                                                                                                                                   |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `status`   | pools this node belongs to (kind, trust level, workers online), workers (online, paused, GPU, pinned model, isolation as reported), credits, jobs in flight, jobs waiting on the owner                                                                                                                                            |
| `jobs`     | recent jobs; `limit` (default 10, max 50) and `status_filter`                                                                                                                                                                                                                                                                     |
| `job`      | one job: status, mode, scope, workload, items, attempts, worker, verification level, error                                                                                                                                                                                                                                        |
| `result`   | a finished job's result and receipt; results over 20,000 characters are summarised instead of inlined                                                                                                                                                                                                                             |
| `estimate` | for a `workload` (`sha256` or `embeddings`) and `items`: every known worker with an estimated duration, a cost, and why it is or is not eligible, plus the option a deterministic rule would pick and the local alternative; `scope` restricts to one pool or project, `model_digest` excludes workers on another embedding model |

Estimates learn from completed jobs (median duration per worker and
workload over the last 16) and say `basis: "prior"` until they have history.
No model call is involved in an estimate.

## What the agent is told

The system prompt gains a short static "Compute Pools" section whenever the
tool exists. It explains the three pool kinds (the node's own machine,
private pools of trusted machines, collective pools shared with a group),
names the actions, and sets four rules:

1. Call `status` or `estimate` before saying what compute is available;
   never guess counts.
2. State each result's verification level. `recomputed` means the
   coordinator re-ran the work and compared; `shape_only_trusted_worker`
   means the output was checked for shape and the worker is trusted, which
   is not a proof; `redundant` means a second worker agreed.
3. Personal and confidential memory never leaves this machine.
4. The agent may quote a paid job; only the owner funds it. A paid job waits
   at `awaiting_payment` until the owner approves it in the Control UI or
   on the command line.

The section carries no numbers, so it sits in the cached part of the prompt
and costs nothing after the first turn. Numbers come from the tool.

## The live state block

When something is actionable, the end of the system prompt (after the cache
boundary, so it never disturbs the cached prefix) carries a short block:

```text
<compute-state v=418 as_of=12s_ago>
pools: private(1/1 online, 1 gpu), lab(2/3 online, 1 gpu, trusted)
credits: 140 TEST_CREDIT
jobs: 2 running (embeddings x96 on gpu-2, sha256 x12 on w1)
needs owner: pay1 awaiting_payment 0.4 USDC
last: a81c succeeded 3m_ago (embeddings x96 on gpu-2, recomputed)
</compute-state>
```

Lines appear in that fixed order and only when they have something to say:

- a job in flight that the agent or the owner started
- a job waiting on the owner (`awaiting_payment`, `payment_review`)
- a completion the agent has not been shown yet (shown once, then dropped)
- a pool other than the local one joined or changed its worker count (once)
- credits below `compute.awareness.creditFloor`
- completions held because the wake budget is spent
- the coordinator is unreachable

At steady state (only the local worker, nothing running, nothing new) the
block is omitted entirely. It is capped at `compute.awareness.maxTokens`
(default 120), carries a monotonic version `v` and an age `as_of`, excludes
jobs the memory system starts for itself, and never appears for subagents.
Coordinator strings are escaped: no angle brackets, no newlines. It is not
part of the heartbeat's hashed inputs, so a running job never re-arms an
interval tick. Turn it off with `compute.awareness.stateBlock: false`; the
tool keeps working.

## How a finished job reaches the agent

A gateway-side watcher polls the coordinator with backoff (2 s while a job is
running, growing to 30 s) and stops when nothing is in flight; an idle node
has zero ticks. When a job the agent or the owner started reaches
`succeeded`, `failed`, `expired`, `cancelled`, `refunded`,
`awaiting_payment` or `payment_review`:

1. A row is written to `compute_deliveries` (SQLite,
   `~/.bitterbot/compute/deliveries.sqlite`), one per job and transition,
   before anything else happens.
2. A system event is queued in the session that started the job (the task's
   session for agent-started jobs, the owner's main session otherwise).
3. The heartbeat is woken with reason `compute-event`, which bypasses the
   empty-`HEARTBEAT.md` skip and is not hash-gated, at most
   `compute.awareness.wakeBudgetPerHour` times per hour (default 20). Over
   the budget, the event is still queued, the row is marked deferred, the
   state block shows it as waiting, and it is delivered on the next heartbeat
   or user turn, or when the budget resets. Nothing is dropped.
4. The row is marked delivered when a heartbeat turn completes for that
   session. On gateway start the watcher reconciles rows against the
   coordinator, so a job that finished while the gateway was down is still
   reported, once. The local operator's coordinator starts alongside the
   gateway, so that first reconcile retries with backoff for about a minute
   before an unreachable coordinator is logged as a warning.

What never wakes the agent: worker or GPU count changes, credit changes,
progress, queue depth, and anything started by the memory system for its own
use (those jobs are recorded with origin `internal`).

## Starting work from the agent

On an owner turn, and only when the node's backend supports it, the tool
also offers:

| action   | what it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `submit` | run a batch on a `private` pool or a `collective` project: `mode`, `scope` (pool or project id), `workload`, `inputs` (1 to 128 strings, 256 KiB total), and for embeddings `model` and `model_digest`. Optional `task_id` links the job to a long-horizon task; optional `reason` is recorded on it. Returns the job id. Where paid compute is enabled, `mode: paid_usdc` with `max_cost_usdc` and no `scope` submits a paid job that waits for the owner (see [Paid jobs](#paid-jobs-and-who-pays)). |
| `cancel` | cancel a job this agent started. `job_id`. Jobs started by the owner or by the memory system cannot be cancelled from here.                                                                                                                                                                                                                                                                                                                                                                            |

Rules the code enforces, not the prompt:

- Non-owner turns get a refusal before anything reaches the coordinator.
- `paid` (credits) is rejected. `paid_usdc` is accepted only when
  `compute.paid.enabled` is on and the coordinator offers paid work to this
  node; the job then stops at `awaiting_payment` and the owner decides (see
  [Paid jobs](#paid-jobs-and-who-pays)). Otherwise the agent can quote a
  paid job with `estimate` and nothing more.
- Inputs are validated gateway-side (count, size, embedding model present)
  before the coordinator sees them; the coordinator's limits are the second
  line.
- Every agent-started job is recorded with origin `agent` and the session it
  came from, so its completion is delivered back to that session.
- A retried tool call cannot submit twice: the idempotency key is derived
  from the tool call id.

When `task_id` is given, the task moves to `waiting_external`, the job is
recorded under `metadata.computeJobs`, and a fallback cron wakeup is
scheduled twelve minutes out (jobs expire after ten) with the same payload
`task_schedule_wakeup` uses. When the job finishes, the watcher records the
outcome on the task and pulls that wakeup forward to now, so the task resumes
through the normal PLAN-16 path (isolated session, latest handoff) as soon
as the completion lands. If the task store is not active, `submit` still
succeeds and says the link failed rather than pretending.

Oversized results (`result` above 20,000 characters) are written to
`<workspace>/compute/<job id>.json` (mode 0600) and the path is returned.

## Embeddings on the pool

The node's own memory system is the daily consumer of compute: every chunk it
indexes is embedded. With `compute.embeddings.provider: pool` (the default)
an embedding batch may run on a pool worker instead of this machine, under
three rules the code enforces. None of them is a prompt instruction, and the
agent cannot change any of them.

**Same computation, or nothing.** Every memory index is written under an
embedding profile: provider, model, the model's content digest, dimensions,
normalisation, truncation and chunking rules. The profile is stored on the
index and compared on every sync. A pool worker is eligible only when its
pinned model digest equals the local one, and the result it returns is
checked again on receipt: vector count, digest, dimensions and the worker's
reported processing rules. Any mismatch puts that worker in cooldown
(`compute.embeddings.cooldownMs`, default five minutes), runs the batch
locally, and writes a ledger row saying why. There is never a per-batch mix.

In practice this means pool embeddings work when the node embeds through a
local Ollama (an OpenAI-compatible `remote.baseUrl` on localhost) and the pool
workers pin the same Ollama model; the digest is read from Ollama's manifest.
A node on the bundled GGUF model hashes that file as its digest, which no
Ollama worker matches, so its batches stay local by construction. Remote APIs
report no digest and never route.

**Egress by governance class.** Each pool carries the owner's trust level:
`local` (a pool served only by workers this machine runs itself, such as the
local GPU operator's `private` pool; the moment a peer you granted access
joins it, the pool drops to its configured trust), `trusted` (set with
`compute.pools.<id>.trust: trusted`), or `untrusted` (the default for every
other pool, including collectives). No pool is local because of its name, and
`local` cannot be set in config: it is a fact the snapshot establishes from
who serves the pool. Each input carries the same governance class the memory
row gets, raised by what the text says:

| class          | may run on                    |
| -------------- | ----------------------------- |
| `confidential` | this machine only             |
| `personal`     | this machine or trusted pools |
| `normal`       | any pool                      |

Session transcripts are `personal` unless `compute.egress.transcriptsDefaultClass`
says otherwise, so they stay on this machine or on machines you trust. A batch
is split by class and each part is routed under its own ceiling. Inputs with
no known class count as `personal`. Queries always run locally.

**Nothing waits on the pool.** Routing is deterministic: among eligible,
permitted workers not in cooldown, the pool is chosen when a GPU worker's
measured estimate beats the local estimate by `compute.embeddings.marginMs`
(default 500). Until local has one measured batch, nothing routes. A pool
batch that exceeds `compute.embeddings.timeoutMs` (default 60 s) is cancelled
and run locally. Pool jobs are recorded with origin `internal`: they never
appear in the state block and never wake the agent, except once after ten
consecutive fallbacks, when the block says local embedding is in effect.

Every routed sub-batch lands in the compute ledger
(`~/.bitterbot/compute/deliveries.sqlite`, table `compute_embedding_batches`):
route, pool, worker, trust, class, items, profile, job id, duration, and the
fallback reason. `bitterbot doctor` summarises the last week under "Compute
embeddings": a policy violation row is an error (the guard ran the batch
locally, but the router disagreed with the policy); mismatch cooldowns and a
high fallback share are warnings.

### When the model changes

A provider or model change is handled as before: the index is rebuilt
automatically under the new model. A change under the same model name (an
Ollama tag pulled again with new weights, a GGUF replaced in place, a chunker
change) is different: the index goes on hold. No new vector is written,
vector search is paused (keyword search keeps working), `bitterbot memory
status` shows the conflict, and the log says so once. Rebuild with:

```bash
bitterbot memory migrate-embeddings          # shows what changed, changes nothing
bitterbot memory migrate-embeddings --yes    # rebuilds under the new profile
```

`bitterbot memory index --force` does the same rebuild. Both re-embed every
chunk, so on a large index expect the same time a first index took.

## Paid jobs and who pays

Paid compute is off by default (`compute.paid.enabled: false`). When the
owner turns it on, and the coordinator reports paid work as available to
this node (the invite flag), an owner turn may submit `mode: paid_usdc` with
`max_cost_usdc`. The Soapbox backend addresses the job to the online,
unpaused operator with the lowest id that advertises `paid_usdc`, and refuses
when there is none; the owner sees that operator as the payee on the quote
before anything is funded. The coordinator accepts the job and parks it at
`awaiting_payment` with a quote: an exact amount, a payee and a hash over
both. The tool then does two things and stops:

- it puts a hold in the review queue ("Fund compute job j-42: 0.42 USDC to
  0xabc...") in the session that asked, and
- it tells the agent the cost and that the job is waiting for the owner.

Nothing is funded yet. The owner approves in one of two places, and both
run the same code:

- the review queue (Control UI, Activity), which resolves the hold through
  `review.resolve`, or
- `bitterbot compute approve <job>`, which calls the admin-only
  `compute.approve` gateway method with the quote hash it displayed and
  settles the hold if there is one. A Control UI client can call the same
  method; a chat reply or the node's internal connection cannot use it.

Approving mints an **approval token** that carries the job id, the exact
quote hash, the scopes of the gateway connection that decided, the surface
that decided and a five-minute expiry, signed with a per-process secret. The
gateway checks it without consuming it; the backend's signer (which runs in
the gateway process as part of the plugin) verifies it again before building
a transaction, and that verification consumes it, so a token is good for one
transaction. A signer in another process cannot verify a token at all:
funding authority never leaves the gateway process. The funding call runs
inside the spend gate as an `rpc` spend, so it lands in the payment record
next to every other outbound payment, and one job is funded by one caller at
a time (a second approval while one is in flight is refused as
`in_progress`).

The signer refuses, logs, writes a ledger row and counts:

| refusal               | when                                                                                                          |
| --------------------- | ------------------------------------------------------------------------------------------------------------- |
| `agent_origin`        | the request carries origin `agent` (a tool call, whatever it claims); refused before the quote is read        |
| `chat_decision`       | the approval was labelled as a chat reply (`/approve`)                                                        |
| `internal_connection` | the deciding gateway connection is the node's own internal (`backend` mode) client, whatever its scopes       |
| `missing_scope`       | the deciding connection lacks `operator.admin` and `operator.approvals`                                       |
| `paid_disabled`       | `compute.paid.enabled` is off                                                                                 |
| `ledger_unavailable`  | the compute runtime is not registered, so there is no ledger to enforce the caps and the already-funded guard |
| `over_cap`            | the quote is above `compute.paid.maxUsdcPerJob` (default 5 USDC)                                              |
| `over_daily_cap`      | funding in the last 24 hours plus this quote exceeds `maxUsdcPerDay` (default 20)                             |
| `quote_changed`       | the coordinator now quotes something other than what was approved                                             |
| `already_funded`      | the ledger has a funded row for the job                                                                       |
| `in_progress`         | another approval is funding the job, or a funding started less than ten minutes ago and never settled         |
| `bad_token:*`         | missing, malformed, tampered, expired, mismatched or reused token                                             |

The chat `/approve` command is also turned away one step earlier: the
`review.resolve` handler refuses to approve a compute hold from a chat reply
or an internal connection and leaves the hold pending, so the owner can
still approve it from the Control UI or the CLI. Denying from chat works.

`bitterbot doctor` reports the week's funding and refusals under "Compute
payments". An `agent_origin` refusal is an error there: nothing moved, but
something tried.

## What memory keeps

Every finished job the agent or the owner started becomes an `episode`
chunk in memory ("Compute job j-42 (sha256 x200, private in lab on worker
w1) succeeded, recorded 2026-10-18 14:02 UTC; started by the agent."),
written when the watcher delivers the completion (after a gateway outage,
when it reconciles), so later questions about what the pool ran are
answered from memory rather than from the coordinator. The node's own
embedding batches are never episodes, and only the first clause of a
coordinator error is kept. Episodes go to the default agent's memory. The dream cycle's
working-memory rewrite also receives a compute block built from the ledger
(pools and trust, jobs consumed and their outcomes, embedding batches by
route and class, paid jobs funded), which The Niche section reflects; a
node with no compute activity gets no block. See
[Compute pools](/network/compute).

## Hormones

Compute leaves a small mark on the agent's mood, nothing more. A job you
can see succeed on the pool, one the watcher saw running, gives a dopamine
lift the size of a recalled happy memory (0.05); a worker still listed but
offline since the previous poll, the coordinator going unreachable, or
memory embeddings falling back to local for a sustained run gives a
cortisol rise of the same size. The node's own batches never lift; their
one setback is that sustained-fallback event. Jobs first seen already
finished (after an outage) never nudge, and a poll after an idle stretch
starts a fresh baseline instead of blaming the gap on a worker.

The bounds are the point: one nudge per kind every thirty minutes and four
per hour, and at that size and spacing two nudges of one kind cannot add up
to the dream engine's hormonal rise trigger (0.15), so compute colours the
mood and never starts a dream or an automatic scratch note.
`compute.awareness.nudges: false` registers no sink at all, and every nudge
is then a no-op whatever the plugin passes.

## What the agent can never do

There is no action that funds, approves or signs anything. The paid path
above starts from an authenticated owner connection and ends at a signer that
verifies the owner's token. An agent-origin or internal-origin request is
refused by the signer before a quote is even read; a chat reply and the
node's internal connection are refused at the review handler and again at
the signer. A test builds every registered tool as an owner turn with paid
compute on, throws funding-shaped calls at each of them and asserts that the
backend's `fund()` never runs and no token is minted; a second test pins
`compute.approve` to `operator.admin`. The GENOME axiom ("never fund,
approve or sign a payment on your own authority") and the considerations log
remain, as the belt to the signer's suspenders.

## For plugin authors

A backend is any object with `snapshot()`, `jobs()`, `job(id)` and
`result(id)`; register it with `registerComputeBackend` from
`src/compute/awareness`. `snapshotFromSoapboxStatus` turns a Soapbox
`status` payload into the secret-free snapshot the tool renders: it copies
named fields only, so bearer tokens, RPC URLs, escrow addresses and wallet
secrets never reach the agent.

To get the state block and completion delivery, also:

- open the delivery store (`ComputeDeliveryStore.open()`) and start the
  watcher (`startComputeWatcher({ backend, store, ownerSessionKey, wakeBudgetPerHour, nudges })`,
  passing `compute.awareness.wakeBudgetPerHour` and `compute.awareness.nudges`
  from the config; report an unreachable coordinator as `reachable: false`
  in the snapshot rather than throwing, so the state block and the setback
  nudge can see it);
- record an origin for every job you submit, before or right after the
  coordinator accepts it: `store.recordOrigin(jobId, "owner", null)` for the
  Compute tab and CLI, `"agent"` with the task's session key for
  agent-started jobs, `"internal"` for anything the node does for itself.
  Jobs with no recorded origin are shown in `status` but never delivered,
  because the watcher cannot tell whose they are;
- call `watcher.kick()` after a submit so polling resumes at once;
- to let the agent submit and cancel, implement `submit(req)` and
  `cancel(id)` on the backend and call `registerComputeRuntime({ store, watcher })`.
  Without both, the tool stays read-only. `submit` receives
  `{ kind: "paid_usdc", maxCostUsdc }` only when the owner enabled paid
  compute and the snapshot's `paid.available` is true; set that flag from
  the coordinator's invite state;
- for paid jobs, implement `quote(id)` (the `awaiting_payment` amount, payee
  and `computeQuoteHash(...)` of them; null when the job is not waiting) and
  `fund(req)`. `fund` is called only by `approveComputeFunding` in
  `src/compute/awareness/payment.ts`, inside the spend gate, with a verified
  `approvalToken`. Your signer (`fundSoapbox`) must still call
  `verifyComputeApprovalToken(req.approvalToken, { jobId, quoteHash })`
  before building a transaction and refuse on any failure; use
  `req.idempotencyKey` so a retried approval never funds twice. The payment
  ledger (funded rows, the daily cap, the already-funded guard) lives in the
  delivery store, so `registerComputeRuntime` must have run before paid
  jobs are offered;
- for pool embeddings, `result(id)` of an embeddings job must return the
  Soapbox shape unchanged: `{ embeddings: number[][], execution: { model,
  model_digest, dimensions, ... } }`. The memory system verifies the digest
  and dimensions from `execution` before writing anything; a worker that
  also reports `truncate` and `normalize` is checked on those too. Report
  pool trust through `snapshotFromSoapboxStatus(status, { poolTrust })` with
  `resolvePoolTrust(config, poolId)` so the tool and the router agree.
