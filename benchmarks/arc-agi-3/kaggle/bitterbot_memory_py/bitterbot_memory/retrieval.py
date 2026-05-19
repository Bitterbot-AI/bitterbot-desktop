"""Hybrid keyword + vector retrieval with RRF merge.

Mirrors the query semantics of `src/memory/sage-memory.ts`'s SAGE
retrieval: BM25 over text → top-K candidates; vector cosine over
embeddings → top-K candidates; the two rank lists are merged via
Reciprocal Rank Fusion (RRF) with configurable weights.

The implementation is intentionally store-aware: it queries the
`entities` table (entity name + properties JSON as the indexable text)
and the `embeddings` table (BLOB-packed float32 vectors). Embeddings
are populated lazily — call `ensure_embeddings(kg, embedder)` once at
process startup or after a batch of new entities, then `query()` will
include them.
"""

from __future__ import annotations

import re
import struct
import time
from dataclasses import dataclass

import numpy as np
from rank_bm25 import BM25Okapi

from .embedder import Embedder
from .knowledge_graph import Entity, KnowledgeGraph, _row_to_entity
from .store import MemoryStore


# Split on any run of non-alphanumeric chars so "moving-up-clears-row"
# tokenizes to ["moving", "up", "clears", "row"]. Without this, BM25
# would see hyphenated identifiers as single opaque tokens and miss
# every realistic natural-language query.
_TOKEN_RE = re.compile(r"[a-z0-9]+")


def _tokenize(text: str) -> list[str]:
    return _TOKEN_RE.findall(text.lower())


@dataclass
class RetrievalHit:
    entity: Entity
    score: float
    bm25_rank: int | None
    vector_rank: int | None


# ── BLOB <-> ndarray helpers ────────────────────────────────────────


def _pack_vec(v: np.ndarray) -> bytes:
    """Pack a 1-D float32 ndarray to little-endian bytes."""
    v32 = v.astype(np.float32, copy=False)
    return struct.pack(f"<{len(v32)}f", *v32.tolist())


def _unpack_vec(blob: bytes, dim: int) -> np.ndarray:
    return np.array(struct.unpack(f"<{dim}f", blob), dtype=np.float32)


# ── Embedding population ────────────────────────────────────────────


def _entity_indexable_text(e: Entity) -> str:
    """The string we feed to BM25 and the embedder for an entity."""
    parts = [e.name, e.entity_type]
    if e.properties:
        # Property values can be int/float/bool/str/list — coerce to str.
        for k, v in e.properties.items():
            parts.append(f"{k}={v}")
    return " ".join(parts)


def ensure_embeddings(
    store: MemoryStore,
    embedder: Embedder,
    *,
    batch_size: int = 64,
    force: bool = False,
) -> int:
    """Compute + persist embeddings for every entity missing one.

    Returns the number of new embeddings written. Cheap to call
    repeatedly — it skips entities that already have an embedding from
    the same model, unless `force=True`.
    """
    conn = store.conn
    now = int(time.time() * 1000)

    if force:
        rows = conn.execute("SELECT * FROM entities").fetchall()
    else:
        rows = conn.execute(
            "SELECT e.* FROM entities e"
            " LEFT JOIN embeddings emb"
            "   ON emb.entity_id = e.id AND emb.model = ?"
            " WHERE emb.entity_id IS NULL",
            (embedder.model_name,),
        ).fetchall()

    if not rows:
        return 0

    entities = [_row_to_entity(r) for r in rows]
    written = 0
    for i in range(0, len(entities), batch_size):
        chunk = entities[i : i + batch_size]
        texts = [_entity_indexable_text(e) for e in chunk]
        vecs = embedder.encode(texts)
        # Validate the embedder isn't lying about its dim
        if vecs.shape[1] != embedder.dim:
            raise ValueError(
                f"Embedder {embedder.model_name} reports dim={embedder.dim}"
                f" but produced vectors of shape {vecs.shape}"
            )
        for entity, vec in zip(chunk, vecs):
            conn.execute(
                "INSERT OR REPLACE INTO embeddings (entity_id, vector, dim, model, created_at)"
                " VALUES (?, ?, ?, ?, ?)",
                (entity.id, _pack_vec(vec), int(vec.shape[0]), embedder.model_name, now),
            )
            written += 1
    return written


# ── Hybrid query ────────────────────────────────────────────────────


