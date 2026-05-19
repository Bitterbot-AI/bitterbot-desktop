"""CuriosityEngine tests — count-based novelty over (state, action) pairs."""

from __future__ import annotations

import pytest

from bitterbot_memory.curiosity import CuriosityEngine
from bitterbot_memory.store import MemoryStore


def test_unseen_pair_returns_max_novelty(store: MemoryStore) -> None:
    c = CuriosityEngine(store)
    n = c.score_novelty("game-abc", "state-1", 3)
    assert n.novelty == 1.0
    assert n.observed_count == 0


def test_novelty_decreases_with_observation_count(store: MemoryStore) -> None:
    c = CuriosityEngine(store)
    c.log_transition("game-abc", "state-1", 3, "state-2", pixel_delta=5)
    n1 = c.score_novelty("game-abc", "state-1", 3)
    assert n1.observed_count == 1
    assert n1.novelty == pytest.approx(1.0 / (1.0 + 1 * 0.3), abs=1e-6)

    for _ in range(4):
        c.log_transition("game-abc", "state-1", 3, "state-2")
    n5 = c.score_novelty("game-abc", "state-1", 3)
    assert n5.observed_count == 5
    assert n5.novelty == pytest.approx(1.0 / (1.0 + 5 * 0.3), abs=1e-6)
    assert n5.novelty < n1.novelty


def test_novelty_is_per_state_action_pair(store: MemoryStore) -> None:
    """Logging (s1, a3) should not affect novelty of (s1, a4) or (s2, a3)."""
    c = CuriosityEngine(store)
    for _ in range(10):
        c.log_transition("game-abc", "state-1", 3, "state-2")
    # Different action, same state
    assert c.score_novelty("game-abc", "state-1", 4).novelty == 1.0
    # Same action, different state
    assert c.score_novelty("game-abc", "state-other", 3).novelty == 1.0


def test_novelty_cross_game_count_is_shared(store: MemoryStore) -> None:
    """Transitions from another game contribute to novelty — that's
    the whole point of cross-game memory."""
    c = CuriosityEngine(store)
    for _ in range(3):
        c.log_transition("game-A", "state-shared", 1, "state-next")
    # Score for a different game on the same (state, action)
    n = c.score_novelty("game-B", "state-shared", 1)
    assert n.observed_count == 3


def test_transitions_for_game_counts_only_that_game(store: MemoryStore) -> None:
    c = CuriosityEngine(store)
    c.log_transition("game-A", "s1", 1, "s2")
    c.log_transition("game-A", "s2", 2, "s3")
    c.log_transition("game-B", "s1", 1, "s2")
    assert c.transitions_for_game("game-A") == 2
    assert c.transitions_for_game("game-B") == 1
    assert c.transitions_for_game("game-C") == 0


def test_novelty_clamped_to_unit_interval(store: MemoryStore) -> None:
    c = CuriosityEngine(store)
    for _ in range(100):
        c.log_transition("game-abc", "state-1", 3, "state-2")
    n = c.score_novelty("game-abc", "state-1", 3)
    assert 0.0 <= n.novelty <= 1.0
