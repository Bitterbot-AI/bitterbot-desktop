"""Embedding providers for the Python memory port.

Defines an `Embedder` protocol and two implementations:

- `BGEEmbedder`: loads `BAAI/bge-small-en-v1.5` (or any sentence-style
  encoder) via the preinstalled `transformers` package. Mean-pools the
  last hidden state, L2-normalizes. ~384-dim vectors. Runs on CPU by
  default; pass `device="cuda"` to share GPU with vLLM (will use
  negligible VRAM beside a 70 B quantized model).

- `HashEmbedder`: deterministic, dependency-free fake. Hashes the input
  to a fixed-size float vector. Used in tests so retrieval logic can be
  verified without downloading a real model.

Both expose the same `encode(texts: list[str]) -> np.ndarray` interface.
"""

from __future__ import annotations

import hashlib
from typing import Protocol

import numpy as np


class Embedder(Protocol):
    """Anything that turns a list of strings into a 2-D float32 array."""

    @property
    def dim(self) -> int: ...
    @property
    def model_name(self) -> str: ...

    def encode(self, texts: list[str]) -> np.ndarray:
        """Return an array of shape (len(texts), self.dim). L2-normalized."""
        ...


class HashEmbedder:
    """Deterministic, dependency-free embedder for tests.

    Splits each input on whitespace, hashes each token to a bucket
    index, and accumulates a count vector. Then L2-normalizes. The
    resulting space has the property that texts with overlapping tokens
    have cosine similarity > 0, while disjoint texts are orthogonal —
    which is sufficient for testing the retrieval merge logic.
    """

    def __init__(self, dim: int = 64) -> None:
        self._dim = dim

    @property
    def dim(self) -> int:
        return self._dim

    @property
    def model_name(self) -> str:
        return f"hash-{self._dim}"

    def encode(self, texts: list[str]) -> np.ndarray:
        out = np.zeros((len(texts), self._dim), dtype=np.float32)
        for i, t in enumerate(texts):
            for tok in t.lower().split():
                h = int.from_bytes(hashlib.sha1(tok.encode()).digest()[:4], "big")
                out[i, h % self._dim] += 1.0
        norms = np.linalg.norm(out, axis=1, keepdims=True)
        # Avoid divide-by-zero; an empty string stays a zero vector.
        norms = np.where(norms == 0, 1.0, norms)
        return out / norms


class BGEEmbedder:
    """`BAAI/bge-small-en-v1.5`-style embedder via `transformers`.

    Lazily loads the model on first `encode()` call to keep import-time
    cost zero. Loading is slow (~3 s on CPU, ~1 s on H100) so callers
    should warm it up before the per-action hot loop.

    The default `model_path` is the HuggingFace repo id; on Kaggle pass
    an absolute path like `/kaggle/input/bge-small-en-v1.5/` so it loads
    offline.
    """

    def __init__(
        self,
        model_path: str = "BAAI/bge-small-en-v1.5",
        device: str = "cpu",
        max_length: int = 256,
    ) -> None:
        self._model_path = model_path
        self._device = device
        self._max_length = max_length
        self._tokenizer = None
        self._model = None
        self._dim = 384  # Known for bge-small / MiniLM-class encoders.

    @property
    def dim(self) -> int:
        return self._dim

    @property
    def model_name(self) -> str:
        return self._model_path

    def _load(self) -> None:
        if self._model is not None:
            return
        # Local import so the package is importable without torch/transformers
        # installed (e.g., during pure-test runs that only need HashEmbedder).
        from transformers import AutoModel, AutoTokenizer
        import torch  # noqa: F401  (verifies torch is available)

        self._tokenizer = AutoTokenizer.from_pretrained(self._model_path)
        self._model = AutoModel.from_pretrained(self._model_path).to(self._device)
        self._model.eval()
        # Update dim from the actual model in case we ever swap to a
        # non-bge-small checkpoint.
        self._dim = int(self._model.config.hidden_size)

    def encode(self, texts: list[str]) -> np.ndarray:
        if not texts:
            return np.zeros((0, self._dim), dtype=np.float32)
        self._load()
        assert self._tokenizer is not None and self._model is not None
        import torch

        batch = self._tokenizer(
            texts,
            padding=True,
            truncation=True,
            max_length=self._max_length,
            return_tensors="pt",
        ).to(self._device)
        with torch.no_grad():
            outputs = self._model(**batch)
        # Mean-pool over non-padding tokens.
        last_hidden = outputs.last_hidden_state  # (B, T, H)
        mask = batch["attention_mask"].unsqueeze(-1).float()  # (B, T, 1)
        summed = (last_hidden * mask).sum(dim=1)  # (B, H)
        counts = mask.sum(dim=1).clamp(min=1e-9)  # (B, 1)
        pooled = summed / counts
        # L2-normalize for cosine similarity via dot product.
        pooled = torch.nn.functional.normalize(pooled, p=2, dim=1)
        return pooled.cpu().numpy().astype(np.float32)
