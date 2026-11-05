"""Static figure from audited development results; deterministic repeats are labelled."""
import hashlib
import json
from pathlib import Path
import sys

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

root, output = map(Path, sys.argv[1:])
assert not output.exists()
analysis = json.loads((root / "analysis.json").read_text(encoding="utf8"))
audit = json.loads((root / "audit.json").read_text(encoding="utf8"))
assert audit["status"] == "passed"
output.mkdir()
plt.rcParams.update({"font.family": "DejaVu Sans", "font.size": 11, "svg.fonttype": "none", "text.color": "#1C2D43"})
fig = plt.figure(figsize=(13, 8), facecolor="#F7F9FC")
fig.text(.055, .94, "Can a discovered repair become a reusable procedure?", fontsize=21, weight="bold")
fig.text(.055, .894, "Bitterbot · two model-generated procedures · four previously consumed synthetic case clusters", fontsize=11, color="#536277")
grid = fig.add_gridspec(1, 2, left=.205, right=.95, top=.76, bottom=.31, wspace=.55)
ax = fig.add_subplot(grid[0, 0], facecolor="#F7F9FC")
groups = ["retrieval:shared", "advice:candidate-0", "compiled:candidate-0", "advice:candidate-1", "compiled:candidate-1"]
labels = ["Raw evidence", "Procedure A · advice", "Procedure A · executed", "Procedure B · advice", "Procedure B · executed"]
colors = ["#7D8DA3", "#859CCC", "#008578", "#859CCC", "#008578"]
for y, group in enumerate(groups):
    row = next(r for r in analysis["summary"] if r["group"] == group)
    value = 100 * row["repaired"] / row["assigned"]
    ax.barh(y, value, color=colors[y], height=.58)
    ax.text(value+2, y, f"{row['repaired']}/{row['assigned']}", va="center", weight="bold")
ax.set_yticks(range(5), labels)
ax.invert_yaxis()
ax.set_title("Same four failed starting states", loc="left", pad=20, weight="bold", fontsize=12)
ax.set_xlabel("Native-verified repairs · 3 runs/state", fontsize=10)
bx = fig.add_subplot(grid[0, 1], facecolor="#F7F9FC")
for y, row in enumerate(analysis["panel"]):
    value = 100 * row["repaired"] / row["failed"]
    bx.barh(y, value, color="#008578", height=.5)
    bx.text(value+2, y, f"{row['repaired']}/{row['failed']}", va="center", weight="bold")
bx.set_yticks([0, 1], ["Procedure A", "Procedure B"])
bx.invert_yaxis()
bx.set_title("28 other failed recorded states", loc="left", pad=20, weight="bold", fontsize=12)
bx.set_xlabel("Native-verified repairs · abstentions included", fontsize=10)
for axis in [ax, bx]:
    axis.set_xlim(0, 119)
    axis.set_xticks([0, 25, 50, 75, 100], ["0", "25", "50", "75", "100%"])
    axis.set_axisbelow(True)
    axis.grid(axis="x", color="#DEE5ED", linewidth=.8)
    axis.tick_params(length=0, pad=8)
    for spine in axis.spines.values():
        spine.set_visible(False)
healthy = "; ".join(f"{chr(65+i)}: {r['preserved']}/{r['healthy']} preserved, {r['healthyWrites']} writes" for i, r in enumerate(analysis["panel"]))
fig.text(.055, .21, "Already-working state check — " + healthy, fontsize=11, weight="bold")
fig.text(.055, .16, f"Raw evidence includes {len(analysis['review']['interfaceErrors'])} rejected outputs. Independent verification rejected {len(analysis['review']['falseSelfVerifications'])} procedure success claims.", fontsize=10)
fig.text(.055, .11, "Development only: repeated executions and additional states are not independent new tasks. Privileged simulator access.", fontsize=10, color="#536277")
fig.text(.055, .075, "The development gate failed. No ordinary-agent or recipient benefit established. Zero inference during execution is by design.", fontsize=10, color="#536277")
fig.savefig(output / "results.png", dpi=160, facecolor=fig.get_facecolor())
fig.savefig(output / "results.svg", facecolor=fig.get_facecolor())
plt.close(fig)
sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
manifest = {"run": root.name, "analysisHash": sha(root / "analysis.json"), "auditHash": sha(root / "audit.json"), "matplotlib": matplotlib.__version__, "generatorHash": sha(Path(__file__))}
(output / "manifest.json").write_text(json.dumps(manifest, indent=2)+"\n", encoding="utf8")
(output / "plot-guarded-procedure.py").write_bytes(Path(__file__).read_bytes())
print(json.dumps(manifest))
