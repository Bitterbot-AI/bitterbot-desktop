"""HormonalState tests — exponential decay toward homeostasis."""

from __future__ import annotations

import pytest

from bitterbot_memory.hormonal import (
    DEFAULT_HOMEOSTASIS,
    DOPAMINE_HALFLIFE_MS,
    EVENT_SPIKES,
    HormonalState,
)
from bitterbot_memory.store import MemoryStore


def test_initial_state_matches_homeostasis(store: MemoryStore) -> None:
    h = HormonalState(store)
    s = h.get_state(now_ms=0)
    assert s.dopamine == pytest.approx(DEFAULT_HOMEOSTASIS["dopamine"])
    assert s.cortisol == pytest.approx(DEFAULT_HOMEOSTASIS["cortisol"])
    assert s.oxytocin == pytest.approx(DEFAULT_HOMEOSTASIS["oxytocin"])


def test_stimulate_reward_raises_dopamine(store: MemoryStore) -> None:
    h = HormonalState(store)
    before = h.get_state(now_ms=0).dopamine
    h.stimulate("reward", now_ms=0)
    after = h.get_state(now_ms=0).dopamine
    assert after == pytest.approx(before + EVENT_SPIKES["reward"]["dopamine"], abs=1e-6)


def test_stimulate_error_raises_only_cortisol(store: MemoryStore) -> None:
    h = HormonalState(store)
    h.stimulate("error", now_ms=0)
    s = h.get_state(now_ms=0)
    # Cortisol up, dopamine and oxytocin unchanged
    assert s.cortisol == pytest.approx(DEFAULT_HOMEOSTASIS["cortisol"] + 0.30, abs=1e-6)
    assert s.dopamine == pytest.approx(DEFAULT_HOMEOSTASIS["dopamine"], abs=1e-6)
    assert s.oxytocin == pytest.approx(DEFAULT_HOMEOSTASIS["oxytocin"], abs=1e-6)


def test_stimulate_clamps_at_one(store: MemoryStore) -> None:
    h = HormonalState(store)
    for _ in range(20):
        h.stimulate("urgency", now_ms=0)  # +0.4 cortisol each
    assert h.get_state(now_ms=0).cortisol == pytest.approx(1.0, abs=1e-9)


def test_decay_returns_to_homeostasis_over_many_halflives(store: MemoryStore) -> None:
    h = HormonalState(store)
    h.stimulate("reward", now_ms=0)
    # After 20 dopamine half-lives, value is essentially homeostasis.
    far_future = 20 * DOPAMINE_HALFLIFE_MS
    s = h.get_state(now_ms=far_future)
    assert s.dopamine == pytest.approx(DEFAULT_HOMEOSTASIS["dopamine"], abs=1e-5)


def test_decay_one_halflife_moves_halfway(store: MemoryStore) -> None:
    h = HormonalState(store)
    h.stimulate("reward", now_ms=0)
    spiked = h.get_state(now_ms=0).dopamine
    one_hl = h.get_state(now_ms=DOPAMINE_HALFLIFE_MS).dopamine
    base = DEFAULT_HOMEOSTASIS["dopamine"]
    # After one half-life, (spiked - base) should be halved.
    assert one_hl - base == pytest.approx((spiked - base) / 2.0, abs=1e-6)


def test_decay_below_threshold_clamps_to_zero(store: MemoryStore) -> None:
    """Values < 0.001 round to zero per the TS behavior."""
    # Use a homeostasis of zero so decay actually reaches the threshold
    h = HormonalState(store, homeostasis={"dopamine": 0.0, "cortisol": 0.0, "oxytocin": 0.0})
    h.stimulate("reward", now_ms=0)
    # After 15 dopamine half-lives the residual is ~10^-5 ≪ 0.001
    far = 15 * DOPAMINE_HALFLIFE_MS
    s = h.get_state(now_ms=far)
    assert s.dopamine == 0.0


def test_state_persists_across_reload(store: MemoryStore, tmp_path) -> None:
    """A fresh HormonalState instance reads back the prior snapshot."""
    h1 = HormonalState(store)
    h1.stimulate("achievement", now_ms=100)
    snap1 = h1.get_state(now_ms=100)
    # Construct a new instance over the same store
    h2 = HormonalState(store)
    snap2 = h2.get_state(now_ms=100)
    assert snap2.dopamine == pytest.approx(snap1.dopamine, abs=1e-9)
    assert snap2.cortisol == pytest.approx(snap1.cortisol, abs=1e-9)
    assert snap2.oxytocin == pytest.approx(snap1.oxytocin, abs=1e-9)


def test_event_spikes_table_covers_all_event_names() -> None:
    """Every HormonalEvent literal must have a spike entry."""
    # Pull the literal members programmatically — get_args on Literal.
    from typing import get_args

    from bitterbot_memory.hormonal import HormonalEvent

    declared = set(get_args(HormonalEvent))
    spiked = set(EVENT_SPIKES.keys())
    assert declared == spiked
