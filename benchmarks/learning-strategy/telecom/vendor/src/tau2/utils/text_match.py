# Copyright Sierra
"""Normalization for names and identifiers spoken in domain tasks."""

import unicodedata


def fold_for_match(text: str) -> str:
    """Fold accents and case, preserving internal whitespace and punctuation.

    Callers must reject ambiguous matches rather than selecting a different record.
    """
    decomposed = unicodedata.normalize("NFD", text.strip())
    return "".join(ch for ch in decomposed if not unicodedata.combining(ch)).casefold()
