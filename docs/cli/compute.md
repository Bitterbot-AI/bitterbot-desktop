---
summary: "CLI reference for `bitterbot compute` (quote and approve paid compute jobs)"
read_when:
  - A paid compute job is waiting for payment and you want to fund it from the terminal
  - You want to see what a paid job would cost before approving it
title: "compute"
---

# `bitterbot compute`

The owner's terminal surface for paid compute (PLAN-57). The agent can
quote and, where paid compute is enabled, submit a paid job; only you can
fund one. These commands hold an admin connection to the gateway, and the
funding is bound to that connection.

Related:

- The agent's tool and the paid path: [compute](/tools/compute)
- Holds in the review queue: [Action review](/tools/action-review)

## Commands

```bash
bitterbot compute quote <jobId>            # what the job is waiting for
bitterbot compute approve <jobId>          # show the quote; nothing funded
bitterbot compute approve <jobId> --yes    # fund it at the quoted amount
```

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
