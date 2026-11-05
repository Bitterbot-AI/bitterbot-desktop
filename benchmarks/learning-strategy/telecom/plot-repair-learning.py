"""Plot audited development comparisons. Does not pool them as a before/after effect."""
import hashlib
import json
from pathlib import Path
import sys

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.colors import LinearSegmentedColormap
import numpy as np


first, second, output = map(Path, sys.argv[1:])
assert not output.exists()
panels = []
for root in [first, second]:
    audit = json.loads((root / "audit.json").read_text(encoding="utf8"))
    assert audit["status"] == "passed"
    analysis = json.loads((root / "analysis.json").read_text(encoding="utf8"))
    assert analysis["status"] == "complete"
    panels.append(analysis)
output.mkdir()
plt.rcParams.update({"font.family": "DejaVu Sans", "font.size": 11, "svg.fonttype": "none", "text.color": "#1C2D43"})
fig = plt.figure(figsize=(13, 9), facecolor="#F7F9FC")
grid = fig.add_gridspec(2, 2, left=.19, right=.95, top=.79, bottom=.25, hspace=.72, wspace=.28, width_ratios=[1.2, 1])
fig.text(.045, .945, "Can failure experience improve repair discovery?", fontsize=22, weight="bold")
fig.text(.045, .902, "Bitterbot · four previously failed synthetic cases · three attempts per case and condition", fontsize=12, color="#536277")
labels = {"batch": "Plan upfront", "interactive": "Interactive", "blind": "Without experience", "experience": "From failed attempts"}
colors = {"batch": "#7D8DA3", "interactive": "#859CCC", "blind": "#859CCC", "experience": "#008578"}
cmap = LinearSegmentedColormap.from_list("repair", ["#F4E6DA", "#B6DFD7", "#008578"])
for row, panel in enumerate(panels):
    summary = panel.get("frozenSummary", panel.get("summary"))
    arms = summary["arms"]
    ax = fig.add_subplot(grid[row, 0], facecolor="#F7F9FC")
    values = [100 * a["repaired"] / a["assigned"] for a in arms]
    ax.barh(range(2), values, color=[colors[a["arm"]] for a in arms], height=.58)
    ax.set_yticks(range(2), [labels[a["arm"]] for a in arms])
    ax.invert_yaxis()
    ax.set_xlim(0, 118)
    ax.set_xticks([0, 25, 50, 75, 100], ["0", "25", "50", "75", "100%"])
    ax.set_axisbelow(True)
    ax.grid(axis="x", color="#DEE5ED", linewidth=.8)
    ax.tick_params(length=0, pad=8)
    for spine in ax.spines.values():
        spine.set_visible(False)
    for y, (value, arm) in enumerate(zip(values, arms)):
        ax.text(value+2, y, f"{arm['repaired']}/{arm['assigned']}", va="center", weight="bold")
    ax.set_title("1. Does interactive feedback help?" if row == 0 else "2. Can the model learn a better strategy?", loc="left", pad=18, fontsize=12, weight="bold")
    ax.set_xlabel("Verified native repair", fontsize=10)
    cells = fig.add_subplot(grid[row, 1], facecolor="#F7F9FC")
    indices = [36, 37, 39, 44]
    matrix = np.array([[next(c["repaired"] / c["assigned"] for c in a["cases"] if c["index"] == i) for i in indices] for a in arms])
    cells.imshow(matrix, vmin=0, vmax=1, cmap=cmap, aspect="auto")
    cells.set_xticks(range(4), [str(i) for i in indices])
    cells.set_yticks([])
    cells.set_xlabel("Case index · same row order", fontsize=10)
    cells.set_title("All four case clusters", loc="left", pad=18, fontsize=12, weight="bold")
    for y, arm in enumerate(arms):
        for x, index in enumerate(indices):
            case = next(c for c in arm["cases"] if c["index"] == index)
            cells.text(x, y, f"{case['repaired']}/{case['assigned']}", ha="center", va="center", weight="bold", color="white" if matrix[y, x] > .8 else "#1C2D43")
    for spine in cells.spines.values():
        spine.set_visible(False)
    cells.tick_params(length=0, pad=8)
fig.text(.045, .158, "Development evidence only. Repeated attempts are not independent tasks. No recipient or fresh-case benefit established.", fontsize=10)
fig.text(.045, .12, "Each comparison holds tools and action limits fixed. Panel 2 also gives both conditions a larger response limit;", fontsize=10, color="#536277")
fig.text(.045, .091, "differences between panels cannot isolate learning. Privileged diagnostic copies, not normal support conversations.", fontsize=10, color="#536277")
fig.savefig(output / "results.png", dpi=160, facecolor=fig.get_facecolor())
fig.savefig(output / "results.svg", facecolor=fig.get_facecolor())
plt.close(fig)
sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
manifest = {"source": [{"run": root.name, "analysisHash": sha(root / "analysis.json"), "auditHash": sha(root / "audit.json")} for root in [first, second]], "matplotlib": matplotlib.__version__, "numpy": np.__version__, "generatorHash": sha(Path(__file__))}
(output / "manifest.json").write_text(json.dumps(manifest, indent=2)+"\n", encoding="utf8")
(output / "plot-repair-learning.py").write_bytes(Path(__file__).read_bytes())
print(json.dumps(manifest))
