"""Tests for arc_adapter without arcengine installed.

The adapter module must import cleanly on machines that don't have
the `arcengine` package — only `make_arc_agent_class()` itself
requires it (lazy import). These tests verify that contract.
"""

from __future__ import annotations

import sys

import pytest


def test_module_imports_without_arcengine() -> None:
    """Top-level import should succeed even on dev machines without the
    Kaggle competition wheels installed."""
    # Sanity: ensure the package isn't actually present.
    assert "arcengine" not in sys.modules
    # If this import fails, the offline-import contract is broken.
    from bitterbot_memory import arc_adapter  # noqa: F401


def test_make_arc_agent_class_raises_when_arcengine_missing() -> None:
    """The factory does the actual arcengine import; it should fail
    fast with a clear ImportError when called locally."""
    from bitterbot_memory.arc_adapter import make_arc_agent_class

    with pytest.raises((ImportError, ModuleNotFoundError)):
        make_arc_agent_class()
