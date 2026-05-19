# bitterbot-memory (Python)

Python port of Bitterbot's biological-memory subsystems. Targets the offline ARC-AGI-3 Kaggle competition container (no internet, H100 80 GB, 9 h wall clock) but is a general-purpose library — install it standalone via `pip install -e .` for any Python project that wants knowledge-graph + SAGE-style retrieval + hormonal-modulated exploration.

This is the **second source of truth** for Bitterbot's biological memory. The TypeScript implementation in `src/memory/` (under the Bitterbot desktop repo) is the primary source; this Python port mirrors the same entity/relation schema, the same retrieval semantics, and the same hormonal homeostasis constants. Behavioral parity is verified by `tests/test_ts_parity.py`, which replays snapshots captured from the TS test suite.

## What's here

| Module               | What it does                                                                                       |
| -------------------- | -------------------------------------------------------------------------------------------------- |
| `store.py`           | SQLite schema + migration runner. Mirrors `src/memory/migrations.ts` entities + relationships DDL. |
| `knowledge_graph.py` | Entity + relation CRUD with upsert-by-(name,type) and `mention_count` reinforcement.               |
| `embedder.py`        | `BGEEmbedder` wrapping `BAAI/bge-small-en-v1.5` via the preinstalled `transformers` package.       |
| `retrieval.py`       | Hybrid BM25 + vector retrieval with RRF merge over knowledge-graph entity texts.                   |
| `hormonal.py`        | `HormonalState` dataclass (`dopamine`, `cortisol`, `oxytocin`) with stimulate / decay.             |
| `curiosity.py`       | GCCRF-style novelty score over `(state_hash, action)` tuples.                                      |
| `epistemic.py`       | Hypothesis state per game (text + confidence + refutation count).                                  |
| `rules.py`           | `ArcRule` entity helpers (upsert with duplicate-text reinforcement).                               |
| `memory.py`          | `BitterbotMemory` facade that ties everything together.                                            |

## Why it exists separately from the TS side

The Kaggle scoring container has no internet, so the TS Bitterbot stack (which can call OpenAI for embeddings) won't work there. The Python port:

- Uses local embedding via `BAAI/bge-small-en-v1.5` (140 MB, runs on CPU or H100 alongside vLLM).
- Has zero external API dependencies.
- Is a single-process companion to the ARC-AGI-3 agent — no separate MCP server boot cost.

See `research/plans/PLAN-19b-ARC-AGI-3-KAGGLE.md` for the full architectural rationale.

## Development

```bash
cd benchmarks/arc-agi-3/kaggle/bitterbot_memory_py
pip install -e ".[test,embedder]"
pytest
```
