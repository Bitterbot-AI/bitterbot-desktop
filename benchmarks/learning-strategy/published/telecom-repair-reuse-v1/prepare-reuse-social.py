"""Build a social graphic and compact evidence bundle from the audited study.

No model/image generation: every plotted quantity comes from the recorded analysis.
This command prepares local files and does not publish anything.
"""
import hashlib
import json
from pathlib import Path
import shutil
import sys

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import FancyBboxPatch, Rectangle

root, output = map(Path, sys.argv[1:])
assert not output.exists()
read = lambda name: json.loads((root / name).read_text(encoding="utf8"))
sha = lambda filename: hashlib.sha256(filename.read_bytes()).hexdigest()
analysis, audit = read("analysis.json"), read("audit.json")
assert audit["status"] == "passed"
assert audit["completeHash"] == sha(root / "complete.json")
assert analysis["auditHash"] == sha(root / "audit.json")
assert analysis["gatePassed"] is False
assert len(analysis["panel"]) == 2
for row in analysis["panel"]:
    assert (row["repaired"], row["failed"], row["preserved"], row["healthy"], row["healthyWrites"], row["abstained"]) == (12, 28, 16, 16, 0, 8)
for candidate in ["candidate-0", "candidate-1"]:
    for arm in ["compiled", "advice"]:
        row = next(r for r in analysis["summary"] if r["group"] == f"{arm}:{candidate}")
        assert (row["repaired"], row["assigned"]) == (6, 12)
        if arm == "compiled":
            assert row["modelCalls"] == 0

output.mkdir(parents=True)
(output / "evidence").mkdir()
for name in ["analysis.json", "audit.json", "complete.json", "protocol.json", "artifacts.json", "trials.jsonl"]:
    shutil.copyfile(root / name, output / "evidence" / name)

navy, card, white, muted, mint, amber = "#0B1526", "#152339", "#F5F8FC", "#BCC9DC", "#65E5BC", "#FFD191"
plt.rcParams.update({"font.family": "DejaVu Sans", "svg.fonttype": "none"})
fig = plt.figure(figsize=(8, 10), facecolor=navy)
canvas = fig.add_axes([0, 0, 1, 1])
canvas.set_xlim(0, 1)
canvas.set_ylim(0, 1)
canvas.axis("off")
def box(x, y, w, h, color=card):
    canvas.add_patch(FancyBboxPatch((x, y), w, h, boxstyle="round,pad=0.012,rounding_size=0.015", facecolor=color, edgecolor="none"))
def text(x, y, value, size=12, color=white, weight="normal", **kwargs):
    fig.text(x, y, value, fontsize=size, color=color, weight=weight, **kwargs)

text(.065, .953, "BITTERBOT  /  RESEARCH NOTE", 11, mint, "bold")
text(.065, .867, "A discovered repair.\nA reusable capability.", 28, weight="bold", linespacing=1.13)
text(.065, .791, "Two independently generated procedures.\nBoth achieved the same result:", 13, muted, linespacing=1.4)

box(.065, .485, .87, .26)
rate = 100 * analysis["panel"][0]["repaired"] / analysis["panel"][0]["failed"]
text(.09, .61, f"{rate:.0f}%", 67, mint, "bold")
text(.46, .665, "of additional failed\nrecorded states repaired", 15, linespacing=1.5)
text(.46, .598, "12 of 28, per procedure", 12, muted)
canvas.add_patch(Rectangle((.09, .545), .82, .025, facecolor="#34465F", edgecolor="none"))
canvas.add_patch(Rectangle((.09, .545), .82 * rate / 100, .025, facecolor=mint, edgecolor="none"))
text(.09, .513, "12 repaired", 10, mint, "bold")
text(.91, .513, "16 unresolved · includes 8 identity abstentions", 9, muted, ha="right")

box(.065, .353, .415, .092)
box(.52, .353, .415, .092)
text(.09, .401, "16/16", 29, weight="bold")
text(.09, .367, "working states left unchanged", 10.5, muted)
text(.545, .401, "0", 29, mint, "bold")
text(.545, .367, "LLM calls during reuse*", 11, muted)
text(.065, .322, "*Generating the procedures required model calls.", 10.5, muted)

box(.065, .226, .87, .061)
text(.085, .269, "CONTROL COMPARISON · ORIGINAL INPUTS", 9, muted, "bold")
text(.085, .241, "Executed procedure 6/12    ·    Advice 6/12", 13.5, weight="bold")
text(.065, .199, "Qualification gate failed. No accuracy gain over advice.", 11, amber)

text(.065, .132, "Getting closer to fully autonomous learning,\nstep by step…", 14, mint, linespacing=1.35)
text(.065, .065, "Development only: four previously seen synthetic cases.\nThese states are not independent tasks. Broader transfer is unproven.", 9.5, muted, linespacing=1.5)
text(.065, .025, f"{audit['assignments']} executions replay-audited  ·  telecom-guarded-procedure-v1", 8.5, muted)
fig.savefig(output / "linkedin-graphic.png", dpi=200, facecolor=navy)
fig.savefig(output / "linkedin-graphic.svg", facecolor=navy)
plt.close(fig)

shutil.copyfile(Path(__file__), output / "prepare-reuse-social.py")
manifest = {
    "kind": "local-publication-package-not-published",
    "sourceRun": root.name,
    "sourceAnalysisHash": sha(root / "analysis.json"),
    "sourceAuditHash": sha(root / "audit.json"),
    "matplotlib": matplotlib.__version__,
    "files": {p.relative_to(output).as_posix(): sha(p) for p in sorted(output.rglob("*")) if p.is_file()},
    "scope": "Compact derived evidence; does not include full raw provider receipts, source snapshots or native replay dependencies. Main local study retains those.",
}
(output / "manifest.json").write_text(json.dumps(manifest, indent=2)+"\n", encoding="utf8")
print(json.dumps({"output": str(output), "image": "linkedin-graphic.png", "pixels": [1600, 2000], "verifiedAssignments": audit["assignments"]}))
