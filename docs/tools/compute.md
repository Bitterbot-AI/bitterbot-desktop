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
first piece of PLAN-57 (compute awareness). This release ships the
read-only half: the agent can look, estimate and report. Submitting work
from the agent and the live state block in the prompt tail follow in later
releases.

## When the tool exists

Two conditions, both required:

- `compute.enabled` is not `false` (default: on).
- A compute backend is loaded. The Soapbox compute plugin registers one when
  it starts. Without a backend there is no tool and no prompt section, so a
  node with no pool spends no tokens on compute awareness.

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
   at `awaiting_payment` until the owner approves it in the Compute tab or
   on the command line.

The section carries no numbers, so it sits in the cached part of the prompt
and costs nothing after the first turn. Numbers come from the tool.

## What the agent can never do

There is no action that funds, approves or signs anything. Funding a paid
job goes through the owner's review rail, bound to an authenticated owner
session; nothing the agent can call produces a funding transaction. This is
a structural property of the tool surface, not a prompt instruction.

## For plugin authors

A backend is any object with `snapshot()`, `jobs()`, `job(id)` and
`result(id)`; register it with `registerComputeBackend` from
`src/compute/awareness`. `snapshotFromSoapboxStatus` turns a Soapbox
`status` payload into the secret-free snapshot the tool renders: it copies
named fields only, so bearer tokens, RPC URLs, escrow addresses and wallet
secrets never reach the agent.
