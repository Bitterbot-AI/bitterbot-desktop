---
summary: "Bitterbot agent built for ARC-AGI-3: Claude Code SDK + Anthropic partner template + Bitterbot Memory MCP server exposing biological-memory subsystems"
read_when:
  - Running or submitting to ARC Prize 2026 / ARC-AGI-3
  - Wanting to see how Bitterbot's memory subsystems compose into a non-conversational agent
  - Wanting to call Bitterbot's biological memory from any Claude Code session (the MCP server is reusable)
title: "ARC-AGI-3 agent"
---

# ARC-AGI-3 agent

A Claude Code SDK-driven agent for the [ARC-AGI-3](https://arcprize.org/arc-agi/3) interactive benchmark, following the [Anthropic partner template](https://docs.arcprize.org/partner_templates/anthropic) for runtime and file layout, plus a **Bitterbot Memory MCP server** that exposes the knowledge graph, SAGE retrieval, curiosity engine, epistemic-directive engine, and hormonal state manager as typed MCP tools Claude Code calls natively.

The architecture exists because ARC-AGI-3 scores **Relative Human Action Efficiency** (RHAE) where `level_score = (human_actions / ai_actions)^2`. The quadratic ratio means a memory-augmented agent that remembers a rule from level 1 and uses it efficiently in level 2 wins hard. Bitterbot is, fundamentally, retrieval-augmented persistent memory.

See [PLAN-19](../../research/plans/PLAN-19-ARC-AGI-3-AGENT.md) for the end-to-end engineering plan.

## What it is

The agent has three layers:

1. **Claude Code SDK** (`@anthropic-ai/claude-code`'s `query()`) drives the per-turn observe → reason → act loop. Default model Opus 4.7. Claude Code gets built-in bash, file I/O, and Python execution — useful for dynamic grid analysis.
2. **Shell-script "action tools"** in `benchmarks/arc-agi-3/actions/` match the partner-template convention exactly (`list-games.js`, `start-game.js`, `action.js --type N [--x X --y Y]`, `reset-game.js`, `status.js`, `get-scorecard.js`, `open-scorecard.js`, `close-scorecard.js`). Claude Code calls these via bash.
3. **Bitterbot Memory MCP server** in `benchmarks/arc-agi-3/mcp-server/` exposes Bitterbot's biological-memory subsystems as MCP tools Claude Code calls natively. Tools: `memory.query`, `memory.record_rule`, `memory.log_transition`, `memory.get_hypothesis`, `memory.update_hypothesis`, `memory.score_novelty`, `memory.get_hormonal_state`, `memory.list_skills`.

State is filesystem (per the partner template): `games/<game-id>/{frames, notes, scripts}/`, plus a project-wide `notes/` for cross-game scratchpad. The MCP server's tools persist structured memory into the knowledge graph in parallel; the filesystem is Claude's working surface and the KG is the canonical store.

A `CLAUDE.md` file in the project tells Claude Code about both the action tools and the memory MCP tools, plus the cross-level transfer strategy.

## Architecture

```
                         ┌──────────────────────────┐
                         │  Claude Code SDK         │
                         │  @anthropic-ai/claude-code│
                         │  query() drives Opus 4.7  │
                         └─────────────┬────────────┘
                                       │
                                       │ reads CLAUDE.md, calls tools
                                       ▼
       ┌──────────────────────────────────────────────────────────┐
       │  Tools Claude Code can invoke per-turn                    │
       │  (internal reasoning + tool calls don't count vs RHAE)    │
       └──────────────────────────────────────────────────────────┘
                   │                          │
                   ▼                          ▼
       ┌──────────────────────┐    ┌───────────────────────────────┐
       │ shell-script actions │    │ Bitterbot Memory MCP server   │
       │ (game I/O surface)   │    │ (biological memory surface)   │
       │                      │    │                               │
       │ - list-games.js      │    │ - memory.query(text)          │
       │ - open-scorecard.js  │    │ - memory.record_rule(...)     │
       │ - start-game.js      │    │ - memory.log_transition(...)  │
       │ - action.js --type N │    │ - memory.get_hypothesis()     │
       │ - status.js          │    │ - memory.update_hypothesis(.) │
       │ - close-scorecard.js │    │ - memory.score_novelty(...)   │
       │ - reset-game.js      │    │ - memory.get_hormonal_state() │
       └──────────┬───────────┘    └────────────┬──────────────────┘
                  │                              │
                  ▼                              ▼
       ┌──────────────────────┐    ┌───────────────────────────────┐
       │ ARC-AGI-3 REST API   │    │ Bitterbot subsystems          │
       │ three.arcprize.org   │    │ knowledge-graph + SAGE +      │
       │                      │    │ curiosity + epistemic-        │
       │                      │    │ directives + hormonal +       │
       │                      │    │ skill-crystallizer            │
       └──────────────────────┘    └───────────────────────────────┘

       ┌──────────────────────────────────────────────────────────┐
       │  Filesystem state Claude Code reads/writes between turns │
       │  - games/<id>/frames/frame_NNNN.json                     │
       │  - games/<id>/game.json                                  │
       │  - games/<id>/scripts/  (Claude writes its own analysis) │
       │  - notes/<topic>.md     (Claude's cross-game scratchpad) │
       │  - helpers/             (frame, grid, viz utilities)     │
       └──────────────────────────────────────────────────────────┘
```

## Why this architecture (not raw API + function calling)

This plan went through one revision. The original PLAN-19 design used raw Anthropic API + function-calling tools registered with Bitterbot's `pi-embedded-runner`. After reading the [Anthropic partner template](https://docs.arcprize.org/partner_templates/anthropic) and its reference implementation, the design switched to Claude Code SDK + shell actions + filesystem state + MCP server. The new design:

- **Follows Anthropic's endorsed pattern.** The partner-template approach is what Anthropic and the ARC Prize team jointly recommend.
- **Has less code.** Claude Code SDK handles the agent loop, prompt assembly, tool dispatch, retries. Roughly 1000 LOC of custom code disappears (2200 → 1200).
- **Gets code execution for free.** Claude can write its own grid-analysis Python script mid-game when it spots a pattern. We don't need to anticipate every analysis primitive.
- **Produces a reusable artifact.** The Memory MCP server can be called by any Claude Code session (or any MCP-aware agent — Claude Desktop, Cline, Cursor). Bitterbot's biological memory becomes a general-purpose agent capability, not just an internal Bitterbot subsystem.

The MCP server is the strategic addition. The partner template uses filesystem notes as memory; we add structured retrieval, hypothesis tracking, novelty scoring, and hormonal modulation on top.

## Submission tracks

ARC Prize 2026 has three submission surfaces with different rules:

| Track                     | Where                                             | Internet              | LLM                              | Prize                                                                  |
| ------------------------- | ------------------------------------------------- | --------------------- | -------------------------------- | ---------------------------------------------------------------------- |
| **Verified Testing**      | arcprize.org                                      | Yes, $10K retail cap  | Any hosted (Opus / GPT / Gemini) | Milestone prizes ($25K/$10K/$2.5K twice) gate through this leaderboard |
| **Community leaderboard** | github.com/arcprize/ARC-AGI-Community-Leaderboard | n/a (self-report)     | Any                              | No prize — public credit + scorecard URL                               |
| **Kaggle competition**    | kaggle.com/competitions/arc-prize-2026-arc-agi-3  | **No** — offline only | Local weights only               | Milestone prizes via Kaggle submission                                 |

The Bitterbot agent targets the **Verified Testing track** primarily. Opus 4.7 is the default model via Claude Code SDK. The Kaggle offline submission is a stretch goal that requires swapping the Anthropic-hosted Claude Code for a local-model OpenAI-compatible server (vLLM or Ollama running Qwen 32B / similar) — see PLAN-19 Phase 6c. The MCP server and action scripts are unchanged on that path.

## Running it

Prereqs:

- `ARC_API_KEY` from https://arcprize.org/platform (Google or GitHub login).
- `ANTHROPIC_API_KEY` for Claude Code SDK.
- `OPENAI_API_KEY` for embeddings inside the MCP server (SAGE retrieval).

Set in `.env` and source. The `.claude/mcp.json` config in `benchmarks/arc-agi-3/` registers the Bitterbot Memory MCP server with Claude Code.

### Play one public game

```bash
node --import tsx benchmarks/arc-agi-3/runners/run-single-game.ts \
  --game ls20-016295f7601e \
  --max-turns 50 \
  --output benchmarks/arc-agi-3/results/single.jsonl
```

The runner emits one `ARC {...}` JSON line per Claude Code message for live monitoring.

### Run the full ablation

```bash
bash benchmarks/arc-agi-3/runners/run-ablation.sh
```

Runs the 5-cell ablation matrix across the 25 public games. Cells toggle MCP-tool exposure:

| Cell                      | MCP tools exposed                                                                  |
| ------------------------- | ---------------------------------------------------------------------------------- |
| baseline-partner-template | none (matches the unmodified ThariqS template)                                     |
| +memory                   | `memory.query`, `memory.log_transition`                                            |
| +hypothesis               | + `memory.get_hypothesis`, `memory.update_hypothesis`                              |
| +curiosity                | + `memory.score_novelty`                                                           |
| full                      | all (also `memory.record_rule`, `memory.get_hormonal_state`, `memory.list_skills`) |

Outputs:

- `benchmarks/arc-agi-3/results/<cell>/<gameId>.jsonl` — per-message logs
- `benchmarks/arc-agi-3/results/<cell>/summary.json` — RHAE per level + per game, cost, wall-clock
- `benchmarks/arc-agi-3/results/<cell>/improvement-curve.csv` — RHAE vs. game-index (the cross-level transfer measurement)

### Submit to Verified Testing

```bash
node --import tsx benchmarks/arc-agi-3/runners/submit-verified.ts \
  --tags "bitterbot-v1,biological-memory,mcp" \
  --games verified-track
```

Opens a single scorecard, runs the full track (25 public + 55 semi-private games), closes the scorecard, prints the `scorecard_url`. The URL goes in the community-leaderboard PR.

## Calling the Memory MCP server from other Claude Code sessions

The MCP server is reusable beyond ARC. To call Bitterbot's biological memory from any Claude Code session:

1. Build the MCP server: `pnpm build` (or run via `tsx` directly).
2. Add to your Claude Code MCP config (`~/.claude/mcp.json` or per-project `.claude/mcp.json`):

```json
{
  "mcpServers": {
    "bitterbot-memory": {
      "command": "node",
      "args": ["--import=tsx", "/path/to/bitterbot/benchmarks/arc-agi-3/mcp-server/index.ts"],
      "env": {
        "BITTERBOT_AGENT_DIR": "~/.bitterbot/agents/my-agent",
        "OPENAI_API_KEY": "${OPENAI_API_KEY}"
      }
    }
  }
}
```

3. Claude Code will see the `memory.*` tools and can call them in any session.

## What this agent measures (and why it matters)

The point isn't to beat OpenAI on absolute score. Frontier models hit <0.5% on ARC-AGI-3 because they treat every level independently. The point is to show the **improvement curve** — that game N is solved with measurably fewer actions because the agent retained world-model fragments from games 1..N-1.

Three documented frontier failure modes (from Epium's analysis of Opus 4.7 / GPT-5.5 transcripts) map directly onto Bitterbot's strengths:

| Frontier failure                                                                                  | Bitterbot mitigation                                                                                |
| ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Fragmented world modeling: notice local mechanics, never integrate                                | `memory.record_rule` writes structured rules into the KG; `memory.query` retrieves across levels    |
| False analogies to training data: force-fit envs into Tetris/Frogger                              | `memory.update_hypothesis` maintains explicit hypotheses with confidence; refutation on `GAME_OVER` |
| Solving without understanding: execute correct sequence with wrong theory, propagate wrong theory | Reconsolidation makes recalled memories labile; SAGE structural gating dampens spurious edges       |

The ablation harness measures whether these mitigations actually translate to RHAE.

## State of the field (May 2026)

- Frontier models: Gemini 3.1 Pro 0.37%; Opus 4.6 0.25%; GPT-5.4 0.26%.
- Best world-model agent: Symbolica Agentica **32.58%** on the public-25 set (executable code as the world model).
- Best lightweight RL: StochasticGoose 12.58% (CNN + RL frame-delta prediction, no LLM).
- Community leaderboard: low single digits with public submissions.

A non-zero Bitterbot score on the public-25 with a public repo and scorecard URL qualifies for the community leaderboard immediately. There is no minimum-score threshold.

## Code license

The agent code lives in `benchmarks/arc-agi-3/` and inherits the repository's MIT license. ARC Prize 2026 requires solution code under CC0 or MIT-0 — the writeup must dual-license the `benchmarks/arc-agi-3/` files under MIT-0 at submission time. The Bitterbot dependencies (already MIT) and third-party packages (Apache-2.0 / GPL-3.0 in our deps) satisfy the eligibility rules.

## See also

- [PLAN-19](../../research/plans/PLAN-19-ARC-AGI-3-AGENT.md) — the engineering plan (revised after reading the Anthropic partner template)
- [Anthropic partner template](https://docs.arcprize.org/partner_templates/anthropic) — runtime + file layout we follow
- [Reference repo: ThariqS/ARC-AGI-3-ClaudeCode-SDK](https://github.com/ThariqS/ARC-AGI-3-ClaudeCode-SDK)
- [SAGE graph memory](../memory/sage-graph-memory.md) — the multi-hop retrieval the MCP server exposes
- [Curiosity & search](../memory/curiosity-and-search.md) — GCCRF intrinsic reward used in `memory.score_novelty`
- [Emotional system](../memory/emotional-system.md) — hormonal state used in `memory.get_hormonal_state`
- [Long-horizon runtime](./long-horizon.md) — the Task primitive that wraps multi-game evaluation runs

## References

- [ARC-AGI-3 technical report (arxiv:2603.24621)](https://arxiv.org/abs/2603.24621)
- [ARC-AGI-3 docs](https://docs.arcprize.org/)
- [ARC Prize 2026](https://arcprize.org/competitions/2026)
- [Executable World Models paper (arxiv:2605.05138)](https://arxiv.org/abs/2605.05138) — current SOTA reference
- [Epium: three reasoning failure patterns in frontier models](https://epium.com/news/arc-agi-3-analysis-finds-three-reasoning-failure-patterns-in-frontier-models/)
- [MCP specification](https://modelcontextprotocol.io/specification)
