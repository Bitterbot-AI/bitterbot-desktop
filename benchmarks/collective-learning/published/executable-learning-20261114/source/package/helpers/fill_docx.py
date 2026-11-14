#!/usr/bin/env python3
"""Fill a bounded DOCX offer-letter template from a JSON data object.

Contract: docx-placeholder-workflow-v1

Replaces {{FIELD_NAME}} placeholders (uppercase + underscores, inside double
braces) that may be split across multiple Word runs within a single paragraph.
Handles a single conditional block per paragraph:

    {{IF_RELOCATION}}...{{END_IF_RELOCATION}}

The enclosed content is kept only when data["RELOCATION_PACKAGE"] == "Yes"
(exact match); the control markers are always removed. RELOCATION_PACKAGE is the
only governing field and is required whenever the conditional appears; a bare
RELOCATION key is unused and never acts as an alias or fallback. If the
governing field is absent the script exits nonzero and reports the missing
requirement rather than inventing a default.

Stories processed: body paragraphs, table cells (including nested tables), and
the default / first-page / even-page headers and footers of every section.

Usage:
    python3 helpers/fill_docx.py --template IN.docx --data IN.json --output OUT.docx

On unsupported or invalid input the script exits nonzero rather than inventing
data. It never modifies the input files.
"""

import argparse
import json
import re
import sys

import docx
from docx.document import Document as _Document
from docx.table import _Cell, Table
from docx.text.paragraph import Paragraph


# A placeholder field: {{UPPER_SNAKE}} (letters, digits, underscores).
FIELD_RE = re.compile(r"\{\{([A-Z][A-Z0-9_]*)\}\}")

# Conditional markers. The suffix after IF_/END_IF_ is the governing field name.
IF_RE = re.compile(r"\{\{IF_([A-Z][A-Z0-9_]*)\}\}")
END_IF_RE = re.compile(r"\{\{END_IF_([A-Z][A-Z0-9_]*)\}\}")

# Any remaining template marker (used only to detect leftovers for integrity).
ANY_MARKER_RE = re.compile(r"\{\{[^}]*\}\}")


def err(msg):
    sys.stderr.write("fill_docx: " + msg + "\n")


# ---------------------------------------------------------------------------
# Story discovery
# ---------------------------------------------------------------------------

def _iter_block_paragraphs(parent):
    """Yield every paragraph inside a container, descending into tables and
    nested tables (table cells can themselves contain tables)."""
    if isinstance(parent, _Document):
        body = parent.element.body
        children = (parent.paragraphs, parent.tables)
    elif isinstance(parent, _Cell):
        children = (parent.paragraphs, parent.tables)
    else:
        children = (parent.paragraphs, parent.tables)

    paragraphs, tables = children
    for p in paragraphs:
        yield p
    for tbl in tables:
        yield from _iter_table_paragraphs(tbl)


def _iter_table_paragraphs(tbl: Table):
    for row in tbl.rows:
        for cell in row.cells:
            for p in cell.paragraphs:
                yield p
            for nested in cell.tables:
                yield from _iter_table_paragraphs(nested)


def _iter_story_paragraphs(document: _Document):
    """Yield paragraphs from the body plus every header/footer story of every
    section (default, first-page, even-page)."""
    # Body (paragraphs + tables, recursively)
    yield from _iter_block_paragraphs(document)

    for section in document.sections:
        for part in (
            section.header,
            section.first_page_header,
            section.even_page_header,
            section.footer,
            section.first_page_footer,
            section.even_page_footer,
        ):
            if part is None:
                continue
            # paragraphs directly, plus any tables inside the header/footer
            for p in part.paragraphs:
                yield p
            for tbl in part.tables:
                yield from _iter_table_paragraphs(tbl)


# ---------------------------------------------------------------------------
# Transformation
# ---------------------------------------------------------------------------

_MISSING = object()


def _conditional_value(name, data):
    """Resolve the data value governing a conditional named X.

    The conditional marker {{IF_X}} is governed exclusively by the data field
    "<X>_PACKAGE" (e.g. {{IF_RELOCATION}} is governed by RELOCATION_PACKAGE).
    That governing field is required whenever the conditional appears.

    A bare "<X>" key is unused by the conditional: it must never act as an
    alias or fallback for the governing field, and it must never influence
    keep/drop. When the governing "<X>_PACKAGE" field is absent, this returns
    the sentinel _MISSING so the caller can fail with a missing-requirement
    diagnostic rather than inventing a default."""
    pkg = name + "_PACKAGE"
    if pkg in data:
        return data[pkg]
    return _MISSING


