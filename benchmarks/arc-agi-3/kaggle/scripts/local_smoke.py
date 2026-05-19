"""Local smoke test for the BitterbotAgent.

Drives the agent through N synthetic turns against a stub LLM,
exercising the full memory pipeline (transition logging, rule
recording, hypothesis updates, hormonal modulation, novelty scoring).
This is what you run before paying for a Kaggle scoring slot to
verify the agent doesn't deadlock on a real frame distribution.

Usage:
    python benchmarks/arc-agi-3/kaggle/scripts/local_smoke.py \
        --turns 20 [--llm vllm|stub] [--memory-db /tmp/mem.sqlite]
"""

from __future__ import annotations

import argparse
import logging
import sys
from pathlib import Path

import numpy as np

# Make the in-tree package importable without installing.
_PKG_ROOT = Path(__file__).resolve().parent.parent / "bitterbot_memory_py"
sys.path.insert(0, str(_PKG_ROOT))

from bitterbot_memory import BitterbotMemory  # noqa: E402
from bitterbot_memory.agent import BitterbotAgent  # noqa: E402
from bitterbot_memory.embedder import HashEmbedder  # noqa: E402

logging.basicConfig(level=logging.INFO, format="[%(levelname)s] %(message)s")
logger = logging.getLogger("smoke")


def stub_llm(_system: str, _user: str) -> str:
    """Deterministic stub that cycles through ACTION1..5 and records a rule on turn 0."""
    if not hasattr(stub_llm, "_turn"):
        stub_llm._turn = 0  # type: ignore[attr-defined]
    stub_llm._turn += 1  # type: ignore[attr-defined]
    kind = ((stub_llm._turn - 1) % 5) + 1  # type: ignore[attr-defined]
    extras = ""
    if stub_llm._turn == 1:  # type: ignore[attr-defined]
        extras = (
            "<rule_observed>ACTION1 moves the cursor up by one cell</rule_observed>"
            "<hypothesis_update>Goal is to navigate the cursor to the green target</hypothesis_update>"
        )
    return (
        f"<scratchpad>turn {stub_llm._turn} — trying ACTION{kind}</scratchpad>"  # type: ignore[attr-defined]
        f"<action>ACTION{kind}</action>{extras}"
    )


def make_random_grid(seed: int) -> np.ndarray:
    rng = np.random.RandomState(seed)
    return rng.randint(0, 16, size=(64, 64), dtype=np.uint8)


def run(turns: int, llm_choice: str, memory_db: Path) -> None:
    llm_callable = stub_llm
    if llm_choice == "vllm":
        from bitterbot_memory.vllm_client import VLLMClient

        llm_callable = VLLMClient()

    if memory_db.exists():
        memory_db.unlink()
    mem = BitterbotMemory(memory_db, embedder=HashEmbedder(dim=128))
    agent = BitterbotAgent(mem, llm_callable)

    game_id = "smoke-game-01"
    logger.info("Starting %d-turn smoke against game_id=%s", turns, game_id)
    for t in range(turns):
        frame = BitterbotAgent.snapshot(make_random_grid(t), "NOT_FINISHED", score=t)
        result = agent.choose_action(game_id, frame)
        logger.info(
            "T%02d: kind=%d via=%s rule=%s",
            t,
            result.parsed.kind,
            result.parsed.parsed_via,
            (result.parsed.rule_observed or "")[:60],
        )
    agent.on_episode_end(game_id, won=True)

    logger.info("--- post-run summary ---")
    rules = mem.list_rules(game_id)
    logger.info("rules learned: %d", len(rules))
    for r in rules[:5]:
        logger.info("  conf=%.2f seen=%dx %s", r.confidence, r.mention_count, r.rule[:80])
    hyp = mem.get_hypothesis(game_id)
    if hyp is not None:
        logger.info("hypothesis: %s (confidence=%.2f)", hyp.text, hyp.confidence)
    hs = mem.get_hormonal_state()
    logger.info(
        "hormonal: dopamine=%.2f cortisol=%.2f oxytocin=%.2f",
        hs.dopamine,
        hs.cortisol,
        hs.oxytocin,
    )
    logger.info("transitions logged: %d", mem.curiosity.transitions_for_game(game_id))
    mem.close()


def main() -> None:
    p = argparse.ArgumentParser(description="Local Bitterbot ARC agent smoke")
    p.add_argument("--turns", type=int, default=20, help="how many synthetic turns to drive")
    p.add_argument(
        "--llm",
        choices=("stub", "vllm"),
        default="stub",
        help="stub (default, deterministic) or vllm (requires local vllm at localhost:8000)",
    )
    p.add_argument(
        "--memory-db",
        type=Path,
        default=Path("/tmp/bitterbot_smoke_memory.sqlite"),
        help="path to the SQLite memory store (deleted at start)",
    )
    args = p.parse_args()
    run(args.turns, args.llm, args.memory_db)


if __name__ == "__main__":
    main()
