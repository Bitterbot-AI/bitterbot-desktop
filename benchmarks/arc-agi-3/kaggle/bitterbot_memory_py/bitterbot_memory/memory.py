"""BitterbotMemory facade — single import for the ARC agent.

Wires together the store, knowledge graph, retriever, hormonal state,
curiosity engine, epistemic directives, and rule store. The
`BitterbotAgent.choose_action` loop in Phase 3 will call into this
facade for all per-turn memory operations.

The facade is intentionally a thin coordinator — actual logic lives
in the submodules. Keeping it slim makes the agent easier to test
(swap submodules with fakes) and matches the TS MemoryIndexManager's
role on the TypeScript side.
"""

from __future__ import annotations

from pathlib import Path

from .curiosity import CuriosityEngine, NoveltyScore
from .embedder import Embedder, HashEmbedder
from .epistemic import EpistemicDirectives, Hypothesis
from .hormonal import HormonalEvent, HormonalSnapshot, HormonalState
from .knowledge_graph import KnowledgeGraph
from .retrieval import HybridRetriever, RetrievalHit, ensure_embeddings
from .rules import ArcRule, RuleStore
from .store import MemoryStore, open_store


class BitterbotMemory:
    """All-in-one biological memory bundle for the Kaggle ARC agent."""

    def __init__(
        self,
        store_path: str | Path,
        embedder: Embedder | None = None,
    ) -> None:
        self.store: MemoryStore = open_store(store_path)
        self.embedder: Embedder = embedder or HashEmbedder(dim=128)
        self.kg: KnowledgeGraph = KnowledgeGraph(self.store)
        self.retriever: HybridRetriever = HybridRetriever(self.store, self.embedder)
        self.hormonal: HormonalState = HormonalState(self.store)
        self.curiosity: CuriosityEngine = CuriosityEngine(self.store)
        self.epistemic: EpistemicDirectives = EpistemicDirectives(self.store)
        self.rules: RuleStore = RuleStore(self.store)

    # ── Retrieval / rule lifecycle ────────────────────────────────

    def query(self, text: str, top_k: int = 5) -> list[RetrievalHit]:
        return self.retriever.query(text, top_k=top_k)

    def record_rule(
        self,
        game_id: str,
        rule: str,
        *,
        evidence: str | None = None,
        confidence: float = 0.5,
    ) -> ArcRule:
        r = self.rules.record(game_id, rule, evidence=evidence, confidence=confidence)
        # Refresh embeddings for any newly-created entities so the next
        # query() can find them through the vector channel too.
        ensure_embeddings(self.store, self.embedder)
        return r

    def list_rules(self, game_id: str, limit: int = 100) -> list[ArcRule]:
        return self.rules.list_for_game(game_id, limit=limit)

    # ── Transition logging / novelty ──────────────────────────────

    def log_transition(
        self,
        game_id: str,
        prev_state_hash: str,
        action: int,
        next_state_hash: str,
        pixel_delta: int = 0,
    ) -> None:
        self.curiosity.log_transition(
            game_id, prev_state_hash, action, next_state_hash, pixel_delta
        )

    def score_novelty(self, game_id: str, state_hash: str, action: int) -> NoveltyScore:
        return self.curiosity.score_novelty(game_id, state_hash, action)

    # ── Hypotheses ────────────────────────────────────────────────

    def get_hypothesis(self, game_id: str) -> Hypothesis | None:
        return self.epistemic.get(game_id)

    def update_hypothesis(
        self,
        game_id: str,
        text: str,
        confidence: float,
        *,
        refute: bool = False,
    ) -> Hypothesis:
        return self.epistemic.update(game_id, text, confidence, refute=refute)

    # ── Hormonal state ────────────────────────────────────────────

    def get_hormonal_state(self) -> HormonalSnapshot:
        return self.hormonal.get_state()

    def record_event(self, event: HormonalEvent) -> None:
        self.hormonal.stimulate(event)

    # ── Lifecycle ─────────────────────────────────────────────────

    def close(self) -> None:
        self.store.close()

    def __enter__(self) -> "BitterbotMemory":
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        self.close()
