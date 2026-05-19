"""ARC-AGI-3 frame analysis helpers.

Pure-Python utilities for the agent's per-turn observation pipeline.
Mirrors the TS helpers in `benchmarks/arc-agi-3/helpers/`:
- `grid-visualization.ts`  → `grid_to_ascii`
- `grid-analysis.ts`       → `connected_components`, `pixel_diff`, `bounding_box`

Inputs are `numpy.ndarray` of dtype uint8 with values in [0, 15] and
shape (H, W). The ARC server delivers a 64x64 grid in this format
(JSON list-of-lists; the agent converts via `np.asarray(frame, dtype=np.uint8)`).
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass

import numpy as np


# ── 16-color ASCII palette ─────────────────────────────────────────
# Chosen so distinct colors are visually distinct as ASCII glyphs and
# black (0) renders as the lightest character to read as background.
# Matches the TS palette in helpers/grid-visualization.ts.
_GLYPHS = ".#OXoxBb-+=:|/\\@"  # 16 chars
assert len(_GLYPHS) == 16


@dataclass
class FrameSnapshot:
    """An ARC-AGI-3 observation, normalized for memory + prompts.

    Fields are explicit so the agent doesn't depend on the
    `arcengine` types directly — those are only available inside the
    Kaggle container. The `arc_adapter` module bridges arcengine
    FrameData into this dataclass.
    """

    grid: np.ndarray
    """(H, W) uint8 array of color values 0..15."""
    state: str
    """One of NOT_STARTED, NOT_FINISHED, WIN, GAME_OVER."""
    score: int
    """Cumulative actions consumed so far (or whatever the API reports)."""
    state_hash: str
    """SHA1 of the grid bytes (first 16 chars), used as a memory key."""


# ── Hash + ASCII ───────────────────────────────────────────────────


def hash_grid(grid: np.ndarray) -> str:
    """Stable 16-char hex hash of the grid bytes. Used as state key."""
    return hashlib.sha1(grid.tobytes()).hexdigest()[:16]


def grid_to_ascii(grid: np.ndarray) -> str:
    """Render the grid as ASCII art. One glyph per cell, rows newline-separated.

    A 64x64 grid produces a (64*65)=4160-character string. With three
    frames in context this is ~3k tokens — significant but manageable
    inside an 8k window.
    """
    if grid.ndim != 2:
        raise ValueError(f"expected 2-D grid, got shape {grid.shape}")
    lines = []
    for row in grid:
        lines.append("".join(_GLYPHS[int(v) & 0x0F] for v in row))
    return "\n".join(lines)


# ── Diff ───────────────────────────────────────────────────────────


def pixel_diff(prev: np.ndarray, curr: np.ndarray) -> int:
    """Count cells that changed between two same-shape grids."""
    if prev.shape != curr.shape:
        raise ValueError(f"shape mismatch {prev.shape} vs {curr.shape}")
    return int(np.count_nonzero(prev != curr))


@dataclass
class DiffRegion:
    min_row: int
    max_row: int
    min_col: int
    max_col: int
    changed_cells: int


def diff_region(prev: np.ndarray, curr: np.ndarray) -> DiffRegion | None:
    """Return the bounding box of changed cells (None if no change)."""
    if prev.shape != curr.shape:
        raise ValueError(f"shape mismatch {prev.shape} vs {curr.shape}")
    mask = prev != curr
    if not mask.any():
        return None
    rows = np.where(mask.any(axis=1))[0]
    cols = np.where(mask.any(axis=0))[0]
    return DiffRegion(
        min_row=int(rows[0]),
        max_row=int(rows[-1]),
        min_col=int(cols[0]),
        max_col=int(cols[-1]),
        changed_cells=int(mask.sum()),
    )


# ── Connected components ───────────────────────────────────────────


@dataclass
class Component:
    color: int
    cells: list[tuple[int, int]]
    """List of (row, col) coordinates."""
    centroid: tuple[float, float]
    bounding_box: tuple[int, int, int, int]
    """(min_row, max_row, min_col, max_col)."""


def connected_components(
    grid: np.ndarray,
    *,
    background: int | None = None,
    min_size: int = 1,
    connectivity: int = 4,
) -> list[Component]:
    """4-connected flood-fill grouping of same-color pixels.

    If `background` is None, defaults to the most-frequent color
    (which is what the partner template assumes). Components smaller
    than `min_size` are dropped.
    """
    if grid.ndim != 2:
        raise ValueError(f"expected 2-D grid, got shape {grid.shape}")
    h, w = grid.shape

    if background is None:
        flat = grid.flatten()
        background = int(np.bincount(flat, minlength=16).argmax())

    if connectivity == 4:
        neighbors = [(-1, 0), (1, 0), (0, -1), (0, 1)]
    elif connectivity == 8:
        neighbors = [(-1, -1), (-1, 0), (-1, 1), (0, -1), (0, 1), (1, -1), (1, 0), (1, 1)]
    else:
        raise ValueError(f"connectivity must be 4 or 8, got {connectivity}")

    visited = np.zeros_like(grid, dtype=bool)
    components: list[Component] = []
    for r in range(h):
        for c in range(w):
            if visited[r, c] or int(grid[r, c]) == background:
                continue
            color = int(grid[r, c])
            stack = [(r, c)]
            cells: list[tuple[int, int]] = []
            while stack:
                cr, cc = stack.pop()
                if visited[cr, cc]:
                    continue
                if int(grid[cr, cc]) != color:
                    continue
                visited[cr, cc] = True
                cells.append((cr, cc))
                for dr, dc in neighbors:
                    nr, nc = cr + dr, cc + dc
                    if 0 <= nr < h and 0 <= nc < w and not visited[nr, nc]:
                        if int(grid[nr, nc]) == color:
                            stack.append((nr, nc))
            if len(cells) < min_size:
                continue
            rs = [p[0] for p in cells]
            cs = [p[1] for p in cells]
            components.append(
                Component(
                    color=color,
                    cells=cells,
                    centroid=(sum(rs) / len(rs), sum(cs) / len(cs)),
                    bounding_box=(min(rs), max(rs), min(cs), max(cs)),
                )
            )
    return components


# ── Color histogram ────────────────────────────────────────────────


def color_histogram(grid: np.ndarray) -> dict[int, int]:
    """Return {color: count} for every color present in the grid."""
    flat = grid.flatten()
    counts = np.bincount(flat, minlength=16)
    return {int(c): int(counts[c]) for c in range(16) if counts[c] > 0}
