---
summary: "Compute pools from the network's point of view: what connects where, what may leave the machine, the settings, and what the owner can do"
read_when:
  - You are deciding whether to join or trust a compute pool
  - You want the full list of compute.* settings and their defaults
  - You are auditing what memory content can reach another machine
title: "Compute pools"
---

# Compute pools

A compute pool is a set of machines that run batches of work for each
other: SHA-256 batches and text embeddings on a pinned model today. This
node can run its own work locally, send it to a private pool of machines
you trust, to a collective pool shared with a group, or (when paid compute
is on) to a paid job the owner funds. The agent knows which pools exist,
what they cost and when its work finishes ([the compute tool](/tools/compute)).
This page is the owner's view: the network, the trust model, the settings
and the controls.

## What connects where

The coordinator and workers are run by the Soapbox plugin, which registers
the compute backend with the gateway. Nothing here dials out until that
plugin is configured with a coordinator; a node without one spends no
tokens and opens no connections for compute. The coordinator URL and every
pool endpoint are listed in [What this node connects to](/network/egress).

- The gateway polls the coordinator for job status only while a job it
  started is in flight, with backoff, and stops when idle.
- Results come back through the coordinator; the agent reads them with the
  `compute` tool. Results over 20,000 characters are written to
  `<workspace>/compute/<job id>.json`.
- Nothing secret reaches the agent: tokens, RPC URLs, escrow addresses and
  wallet details are stripped from the snapshot it sees.

## Trust and what may leave the machine

Memory governance tags every chunk `normal`, `personal` or `confidential`.
The egress policy decides which pool trust each class may reach:

| content class  | may run on                                  |
| -------------- | ------------------------------------------- |
| `confidential` | this machine only                           |
| `personal`     | this machine and pools you marked `trusted` |
| `normal`       | any pool, including `untrusted` ones        |

Every pool you join is `untrusted` until you say otherwise. Session
transcripts default to `personal` (`compute.egress.transcriptsDefaultClass`).
The policy is enforced in the embedding provider itself and again in the
pool routing; a batch that would cross a line runs locally and is recorded
as a policy violation for `bitterbot doctor`.

To raise or lower a pool's trust:

```bash
bitterbot compute trust <pool-id> trusted
bitterbot compute trust <pool-id> untrusted
```

This writes `compute.pools.<pool-id>.trust` and applies to new embedding
batches after the next gateway restart.

## The owner's controls

```bash
bitterbot compute status                 # pools, workers, credits, jobs in flight
bitterbot compute jobs [--limit 20] [--status running]
bitterbot compute quote <job>            # what a paid job is waiting for
bitterbot compute approve <job> --yes    # fund it (owner only)
bitterbot compute pause <worker>         # rest one of this node's workers
bitterbot compute pause <worker> --resume
bitterbot compute trust <pool> trusted|untrusted
```

Reading methods (`compute.status`, `compute.jobs`, `compute.quote`) need
`operator.read`; `compute.approve`, `compute.pause` and `compute.trust`
need `operator.admin`. See [bitterbot compute](/cli/compute).

## Money

Paid jobs are off by default. When `compute.paid.enabled` is on and the
coordinator offers paid work to this node, the agent may submit a paid job;
it waits at `awaiting_payment` until you approve it in the review queue or
with `bitterbot compute approve`. The signer refuses anything that is not an
authenticated owner decision for an exact quote inside the caps. The full
rules and refusal reasons are in
[Paid jobs and who pays](/tools/compute#paid-jobs-and-who-pays).

## What memory keeps

- Every finished job the agent or you started becomes an `episode` chunk
  ("Compute job j-42 (sha256 x200, private in lab on worker w1) succeeded, recorded ... UTC; started by the agent"),
  so "what did the pool run for me last week" is answerable from memory.
  The node's own embedding batches are not episodes.
- Every dream cycle's working-memory rewrite receives a compute block over
  the last 7 days (pools and their trust, jobs consumed and how they went,
  embedding batches routed and where, paid jobs funded) as soon as there is
  any compute activity, and The Niche section reflects it. A node with no
  pools and no routed batches gets no block and pays no tokens for it. The
  success rate counts succeeded against succeeded, failed and expired jobs.
- Episodes are written to the default agent's memory; on a node with several
  agents, a job another agent started still lands there (the episode carries
  the session it reported to).
- `bitterbot doctor` has two sections, "Compute embeddings" and "Compute
  payments", read from the same local ledger.

## Upgrading

Compute awareness is on by default, on new installs and on upgrades alike:
a config without a `compute` key behaves as `compute.enabled: true`. On a
node without the Soapbox plugin loaded that means nothing at all. The
`compute` tool and its prompt section exist only when a backend (the
plugin with a coordinator) is loaded, the state block renders only when
something is actionable, the compute block in working memory appears only
once there is activity, and no connection is opened. An idle upgraded node
spends no extra tokens and dials nothing new. The Settings form does gain a
Compute group with every key below on every node, so the switches are
visible before they matter.

What does change once the plugin is loaded and a pool exists: memory
embedding batches may route to eligible pool workers under the egress
policy (`compute.embeddings.provider: pool` is the default; set `local` to
keep them home), finished jobs become episodes, and compute colours the
agent's mood a little. Paid jobs stay off until you turn
`compute.paid.enabled` on. `compute.enabled: false` turns everything off at
once.

## Settings

All keys live under `compute` in `~/.bitterbot/bitterbot.json` and in the
Settings form.

| key                                      | default     | what it does                                                                                   |
| ---------------------------------------- | ----------- | ---------------------------------------------------------------------------------------------- |
| `compute.enabled`                        | `true`      | The one kill switch: tool, prompt section, state block, pool embeddings, paid path.            |
| `compute.awareness.stateBlock`           | `true`      | Render the `<compute-state>` block in the prompt's volatile tail when something is actionable. |
| `compute.awareness.maxTokens`            | `120`       | Token budget for that block.                                                                   |
| `compute.awareness.creditFloor`          | `10`        | Below this many credits the block says so.                                                     |
| `compute.awareness.wakeBudgetPerHour`    | `20`        | Most agent wakes per hour from compute completions; the rest are deferred, never dropped.      |
| `compute.awareness.nudges`               | `true`      | Small hormonal nudges on owner-visible successes and setbacks; rate-limited.                   |
| `compute.pools.<id>.trust`               | `untrusted` | Which memory classes may reach the pool (see above).                                           |
| `compute.embeddings.provider`            | `pool`      | Route memory embedding batches to eligible pool workers; `local` turns routing off.            |
| `compute.embeddings.marginMs`            | `500`       | A worker must beat the local estimate by this much to be chosen.                               |
| `compute.embeddings.cooldownMs`          | `300000`    | How long a worker is skipped after a timeout, mismatch or policy violation.                    |
| `compute.embeddings.timeoutMs`           | `60000`     | How long one pool batch may take before it falls back to local.                                |
| `compute.embeddings.modelDigest`         | unset       | Override the local model digest for parity checks (remote embedding APIs only).                |
| `compute.egress.transcriptsDefaultClass` | `personal`  | Governance class for transcript chunks with no higher tag.                                     |
| `compute.paid.enabled`                   | `false`     | Let the agent submit paid jobs; funding is always the owner's act.                             |
| `compute.paid.maxUsdcPerJob`             | `5`         | Most USDC one job may be funded for.                                                           |
| `compute.paid.maxUsdcPerDay`             | `20`        | Most USDC compute funding may total in a rolling 24 hours.                                     |