class HybridRetriever:
    """BM25 + vector retrieval over the entity table, merged via RRF.

    The retriever caches a BM25 index across calls but invalidates it
    when the entity count changes (a cheap proxy for "the corpus
    moved"). For a Kaggle-scale workload (low thousands of entities,
    no concurrent writers) this is plenty fast.
    """

    def __init__(
        self,
        store: MemoryStore,
        embedder: Embedder | None,
        *,
        bm25_weight: float = 0.5,
        vector_weight: float = 0.5,
        rrf_k: int = 60,
    ) -> None:
        self._store = store
        self._embedder = embedder
        self._bm25_weight = bm25_weight
        self._vector_weight = vector_weight
        self._rrf_k = rrf_k
        self._bm25 = None
        self._bm25_entity_ids: list[str] = []
        self._bm25_doc_count = -1  # so the first build always runs

    # ── BM25 index ──────────────────────────────────────────────────

    def _rebuild_bm25(self) -> None:
        conn = self._store.conn
        rows = conn.execute("SELECT * FROM entities").fetchall()
        entities = [_row_to_entity(r) for r in rows]
        self._bm25_entity_ids = [e.id for e in entities]
        if not entities:
            self._bm25 = None
            self._bm25_doc_count = 0
            return
        docs = [_tokenize(_entity_indexable_text(e)) for e in entities]
        self._bm25 = BM25Okapi(docs)
        self._bm25_doc_count = len(entities)

    def _ensure_bm25(self) -> None:
        if self._bm25 is None:
            self._rebuild_bm25()
            return
        # Cheap invalidation: if the entity count moved, rebuild.
        current = self._store.conn.execute(
            "SELECT COUNT(*) AS c FROM entities"
        ).fetchone()["c"]
        if current != self._bm25_doc_count:
            self._rebuild_bm25()

    # ── Vector index ────────────────────────────────────────────────

    def _vector_topk(self, query_vec: np.ndarray, k: int) -> list[tuple[str, float]]:
        rows = self._store.conn.execute(
            "SELECT entity_id, vector, dim FROM embeddings WHERE model = ?",
            (self._embedder.model_name if self._embedder else "",),
        ).fetchall()
        if not rows:
            return []
        vecs = np.stack([_unpack_vec(r["vector"], r["dim"]) for r in rows])
        sims = vecs @ query_vec  # cosine since both sides are L2-normalized
        order = np.argsort(-sims)[:k]
        return [(rows[i]["entity_id"], float(sims[i])) for i in order]

    # ── Main entry ──────────────────────────────────────────────────

    def query(self, text: str, top_k: int = 5) -> list[RetrievalHit]:
        """Return the top-K entities matching `text`.

        Runs BM25 and vector retrieval in parallel (well, sequentially
        — they're cheap), then merges the two rank lists via RRF.

        If no embedder is configured, falls back to BM25-only.
        If no entities have embeddings, falls back to BM25-only.
        """
        self._ensure_bm25()
        if self._bm25 is None:
            return []

        candidates_k = max(top_k * 4, 20)

        # ── BM25 ranks ──
        tokens = _tokenize(text)
        bm25_scores = self._bm25.get_scores(tokens) if tokens else np.zeros(self._bm25_doc_count)
        bm25_order = np.argsort(-bm25_scores)[:candidates_k]
        bm25_rank: dict[str, int] = {}
        for rank, idx in enumerate(bm25_order, start=1):
            if bm25_scores[idx] <= 0:
                # No real hit; don't pollute the rank dict with zero-score docs.
                continue
            bm25_rank[self._bm25_entity_ids[idx]] = rank

        # ── Vector ranks ──
        vector_rank: dict[str, int] = {}
        if self._embedder is not None:
            qvec = self._embedder.encode([text])[0]
            vec_hits = self._vector_topk(qvec, candidates_k)
            for rank, (eid, _score) in enumerate(vec_hits, start=1):
                vector_rank[eid] = rank

        # ── RRF merge ──
        all_ids = set(bm25_rank) | set(vector_rank)
        scored: list[tuple[str, float]] = []
        for eid in all_ids:
            score = 0.0
            if eid in bm25_rank:
                score += self._bm25_weight / (self._rrf_k + bm25_rank[eid])
            if eid in vector_rank:
                score += self._vector_weight / (self._rrf_k + vector_rank[eid])
            scored.append((eid, score))
        scored.sort(key=lambda p: -p[1])

        # ── Hydrate ──
        kg = KnowledgeGraph(self._store)
        hits: list[RetrievalHit] = []
        for eid, sc in scored[:top_k]:
            e = kg.find_entity_by_id(eid)
            if e is None:
                continue
            hits.append(
                RetrievalHit(
                    entity=e,
                    score=sc,
                    bm25_rank=bm25_rank.get(eid),
                    vector_rank=vector_rank.get(eid),
                )
            )
        return hits
