"""Bitterbot biological memory — Python port.

Top-level facade re-exports for convenience. The submodules can also be
imported directly; this file just keeps the common entry points discoverable.

See PLAN-19b for the architectural rationale.
"""

from .memory import BitterbotMemory
from .store import MemoryStore, open_store

__all__ = ["BitterbotMemory", "MemoryStore", "open_store"]
__version__ = "0.1.0"
