"""Bridge between BitterbotAgent (framework-agnostic) and the
`arcprize/ARC-AGI-3-Agents` `Agent` ABC the competition's `main.py`
spawns.

The `arcengine` package isn't available outside the Kaggle container,
so we import it lazily — this module's top-level imports succeed
during local pytest but trying to actually instantiate
`BitterbotARCAgent` requires `arcengine` to be installed.

Mapping conventions (see action_parser.ParsedAction):
    kind 0   -> GameAction.RESET
    kind 1-5 -> GameAction.ACTION1..ACTION5  (simple, directional / contextual)
    kind 6   -> GameAction.ACTION6  (complex, requires x/y)
    kind 7   -> GameAction.ACTION7  (simple, undo)

For complex actions we also call `.set_data({"x":..., "y":...})` and
attach the parsed scratchpad to `.reasoning` so the scorecard shows
the model's intent.
"""

from __future__ import annotations

import logging
import time
from pathlib import Path
from typing import TYPE_CHECKING, Any

import numpy as np

from .agent import BitterbotAgent
from .embedder import BGEEmbedder, Embedder, HashEmbedder
from .memory import BitterbotMemory

if TYPE_CHECKING:
    # These come from the arcengine package which ships inside the
    # Kaggle competition container only. Importing them under
    # TYPE_CHECKING keeps mypy + IDEs happy without requiring the
    # package locally.
    from arcengine import FrameData, GameAction  # noqa: F401

logger = logging.getLogger(__name__)


class BitterbotARCAgent:
    """Concrete `arcprize/ARC-AGI-3-Agents` `Agent` subclass.

    Wraps `BitterbotAgent` so the framework's `main.py` can run
    `python main.py --agent bitterbot` and have everything wire up.

    Subclasses `Agent` at runtime — we don't subclass at module
    definition time because the parent class lives in
    `arcprize/ARC-AGI-3-Agents` which isn't on `sys.path` until the
    Kaggle entry script vendor-copies it into place. The
    `make_arc_agent_class()` factory below does the actual subclassing.
    """


