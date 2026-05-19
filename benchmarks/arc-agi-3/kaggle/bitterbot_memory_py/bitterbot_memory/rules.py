"""ArcRule helpers — semantic upserts on the knowledge graph.

A "rule" is an `arc_rule` entity whose `name` field is the rule text.
Upsert behavior:
- Identical rule text for the same game_id → `mention_count` increments
  (handled by `KnowledgeGraph.upsert_entity` directly).
- `properties` accumulates `{confidence, evidence, last_observed_at}`.
- `evidence` is appended to a list rather than overwritten.

The TS side stores rules with the same shape so DBs are
interchangeable — see `src/memory/knowledge-graph.ts` arc_rule entries
created by `mcp-server/tools/record-rule.ts`.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any

from .knowledge_graph import (
    Entity,
    ExtractedEntity,
    KnowledgeGraph,
    _row_to_entity,
)
from .store import MemoryStore


@dataclass
class ArcRule:
    """Convenience view over an `arc_rule` entity."""

    id: str
    game_id: str
    rule: str
    confidence: float
    evidence: list[str]
    mention_count: int
    last_observed_at: int


def _now_ms() -> int:
    return int(time.time() * 1000)


def _entity_to_rule(e: Entity) -> ArcRule:
    props = e.properties or {}
    evidence_raw = props.get("evidence", [])
    if isinstance(evidence_raw, str):
        evidence = [evidence_raw]
    elif isinstance(evidence_raw, list):
        evidence = [str(x) for x in evidence_raw]
    else:
        evidence = []
    return ArcRule(
        id=e.id,
        game_id=str(props.get("game_id", "")),
        rule=e.name,
        confidence=float(props.get("confidence", 0.5)),
        evidence=evidence,
        mention_count=e.mention_count,
        last_observed_at=int(props.get("last_observed_at", e.last_seen_at)),
    )


class RuleStore:
    """Read + upsert API on top of the knowledge graph for arc_rule entities."""

    def __init__(self, store: MemoryStore) -> None:
        self._store = store
        self._kg = KnowledgeGraph(store)

    def record(
        self,
        game_id: str,
        rule: str,
        *,
        evidence: str | None = None,
        confidence: float = 0.5,
    ) -> ArcRule:
        """Upsert a rule. Reinforces an existing rule via mention_count
        and appends `evidence` (deduplicated)."""
        rule_text = rule.strip()
        if not rule_text:
            raise ValueError("rule text must be non-empty")

        existing = self._kg.find_entity_by_name_type(rule_text, "arc_rule")

        # Compose properties. Game id is required so the rule is
        # discoverable via list(game_id); evidence is a deduped list.
        new_evidence: list[str] = []
        if existing is not None:
            old_evidence = existing.properties.get("evidence", [])
            if isinstance(old_evidence, list):
                new_evidence = [str(x) for x in old_evidence]
            elif isinstance(old_evidence, str):
                new_evidence = [old_evidence]
        if evidence and evidence not in new_evidence:
            new_evidence.append(evidence)

        props: dict[str, Any] = {
            "game_id": game_id,
            "confidence": float(confidence),
            "evidence": new_evidence,
            "last_observed_at": _now_ms(),
        }
        entity = self._kg.upsert_entity(
            ExtractedEntity(name=rule_text, type="arc_rule", properties=props)
        )
        return _entity_to_rule(entity)

    def list_for_game(self, game_id: str, limit: int = 100) -> list[ArcRule]:
        """Return all arc_rule entities whose properties.game_id matches.

        Uses a direct SQL filter on the JSON-encoded properties for
        speed; for very large rule sets this could grow, but our
        per-agent rule count is bounded by competition turn count.
        """
        rows = self._store.conn.execute(
            "SELECT * FROM entities WHERE entity_type = 'arc_rule'"
            "   AND properties LIKE ?"
            " ORDER BY mention_count DESC, last_seen_at DESC LIMIT ?",
            (f'%"game_id": "{game_id}"%', limit),
        ).fetchall()
        return [_entity_to_rule(_row_to_entity(r)) for r in rows]
