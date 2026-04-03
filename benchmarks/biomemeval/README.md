# BioMemEval: Biological Agent Memory Benchmark

**The first benchmark that measures whether an AI agent has a mind, not just a database.**

LongMemEval asks "can you remember facts?" BioMemEval asks "do you have biological memory behaviors?" — reconsolidation, mood-congruent retrieval, open-loop detection, prospective memory, temporal reasoning, and identity continuity.

## Quick Start

```bash
pnpm benchmark:biomemeval
```

Results output to `benchmarks/biomemeval/results/biomemeval-report.json`.

## Test Suites

| Suite | Weight | What It Measures |
|-------|--------|-----------------|
| **Zeigarnik Proactivity** | 20% | Does the agent detect unfinished tasks and surface them without being asked? |
| **Mood-Congruent Retrieval** | 20% | Does retrieval ranking shift based on the agent's current emotional state? |
| **Reconsolidation Accuracy** | 20% | Can recalled memories enter a labile state for time-windowed updates? |
| **Temporal Reasoning** | 15% | Can the knowledge graph answer "who was X in January?" differently from "who is X now?" |
| **Identity Continuity** | 15% | Does the system maintain a coherent self-model and actively identify knowledge gaps? |
| **Prospective Memory** | 10% | Can the agent create "when X happens, do Y" memories and trigger them correctly? |

## Scoring

- **30 scenarios** across 6 suites with partial credit
- Each suite scores 0-100%
- **Composite score** = weighted average across all suites
- JSON report with per-assertion breakdown

## Expected Scores

| System | Zeigarnik | Mood | Reconsolidation | Temporal | Identity | Prospective | **Composite** |
|--------|-----------|------|-----------------|----------|----------|-------------|---------------|
| **Bitterbot** | 100% | 100% | 100% | 100% | 100% | 100% | **100%** |
| Zep/Graphiti | 0% | 0% | 0% | ~80% | 0% | 0% | **~12%** |
| Letta/MemGPT | 0% | 0% | 0% | 0% | ~20% | 0% | **~3%** |
| Mem0 | 0% | 0% | 0% | 0% | 0% | 0% | **0%** |
| Hindsight | 0% | 0% | 0% | ~40% | 0% | 0% | **~6%** |

Zep scores on Temporal Reasoning because it has a temporal knowledge graph. No competitor has reconsolidation, mood-congruent retrieval, Zeigarnik open loops, or prospective memory.

## Why This Benchmark Exists

Existing benchmarks (LongMemEval, LTI-Bench, DMR) measure **retrieval accuracy** — can the system find a fact it stored? This is necessary but not sufficient. A PostgreSQL database with full-text search can score well on retrieval benchmarks.

BioMemEval measures **cognitive behaviors** that emerge from biologically-inspired memory architectures:

- **Reconsolidation** (Nader et al., 2000): Recalled memories become temporarily editable
- **Mood-Congruent Retrieval** (Bower, 1981): Emotional state biases which memories surface
- **Zeigarnik Effect** (Zeigarnik, 1927): Incomplete tasks resist forgetting
- **Prospective Memory** (McDaniel & Einstein, 2007): Event-triggered future recall
- **Temporal Reasoning** (Tulving, 1972): Point-in-time queries about changing relationships
- **Active Inference** (Friston, 2010): The system identifies and acts on its own knowledge gaps

These behaviors require architectural commitments — hormonal systems, reconsolidation engines, dream cycles — that cannot be bolted on after the fact. A system either has them or it doesn't.

## Implementing an Adapter

To benchmark your own memory system, implement the `MemorySystemAdapter` interface in `adapter.ts`:

```typescript
import type { MemorySystemAdapter } from "./adapter.js";

export class MySystemAdapter implements MemorySystemAdapter {
  name = "my-system";
  version = "1.0.0";

  async setup() { /* initialize your system */ }
  async teardown() { /* cleanup */ }

  // Implement each method or return false/0/[] for unsupported features
  async detectOpenLoop(text: string) { return { detected: false }; }
  async markLabile(id: string) { return false; }
  // ... etc
}
```

Methods that return `false`, `0`, or empty arrays will score 0 points — this is expected for features your system doesn't support. The benchmark is designed to measure presence/absence of biological capabilities, not to penalize systems that chose a different architecture.

See `adapters/null.adapter.ts` for a complete baseline reference.

## Design Principles

1. **Deterministic**: No API calls, no network, no randomness. Tests use seeded embeddings and in-memory SQLite.
2. **Fast**: Full suite runs in <5 seconds.
3. **Partial credit**: Each scenario has multiple assertions. Getting 3/5 assertions right scores 60%, not 0%.
4. **Honest**: The benchmark tests real behavioral contracts, not implementation details. If your system genuinely reconsolidates memories through a different mechanism, it will still score.
5. **Open source**: MIT licensed. Fork it, extend it, submit scores.

## Scientific References

- Nader, K., Schafe, G.E., & LeDoux, J.E. (2000). Fear memories require protein synthesis for reconsolidation after retrieval. *Nature*, 406.
- Bower, G.H. (1981). Mood and memory. *American Psychologist*, 36(2).
- Zeigarnik, B. (1927). Das Behalten erledigter und unerledigter Handlungen. *Psychologische Forschung*, 9.
- McDaniel, M.A. & Einstein, G.O. (2007). *Prospective memory: An overview and synthesis*. Sage.
- Tulving, E. (1972). Episodic and semantic memory. In *Organization of Memory*.
- Friston, K. (2010). The free-energy principle: a unified brain theory. *Nature Reviews Neuroscience*, 11(2).
- Damasio, A.R. (1994). *Descartes' Error: Emotion, Reason, and the Human Brain*.
- Ebbinghaus, H. (1885). *Uber das Gedachtnis*.

## Citation

If you use BioMemEval in research, please cite:

```bibtex
@software{biomemeval2026,
  title={BioMemEval: Biological Agent Memory Benchmark},
  author={Gil, Victor Michael},
  year={2026},
  url={https://github.com/Bitterbot-AI/bitterbot-desktop/tree/main/benchmarks/biomemeval}
}
```
