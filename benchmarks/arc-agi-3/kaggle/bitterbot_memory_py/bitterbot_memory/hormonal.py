"""Hormonal state manager — Python port.

Mirrors `src/memory/hormonal.ts`'s `HormonalStateManager` with the
same exponential-decay-toward-homeostasis formula and the same
EVENT_SPIKES table for each `HormonalEvent` kind.

Persists the current state to the `hormonal_state` table on every
mutation so the ARC agent's hormonal state survives a process
restart (irrelevant on Kaggle where the agent runs once, but useful
for offline replay).

Subset of TS behavior intentionally NOT ported:
- Emotional anchors (`EmotionalAnchor`, auto-anchor on strong events)
- State trajectory history snapshots
- Network cortisol override (management-node spike)
These are out of scope for the Kaggle ARC agent.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Literal

from .store import MemoryStore


HormonalEvent = Literal[
    "reward",
    "error",
    "social",
    "achievement",
    "urgency",
    "curiosity_high",
    "curiosity_progress",
    "curiosity_aligned",
    "curiosity_stagnant",
    "curiosity_bonding",
    "marketplace_sale",
    "recall_positive",
    "recall_negative",
    "recall_relational",
]


# Half-lives in milliseconds. Match the TS DEFAULT_*_HALFLIFE constants.
DOPAMINE_HALFLIFE_MS = 30 * 60_000
CORTISOL_HALFLIFE_MS = 60 * 60_000
OXYTOCIN_HALFLIFE_MS = 45 * 60_000

# Resting baseline the hormones decay toward (instead of zero).
# Matches DEFAULT_HOMEOSTASIS in the TS side.
DEFAULT_HOMEOSTASIS = {
    "dopamine": 0.15,
    "cortisol": 0.02,
    "oxytocin": 0.20,
}


# Per-event spike magnitudes — mirror of TS EVENT_SPIKES.
EVENT_SPIKES: dict[HormonalEvent, dict[str, float]] = {
    "reward": {"dopamine": 0.30, "cortisol": 0.00, "oxytocin": 0.00},
    "error": {"dopamine": 0.00, "cortisol": 0.30, "oxytocin": 0.00},
    "social": {"dopamine": 0.00, "cortisol": 0.00, "oxytocin": 0.30},
    "achievement": {"dopamine": 0.40, "cortisol": 0.00, "oxytocin": 0.20},
    "urgency": {"dopamine": 0.00, "cortisol": 0.40, "oxytocin": 0.00},
    "curiosity_high": {"dopamine": 0.25, "cortisol": 0.00, "oxytocin": 0.00},
    "curiosity_progress": {"dopamine": 0.20, "cortisol": 0.00, "oxytocin": 0.00},
    "curiosity_aligned": {"dopamine": 0.10, "cortisol": 0.00, "oxytocin": 0.00},
    "curiosity_stagnant": {"dopamine": 0.00, "cortisol": 0.15, "oxytocin": 0.00},
    "curiosity_bonding": {"dopamine": 0.10, "cortisol": 0.00, "oxytocin": 0.25},
    "marketplace_sale": {"dopamine": 0.15, "cortisol": 0.00, "oxytocin": 0.05},
    "recall_positive": {"dopamine": 0.05, "cortisol": 0.00, "oxytocin": 0.00},
    "recall_negative": {"dopamine": 0.00, "cortisol": 0.05, "oxytocin": 0.00},
    "recall_relational": {"dopamine": 0.00, "cortisol": 0.00, "oxytocin": 0.05},
}


@dataclass
class HormonalSnapshot:
    """Immutable view of the hormonal state at a moment in time."""

    dopamine: float
    cortisol: float
    oxytocin: float
    updated_at: int


def _now_ms() -> int:
    return int(time.time() * 1000)


class HormonalState:
    """Tri-axis hormonal model with exponential decay to homeostasis.

    Reads + writes the singleton row in the `hormonal_state` table on
    every mutation. The TS side keeps state in-memory and persists
    separately; for the Kaggle agent SQLite is simpler.
    """

    def __init__(
        self,
        store: MemoryStore,
        *,
        homeostasis: dict[str, float] | None = None,
        dopamine_halflife_ms: int = DOPAMINE_HALFLIFE_MS,
        cortisol_halflife_ms: int = CORTISOL_HALFLIFE_MS,
        oxytocin_halflife_ms: int = OXYTOCIN_HALFLIFE_MS,
    ) -> None:
        self._store = store
        self._homeostasis = homeostasis or dict(DEFAULT_HOMEOSTASIS)
        self._dop_hl = dopamine_halflife_ms
        self._cor_hl = cortisol_halflife_ms
        self._oxy_hl = oxytocin_halflife_ms
        self._load_or_init()

    # ── Persistence ────────────────────────────────────────────────

    def _load_or_init(self) -> None:
        row = self._store.conn.execute(
            "SELECT dopamine, cortisol, oxytocin, updated_at FROM hormonal_state WHERE id = 1"
        ).fetchone()
        if row is None:
            now = _now_ms()
            self._dopamine = self._homeostasis["dopamine"]
            self._cortisol = self._homeostasis["cortisol"]
            self._oxytocin = self._homeostasis["oxytocin"]
            self._updated_at = now
            self._persist()
        else:
            self._dopamine = row["dopamine"]
            self._cortisol = row["cortisol"]
            self._oxytocin = row["oxytocin"]
            self._updated_at = row["updated_at"]

    def _persist(self) -> None:
        self._store.conn.execute(
            "INSERT OR REPLACE INTO hormonal_state"
            " (id, dopamine, cortisol, oxytocin, updated_at) VALUES (1, ?, ?, ?, ?)",
            (self._dopamine, self._cortisol, self._oxytocin, self._updated_at),
        )

    # ── Decay ──────────────────────────────────────────────────────

    def decay(self, now_ms: int | None = None) -> None:
        """Apply exponential decay toward homeostasis.

        Formula matches TS:
            value = homeostasis + (value - homeostasis) * 0.5^(elapsed/halflife)
        Below 0.001 is clamped to 0 to avoid sticky float noise.

        Always advances `_updated_at` to `now_ms` so that subsequent
        decay calls use the most recent reference point. Going
        backwards in time (negative elapsed) is treated as zero
        elapsed — the snapshot doesn't change, but the reference time
        moves forward. This is critical for tests that supply
        explicit timestamps; in production `now_ms` is always
        monotonic so the branch is dead.
        """
        now = now_ms if now_ms is not None else _now_ms()
        elapsed = now - self._updated_at
        if elapsed <= 0:
            self._updated_at = now
            return
        d_factor = 0.5 ** (elapsed / self._dop_hl)
        c_factor = 0.5 ** (elapsed / self._cor_hl)
        o_factor = 0.5 ** (elapsed / self._oxy_hl)

        h = self._homeostasis
        self._dopamine = h["dopamine"] + (self._dopamine - h["dopamine"]) * d_factor
        self._cortisol = h["cortisol"] + (self._cortisol - h["cortisol"]) * c_factor
        self._oxytocin = h["oxytocin"] + (self._oxytocin - h["oxytocin"]) * o_factor

        if self._dopamine < 0.001:
            self._dopamine = 0.0
        if self._cortisol < 0.001:
            self._cortisol = 0.0
        if self._oxytocin < 0.001:
            self._oxytocin = 0.0
        self._updated_at = now
        self._persist()

    # ── Read / write ───────────────────────────────────────────────

    def get_state(self, now_ms: int | None = None) -> HormonalSnapshot:
        """Decay-on-read so the returned snapshot is current."""
        self.decay(now_ms=now_ms)
        return HormonalSnapshot(
            dopamine=self._dopamine,
            cortisol=self._cortisol,
            oxytocin=self._oxytocin,
            updated_at=self._updated_at,
        )

    def stimulate(self, event: HormonalEvent, now_ms: int | None = None) -> None:
        """Apply the per-event spike, then persist.

        Spikes are additive and clamped to [0, 1] per axis. Decay
        runs first so the spike sits on top of the current state, not
        on top of a stale snapshot.
        """
        self.decay(now_ms=now_ms)
        spike = EVENT_SPIKES[event]
        self._dopamine = min(1.0, self._dopamine + spike["dopamine"])
        self._cortisol = min(1.0, self._cortisol + spike["cortisol"])
        self._oxytocin = min(1.0, self._oxytocin + spike["oxytocin"])
        self._persist()
