"""Action-parser robustness tests."""

from __future__ import annotations

from bitterbot_memory.action_parser import parse


def test_clean_tagged_action() -> None:
    p = parse("<scratchpad>think</scratchpad>\n<action>ACTION3</action>")
    assert p.kind == 3
    assert p.scratchpad == "think"
    assert p.parsed_via == "tag"


def test_action_with_xy_coords() -> None:
    p = parse("<action>ACTION6 x=10 y=20</action>")
    assert p.kind == 6
    assert p.x == 10 and p.y == 20


def test_action_with_colon_xy_format() -> None:
    p = parse("<action>ACTION6 x: 5 y: 50</action>")
    assert p.kind == 6
    assert p.x == 5 and p.y == 50


def test_action_with_parenthesized_xy() -> None:
    p = parse("<action>ACTION6 (12, 34)</action>")
    assert p.kind == 6
    assert p.x == 12 and p.y == 34


def test_action_without_tag_falls_back_to_token_scan() -> None:
    p = parse("My next move is ACTION2.")
    assert p.kind == 2
    assert p.parsed_via == "fallback"


def test_reset_token_recognized() -> None:
    p = parse("<action>RESET</action>")
    assert p.kind == 0


def test_unparseable_response_defaults_to_directional() -> None:
    p = parse("I don't know what to do.", fallback_seed=42)
    assert p.kind in (1, 2, 3, 4)
    assert p.parsed_via == "default"


def test_click_without_coords_defaults_to_center() -> None:
    p = parse("<action>ACTION6</action>")
    assert p.kind == 6
    assert p.x == 32 and p.y == 32


def test_rule_observed_extracted() -> None:
    text = """
    <action>ACTION3</action>
    <rule_observed>moving left wraps around to the right edge</rule_observed>
    """
    p = parse(text)
    assert p.kind == 3
    assert p.rule_observed == "moving left wraps around to the right edge"


def test_hypothesis_update_extracted() -> None:
    text = """
    <action>ACTION1</action>
    <hypothesis_update>the goal is to align all blue blobs to the top row</hypothesis_update>
    """
    p = parse(text)
    assert p.hypothesis_update == "the goal is to align all blue blobs to the top row"


def test_xy_out_of_range_falls_back() -> None:
    """Coords outside 0..63 should not be accepted."""
    p = parse("<action>ACTION6 x=99 y=200</action>")
    # Click without valid coords → default to (32, 32)
    assert p.kind == 6
    assert p.x == 32 and p.y == 32


def test_action_token_is_case_insensitive() -> None:
    assert parse("<action>action5</action>").kind == 5
    assert parse("<ACTION>Action5</ACTION>").kind == 5


def test_hallucinated_action8_falls_back() -> None:
    """ACTION8 doesn't exist — parser should not match and should fall back."""
    p = parse("<action>ACTION8</action>", fallback_seed=42)
    assert p.kind in (1, 2, 3, 4)
    assert p.parsed_via == "default"
