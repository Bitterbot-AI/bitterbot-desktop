"""BitterbotAgent — framework-agnostic decision loop.

This module contains the core per-turn logic without any dependency
on `arcprize/ARC-AGI-3-Agents` or `arcengine`. That separation keeps
the agent testable without installing the Kaggle competition
framework. At submission time, `arc_adapter.py` wraps this class in
the concrete `Agent` ABC the competition expects.

Per-turn flow:
  1. Snapshot the latest frame into a FrameSnapshot.
  2. If we have a previous (state, action), log the transition + maybe
     stimulate `curiosity_high` if the frame actually changed.
  3. Pull rules, hypothesis, hormonal state, novelty for candidate
     actions from BitterbotMemory.
  4. Build a prompt and call the LLM.
  5. Parse the response into a ParsedAction. Optionally record a new
     rule + update hypothesis.
  6. Return the action.

The LLM is supplied as a callable `(system: str, user: str) -> str`
so tests can stub it without booting vLLM.
"""

from __future__ import annotations

import logging
from collections import deque
from dataclasses import dataclass
from typing import Callable

from .action_parser import ParsedAction, parse as parse_action
from .frame import FrameSnapshot, hash_grid, pixel_diff
from .memory import BitterbotMemory
from .prompts import SYSTEM_PROMPT, build_user_prompt

logger = logging.getLogger(__name__)


LlmCallable = Callable[[str, str], str]
"""(system_prompt, user_prompt) -> raw model output."""


@dataclass
class AgentTurnResult:
    """Trace of one decision turn — useful for logs and replay."""

    parsed: ParsedAction
    prompt_user: str
    response: str
    state_hash_before: str
    state_hash_after: str | None
    """`None` until the next turn observes the resulting frame."""
    pixel_delta: int
    """Cells that changed between the previous frame and the current one."""


class BitterbotAgent:
    """Pure decision-making agent. Stateless across games is the goal,
    but a small ring buffer of recent frames + last actions is kept
    in-memory for prompt construction.
    """

    RECENT_BUFFER_SIZE = 3

    def __init__(
        self,
        memory: BitterbotMemory,
        llm: LlmCallable,
        *,
        candidate_actions: tuple[int, ...] = (1, 2, 3, 4, 5, 6),
        record_rules: bool = True,
    ) -> None:
        self.memory = memory
        self.llm = llm
        self.candidate_actions = candidate_actions
        self.record_rules = record_rules

        self._recent: deque[FrameSnapshot] = deque(maxlen=self.RECENT_BUFFER_SIZE)
        self._last_actions: deque[int] = deque(maxlen=self.RECENT_BUFFER_SIZE - 1)
        self._pending_action: int | None = None
        """Action chosen on the previous turn, awaiting next-frame observation."""

    # ── State helpers ──────────────────────────────────────────────

    def reset_episode(self) -> None:
        """Clear the per-game ring buffer between games."""
        self._recent.clear()
        self._last_actions.clear()
        self._pending_action = None

    @staticmethod
    def snapshot(grid, state: str, score: int) -> FrameSnapshot:
        """Build a FrameSnapshot from raw numpy grid + state metadata."""
        return FrameSnapshot(
            grid=grid,
            state=state,
            score=score,
            state_hash=hash_grid(grid),
        )

    # ── Main entry ─────────────────────────────────────────────────

    def choose_action(self, game_id: str, latest: FrameSnapshot) -> AgentTurnResult:
        """Run the full per-turn loop and return the next action."""
        prev = self._recent[-1] if self._recent else None
        pixel_delta = pixel_diff(prev.grid, latest.grid) if prev is not None else 0

        # 1. Log the transition from the previous (state, action), if any.
        if prev is not None and self._pending_action is not None:
            self.memory.log_transition(
                game_id,
                prev_state_hash=prev.state_hash,
                action=self._pending_action,
                next_state_hash=latest.state_hash,
                pixel_delta=pixel_delta,
            )
            # Reward curiosity when an action visibly changed the world.
            if pixel_delta > 0:
                self.memory.record_event("curiosity_high")

        # 2. Pull memory state for the prompt.
        rules = self.memory.list_rules(game_id, limit=8)
        hypothesis = self.memory.get_hypothesis(game_id)
        hormonal = self.memory.get_hormonal_state()
        novelty_by_action = {
            a: self.memory.score_novelty(game_id, latest.state_hash, a)
            for a in self.candidate_actions
        }
        memory_hits = self.memory.query(
            text=f"{hypothesis.text if hypothesis else 'game mechanics'}",
            top_k=4,
        ) if hypothesis else []

        # 3. Build prompt.
        user_prompt = build_user_prompt(
            game_id=game_id,
            latest=latest,
            recent_frames=list(self._recent) + [latest],
            last_actions=list(self._last_actions) + (
                [self._pending_action] if self._pending_action is not None else []
            ),
            rules=rules,
            hypothesis=hypothesis,
            hormonal=hormonal,
            novelty_by_action=novelty_by_action,
            memory_hits=memory_hits,
        )

        # 4. Call the LLM.
        response = self.llm(SYSTEM_PROMPT, user_prompt)
        parsed = parse_action(response)

        # 5. Update memory from optional payloads.
        if self.record_rules and parsed.rule_observed:
            try:
                self.memory.record_rule(
                    game_id, parsed.rule_observed,
                    evidence=latest.state_hash, confidence=0.7,
                )
            except ValueError:
                logger.debug("empty rule_observed payload, skipping")
        if parsed.hypothesis_update:
            current = self.memory.get_hypothesis(game_id)
            new_confidence = (current.confidence + 0.1) if current else 0.5
            self.memory.update_hypothesis(
                game_id, parsed.hypothesis_update, confidence=min(1.0, new_confidence),
            )

        # 6. Update ring buffers + return.
        if self._pending_action is not None:
            self._last_actions.append(self._pending_action)
        self._recent.append(latest)
        self._pending_action = parsed.kind

        return AgentTurnResult(
            parsed=parsed,
            prompt_user=user_prompt,
            response=response,
            state_hash_before=latest.state_hash,
            state_hash_after=None,
            pixel_delta=pixel_delta,
        )

    # ── Episode-end hook ───────────────────────────────────────────

    def on_episode_end(self, game_id: str, *, won: bool) -> None:
        """Called when the game reaches WIN or GAME_OVER.

        Marks the hypothesis as refuted on GAME_OVER, records the
        achievement/error hormonal event, and clears the per-game
        buffer for the next game.
        """
        self.memory.record_event("achievement" if won else "error")
        if not won:
            current = self.memory.get_hypothesis(game_id)
            if current is not None:
                self.memory.update_hypothesis(
                    game_id, current.text, current.confidence, refute=True
                )
        self.reset_episode()
