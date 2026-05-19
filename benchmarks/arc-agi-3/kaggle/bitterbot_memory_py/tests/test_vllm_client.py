"""VLLMClient tests using a local HTTP server in a thread."""

from __future__ import annotations

import json
import threading
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

from bitterbot_memory.vllm_client import VLLMClient, wait_for_health


class _MockHandler(BaseHTTPRequestHandler):
    """Echo a canned chat-completion response, capture last request."""

    last_body: dict | None = None

    def do_POST(self) -> None:  # noqa: N802
        length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(length).decode("utf-8")
        type(self).last_body = json.loads(body)
        canned = {
            "choices": [
                {
                    "message": {
                        "role": "assistant",
                        "content": "<scratchpad>thinking</scratchpad><action>ACTION3</action>",
                    }
                }
            ]
        }
        out = json.dumps(canned).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/health":
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"OK")
        else:
            self.send_response(404)
            self.end_headers()

    def log_message(self, *_args, **_kwargs) -> None:
        return  # silence


@pytest.fixture()
def vllm_server() -> Iterator[str]:
    """Boot a localhost HTTP server emulating the vLLM endpoint."""
    server = HTTPServer(("127.0.0.1", 0), _MockHandler)
    port = server.server_address[1]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{port}/v1"
    finally:
        server.shutdown()
        server.server_close()
        _MockHandler.last_body = None


def test_vllm_client_calls_endpoint_and_returns_content(vllm_server: str) -> None:
    client = VLLMClient(base_url=vllm_server, model="test-model", temperature=0.2, max_tokens=50)
    out = client("system msg", "user msg")
    assert "ACTION3" in out
    body = _MockHandler.last_body
    assert body is not None
    assert body["model"] == "test-model"
    assert body["temperature"] == 0.2
    assert body["max_tokens"] == 50
    assert body["messages"][0]["role"] == "system"
    assert body["messages"][1]["role"] == "user"
    assert body["messages"][0]["content"] == "system msg"
    assert body["messages"][1]["content"] == "user msg"


def test_vllm_client_returns_empty_on_failed_connection() -> None:
    """No server running on this port — call must return '' not raise."""
    client = VLLMClient(base_url="http://127.0.0.1:1/v1", timeout_s=0.5)
    assert client("s", "u") == ""


def test_wait_for_health_polls_until_ready(vllm_server: str) -> None:
    ok = wait_for_health(vllm_server, timeout_s=2.0, poll_s=0.1)
    assert ok is True


def test_wait_for_health_returns_false_on_timeout() -> None:
    ok = wait_for_health("http://127.0.0.1:1/v1", timeout_s=0.5, poll_s=0.1)
    assert ok is False


def test_vllm_client_satisfies_llm_callable_signature() -> None:
    """VLLMClient instances are callable as (str, str) -> str."""
    from bitterbot_memory.agent import LlmCallable  # type alias

    client = VLLMClient(base_url="http://127.0.0.1:1/v1", timeout_s=0.1)
    cb: LlmCallable = client  # type: ignore[assignment]  # protocol-style check
    assert callable(cb)
