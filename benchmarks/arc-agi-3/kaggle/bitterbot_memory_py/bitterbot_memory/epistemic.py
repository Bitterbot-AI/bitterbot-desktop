"""Epistemic directives — slim hypothesis tracker.

Per-game hypothesis state (text + confidence + refutation count).
Each call to `update_hypothesis` either creates a new row or updates
the existing one. On `refute=True`, increments `refutation_count` and
optionally degrades confidence by a configurable amount.

This is a substantially trimmed port of `src/memory/epistemic-directives.ts`.
The TS side has a much richer directive engine with priors, prior
belief states, posterior updates, and a separate "active directive"
table. For ARC we just need: "what does the agent currently think the
game's goal is?" plus the ability to mark a guess as refuted when
GAME_OVER fires.
"""

from __future__ import annotations

import time
from dataclasses import dataclass

from .store import MemoryStore


@dataclass
class Hypothesis:
    game_id: str
    text: str
    confidence: float
    refutation_count: int
    updated_at: int


def _now_ms() -> int:
    return int(time.time() * 1000)


class EpistemicDirectives:
    """Per-game hypothesis store backed by the `hypotheses` table."""

    # How much confidence to dock on a refutation (additive penalty,
    # clamped at 0). Matches the conservative-update style the TS side
    # uses for posterior updates.
    REFUTATION_PENALTY: float = 0.2

    def __init__(self, store: MemoryStore) -> None:
        self._store = store

    def get(self, game_id: str) -> Hypothesis | None:
        row = self._store.conn.execute(
            "SELECT * FROM hypotheses WHERE game_id = ?", (game_id,)
        ).fetchone()
        if row is None:
            return None
        return Hypothesis(
            game_id=row["game_id"],
            text=row["text"],
            confidence=row["confidence"],
            refutation_count=row["refutation_count"],
            updated_at=row["updated_at"],
        )

    def update(
        self,
        game_id: str,
        text: str,
        confidence: float,
        *,
        refute: bool = False,
    ) -> Hypothesis:
        """Insert-or-update the hypothesis for `game_id`.

        If `refute=True`:
          - increments `refutation_count`
          - confidence is clamped at `max(0, confidence - REFUTATION_PENALTY)`
          - text is updated to the new text (so the agent can record
            why the previous hypothesis failed)
        Otherwise it's a straight upsert with the supplied confidence.
        """
        now = _now_ms()
        existing = self.get(game_id)
        if existing is None:
            new_refutation_count = 1 if refute else 0
            adj_confidence = max(0.0, min(1.0, confidence))
            if refute:
                adj_confidence = max(0.0, adj_confidence - self.REFUTATION_PENALTY)
            self._store.conn.execute(
                "INSERT INTO hypotheses"
                " (game_id, text, confidence, refutation_count, updated_at)"
                " VALUES (?, ?, ?, ?, ?)",
                (game_id, text, adj_confidence, new_refutation_count, now),
            )
            return Hypothesis(
                game_id=game_id,
                text=text,
                confidence=adj_confidence,
                refutation_count=new_refutation_count,
                updated_at=now,
            )

        new_refutation_count = existing.refutation_count + (1 if refute else 0)
        adj_confidence = max(0.0, min(1.0, confidence))
        if refute:
            adj_confidence = max(0.0, adj_confidence - self.REFUTATION_PENALTY)
        self._store.conn.execute(
            "UPDATE hypotheses"
            " SET text = ?, confidence = ?, refutation_count = ?, updated_at = ?"
            " WHERE game_id = ?",
            (text, adj_confidence, new_refutation_count, now, game_id),
        )
        return Hypothesis(
            game_id=game_id,
            text=text,
            confidence=adj_confidence,
            refutation_count=new_refutation_count,
            updated_at=now,
        )
