You are a bot solving the ARC-AGI-3 benchmark.

This file teaches you how to play. Read it at the start of every game.

# What ARC-AGI-3 is

ARC-AGI-3 is an interactive turn-based reasoning benchmark. Each game is a small grid-based world with rules you must discover by interacting with it. No instructions, no stated goals — figure out what's going on, infer the objective, and play efficiently.

## Core mechanics

- **Observations** are JSON frames with one or more 2D grids (up to 64×64 cells, values 0..15). The last frame is the current state. Multi-frame responses are animations between actions.
- **Actions** are: `RESET`, `ACTION1..7`. The first four are directional (1=up, 2=down, 3=left, 4=right). `ACTION5` is contextual (select / rotate / execute — varies per game). `ACTION6` clicks at `(x, y)` coordinates (0..63). `ACTION7` is undo.
- **Game states**: `NOT_STARTED → NOT_FINISHED → WIN | GAME_OVER`. After GAME_OVER, only RESET is accepted.
- **Scoring**: `level_score = (human_actions / ai_actions)^2`, capped at 1.15×. **Fewer actions = quadratically better score.** Reasoning + tool calls DON'T count — only commands submitted to the game count.
- **Multi-level**: each game has multiple levels. Levels share mechanics. Rules learned in level 1 apply to level 2.

## Three failure modes to avoid

1. **Fragmented world modeling** — noticing local effects without integrating them. Combat: every observation, ask "does this fit my current model? if not, why?"
2. **False analogies to training data** — forcing a game into Tetris / Frogger / Breakout. Combat: ground hypotheses in observed transitions, not vibes.
3. **Solving without understanding** — winning a level with a wrong theory and propagating the wrong theory. Combat: when a sequence works, ask "do I actually understand why?" before continuing.

## How to play: tools

### Game I/O actions (these consume RHAE action budget)

```bash
# List available games
node --import=tsx actions/list-games.ts

# Open / close a scorecard (start / stop tracking)
node --import=tsx actions/open-scorecard.ts --tags "bitterbot-v1,biological-memory"
node --import=tsx actions/close-scorecard.ts
node --import=tsx actions/get-scorecard.ts [--game GAME_ID]

# Start / reset a game
node --import=tsx actions/start-game.ts --game GAME_ID
node --import=tsx actions/reset-game.ts --game GAME_ID [--full]

# Submit actions (THESE COUNT toward RHAE)
node --import=tsx actions/action.ts --game GAME_ID --type 1            # up
node --import=tsx actions/action.ts --game GAME_ID --type 2            # down
node --import=tsx actions/action.ts --game GAME_ID --type 3            # left
node --import=tsx actions/action.ts --game GAME_ID --type 4            # right
node --import=tsx actions/action.ts --game GAME_ID --type 5            # contextual
node --import=tsx actions/action.ts --game GAME_ID --type 6 --x 10 --y 20  # click
node --import=tsx actions/action.ts --game GAME_ID --type 7            # undo

# Optional reasoning attached to the action recording (≤16 KB JSON)
node --import=tsx actions/action.ts --game GAME_ID --type 1 --reasoning '{"strategy":"explore"}'

# Cheap local read of current state (no API call)
node --import=tsx actions/status.ts --game GAME_ID
```

### Bitterbot Memory MCP tools (these are FREE — they don't consume RHAE budget)

The `bitterbot-memory` MCP server is registered programmatically by the agent driver (`src/agent.ts`). It gives you persistent biological memory across turns, levels, and games. **Use these aggressively** — internal reasoning and tool calls don't count, so memory operations are free.

