"""Frame analysis helpers — ASCII, hash, diff, connected components."""

from __future__ import annotations

import numpy as np

from bitterbot_memory.frame import (
    color_histogram,
    connected_components,
    diff_region,
    grid_to_ascii,
    hash_grid,
    pixel_diff,
)


def test_hash_grid_is_stable_and_unique() -> None:
    a = np.array([[0, 1], [2, 3]], dtype=np.uint8)
    b = np.array([[0, 1], [2, 3]], dtype=np.uint8)
    c = np.array([[0, 1], [2, 4]], dtype=np.uint8)
    assert hash_grid(a) == hash_grid(b)
    assert hash_grid(a) != hash_grid(c)
    assert len(hash_grid(a)) == 16


def test_grid_to_ascii_dimensions() -> None:
    g = np.zeros((4, 5), dtype=np.uint8)
    s = grid_to_ascii(g)
    rows = s.split("\n")
    assert len(rows) == 4
    assert all(len(r) == 5 for r in rows)


def test_grid_to_ascii_distinct_glyphs_per_value() -> None:
    g = np.array([[0, 1, 2], [3, 4, 5]], dtype=np.uint8)
    s = grid_to_ascii(g)
    # All six glyphs should be different
    assert len(set(s.replace("\n", ""))) == 6


def test_pixel_diff_zero_when_identical() -> None:
    g = np.ones((8, 8), dtype=np.uint8)
    assert pixel_diff(g, g) == 0


def test_pixel_diff_counts_changes() -> None:
    a = np.zeros((4, 4), dtype=np.uint8)
    b = a.copy()
    b[0, 0] = 1
    b[3, 3] = 5
    assert pixel_diff(a, b) == 2


def test_diff_region_none_when_identical() -> None:
    g = np.zeros((8, 8), dtype=np.uint8)
    assert diff_region(g, g) is None


def test_diff_region_bounding_box() -> None:
    a = np.zeros((8, 8), dtype=np.uint8)
    b = a.copy()
    b[2:5, 3:7] = 4  # 3x4 block
    region = diff_region(a, b)
    assert region is not None
    assert region.min_row == 2 and region.max_row == 4
    assert region.min_col == 3 and region.max_col == 6
    assert region.changed_cells == 12


def test_color_histogram_counts() -> None:
    g = np.array([[0, 0, 1], [2, 2, 2]], dtype=np.uint8)
    h = color_histogram(g)
    assert h == {0: 2, 1: 1, 2: 3}


def test_connected_components_basic() -> None:
    # Two 3-cell horizontal bars on a background of 0.
    g = np.zeros((6, 6), dtype=np.uint8)
    g[1, 1:4] = 1
    g[4, 1:4] = 1
    comps = connected_components(g)
    assert len(comps) == 2
    assert all(c.color == 1 for c in comps)
    assert all(len(c.cells) == 3 for c in comps)


def test_connected_components_distinguishes_colors() -> None:
    g = np.zeros((4, 4), dtype=np.uint8)
    g[0, 0] = 1
    g[0, 1] = 2  # adjacent but different color → separate components
    comps = connected_components(g)
    assert len(comps) == 2


def test_connected_components_diagonal_only_with_8_connectivity() -> None:
    g = np.zeros((3, 3), dtype=np.uint8)
    g[0, 0] = 1
    g[1, 1] = 1
    g[2, 2] = 1
    # 4-connectivity → 3 separate components
    assert len(connected_components(g, connectivity=4)) == 3
    # 8-connectivity → 1 component
    eight = connected_components(g, connectivity=8)
    assert len(eight) == 1
    assert len(eight[0].cells) == 3


def test_connected_components_skips_background() -> None:
    g = np.array([[0, 0, 0], [0, 0, 0]], dtype=np.uint8)
    assert connected_components(g) == []


def test_connected_components_centroid_and_bounding_box() -> None:
    g = np.zeros((5, 5), dtype=np.uint8)
    g[1:4, 1:4] = 3  # 3x3 block centered at (2, 2)
    [c] = connected_components(g)
    assert c.color == 3
    assert c.centroid == (2.0, 2.0)
    assert c.bounding_box == (1, 3, 1, 3)


def test_connected_components_min_size_filter() -> None:
    g = np.zeros((4, 4), dtype=np.uint8)
    g[0, 0] = 1  # singleton
    g[2:4, 2:4] = 2  # 4-cell block
    assert len(connected_components(g, min_size=1)) == 2
    assert len(connected_components(g, min_size=2)) == 1