def _apply_conditionals(text, data):
    """Resolve conditional blocks within a single paragraph's combined text.

    A block is {{IF_X}}...{{END_IF_X}}. Content is kept only when the governing
    data value (see _conditional_value) is exactly "Yes"; the markers are always
    removed. Returns (text, error_or_None, kind) where kind is None on success,
    "structure" for unbalanced/mismatched markers, or "missing-governor" when a
    required governing field is absent.
    """
    while True:
        m_if = IF_RE.search(text)
        if not m_if:
            break
        name = m_if.group(1)
        m_end = END_IF_RE.search(text, m_if.end())
        if not m_end:
            return None, ("unbalanced conditional: {{IF_%s}} without matching "
                          "{{END_IF_%s}} in one paragraph" % (name, name)), \
                "structure"
        if m_end.group(1) != name:
            return None, ("mismatched conditional markers: {{IF_%s}} vs "
                          "{{END_IF_%s}}" % (name, m_end.group(1))), "structure"

        enclosed = text[m_if.end():m_end.start()]
        gov = _conditional_value(name, data)
        if gov is _MISSING:
            return None, ("missing required conditional governor: {{IF_%s}} "
                          "requires data field %s_PACKAGE, which is absent"
                          % (name, name)), "missing-governor"
        keep = gov == "Yes"
        replacement = enclosed if keep else ""
        text = text[:m_if.start()] + replacement + text[m_end.end():]

    # A stray END_IF without an opening IF is an error.
    stray = END_IF_RE.search(text)
    if stray:
        return None, ("unbalanced conditional: {{END_IF_%s}} without matching "
                      "{{IF_%s}}" % (stray.group(1), stray.group(1))), \
            "structure"
    return text, None, None


def _apply_fields(text, data, missing):
    """Replace {{FIELD}} placeholders using data. Unknown field names are
    recorded in `missing` and left for the caller to treat as an error."""
    def repl(m):
        key = m.group(1)
        if key in data:
            return str(data[key])
        missing.add(key)
        return m.group(0)
    return FIELD_RE.sub(repl, text)


def _set_paragraph_text(paragraph: Paragraph, new_text):
    """Write new_text into the paragraph, collapsing it into the first run and
    clearing the remaining runs. Run/paragraph structure is preserved so
    formatting of the first run is retained."""
    runs = paragraph.runs
    if not runs:
        # No runs: if we actually produced text, add one; otherwise leave empty.
        if new_text:
            paragraph.add_run(new_text)
        return
    runs[0].text = new_text
    for r in runs[1:]:
        r.text = ""


def _process_paragraph(paragraph: Paragraph, data, missing):
    runs = paragraph.runs
    if not runs:
        return None, None
    combined = "".join(r.text for r in runs)
    if "{{" not in combined:
        return None, None  # nothing to do; leave untouched

    new_text, cerr, kind = _apply_conditionals(combined, data)
    if cerr:
        return cerr, kind
    new_text = _apply_fields(new_text, data, missing)

    if new_text != combined:
        _set_paragraph_text(paragraph, new_text)
    return None, None


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main(argv=None):
    parser = argparse.ArgumentParser(
        description="Fill a DOCX template from a JSON data object.")
    parser.add_argument("--template", required=True)
    parser.add_argument("--data", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args(argv)

    # Load data.
    try:
        with open(args.data, "r", encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, ValueError) as e:
        err("cannot read data JSON: %s" % e)
        return 2
    if not isinstance(data, dict):
        err("data JSON must be an object of field->value")
        return 2
    # All values must be strings (contract: a JSON object of string values).
    for k, v in data.items():
        if not isinstance(v, str):
            err("data value for %r is not a string" % k)
            return 2
        if "{{" in v or "}}" in v:
            err("data value for %r contains template delimiters" % k)
            return 2

    # Load template.
    try:
        document = docx.Document(args.template)
    except Exception as e:  # noqa: BLE001 - surface any open failure as nonzero
        err("cannot open template DOCX: %s" % e)
        return 2

    missing = set()
    for paragraph in _iter_story_paragraphs(document):
        cerr, kind = _process_paragraph(paragraph, data, missing)
        if cerr:
            err(cerr)
            # A required conditional governor that is absent is a missing
            # requirement, not a structural error: report it and exit 4 so an
            # unused bare field can never serve as an alias or silent default.
            return 4 if kind == "missing-governor" else 3

    if missing:
        err("template references fields not present in data: %s"
            % ", ".join(sorted(missing)))
        return 4

    # Integrity: no unresolved template markers may remain in any story.
    leftovers = set()
    for paragraph in _iter_story_paragraphs(document):
        combined = "".join(r.text for r in paragraph.runs)
        for m in ANY_MARKER_RE.finditer(combined):
            leftovers.add(m.group(0))
    if leftovers:
        err("unresolved template markers remain: %s"
            % ", ".join(sorted(leftovers)))
        return 5

    try:
        document.save(args.output)
    except Exception as e:  # noqa: BLE001
        err("cannot write output DOCX: %s" % e)
        return 2

    return 0


if __name__ == "__main__":
    sys.exit(main())
