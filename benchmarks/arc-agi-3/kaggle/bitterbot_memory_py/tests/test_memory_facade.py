"""Smoke test the BitterbotMemory facade — every public method routes
to the right submodule and the wiring stays intact under realistic
per-turn agent traffic."""

from __future__ import annotations

from pathlib import Path

import pytest

from bitterbot_memory import BitterbotMemory
from bitterbot_memory.embedder import HashEmbedder


@pytest.fixture()
def mem(tmp_path: Path) -> BitterbotMemory:
    m = BitterbotMemory(tmp_path / "memory.sqlite", embedder=HashEmbedder(dim=64))
    try:
        yield m
    finally:
        m.close()


def test_facade_smoke_full_turn(mem: BitterbotMemory) -> None:
    """Simulate one agent turn end-to-end through the facade."""
    # 1. Start of game — no hypothesis yet
    assert mem.get_hypothesis("game-1") is None

    # 2. Record a rule observed on a prior level
    mem.record_rule("game-1", "ACTION3 always moves up", evidence="frame_005", confidence=0.8)

    # 3. Query memory for a strategy hint
    hits = mem.query("move up rule", top_k=3)
    assert any("action3" in h.entity.name for h in hits)

    # 4. Log a transition and re-score novelty
    mem.log_transition("game-1", "state-A", action=3, next_state_hash="state-B", pixel_delta=5)
    n = mem.score_novelty("game-1", "state-A", action=3)
    assert n.observed_count == 1

    # 5. Update hypothesis
    h = mem.update_hypothesis("game-1", "Goal is to clear the top row", confidence=0.6)
    assert h.text == "Goal is to clear the top row"

    # 6. Record an event for hormonal modulation
    initial = mem.get_hormonal_state()
    mem.record_event("achievement")
    after = mem.get_hormonal_state()
    assert after.dopamine > initial.dopamine

    # 7. List rules confirms persistence
    rules = mem.list_rules("game-1")
    assert any("action3" in r.rule for r in rules)
