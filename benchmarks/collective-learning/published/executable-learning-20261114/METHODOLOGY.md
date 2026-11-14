# Methodology and interpretation

## Design and provenance

This development sequence repaired an executable DOCX procedure, tested fresh-session reuse locally, then transferred its exact bytes to an isolated recipient for a counterbalanced comparison. The configured model was `anthropic/claude-opus-4-8`. The two arms in each comparison had the same model, task specification, tools, fixtures and limits; the learned arm additionally had the frozen package. Arm order alternated by pair. There were eight source pairs and twelve recipient pairs, with no replaced failures.

The public task contract required filling split placeholders across document text, nested tables and active headers/footers while preserving placement and section structure. `RELOCATION_PACKAGE` alone governed the conditional: exactly `Yes` included it; other strings removed it; a missing governing field required a nonzero failure. A misleading `RELOCATION` field could not act as a fallback. Fixtures included Unicode, XML metacharacters and conditional edge cases.

The source repair had a 30-case functional panel and 12 original regression cases. The recipient's fresh tasks covered three document genres and included different strings and layouts. The recipient sandbox had 0.75 CPU and 384 MiB, compared with 1 CPU and 512 MiB at the source; it used Toronto timezone and UTF-8. Both used the same physical host and pinned dependency image (`sha256:8c7a2ed155e6e27b42f6787539eb8dc9d914b2eddb2d0d6ae7c47b5bbc142c6a`), Python 3.11.18 and python-docx 1.1.2. This is limited environmental variation, not independent hardware replication.

The transferred package hash is `8a9db2fb33657ba8bb6fa9cf571d98bb4776dcb1881b2f130cd40405ac775eef`. It contains the exact `SKILL.md` and `helpers/fill_docx.py`; hashes, byte sizes, platform, runtime and tool requirements are in each `candidate-package.json`. It was neither edited for the recipient nor imported with source qualification receipts. Separate processes, identities and stores implemented an operator-assisted signed handoff. No production adoption occurred.

## Execution and checking

Ordinary agent sessions selected the skill through the standard loader, without a forced-read instruction. Host instrumentation observed complete instruction reads, helper commands and exit status. Isolated scratch directories, read-only package mounts and network-disabled containers restricted execution. No installs, credentials or extra tool capabilities were granted. The task limit was 20 tool actions, 300 seconds and a 4,096-token model output cap per response.

Checkers and reference artifacts remained host-owned and outside the candidate-visible sandbox and prompts. They checked input integrity, required text and conditional semantics, table-cell placement, active section header/footer content, XML validity, and prohibited active content or changed external relationships. Preflight included correct and deliberately invalid artifacts on Windows and Linux; Docker qualification exercised 24 control and 24 candidate cases before the recipient model comparison. Structural/content correctness is the measured outcome; no blinded human visual-quality rating was collected.

The baseline failure on `evaluation-research-award-4213` was malformed `word/document.xml`, independently corroborated with libxml2. The interruption on `evaluation-service-order-4203` occurred when a 21st cleanup tool request exceeded the host limit. A supplementary artifact check passed, but the run had not completed and remains interrupted. Its $0.39172275 cost was reconciled from recorded usage plus an offline SDK probe showing that the already-aborted follow-up performed zero fetches. This specific between-calls cancellation does not imply that other interrupted requests are free.

A continuation amendment resumed only 16 previously unstarted jobs after that interruption, preserving the original run and unchanged model, limits, package and tasks. No extra observations replaced inconvenient results. The amendment and original readout are included.

## Analysis and costs

Reported total costs include all attempted runs, including the failed and interrupted baseline. The headline 59.27% reduction is `1 - 2.2037925 / 5.41053075`. The median comparison uses the same 11 fully checked pairs in both arms: 108.687 seconds baseline and 37.214 seconds learned. Removing the first pair from both arms gives 107.696 and 36.4665 seconds, respectively. These times include the checker; original receipts also separate checker wall time.

All 11 checked pairs favored the helper on model cost. Cost per verified completion in those pairs was $0.5018808 baseline and $0.18963048 learned. This is a descriptive secondary view; it must not be confused with the all-attempt total-cost denominator used in the infographic.

Frozen rates per million tokens were $5 input, $25 output, $0.50 cache read and $6.25 cache write. Usage audits compared recorded responses with the ledger. The recipient consumed $7.61432325 in recorded model charges. Known source learning consumed $3.07113425, with $14.40 unresolved reservations still retained. Hardware, human labor, previous experiments and unresolved charges prevent a complete net-ROI estimate.

The source's original endpoint required both arms to pass all eight tasks; the baseline did not. The recipient's original endpoint required all twelve pairs checked; one was interrupted. Both remain unmet. No post-hoc significance claim, powered population estimate or general learning claim is made. The same authored mechanism, small sample, two learning environments and single learned package constrain generalization.

## Integrity and scope

Original frozen exports were preserved; public files were selected into this bundle with explicit hashes. Historical analysis scripts can reference private absolute directories and are retained for inspection, not executed by the portable replay. The replay checks artifact outcomes with the original host oracle; repeating that oracle alone does not independently prove its semantic correctness. Negative controls and separate XML parsing provide additional, narrower checks.

The release integration uses main's newer agent runtime. Its unit, transport, sandbox and build tests demonstrate implementation compatibility; the historical timing and cost results belong to the frozen study environment. A fresh measurement on the release runtime is required before attributing these numbers to the shipped runtime.