def make_arc_agent_class(
    *,
    memory_path: str | Path = "/kaggle/working/bitterbot_memory.sqlite",
    embedder_path: str | Path | None = None,
    llm_factory=None,
    record_rules: bool = True,
    candidate_actions: tuple[int, ...] = (1, 2, 3, 4, 5, 6),
):
    """Build the concrete `Agent` subclass at runtime.

    `llm_factory: () -> LlmCallable` lets the caller customize how the
    LLM is reached (default: vLLM via OpenAI-compat endpoint at
    localhost:8000). `embedder_path` is the local path to the BGE
    model dump on the Kaggle container; if None, falls back to the
    deterministic HashEmbedder (useful for the dry-run notebook).

    Returns a class that the framework's swarm can instantiate.
    """
    # Lazy imports so this module is import-safe without arcengine.
    from arcengine import FrameData, GameAction, GameState  # type: ignore
    from agents.agent import Agent  # type: ignore

    if llm_factory is None:
        from .vllm_client import default_vllm_callable

        llm_factory = default_vllm_callable

    def _build_embedder() -> Embedder:
        if embedder_path is not None and Path(embedder_path).exists():
            return BGEEmbedder(model_path=str(embedder_path), device="cuda")
        logger.warning(
            "No BGE embedder available at %s — using HashEmbedder. "
            "Vector retrieval quality will be reduced.",
            embedder_path,
        )
        return HashEmbedder(dim=128)

    def _grid_from_frame(frame: "FrameData") -> np.ndarray:
        """Extract the last grid from a FrameData as a uint8 ndarray.

        A FrameData's `.frame` is a list of 2-D grids (animation
        between actions); the last entry is the final state after
        the action resolved.
        """
        frame_list = getattr(frame, "frame", None) or []
        if not frame_list:
            # First-ever observation before RESET; synthesize empty.
            return np.zeros((64, 64), dtype=np.uint8)
        return np.asarray(frame_list[-1], dtype=np.uint8)

    def _state_name(frame: "FrameData") -> str:
        state = getattr(frame, "state", None)
        return getattr(state, "name", str(state)) if state is not None else "UNKNOWN"

    def _make_game_action(kind: int, x: int | None, y: int | None) -> "GameAction":
        """Map ParsedAction.kind to a GameAction instance."""
        if kind == 0:
            return GameAction.RESET
        # Simple lookup: GameAction.ACTION{n}
        try:
            ga = getattr(GameAction, f"ACTION{kind}")
        except AttributeError:
            logger.warning("Unknown action kind %s, defaulting to ACTION1", kind)
            ga = GameAction.ACTION1
        if hasattr(ga, "is_complex") and ga.is_complex():
            cx = x if x is not None else 32
            cy = y if y is not None else 32
            ga.set_data({"x": cx, "y": cy})
        return ga

    class BitterbotARCAgentImpl(Agent):
        MAX_ACTIONS: int = 80
        AGENT_TAG: str = "bitterbot"

        def __init__(self, *args: Any, **kwargs: Any) -> None:
            super().__init__(*args, **kwargs)
            self._memory = BitterbotMemory(memory_path, embedder=_build_embedder())
            self._llm = llm_factory()
            self._agent = BitterbotAgent(
                self._memory,
                self._llm,
                candidate_actions=candidate_actions,
                record_rules=record_rules,
            )
            self._first_action_done = False
            self._t0 = time.time()
            logger.info(
                "BitterbotARCAgent initialized. game_id=%s card_id=%s",
                getattr(self, "game_id", "?"),
                getattr(self, "card_id", "?"),
            )

        @property
        def name(self) -> str:
            return f"{super().name}.bitterbot"

        def is_done(self, frames: list, latest_frame) -> bool:
            return latest_frame.state is GameState.WIN

        def choose_action(self, frames: list, latest_frame) -> "GameAction":
            # Frame state may be NOT_PLAYED at game start — fire RESET
            # to kick off the session (per the partner template pattern).
            if not self._first_action_done and latest_frame.state in (
                GameState.NOT_PLAYED,
                GameState.GAME_OVER,
            ):
                self._first_action_done = True
                logger.info("Issuing RESET to start game %s", self.game_id)
                action = GameAction.RESET
                action.reasoning = "Bitterbot: initial RESET to kick off session"
                return action

            self._first_action_done = True

            grid = _grid_from_frame(latest_frame)
            state_name = _state_name(latest_frame)
            score = int(getattr(latest_frame, "levels_completed", 0))
            snap = BitterbotAgent.snapshot(grid, state=state_name, score=score)

            try:
                result = self._agent.choose_action(self.game_id, snap)
            except Exception:
                # Don't crash the run — log + fall back to a safe directional move.
                logger.exception("BitterbotAgent.choose_action failed; defaulting to ACTION1")
                ga = GameAction.ACTION1
                ga.reasoning = "Bitterbot: fallback after exception"
                return ga

            parsed = result.parsed
            action = _make_game_action(parsed.kind, parsed.x, parsed.y)
            # Attach the scratchpad for scorecard introspection.
            reasoning_payload: dict[str, Any] = {
                "scratchpad": parsed.scratchpad or "",
                "parsed_via": parsed.parsed_via,
            }
            if parsed.rule_observed:
                reasoning_payload["rule_observed"] = parsed.rule_observed
            if parsed.hypothesis_update:
                reasoning_payload["hypothesis_update"] = parsed.hypothesis_update
            if hasattr(action, "is_simple") and action.is_simple():
                action.reasoning = parsed.scratchpad or "Bitterbot"
            else:
                action.reasoning = reasoning_payload
            return action

        def cleanup(self, *args: Any, **kwargs: Any) -> None:
            try:
                # End-of-episode hormonal signal.
                latest = self.frames[-1] if self.frames else None
                state_name = _state_name(latest) if latest is not None else "UNKNOWN"
                won = state_name == "WIN"
                try:
                    self._agent.on_episode_end(self.game_id, won=won)
                except Exception:
                    logger.exception("on_episode_end failed")
                logger.info(
                    "Bitterbot finished game %s in %.1fs (state=%s, actions=%d)",
                    self.game_id,
                    time.time() - self._t0,
                    state_name,
                    self.action_counter,
                )
            finally:
                try:
                    self._memory.close()
                except Exception:
                    logger.exception("Memory close failed")
                super().cleanup(*args, **kwargs)

    return BitterbotARCAgentImpl
