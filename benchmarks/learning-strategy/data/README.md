# Synthetic experiment archive

All 51 recorded run directories are packaged here as ZIP files, preserving the
original bytes, including failed and interrupted runs, raw model requests and
responses, native transcripts, SQLite ledgers, frozen source snapshots and plots.
These are synthetic benchmark records, not user conversations. Credentials and
installed environments are not included. The upstream telecom data and source
license is retained under [`../telecom/vendor/LICENSE`](../telecom/vendor/LICENSE).

[`manifest.json`](manifest.json) lists every archive and every member with its
byte count and SHA-256. Frozen sources are historical evidence and may differ
from current source; do not format or revise them. Qualification failures remain
failures. ZIP compression avoids committing thousands of duplicated snapshots.

From the repository root, using Python 3.12 or newer:

```sh
python benchmarks/learning-strategy/restore-data.py --verify-only
python benchmarks/learning-strategy/restore-data.py
```

Restoration writes only `benchmarks/learning-strategy/results/` (ignored by Git),
verifies hashes and paths, and refuses to overwrite different existing data.
It makes no network or model calls. A run name can restrict restoration.

To replay the latest study, restore these dependencies:

```sh
python benchmarks/learning-strategy/restore-data.py telecom-guarded-procedure-v1 telecom-repair-learning-v1 telecom-corrected-discovery-v1
python -m venv benchmarks/learning-strategy/telecom/.venv
# Activate the venv using your platform's activation command, then:
python -m pip install -r benchmarks/learning-strategy/telecom/requirements.txt
node benchmarks/learning-strategy/telecom/guarded-procedure-audit.mjs benchmarks/learning-strategy/results/telecom-guarded-procedure-v1
```

Set `TAU_PYTHON` to an absolute Python executable if using another environment.
The audit reconstructs the frozen requests and native actions from recorded
responses; it does not send paid model requests. New collection is a separate,
explicit action requiring a provider credential and a new output directory.

The readable [publication bundle](../published/telecom-repair-reuse-v1/README.md)
contains the complete 148-row latest comparison, procedures, protocol, analysis,
audit result and branded graphic. It is a development result from four previously
consumed case clusters, not evidence of generalization or fully autonomous learning.
