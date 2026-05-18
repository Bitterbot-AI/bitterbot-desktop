# ARC-AGI-3 Agent (PLAN-19, revised)

Bitterbot's agent for [ARC Prize 2026 / ARC-AGI-3](https://arcprize.org/competitions/2026/arc-agi-3).

Built on the [Anthropic partner template](https://docs.arcprize.org/partner_templates/anthropic) (Claude Code SDK + shell-script actions + filesystem state), with Bitterbot's biological memory subsystems exposed as an MCP server Claude Code calls natively. The MCP server is the strategic differentiator and is reusable beyond ARC — any Claude Code session can call it.

For the public-facing architecture overview see [docs/agents/arc-agi-3.md](../../docs/agents/arc-agi-3.md). For the submission process see [SUBMISSION.md](./SUBMISSION.md). For the engineering plan see [research/plans/PLAN-19-ARC-AGI-3-AGENT.md](../../research/plans/PLAN-19-ARC-AGI-3-AGENT.md).

## Status

| Phase | Component                                                                      | Status      |
| ----- | ------------------------------------------------------------------------------ | ----------- |
| 1     | `src/arc-client.ts` + `actions/*.js` — REST client + game I/O shell scripts    | Not started |
| 2     | `helpers/{frame,grid,grid-visualization}-analysis.js` — pure-JS grid utilities | Not started |
| 3     | `mcp-server/` — Bitterbot Memory MCP server                                    | Not started |
| 4     | `CLAUDE.md` — instruction file Claude Code reads                               | Not started |
| 5a    | `src/agent.ts` — Claude Code SDK driver                                        | Not started |
| 5b    | `src/ablation.ts` — 5-cell ablation harness                                    | Not started |
| 6     | Submission + writeup                                                           | Not started |

Plan target: **Milestone #1 (June 30, 2026)** on the Verified Testing track.

## Layout

```
benchmarks/arc-agi-3/
├── README.md                       # this file
├── SUBMISSION.md                   # submission process for both tracks
├── CLAUDE.md                       # instructions Claude Code reads
├── .claude/
│   └── mcp.json                    # registers bitterbot-memory MCP server
├── actions/                        # shell-callable game I/O scripts (partner template convention)
│   ├── list-games.js
│   ├── open-scorecard.js
│   ├── close-scorecard.js
│   ├── get-scorecard.js
│   ├── start-game.js
│   ├── action.js                   # --type 1..7 [--x X --y Y] [--reasoning JSON]
│   ├── reset-game.js
│   └── status.js
├── helpers/                        # pure-JS grid analysis utilities (partner template convention)
│   ├── frame-analysis.js
│   ├── grid-analysis.js
│   └── grid-visualization.js
├── mcp-server/                     # Bitterbot Memory MCP server (the strategic asset)
│   ├── index.ts                    # server entry
│   ├── manifest.json
│   └── tools/
│       ├── query.ts                # memory.query(text)
│       ├── record-rule.ts          # memory.record_rule(rule, evidence?)
│       ├── log-transition.ts       # memory.log_transition(prev, action, next, delta)
│       ├── hypothesis.ts           # memory.get_hypothesis() + update_hypothesis()
│       ├── novelty.ts              # memory.score_novelty(stateHash, action)
│       ├── hormonal.ts             # memory.get_hormonal_state() + record_event()
│       └── skills.ts               # memory.list_skills(gameId)
├── src/                            # agent runner + ablation harness
│   ├── arc-client.ts               # typed REST client (used by actions + MCP)
│   ├── state.ts                    # filesystem state I/O
│   ├── agent.ts                    # Claude Code SDK driver via query()
│   ├── run-games.ts                # multi-game evaluation loop
│   └── ablation.ts                 # 5-cell ablation matrix
├── runners/
│   ├── run-single-game.ts
│   ├── run-ablation.sh
│   └── analyze-runs.ts
├── tests/                          # vitest unit + integration tests
├── fixtures/
│   ├── frame-response-samples/     # captured real FrameResponses
│   └── recorded-games/             # full game replays for offline testing
├── games/                          # per-game state (gitignored)
│   └── <game-id>/
│       ├── frames/
│       ├── notes/
│       ├── scripts/                # Claude-written analysis scripts
│       └── game.json
├── notes/                          # Claude's persistent cross-game scratchpad (gitignored)
├── results/                        # per-run output (gitignored)
└── kaggle/
    └── notebook.ipynb              # offline submission variant (Phase 6c stretch)
```

## Quick start (once implemented)

Prerequisites:

```bash
# In .env (gitignored)
ARC_API_KEY=...        # from https://arcprize.org/platform
ANTHROPIC_API_KEY=...  # Claude Code SDK
OPENAI_API_KEY=...     # embeddings for SAGE retrieval inside the MCP server
```

Play one public game:

```bash
set -a && source .env && set +a
node --import tsx benchmarks/arc-agi-3/runners/run-single-game.ts \
  --game ls20-016295f7601e \
  --max-turns 50 \
  --output benchmarks/arc-agi-3/results/single.jsonl

# Live monitor:
tail -F benchmarks/arc-agi-3/results/single.jsonl | grep --line-buffered '^ARC '
```

Run the 5-cell ablation across all 25 public games:

```bash
bash benchmarks/arc-agi-3/runners/run-ablation.sh
```

## Calling Bitterbot Memory MCP from other Claude Code sessions

The MCP server is independent of the ARC agent. To use Bitterbot's biological memory from any other Claude Code session:

```json
// ~/.claude/mcp.json
{
  "mcpServers": {
    "bitterbot-memory": {
      "command": "node",
      "args": ["--import=tsx", "/abs/path/to/benchmarks/arc-agi-3/mcp-server/index.ts"],
      "env": {
        "BITTERBOT_AGENT_DIR": "~/.bitterbot/agents/my-agent",
        "OPENAI_API_KEY": "${OPENAI_API_KEY}"
      }
    }
  }
}
```

The `memory.*` tools become available in any Claude Code session.

## Key facts about the benchmark

- **API:** `https://three.arcprize.org`, `X-API-Key` auth, 600 RPM limit, AWSALB sticky cookies per `guid`.
- **Observation:** 1–N frames of `64×64` int grids (values 0–15).
- **Actions:** `RESET, ACTION1..7`. ACTION1-4 directional; ACTION5 contextual; ACTION6 click-with-(x,y); ACTION7 undo.
- **Scoring:** `level_score = (human_actions / ai_actions)^2`, capped 1.15×, weighted by level number, averaged across games.
- **Internal reasoning + tool calls DON'T count.** Only game actions (`POST /api/cmd/ACTION*`) count vs RHAE.
- **Game set:** 25 public demo + 55 semi-private + 55 fully-private (135 total).
- **Verified Testing cap:** $10K retail per evaluation run.
- **Kaggle cap:** 12h Kaggle GPU wall-clock, no internet.
- **Open-source mandate:** code under CC0 / MIT-0; deps Apache-2.0 / GPL-3.0+.

## Development conventions

- TypeScript via `tsx` for `src/` and `mcp-server/`. ES-module Node for `actions/` and `helpers/` (matches partner template).
- Tests via `vitest` matching the repo pattern `*.test.ts`. Run: `pnpm vitest run benchmarks/arc-agi-3/`.
- All files stay under the project's 500-LOC soft cap (`scripts/check-ts-max-loc.ts`).
- New `EntityType` and `RelationType` values added to `src/memory/knowledge-graph.ts` must be additive.
- One single-line `ARC {...}` JSON log line per Claude Code message for monitorability (matches the `LME {...}` pattern from `benchmarks/longmemeval/`).
- Per-game results land as JSONL in `results/`; per-cell summaries land as JSON.
- The MCP server uses a minimal `MemoryIndexManager` config that explicitly disables every default-on background scheduler (cf. LongMemEval lessons about trending-sweep / digest / dream-cycle research firing uninvited).

## Dependencies (to add when implementation starts)

```jsonc
// package.json
"dependencies": {
  "@anthropic-ai/claude-code": "^1.0.0",
  "@modelcontextprotocol/sdk": "^1.0.0"
}
```

## See also

- [PLAN-19](../../research/plans/PLAN-19-ARC-AGI-3-AGENT.md) — engineering plan, end-to-end
- [docs/agents/arc-agi-3.md](../../docs/agents/arc-agi-3.md) — public-facing architecture
- [SUBMISSION.md](./SUBMISSION.md) — track-by-track submission process
- [Anthropic partner template](https://docs.arcprize.org/partner_templates/anthropic)
- [Reference repo: ThariqS/ARC-AGI-3-ClaudeCode-SDK](https://github.com/ThariqS/ARC-AGI-3-ClaudeCode-SDK)
- [docs/memory/sage-graph-memory.md](../../docs/memory/sage-graph-memory.md) — the memory layer the MCP server exposes
- [benchmarks/longmemeval/](../longmemeval/) — analogous benchmark structure
