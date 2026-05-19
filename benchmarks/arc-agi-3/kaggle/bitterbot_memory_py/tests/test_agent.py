"""BitterbotAgent integration tests with a stub LLM."""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest

from bitterbot_memory import BitterbotMemory
from bitterbot_memory.agent import BitterbotAgent
from bitterbot_memory.embedder import HashEmbedder


@pytest.fixture()
def mem(tmp_path: Path) -> BitterbotMemory:
    m = BitterbotMemory(tmp_path / "memory.sqlite", embedder=HashEmbedder(dim=32))
    try:
        yield m
    finally:
        m.close()


def _make_grid(seed: int) -> np.ndarray:
    """Deterministic small grid for tests."""
    rng = np.random.RandomState(seed)
    return rng.randint(0, 16, size=(8, 8), dtype=np.uint8)


def test_choose_action_returns_parsed_kind(mem: BitterbotMemory) -> None:
    def stub_llm(_system: str, _user: str) -> str:
        return "<scratchpad>moving right looks new</scratchpad>\n<action>ACTION4</action>"

    agent = BitterbotAgent(mem, stub_llm)
    frame = BitterbotAgent.snapshot(_make_grid(1), state="NOT_FINISHED", score=0)
    result = agent.choose_action("game-1", frame)
    assert result.parsed.kind == 4


def test_choose_action_logs_transition_after_first_turn(mem: BitterbotMemory) -> None:
    responses = iter(["<action>ACTION4</action>", "<action>ACTION3</action>"])
    agent = BitterbotAgent(mem, lambda _s, _u: next(responses))
    f1 = BitterbotAgent.snapshot(_make_grid(1), "NOT_FINISHED", 0)
    f2 = BitterbotAgent.snapshot(_make_grid(2), "NOT_FINISHED", 1)
    agent.choose_action("g", f1)
    assert mem.curiosity.transitions_for_game("g") == 0  # no prior state yet
    agent.choose_action("g", f2)
    assert mem.curiosity.transitions_for_game("g") == 1


def test_choose_action_records_rule_when_emitted(mem: BitterbotMemory) -> None:
    def stub_llm(_s: str, _u: str) -> str:
        return (
            "<action>ACTION3</action>"
            "<rule_observed>ACTION3 moves the cursor up</rule_observed>"
        )

    agent = BitterbotAgent(mem, stub_llm)
    f = BitterbotAgent.snapshot(_make_grid(1), "NOT_FINISHED", 0)
    agent.choose_action("g", f)
    rules = mem.list_rules("g")
    assert any("action3 moves the cursor up" in r.rule for r in rules)


def test_choose_action_updates_hypothesis_when_emitted(mem: BitterbotMemory) -> None:
    def stub_llm(_s: str, _u: str) -> str:
        return (
            "<action>ACTION1</action>"
            "<hypothesis_update>Goal is to align blocks to the top row</hypothesis_update>"
        )

    agent = BitterbotAgent(mem, stub_llm)
    f = BitterbotAgent.snapshot(_make_grid(1), "NOT_FINISHED", 0)
    agent.choose_action("g", f)
    h = mem.get_hypothesis("g")
    assert h is not None
    assert "align blocks" in h.text


def test_on_episode_end_records_event_and_resets_buffer(mem: BitterbotMemory) -> None:
    def stub_llm(_s: str, _u: str) -> str:
        return "<action>ACTION2</action>"

    agent = BitterbotAgent(mem, stub_llm)
    f = BitterbotAgent.snapshot(_make_grid(1), "NOT_FINISHED", 0)
    agent.choose_action("g", f)
    initial_dopamine = mem.get_hormonal_state().dopamine
    agent.on_episode_end("g", won=True)
    after = mem.get_hormonal_state().dopamine
    assert after > initial_dopamine  # achievement bump
    # Buffer cleared
    assert agent._pending_action is None
    assert len(agent._recent) == 0


def test_on_episode_end_refutes_hypothesis_on_loss(mem: BitterbotMemory) -> None:
    """GAME_OVER should mark the current hypothesis as refuted."""
    mem.update_hypothesis("g", "guess that turned out wrong", confidence=0.8)
    agent = BitterbotAgent(mem, lambda _s, _u: "<action>ACTION1</action>")
    agent.on_episode_end("g", won=False)
    h = mem.get_hypothesis("g")
    assert h is not None
    assert h.refutation_count == 1


def test_pixel_delta_triggers_curiosity_event(mem: BitterbotMemory) -> None:
    """A frame-changing action should fire curiosity_high (raises dopamine)."""
    responses = iter(["<action>ACTION4</action>", "<action>ACTION3</action>"])
    agent = BitterbotAgent(mem, lambda _s, _u: next(responses))
    f1 = BitterbotAgent.snapshot(_make_grid(1), "NOT_FINISHED", 0)
    f2 = BitterbotAgent.snapshot(_make_grid(2), "NOT_FINISHED", 1)  # different grid
    agent.choose_action("g", f1)
    pre = mem.get_hormonal_state().dopamine
    agent.choose_action("g", f2)
    post = mem.get_hormonal_state().dopamine
    assert post > pre
