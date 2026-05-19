"""EpistemicDirectives tests — per-game hypothesis tracking."""

from __future__ import annotations

import pytest

from bitterbot_memory.epistemic import EpistemicDirectives
from bitterbot_memory.store import MemoryStore


def test_get_returns_none_for_new_game(store: MemoryStore) -> None:
    ep = EpistemicDirectives(store)
    assert ep.get("game-abc") is None


def test_update_creates_then_returns(store: MemoryStore) -> None:
    ep = EpistemicDirectives(store)
    h = ep.update("game-abc", "Move blocks to clear rows", confidence=0.6)
    assert h.text == "Move blocks to clear rows"
    assert h.confidence == pytest.approx(0.6)
    assert h.refutation_count == 0
    got = ep.get("game-abc")
    assert got is not None and got.text == h.text


def test_update_overwrites_text_and_confidence(store: MemoryStore) -> None:
    ep = EpistemicDirectives(store)
    ep.update("g", "first guess", confidence=0.3)
    h = ep.update("g", "second guess", confidence=0.7)
    assert h.text == "second guess"
    assert h.confidence == pytest.approx(0.7)
    assert h.refutation_count == 0


def test_refute_increments_count_and_docks_confidence(store: MemoryStore) -> None:
    ep = EpistemicDirectives(store)
    ep.update("g", "guess", confidence=0.8)
    h = ep.update("g", "refined guess", confidence=0.7, refute=True)
    assert h.refutation_count == 1
    # 0.7 supplied minus 0.2 penalty = 0.5
    assert h.confidence == pytest.approx(0.5, abs=1e-6)


def test_refute_clamps_confidence_at_zero(store: MemoryStore) -> None:
    ep = EpistemicDirectives(store)
    h = ep.update("g", "guess", confidence=0.1, refute=True)
    # 0.1 - 0.2 = -0.1 → clamped to 0
    assert h.confidence == 0.0
    assert h.refutation_count == 1


def test_refute_accumulates_across_calls(store: MemoryStore) -> None:
    ep = EpistemicDirectives(store)
    ep.update("g", "g1", confidence=0.9)
    ep.update("g", "g2", confidence=0.5, refute=True)
    h = ep.update("g", "g3", confidence=0.5, refute=True)
    assert h.refutation_count == 2


def test_confidence_clamped_to_unit_interval(store: MemoryStore) -> None:
    ep = EpistemicDirectives(store)
    h = ep.update("g", "guess", confidence=2.5)
    assert h.confidence == 1.0
    h2 = ep.update("g", "guess", confidence=-0.5)
    assert h2.confidence == 0.0


def test_separate_games_have_separate_state(store: MemoryStore) -> None:
    ep = EpistemicDirectives(store)
    ep.update("game-A", "theory A", confidence=0.5)
    ep.update("game-B", "theory B", confidence=0.6)
    a = ep.get("game-A")
    b = ep.get("game-B")
    assert a is not None and b is not None
    assert a.text == "theory A"
    assert b.text == "theory B"
