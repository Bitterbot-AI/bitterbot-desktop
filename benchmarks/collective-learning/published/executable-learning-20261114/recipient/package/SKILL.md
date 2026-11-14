---
description: "Fill bounded DOCX templates while preserving content placement"
name: docx-placeholder-workflow
version: 1
contract: docx-placeholder-workflow-v1
entrypoint: helpers/fill_docx.py
---

# docx-placeholder-workflow

Fill a bounded DOCX offer-letter template from a JSON data object by replacing
`{{FIELD_NAME}}` placeholders and resolving a single-paragraph conditional
block, then write a new DOCX. Inputs are never modified.

## When to use this skill

Use this skill when you need to:

- Produce a filled DOCX from a template whose placeholders are **uppercase names
  and underscores inside double braces**, e.g. `{{CANDIDATE_FULL_NAME}}`.
- Supply values from a flat **JSON object of string values** where every field
  the template references is present.
- Keep or drop a conditional region written as
  `{{IF_RELOCATION}}...{{END_IF_RELOCATION}}` inside a single paragraph.

A placeholder may be split across several Word text runs within one paragraph;
the helper reassembles the paragraph text, substitutes, then writes the result
back while preserving the paragraph/run so the first run's formatting is kept.

### Scope / applicability

- **Stories processed:** body paragraphs, table cells (including nested tables),
  and the active default, first-page, and even-page headers and footers of every
  section.
- **Conditional rule:** `{{IF_RELOCATION}}...{{END_IF_RELOCATION}}` occurs within
  one paragraph (possibly across runs). The enclosed content is kept **only when
  `RELOCATION_PACKAGE` is exactly `Yes`**; every other string (and no value)
  removes it, and the control markers are always removed. The `IF_<X>` marker is
  governed **exclusively** by data field `<X>_PACKAGE`, which is **required**
  whenever the conditional appears. A bare `<X>` key (e.g. `RELOCATION`) is
  unused: it **never** acts as an alias or fallback for `<X>_PACKAGE` and never
  affects keep/drop. If the governing `<X>_PACKAGE` field is **absent**, the
  helper **exits nonzero and reports the missing requirement** rather than
  inventing a default (so an unused bare `RELOCATION` key cannot stand in for a
  missing `RELOCATION_PACKAGE`).
- **Not in scope (first contract):** tracked changes, text boxes, embedded
  objects, macros, encrypted files, field-code evaluation, placeholders spanning
  paragraph boundaries. Input values are literal strings without template
  delimiters.

### Integrity guarantees

- Replaces all fields, preserving other text and its body/cell/header/footer
  placement, and preserving section and table structure.
- Exits nonzero rather than inventing data on unsupported or invalid input
  (unreadable/invalid JSON, non-dict data, non-string or delimiter-bearing
  values, unopenable template, unbalanced/mismatched conditionals, a required
  conditional governor absent, template fields missing from data, or unresolved
  markers remaining).
- Introduces no macros or new external relationships; does not edit either input.

## CLI usage

```
python3 helpers/fill_docx.py \
  --template INPUT.docx \
  --data INPUT.json \
  --output OUTPUT.docx
```

All three arguments are required. On success the script writes `OUTPUT.docx` and
exits `0`. On failure it writes a diagnostic to stderr (prefixed `fill_docx:`)
and exits nonzero:

| Exit | Meaning |
|------|---------|
| 0 | Output written successfully |
| 2 | Unreadable/invalid data JSON, bad value types/delimiters, unopenable template, or write failure |
| 3 | Unbalanced or mismatched conditional markers in a paragraph |
| 4 | Required value absent: a template field missing from data, or a conditional's required governing field (`<X>_PACKAGE`) absent |
| 5 | Unresolved template markers remain after substitution |

Contract output filename is `offer_letter_filled.docx`; pass it via `--output`.

## Example

```
python3 helpers/fill_docx.py \
  --template development/case-02/offer_letter_template.docx \
  --data development/case-02/employee_data.json \
  --output /tmp/offer_letter_filled.docx
```

## Dependencies

Python 3.11 standard library plus `python-docx` and `lxml` from the pinned
runtime. No installation or network access required.
