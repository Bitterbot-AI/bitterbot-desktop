"""Count-based novelty over observed (state_hash, action) tuples.

Mirrors `mcp-server/tools/novelty.ts`'s `runScoreNovelty` semantics
without the knowledge-graph round-trip: we log every (prev_state,
action, next_state, pixel_delta) tuple into `arc_transitions` and
score novelty as the logistic squash of the observation count.

Formula:
    novelty = 1 / (1 + observed_count * 0.3)

So 0 observations → 1.0 (maximum novelty), 5 obs → ~0.4, 20 obs → ~0.14.

Pixel delta is recorded but doesn't affect the score directly; it's
useful for the agent's prompt ("this action moved 8 cells") and for
later GCCRF-style learning-progress signals if we wire those up.
"""

from __future__ import annotations

import time
from dataclasses import dataclass

from .store import MemoryStore


@dataclass
class NoveltyScore:
    novelty: float
    observed_count: int


def _now_ms() -> int:
    return int(time.time() * 1000)


class CuriosityEngine:
    """Logs ARC state transitions and scores novelty for prospective
    `(state, action)` pairs from the agent's per-turn loop."""

    def __init__(self, store: MemoryStore) -> None:
        self._store = store

    def log_transition(
        self,
        game_id: str,
        prev_state_hash: str,
        action: int,
        next_state_hash: str,
        pixel_delta: int = 0,
    ) -> None:
        """Append a transition row. Called after every agent action."""
        self._store.conn.execute(
            "INSERT INTO arc_transitions"
            " (game_id, prev_state_hash, action, next_state_hash, pixel_delta, observed_at)"
            " VALUES (?, ?, ?, ?, ?, ?)",
            (game_id, prev_state_hash, action, next_state_hash, pixel_delta, _now_ms()),
        )

    def score_novelty(
        self,
        game_id: str,
        state_hash: str,
        action: int,
    ) -> NoveltyScore:
        """Return 0..1 novelty for the prospective (state, action) pair.

        Considers transitions across all games the agent has played —
        cross-game novelty discounting is the whole point of biological
        memory on this benchmark. `game_id` is currently unused but kept
        in the signature so we can scope later if needed.
        """
        _ = game_id
        row = self._store.conn.execute(
            "SELECT COUNT(*) AS c FROM arc_transitions"
            " WHERE prev_state_hash = ? AND action = ?",
            (state_hash, action),
        ).fetchone()
        observed = int(row["c"])
        novelty = max(0.0, min(1.0, 1.0 / (1.0 + observed * 0.3)))
        return NoveltyScore(novelty=novelty, observed_count=observed)

    def transitions_for_game(self, game_id: str) -> int:
        """Total transitions logged for a game (debugging / dashboards)."""
        row = self._store.conn.execute(
            "SELECT COUNT(*) AS c FROM arc_transitions WHERE game_id = ?", (game_id,)
        ).fetchone()
        return int(row["c"])
