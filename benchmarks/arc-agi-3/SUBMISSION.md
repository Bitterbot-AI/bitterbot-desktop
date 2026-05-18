# Submission process

ARC Prize 2026 has three submission surfaces for ARC-AGI-3. They have different rules and different prize structures. This doc covers what to do for each.

## Track summary

| Track                     | Where                                                        | Internet during eval | Compute cap        | Prize tier                                                                         |
| ------------------------- | ------------------------------------------------------------ | -------------------- | ------------------ | ---------------------------------------------------------------------------------- |
| **Verified Testing**      | https://arcprize.org/leaderboard                             | Yes, $10K retail cap | None on wall-clock | Milestone prizes ($25K / $10K / $2.5K, twice a year) gate through this leaderboard |
| **Community leaderboard** | https://github.com/arcprize/ARC-AGI-Community-Leaderboard    | n/a (self-report)    | n/a                | No prize — public credit, scorecard URL                                            |
| **Kaggle**                | https://www.kaggle.com/competitions/arc-prize-2026-arc-agi-3 | **No, offline only** | 12h on Kaggle GPU  | Milestone prizes via Kaggle submission                                             |

Per [PLAN-19](../../research/plans/PLAN-19-ARC-AGI-3-AGENT.md) the primary target is **Verified Testing** (Opus 4.7 via Claude Code SDK works, marketing story holds, eligible for milestone prizes via that track). The Kaggle track is a stretch goal that requires swapping the Anthropic-hosted Claude Code for a local model behind an OpenAI-compatible server (vLLM or Ollama running Qwen 32B or similar).

The agent itself follows the [Anthropic partner template](https://docs.arcprize.org/partner_templates/anthropic) for runtime (Claude Code SDK), file layout (action scripts in `actions/`, helpers in `helpers/`, filesystem state in `games/<id>/`), and instruction convention (`CLAUDE.md`). The Bitterbot Memory MCP server in `mcp-server/` is the differentiator on top of the template — it exposes biological-memory subsystems as MCP tools Claude Code calls natively.

## Verified Testing track

This is the main submission. Bitterbot's hosted Opus 4.7 calls work here.

### Prerequisites

1. ARC Prize account at https://arcprize.org/platform (Google or GitHub login). Generate an API key.
2. Set `ARC_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` in `.env`.
3. Confirm spend cap configuration in `benchmarks/arc-agi-3/agent.ts` (default $50/game; $4K total expected for the verified-track run).

### Run

```bash
set -a && source .env && set +a
node --import tsx benchmarks/arc-agi-3/runners/submit-verified.ts \
  --tags "bitterbot-v1,biological-memory" \
  --games verified-track \
  --output benchmarks/arc-agi-3/results/verified-submission.jsonl
```

What this does:

1. Opens one scorecard via `POST /api/scorecard/open` with the supplied tags.
2. Runs `agent.playGame` across the verified-track game list (25 public + 55 semi-private = 80 games).
3. Closes the scorecard via `POST /api/scorecard/close`.
4. Captures the returned `scorecard_url`.

Estimated wall-clock: **24–48 hours**.
Estimated cost: **$1.5K–$3K** at Opus 4.7 pricing.

### Get on the leaderboard

The `scorecard_url` is the proof-of-run. Submit it via PR to the [Community Leaderboard repo](https://github.com/arcprize/ARC-AGI-Community-Leaderboard):

```bash
git clone https://github.com/arcprize/ARC-AGI-Community-Leaderboard
cd ARC-AGI-Community-Leaderboard
# Add Bitterbot entry to the JSON registry per repo CONTRIBUTING
# Include: agent name, scorecard_url, public code repo URL, contact
gh pr create --title "Add Bitterbot v1 (biological memory + SAGE)"
```

There is **no minimum-score threshold** for community-leaderboard listing. A 0.5% score with a valid scorecard URL gets listed.

### Milestone #1 (June 30, 2026) submission

For the milestone prize ($25K / $10K / $2.5K to top-3 by RHAE):

1. Complete the verified-track run before June 28 (4-day safety margin).
2. Email the `scorecard_url` to team@arcprize.org per their submission protocol (see the [official ARC Prize policy](https://arcprize.org/policy)).
3. Open-source mandate: ensure `benchmarks/arc-agi-3/` is dual-licensed under MIT-0 in `LICENSE-MIT0` at the time of submission. Bitterbot's other code is already MIT.
4. Attach a writeup (typically 2-3 page PDF or blog post) covering architecture + ablation results within 7 days of submission.

## Kaggle track (stretch, Phase 6c)

Kaggle eval is sandboxed offline. No internet, no external LLM API calls. To submit here:

1. **Replace Claude Code's Anthropic backend** with a local-model OpenAI-compatible server (vLLM or Ollama running Qwen 32B / Phi-3-medium / similar). The MCP server, action scripts, helpers, and `CLAUDE.md` are all unchanged on this path.
2. Package the model weights inside the Kaggle notebook's `/kaggle/input/` mount (within Kaggle's GPU-image size limits, typically ~20-30 GB).
3. Either run Claude Code in "alternative-endpoint" mode pointing at the local server, or rewrite the agent loop as a pure-Python alternative driving the same MCP server.
4. Submit via the Kaggle UI per the competition's submission tab.

This track is **optional** for PLAN-19. Pursue it only if (a) time permits after the Verified Testing submission lands, and (b) the verified-track run shows enough signal to justify the local-model port effort. The MCP server's reusability across hosted vs local LLMs is exactly what makes this stretch goal tractable — only the runtime swaps, not the memory tools.

## Community leaderboard (no prize, fast credit)

If you just want a public score listed without the verified-track cost or compute, run against only the 25 public games:

```bash
node --import tsx benchmarks/arc-agi-3/runners/submit-verified.ts \
  --tags "bitterbot-v1,public-only" \
  --games public-25 \
  --output benchmarks/arc-agi-3/results/community-submission.jsonl
```

Cost: ~$500. Wall-clock: ~8 hours.

Submit the resulting `scorecard_url` via PR to the community leaderboard repo as above.

## Eligibility checklist (Verified Testing + Kaggle prizes)

- [ ] `benchmarks/arc-agi-3/` dual-licensed under MIT-0 at submission time.
- [ ] Third-party deps in `package.json` are Apache-2.0 / MIT / GPL-3.0+ (Bitterbot's defaults satisfy this — re-verify with `pnpm licenses list`).
- [ ] Public code repo URL provided in submission.
- [ ] Writeup attached within 7 days of the deadline.
- [ ] One-click reproducibility on the submitter's infrastructure (the `submit-verified.ts` script is the one-click).

## What "extraordinary submissions" verification means

Per the [Verified Testing Policy](https://arcprize.org/policy), ARC Prize may selectively verify a small number of submissions by re-running them. Requirements for verification:

- One-click runnable on Kaggle (Kaggle track) or the submitter's documented infrastructure (Verified Testing).
- APIs used must be publicly/commercially available from providers with >$10M MRR.
- Retail-cost cap of $10K per evaluation run.
- Wall-clock cap of 12 hours on Kaggle hardware.
- ARC Prize maintains a Verification Fund reimbursing up to $2,500 per reproduction.

For Bitterbot's Verified Testing submission, all of these are satisfied by default: Anthropic + OpenAI exceed $10M MRR; our spend cap is $50/game = $4K total; wall-clock is on our own infrastructure (no Kaggle cap applies); the `submit-verified.ts` script is the one-click trigger.
