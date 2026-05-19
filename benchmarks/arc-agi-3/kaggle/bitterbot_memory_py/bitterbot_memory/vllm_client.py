"""vLLM client adapter.

Satisfies the `LlmCallable = (system: str, user: str) -> str` contract
the BitterbotAgent core expects, talking to a vLLM server via its
OpenAI-compatible REST endpoint at `http://localhost:8000/v1/chat/completions`.

Uses plain `urllib` so there's no extra dependency to ship as a wheel
inside the Kaggle container (the `openai` Python SDK works too but is
heavier than what we need for one-shot chat completions).
"""

from __future__ import annotations

import json
import logging
import os
import time
import urllib.error
import urllib.request
from typing import Any, Callable

logger = logging.getLogger(__name__)


DEFAULT_BASE_URL = "http://localhost:8000/v1"
DEFAULT_MODEL = "Qwen/Qwen2.5-72B-Instruct-AWQ"


def _http_post_json(
    url: str,
    body: dict[str, Any],
    *,
    timeout: float,
    headers: dict[str, str] | None = None,
) -> dict[str, Any]:
    """Plain-urllib POST + JSON decode, with explicit timeout."""
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, data=data, method="POST")
    req.add_header("Content-Type", "application/json")
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    with urllib.request.urlopen(req, timeout=timeout) as resp:  # noqa: S310 (localhost only)
        raw = resp.read().decode("utf-8")
    return json.loads(raw)


class VLLMClient:
    """Single-turn chat-completion client for a local vLLM server.

    Configurable via constructor or `VLLM_*` env vars:
      VLLM_BASE_URL     default http://localhost:8000/v1
      VLLM_MODEL        default Qwen/Qwen2.5-72B-Instruct-AWQ
      VLLM_TEMPERATURE  default 0.3
      VLLM_MAX_TOKENS   default 600
      VLLM_TIMEOUT_S    default 120
    """

    def __init__(
        self,
        *,
        base_url: str | None = None,
        model: str | None = None,
        temperature: float | None = None,
        max_tokens: int | None = None,
        timeout_s: float | None = None,
    ) -> None:
        self.base_url = (base_url or os.environ.get("VLLM_BASE_URL", DEFAULT_BASE_URL)).rstrip("/")
        self.model = model or os.environ.get("VLLM_MODEL", DEFAULT_MODEL)
        self.temperature = (
            temperature
            if temperature is not None
            else float(os.environ.get("VLLM_TEMPERATURE", "0.3"))
        )
        self.max_tokens = (
            max_tokens
            if max_tokens is not None
            else int(os.environ.get("VLLM_MAX_TOKENS", "600"))
        )
        self.timeout_s = (
            timeout_s
            if timeout_s is not None
            else float(os.environ.get("VLLM_TIMEOUT_S", "120"))
        )

    def __call__(self, system: str, user: str) -> str:
        body = {
            "model": self.model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            "temperature": self.temperature,
            "max_tokens": self.max_tokens,
        }
        url = f"{self.base_url}/chat/completions"
        try:
            resp = _http_post_json(url, body, timeout=self.timeout_s)
        except (urllib.error.URLError, TimeoutError) as e:
            logger.warning("vLLM POST failed: %s", e)
            return ""
        choices = resp.get("choices") or []
        if not choices:
            logger.warning("vLLM returned no choices: %s", resp)
            return ""
        msg = choices[0].get("message") or {}
        return str(msg.get("content") or "")


def default_vllm_callable() -> Callable[[str, str], str]:
    """Factory used by arc_adapter when no llm_factory is supplied.

    Returned object is callable as `(system, user) -> str` and reads
    its configuration from env vars at construction time.
    """
    return VLLMClient()


def wait_for_health(
    base_url: str | None = None,
    *,
    timeout_s: float = 180.0,
    poll_s: float = 2.0,
) -> bool:
    """Block until the local vLLM server's `/health` endpoint is 200.

    Returns True on success, False if timed out. The submission
    notebook calls this after spawning the vLLM subprocess to make
    sure the model finished loading before agent traffic starts.
    """
    url = (base_url or os.environ.get("VLLM_BASE_URL", DEFAULT_BASE_URL)).rstrip("/")
    health = url.replace("/v1", "") + "/health"
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(health, timeout=3) as resp:  # noqa: S310
                if resp.status == 200:
                    return True
        except (urllib.error.URLError, TimeoutError):
            pass
        time.sleep(poll_s)
    return False
