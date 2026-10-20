---
summary: "CLI reference for `bitterbot compute` (quote and approve paid compute jobs)"
read_when:
  - A paid compute job is waiting for payment and you want to fund it from the terminal
  - You want to see what a paid job would cost before approving it
title: "compute"
---

# `bitterbot compute`

The owner's terminal surface for compute pools (PLAN-57). `status` and
`jobs` show what the agent sees. `quote` and `approve` handle a paid job:
the agent can quote and, where paid compute is enabled, submit one; only
you can fund it, and the funding is bound to the admin connection these
commands hold. `pause` rests one of this node's workers; `trust` decides
what memory may reach a pool.

Related:

- The agent's tool and the paid path: [compute](/tools/compute)
- The network view, trust model and every setting: [Compute pools](/network/compute)
- Holds in the review queue: [Action review](/tools/action-review)

## Commands

```bash
bitterbot compute status                   # pools, workers, credits, jobs in flight
bitterbot compute jobs [--limit 20] [--status running]
bitterbot compute quote <jobId>            # what the job is waiting for
bitterbot compute approve <jobId>          # show the quote; nothing funded
bitterbot compute approve <jobId> --yes    # fund it at the quoted amount
bitterbot compute pause <workerId>         # pause one of this node's workers
bitterbot compute pause <workerId> --resume
bitterbot compute trust <poolId> trusted   # or untrusted
```

`status` prints the coordinator's reachability, credits, each pool with its
trust (and your configured trust when it differs from what the coordinator
reports), each worker's state and pinned model, the jobs in flight, and
whether paid jobs are enabled and offered. `jobs` lists recent jobs with
their outcome and verification level.

`pause` and `trust` need `operator.admin`. `trust` writes
`compute.pools.<poolId>.trust`; the egress policy reads it when the memory
system starts, so it applies after the next gateway restart.

`quote` prints the amount, the payee, how long the quote is valid, whether
the agent's hold for this job is pending in the review queue, and whether
the paid path or the per-job cap would refuse it.

`approve` without `--yes` prints the same and stops with "Nothing funded".
With `--yes` it calls `compute.approve`, which mints the approval token for
this job and exact quote, funds the job through the spend gate and settles
the pending hold, if any. The transaction hash is printed.

Every command takes `--url`, `--token`, `--password`, `--timeout <ms>` and
`--json`.

## What can refuse

The signer, not the CLI, decides. It refuses when paid compute is off
(`compute.paid.enabled`), when the quote is above
`compute.paid.maxUsdcPerJob` or would exceed `compute.paid.maxUsdcPerDay`,
when the coordinator now quotes something other than what you looked at,
when the job was already funded or another approval is funding it, when the
compute runtime (and so the payment ledger) is not registered, and when the
connection lacks
`operator.admin`. Each refusal is a ledger row that `bitterbot doctor`
reports under "Compute payments".
