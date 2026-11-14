---
name: research-brief
description: Prepare a dated, source-backed research brief that preserves conflicting findings and uncertainty.
---

Read the task and each supplied source before drafting. Use only authorized sources.
Use templates/brief.md for the deliverable. Run scripts/build_brief.py with the
input JSON, output JSON and output Markdown paths when Python 3 is already available.
Do not install tools or fetch additional material without ordinary authorization.
When Node.js is already available, scripts/build_brief.cjs provides an alternative
with the same three file arguments. Check timezone applicability before choosing it.

Normalize publication timestamps to ISO calendar dates with scripts/normalize_sources.py.
Keep publication date, observation date and retrieval date distinct when they differ.
Preserve source identifiers and links; cite every quantitative finding. Exclude sources
explicitly marked superseded. If two current sources disagree, retain both values and
their citations; explain their populations, time windows or measurement differences.
Do not average incompatible measurements or choose a convenient winner.

Use scripts/citations.py to assemble the factual findings. It is a drafting helper,
not an independent correctness verdict. Check the generated brief against the sources.
Describe missing information, limitations and unresolved contradictions. Separate factual
findings from recommendations; make recommendations conditional when evidence is weak.
Include a concrete follow-up action, its owner and the question it should resolve.
Return both brief.json and brief.md. Keep a generated brief in draft until reviewed.

If a source lacks a valid date or has an ambiguous identifier, ask for clarification
or record that uncertainty rather than inventing a date or citation. Consult
references/source-rules.md for these cases.
