"""Robust parser for the LLM's action output.

Expected output format (we instruct the model to emit this):

    <scratchpad>...reasoning, free-form...</scratchpad>
    <action>ACTION3</action>
    <action>ACTION6 x=10 y=20</action>  ← for clicks
    <rule_observed>...optional, free-form rule text...</rule_observed>
    <hypothesis_update>...optional...</hypothesis_update>

The parser is intentionally lenient. Frontier models occasionally
drop the `<action>` tags, hallucinate ACTION8+, or output coordinate
syntax variants like `(10, 20)` or `x: 10, y: 20`. We extract the
first valid ACTION token + the first plausible (x, y) pair and fall
back to the partner-template safe-default (a random non-RESET
directional action) if nothing parses.
"""

from __future__ import annotations

import random
import re
from dataclasses import dataclass


_ACTION_TOKEN_RE = re.compile(r"\bACTION([1-7])\b", re.IGNORECASE)
_RESET_RE = re.compile(r"\bRESET\b", re.IGNORECASE)
_XY_RE = re.compile(r"x[=:\s]+(\d{1,2}).*?y[=:\s]+(\d{1,2})", re.IGNORECASE | re.DOTALL)
_XY_PAREN_RE = re.compile(r"\(\s*(\d{1,2})\s*,\s*(\d{1,2})\s*\)")
_RULE_TAG_RE = re.compile(r"<rule_observed>(.*?)</rule_observed>", re.IGNORECASE | re.DOTALL)
_HYP_TAG_RE = re.compile(
    r"<hypothesis_update>(.*?)</hypothesis_update>", re.IGNORECASE | re.DOTALL
)
_SCRATCHPAD_RE = re.compile(r"<scratchpad>(.*?)</scratchpad>", re.IGNORECASE | re.DOTALL)
_ACTION_TAG_RE = re.compile(r"<action>(.*?)</action>", re.IGNORECASE | re.DOTALL)


@dataclass
class ParsedAction:
    """An action extracted from LLM output.

    `kind` is 0 for RESET, 1..7 for ACTION1..7. `x`/`y` are set only
    for ACTION6 clicks. `rule_observed` and `hypothesis_update` are
    optional free-text payloads the agent uses to update memory.
    `scratchpad` is the model's chain-of-thought (for logging).
    """

    kind: int  # 0=RESET, 1..7=ACTIONn
    x: int | None = None
    y: int | None = None
    rule_observed: str | None = None
    hypothesis_update: str | None = None
    scratchpad: str | None = None
    raw: str = ""
    parsed_via: str = "tag"  # one of: "tag", "fallback", "default"


def _extract_xy(text: str) -> tuple[int, int] | None:
    """Find the first plausible (x, y) pair in 0..63."""
    m = _XY_RE.search(text)
    if m:
        x, y = int(m.group(1)), int(m.group(2))
        if 0 <= x <= 63 and 0 <= y <= 63:
            return x, y
    m = _XY_PAREN_RE.search(text)
    if m:
        x, y = int(m.group(1)), int(m.group(2))
        if 0 <= x <= 63 and 0 <= y <= 63:
            return x, y
    return None


def parse(text: str, *, fallback_seed: int | None = None) -> ParsedAction:
    """Parse the LLM's full response into a `ParsedAction`.

    Strategy (in order, first match wins):
      1. Look inside the first `<action>...</action>` tag.
      2. If no tag, scan the entire response for the first ACTION token.
      3. Otherwise fall back to a random ACTION1..4 (directional) so
         the agent never deadlocks on an unparseable response.
    """
    scratchpad = None
    sp = _SCRATCHPAD_RE.search(text)
    if sp:
        scratchpad = sp.group(1).strip()

    rule = _RULE_TAG_RE.search(text)
    rule_observed = rule.group(1).strip() if rule else None
    hyp = _HYP_TAG_RE.search(text)
    hypothesis_update = hyp.group(1).strip() if hyp else None

    body = _ACTION_TAG_RE.search(text)
    if body:
        tagged = _extract_action(
            body.group(1),
            scratchpad=scratchpad,
            rule_observed=rule_observed,
            hypothesis_update=hypothesis_update,
            raw=text,
            via="tag",
        )
        if tagged.kind != -1:
            return tagged
        # Tag was present but content was unparseable (e.g. hallucinated
        # ACTION8). Fall through to the safe default below rather than
        # returning kind=-1 to the caller.

    # No usable <action> tag — search the whole response.
    action = _extract_action(
        text,
        scratchpad=scratchpad,
        rule_observed=rule_observed,
        hypothesis_update=hypothesis_update,
        raw=text,
        via="fallback",
    )
    if action.kind != -1:
        return action

    # Last resort: safe-default directional action so we never deadlock.
    rng = random.Random(fallback_seed) if fallback_seed is not None else random
    default_kind = rng.choice([1, 2, 3, 4])
    return ParsedAction(
        kind=default_kind,
        scratchpad=scratchpad,
        rule_observed=rule_observed,
        hypothesis_update=hypothesis_update,
        raw=text,
        parsed_via="default",
    )


def _extract_action(
    text: str,
    *,
    scratchpad: str | None,
    rule_observed: str | None,
    hypothesis_update: str | None,
    raw: str,
    via: str,
) -> ParsedAction:
    if _RESET_RE.search(text):
        return ParsedAction(
            kind=0,
            scratchpad=scratchpad,
            rule_observed=rule_observed,
            hypothesis_update=hypothesis_update,
            raw=raw,
            parsed_via=via,
        )
    m = _ACTION_TOKEN_RE.search(text)
    if not m:
        return ParsedAction(
            kind=-1,
            scratchpad=scratchpad,
            rule_observed=rule_observed,
            hypothesis_update=hypothesis_update,
            raw=raw,
            parsed_via=via,
        )
    kind = int(m.group(1))
    x: int | None = None
    y: int | None = None
    if kind == 6:
        xy = _extract_xy(text)
        if xy is None:
            # Click without coords — default to grid center so the
            # action is at least valid.
            x, y = 32, 32
        else:
            x, y = xy
    return ParsedAction(
        kind=kind,
        x=x,
        y=y,
        scratchpad=scratchpad,
        rule_observed=rule_observed,
        hypothesis_update=hypothesis_update,
        raw=raw,
        parsed_via=via,
    )
