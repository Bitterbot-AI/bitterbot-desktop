"""Shared pytest fixtures."""

from __future__ import annotations

import sys
from pathlib import Path
from collections.abc import Iterator

import pytest

# Allow `from bitterbot_memory import ...` without installing the package.
_PKG_ROOT = Path(__file__).resolve().parent.parent
if str(_PKG_ROOT) not in sys.path:
    sys.path.insert(0, str(_PKG_ROOT))

from bitterbot_memory.store import MemoryStore, open_store  # noqa: E402


@pytest.fixture()
def store(tmp_path: Path) -> Iterator[MemoryStore]:
    """A fresh memory store backed by a temp file. Closes at teardown."""
    s = open_store(tmp_path / "memory.sqlite")
    try:
        yield s
    finally:
        s.close()