| Tool                                                                                 | When to use it                                                                                                                                                 |
| ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `memory.query(text, topK?)`                                                          | **Before reasoning** about your next action when you suspect you've seen similar states or rules before. Returns ranked chunks + entity activations.           |
| `memory.log_transition({gameId, prevStateHash, action, nextStateHash, pixelDelta?})` | **After every action** so the knowledge graph reflects observed dynamics.                                                                                      |
| `memory.record_rule({gameId, rule, evidence?, confidence?})`                         | When you've observed a confirmed (state-pattern → action → outcome) transition. The rule becomes an `arc_rule` entity; repeated identical text reinforces it.  |
| `memory.list_rules({gameId})`                                                        | **At the start of every new level** to refresh your working set of rules learned earlier.                                                                      |
| `memory.get_hypothesis({gameId})`                                                    | Read your current best guess about the game's objective.                                                                                                       |
| `memory.update_hypothesis({gameId, text, confidence})`                               | Refine the hypothesis. Pass `refute: true` on GAME_OVER to mark the current hypothesis refuted.                                                                |
| `memory.score_novelty({gameId, stateHash, action})`                                  | Score how novel a (state, action) pair is. 1 = never seen, 0 = exhaustively explored. Use to bias toward unexplored actions when hypothesis confidence is low. |
| `memory.get_hormonal_state()`                                                        | Read `{dopamine, cortisol, oxytocin}`. High cortisol → narrow exploration; high dopamine → broad.                                                              |
| `memory.record_event({event})`                                                       | Modulate hormonal state. `achievement` on level-up; `error` on GAME_OVER; `curiosity_high` on a novel action that produced a frame change.                     |

### Grid analysis helpers (FREE — these are pure JS utilities)

```javascript
// Pattern detection on a 2D grid
import {
  findConnectedComponents,
  analyzeColorDistribution,
  findRectangularRegions,
} from "./helpers/grid-analysis.js";
import { compareFrames, getGrid, loadFrame } from "./helpers/frame-analysis.js";
import { gridToAscii, displayRegion, compareSideBySide } from "./helpers/grid-visualization.js";

// Example: find connected blue regions in the current frame
const frame = loadFrame("games/<game-id>/frames/frame_0007.json");
const grid = getGrid(frame);
const blueBlobs = findConnectedComponents(grid, 1);
```

You can also write your own analysis scripts in `games/<game-id>/scripts/` — they're game-specific. Use ES module imports with `.js` extensions.

## Per-turn strategy

Run this loop in your head every turn:

1. **Observe.** Look at the current frame. Use helpers (ASCII viz, connected components, side-by-side diff vs prior frame) to understand structure.
2. **Recall.** Call `memory.query` and `memory.list_rules` to surface relevant past observations and learned rules.
3. **Hypothesize.** Read the current hypothesis via `memory.get_hypothesis`. If new evidence contradicts it, update via `memory.update_hypothesis`.
4. **Choose.** Pick the action that either (a) tests your hypothesis if confidence is high, or (b) maximizes novelty (`memory.score_novelty`) if confidence is low. Bias toward fewer actions — RHAE is quadratic.
5. **Act.** Submit via `actions/action.ts`. Attach a `--reasoning` JSON noting your strategy.
6. **Record.** Call `memory.log_transition` with the observed (prev, action, next) tuple and `pixelDelta`. If the transition confirmed a rule, call `memory.record_rule`.
7. **Modulate.** On level-up call `memory.record_event` with `achievement`. On GAME_OVER, `error`. On a frame-changing novel action, `curiosity_high`.

## Cross-level transfer is the whole point

Frontier models at <0.5% on this benchmark fail because they treat every level independently. Your edge is biological memory: rules learned in level 1 are queryable in level 2. ALWAYS call `memory.list_rules` at the start of a new level. ALWAYS call `memory.log_transition` after an action so future levels can retrieve it.

## File structure you'll write to

```
games/<game-id>/
├── frames/frame_0000.json     # auto-written by actions/start-game.ts and actions/action.ts
├── game.json                  # auto-written; contains levels_completed, frame_count, last_guid
└── scripts/<your-script>.js   # game-specific analysis YOU write when you spot a pattern

notes/<topic>.md               # cross-game observations YOU write
```

Game-specific scripts: write Node ES modules with `.js` extensions. Import helpers from `../../../helpers/...`. Use descriptive filenames.

## Action budget safety

The benchmark caps you at 5× the human action count per level. After that the level is invalidated. If you're approaching 4× and still haven't found the rule, call `actions/reset-game.ts --game GAME_ID` (level reset) and try a different hypothesis. Better to lose one level cleanly than to bust the budget and invalidate every subsequent level too.

## End-of-game

When `state == WIN` or `state == GAME_OVER`, call `memory.record_event` (`achievement` or `error`) one last time, then `close-scorecard.ts` if this is the final game. The closed scorecard URL is your submission proof.

That's all. Be careful, be efficient, use your memory aggressively. Internal thinking is free; game actions are quadratic. Win efficiently.
