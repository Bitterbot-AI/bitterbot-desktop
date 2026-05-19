"""Prompt builders for the BitterbotAgent.

Two surfaces:
- `SYSTEM_PROMPT`: static; teaches the model the ARC-AGI-3 mechanics +
  the exact output format the action parser expects.
- `build_user_prompt`: per-turn; composes the current frame, the recent
  frame history, the memory snapshot (rules + hypothesis + novelty),
  and the hormonal state into a single string.

Keep prompts short. At 50 t/s decode + 3.5 h LLM budget, every 100
extra prompt tokens × 25 games × 50 turns burns 2 minutes of wall
clock. Cropping frames to changed regions and limiting recent-frame
context to 2 prior frames keeps us in the 3k-token range per turn.
"""

from __future__ import annotations

from typing import Iterable

from .curiosity import NoveltyScore
from .epistemic import Hypothesis
from .frame import FrameSnapshot, diff_region, grid_to_ascii
from .hormonal import HormonalSnapshot
from .retrieval import RetrievalHit
from .rules import ArcRule


SYSTEM_PROMPT = """You are playing an interactive ARC-AGI-3 game.

# What you see
Each turn you get the current 64x64 grid (values 0..15, rendered as ASCII glyphs) plus a short recap of the last 1-2 turns.

# What you do
Pick exactly one action per turn from:
  ACTION1 = up
  ACTION2 = down
  ACTION3 = left
  ACTION4 = right
  ACTION5 = contextual (select / rotate / use; varies per game)
  ACTION6 = click at (x, y) where 0 <= x,y <= 63
  ACTION7 = undo
  RESET   = give up the current level and restart it

# Scoring
Score is QUADRATIC in your action count: level_score = (human_actions / ai_actions)^2, capped at 1.15x. Fewer actions => much higher score. Internal reasoning is free; submitted actions cost.

# Your edge: persistent biological memory
You have a memory layer that persists rules learned in earlier levels of this game (and earlier games entirely). Frontier models without memory fail because they treat every level fresh. You don't.

# Output format (the action parser is strict-but-forgiving)
Always emit:

<scratchpad>
brief reasoning, 1-3 sentences, what hypothesis you're testing
</scratchpad>
<action>ACTION3</action>

For clicks, include coords:
<action>ACTION6 x=10 y=20</action>

Optional:
<rule_observed>short rule text the last action confirmed</rule_observed>
<hypothesis_update>refined theory of the game's goal</hypothesis_update>

# Three failure modes to avoid
1. Fragmented world modeling — noticing local effects without integrating them.
2. False analogies to training data — forcing the game into Tetris / Frogger / Breakout.
3. Solving without understanding — winning a level with a wrong theory and propagating it.
"""


def _format_rules(rules: Iterable[ArcRule], limit: int = 6) -> str:
    rules_list = list(rules)[:limit]
    if not rules_list:
        return "(none yet)"
    out = []
    for r in rules_list:
        out.append(f"  - [conf={r.confidence:.2f}, seen={r.mention_count}x] {r.rule}")
    return "\n".join(out)


def _format_hypothesis(h: Hypothesis | None) -> str:
    if h is None:
        return "(no hypothesis yet — observe and form one)"
    return (
        f"  text: {h.text}\n"
        f"  confidence: {h.confidence:.2f}\n"
        f"  refutations so far: {h.refutation_count}"
    )


def _format_hormonal(s: HormonalSnapshot) -> str:
    breadth_hint = "narrow" if s.cortisol > 0.4 else ("broad" if s.dopamine > 0.4 else "balanced")
    return (
        f"  dopamine={s.dopamine:.2f}  cortisol={s.cortisol:.2f}  oxytocin={s.oxytocin:.2f}\n"
        f"  (high cortisol -> exploit; high dopamine -> explore; current bias: {breadth_hint})"
    )


def _format_novelty(novelty_by_action: dict[int, NoveltyScore]) -> str:
    if not novelty_by_action:
        return "(no novelty data — first turn)"
    rows = []
    for action in sorted(novelty_by_action.keys()):
        n = novelty_by_action[action]
        rows.append(f"  ACTION{action}: novelty={n.novelty:.2f}  observed={n.observed_count}x")
    return "\n".join(rows)


def _format_memory_hits(hits: Iterable[RetrievalHit], limit: int = 4) -> str:
    hits_list = list(hits)[:limit]
    if not hits_list:
        return ""
    lines = []
    for h in hits_list:
        lines.append(f"  - [{h.entity.entity_type}] {h.entity.name}  (rrf={h.score:.3f})")
    return "Relevant memory hits:\n" + "\n".join(lines) + "\n"


def _format_recent(recent: Iterable[FrameSnapshot], last_actions: Iterable[int]) -> str:
    """Compact view of the last 1-2 frames.

    Renders only the changed region as ASCII to save tokens. If no
    changes are detectable, we render a brief metadata line and skip
    the grid.
    """
    recent_list = list(recent)
    actions_list = list(last_actions)
    if len(recent_list) < 2:
        return "(no prior frames yet — first turn of this game)"
    lines: list[str] = []
    for i in range(1, len(recent_list)):
        prev, curr = recent_list[i - 1], recent_list[i]
        action_id = actions_list[i - 1] if i - 1 < len(actions_list) else "?"
        region = diff_region(prev.grid, curr.grid)
        if region is None or region.changed_cells == 0:
            lines.append(f"After ACTION{action_id}: no pixel change.")
            continue
        lines.append(
            f"After ACTION{action_id}: {region.changed_cells} cells changed in "
            f"rows {region.min_row}-{region.max_row}, cols {region.min_col}-{region.max_col}."
        )
        # Crop curr frame to the diff region for compact display
        cropped = curr.grid[
            region.min_row : region.max_row + 1, region.min_col : region.max_col + 1
        ]
        lines.append(grid_to_ascii(cropped))
    return "\n".join(lines)


def build_user_prompt(
    *,
    game_id: str,
    latest: FrameSnapshot,
    recent_frames: Iterable[FrameSnapshot],
    last_actions: Iterable[int],
    rules: Iterable[ArcRule],
    hypothesis: Hypothesis | None,
    hormonal: HormonalSnapshot,
    novelty_by_action: dict[int, NoveltyScore],
    memory_hits: Iterable[RetrievalHit] = (),
) -> str:
    """Compose the per-turn user prompt the model will react to."""
    ascii_grid = grid_to_ascii(latest.grid)
    rules_block = _format_rules(rules)
    hyp_block = _format_hypothesis(hypothesis)
    horm_block = _format_hormonal(hormonal)
    nov_block = _format_novelty(novelty_by_action)
    mem_hits_block = _format_memory_hits(memory_hits)
    recent_block = _format_recent(recent_frames, last_actions)

    return f"""# Game
game_id: {game_id}
state: {latest.state}
score (actions so far): {latest.score}

# Current frame (64x64)
{ascii_grid}

# Recent frames (changes only)
{recent_block}

# Rules learned (most-reinforced first)
{rules_block}

# Current hypothesis
{hyp_block}

# Hormonal state (modulates exploration breadth)
{horm_block}

# Novelty for candidate actions
{nov_block}

{mem_hits_block}# Pick your next action.
Emit a <scratchpad> with 1-3 sentences of reasoning, then exactly one <action> tag.
""".strip()
