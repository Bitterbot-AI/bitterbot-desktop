# Executable learning: a verified reuse and transfer pilot

**Finding:** a repaired, reusable DOCX helper made the agent materially cheaper and faster on this bounded workflow, and the same package retained that benefit in an isolated recipient. This is evidence for executable reuse, not a demonstration of general self-improvement or a benefit from pooling peer evidence.

| Observation | Baseline | Learned helper |
| --- | ---: | ---: |
| Source: checked task passes | 7/8 | 8/8 |
| Source: total recorded model cost | $2.957636 | $1.1540205 |
| Recipient: task passes / 12 attempts | 10 | 12 |
| Recipient: verified task failures | 1 | 0 |
| Recipient: interruptions | 1 | 0 |
| Recipient: total recorded model cost, all attempts | $5.41053075 | $2.2037925 |
| Recipient: median task time, 11 fully checked pairs | 108.687 s | 37.214 s |

The recipient's total model cost was **59.27% lower**, and the helper arm was cheaper in all 11 fully checked pairs. All 12 helper runs read the complete instructions and executed the helper. Prices are usage-derived at the frozen configuration's rates, including cached tokens and failed/interrupted attempts; they are not invoice reconciliation or total deployment cost.

The direct repair improved the source functional panel from **26/30 to 30/30**, while retaining all 12 original regression cases. The recipient used the unchanged complete package, with separate identities, process and storage, on three new document genres: service orders, research awards and equipment assignments. Those genres exercise one DOCX mechanism; they are not three independent learning domains. The transfer was an operator-assisted signed offline handoff on the same physical machine, not a measured autonomous mesh deployment.

## What did not work, and what is still unknown

- Earlier prompt-oriented collective-learning experiments did not establish an advantage. The stopped comparison had 15 complete pooled-versus-exchanged blocks, with one improvement and one regression. Its limitations and original result are retained in `earlier-stopped-study.json`.
- The recipient baseline produced one malformed XML document. Another baseline run produced a valid artifact but hit the 20-tool limit during cleanup. Its primary outcome remains **interrupted**, not a retroactively counted success or task failure.
- Both original finite-panel endpoints were unmet: the source endpoint required a perfect baseline, and the recipient endpoint required all 12 pairs to be checked. These descriptive gains do not rewrite those frozen endpoints.
- This small authored pilot does not establish population accuracy gains, independent-user transfer, better prose or visual design, retention after 24 hours, net financial ROI, or added value from pooled evidence. Known source learning cost was $3.07113425, with another $14.40 held unresolved. We do not call the gross task savings net profit.
- Measurements were made on the frozen pre-port runtime. The release ports the implementation to main's newer runtime; release tests are software validation, not a repetition of these performance measurements.

## Reproduce the published observations

From any OS with Python 3.11 or later, run:

```sh
python -B -X utf8 benchmarks/collective-learning/published/executable-learning-20261114/replay.py
node benchmarks/collective-learning/published/executable-learning-20261114/verify-transfer.mjs
```

This needs only the Python standard library. It verifies source file hashes, the complete package manifest and file hashes, reruns the host checkers over all **148 saved artifacts** (88 source, 60 recipient), preserves the interrupted observation, and recomputes arm totals and matched medians. It makes no network requests, model calls or executions of the learned helper. Original Windows/Linux replay receipts are also included.

`source/` and `recipient/` contain authored fixtures, task-level measurements, saved outputs, direct validation results, frozen schedules, the exact learned package and host checkers. `source-provenance.json` maps the selected files to their original exports and hashes. `historical-driver/` and `historical-analysis/` preserve the actual study source; their original absolute paths are historical, not portable entrypoints. Provider conversation sessions, credentials, private coordination and the unrelated full working-tree archive are excluded. This bundle supports independent artifact checking and descriptive analysis; it does not claim a fully hermetic rerun of the historical model provider.

See [methodology](METHODOLOGY.md), [next experiments](NEXT_EXPERIMENTS.md), and [social drafts](social/posts.md). The package remains an experimental example; these observations do not bypass the production qualification gate or activate it for users.

Public fixture and direct-run directories use the numeric case suffix to keep Windows checkout paths bounded. Case IDs and original inventories remain unchanged; the provenance index maps every relocated file. The optional Node command verifies the saved Ed25519 release and bundle hashes with built-in cryptography. It grants no installation or distribution authority.
