"""Plot audited, measurement-reviewed panels without combining repeated cases.

Usage: python plot-corrected-results.py confirmation-root fresh-root new-output
Requires matplotlib. The output directory must not exist.
"""

import hashlib
import json
from pathlib import Path
import sys

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.colors import LinearSegmentedColormap
import numpy as np


def sha(file):
    return hashlib.sha256(file.read_bytes()).hexdigest()


def load_panel(root, stage):
    files = {
        name: json.loads((root / f"{name}.json").read_text(encoding="utf-8"))
        for name in ["complete", "audit", "analysis", "measurement-review"]
    }
    assert files["complete"]["status"] == "complete"
    for name in ["audit", "analysis", "measurement-review"]:
        assert files[name]["status"] == "passed"
    data = files["analysis"]
    assert data["stage"] == stage
    review = files["measurement-review"]
    for name in ["audit", "analysis", "complete"]:
        assert review[f"{name}Hash"] == sha(root / f"{name}.json")
    assert len(review["episodes"]) == len(data["rows"])
    for row in review["episodes"]:
        assert row["measurementAligned"] is True
        assert row["episodeHash"] == sha(root / f"episode-{row['label']}.json")
    return data


confirmation_root, fresh_root, output = map(Path, sys.argv[1:])
panels = [load_panel(confirmation_root, "confirmation"), load_panel(fresh_root, "fresh")]
assert not output.exists(), "Refusing to overwrite a figure bundle"
output.mkdir()

plt.rcParams.update({
    "font.family": "DejaVu Sans",
    "font.size": 11,
    "axes.titleweight": "bold",
    "axes.labelcolor": "#25334B",
    "text.color": "#17263C",
    "svg.fonttype": "none",
})
fig = plt.figure(figsize=(14, 10.5), facecolor="#F8FAFC")
grid = fig.add_gridspec(2, 2, left=0.17, right=0.95, top=0.81, bottom=0.24,
                      hspace=0.64, wspace=0.27, width_ratios=[1.25, 1])
fig.text(0.045, 0.945, "Can an agent improve its reusable procedure?", fontsize=23, weight="bold")
fig.text(0.045, 0.905, "Bitterbot  /  frozen synthetic telecom comparisons", fontsize=13, color="#536277")
fig.text(0.045, 0.872, "Same model and native tools. Experience-informed proposals versus baseline and proposals without task feedback.", fontsize=10.5)

labels = {
    "baseline": "Baseline",
    "experience-0": "Learned 1 (nominee)",
    "blind-0": "Blind 1",
    "experience-1": "Learned 2",
    "blind-1": "Blind 2",
}
order = ["baseline", "experience-0", "blind-0", "experience-1", "blind-1"]
colors = {"baseline": "#75869C", "experience": "#008578", "blind": "#8198CB"}
cmap = LinearSegmentedColormap.from_list("repairs", ["#F8E9DF", "#B6DFD7", "#008578"])
summaries = []
for number, data in enumerate(panels):
    arms = {a["arm"]: a for a in data["arms"]}
    names = [name for name in order if name in arms]
    ax = fig.add_subplot(grid[number, 0], facecolor="#F8FAFC")
    rates = [100 * arms[name]["repairs"] / arms[name]["episodes"] for name in names]
    ax.barh(range(len(names)), rates, height=0.65,
            color=[colors[name.split("-")[0]] for name in names])
    ax.set_yticks(range(len(names)), [labels[name] for name in names])
    ax.invert_yaxis()
    ax.set_xlim(0, 122)
    ax.set_xticks([0, 25, 50, 75, 100], ["0", "25", "50", "75", "100%"])
    ax.tick_params(axis="both", length=0, pad=8)
    ax.set_axisbelow(True)
    ax.grid(axis="x", color="#DCE3EB", linewidth=0.7)
    for spine in ax.spines.values():
        spine.set_visible(False)
    for y, (name, rate) in enumerate(zip(names, rates)):
        arm = arms[name]
        ax.text(rate + 2, y, f"{arm['repairs']}/{arm['episodes']}", va="center", fontsize=11, weight="bold")
    stage_title = "Confirmation: 6 cases × 2 repeats" if number == 0 else "Fresh: 6 reserved cases × 3 repeats"
    ax.set_title(stage_title, loc="left", pad=18, fontsize=13)
    ax.set_xlabel("Native task success", fontsize=10)

    matrix = np.array([[next(a["repairs"] / a["total"] for a in case["arms"] if a["arm"] == name)
                        for case in data["cases"]] for name in names])
    cells = fig.add_subplot(grid[number, 1], facecolor="#F8FAFC")
    cells.imshow(matrix, vmin=0, vmax=1, cmap=cmap, aspect="auto")
    cells.set_title("Repairs by case", loc="left", pad=18, fontsize=13)
    cells.set_xticks(range(len(data["cases"])), [str(c["index"]) for c in data["cases"]])
    cells.set_yticks([])
    cells.set_xlabel("Case index · same row order", fontsize=10)
    cells.tick_params(axis="x", length=0, pad=8)
    for y, name in enumerate(names):
        for x, case in enumerate(data["cases"]):
            arm = next(a for a in case["arms"] if a["arm"] == name)
            cells.text(x, y, f"{arm['repairs']}/{arm['total']}", va="center", ha="center",
                       color="white" if matrix[y, x] >= 0.8 else "#17263C", weight="bold")
    for spine in cells.spines.values():
        spine.set_visible(False)
    effect = next(c["successDifference"] for c in data["comparisons"]
                  if c["intervention"] == "experience-0" and c["control"] == "baseline")
    summaries.append({"stage": data["stage"], "nomineeVsBaseline": effect,
                      "gatePassed": data["advancementGate"]["passed"], "arms": data["arms"]})

for y, summary in zip([0.17, 0.137], summaries):
    effect = summary["nomineeVsBaseline"]
    fig.text(0.045, y, f"{summary['stage'].capitalize()} · nominee vs baseline: "
             f"{100 * effect['mean']:+.1f} percentage points "
             f"(descriptive 95% case-cluster interval: {100 * effect['low']:.1f} to {100 * effect['high']:.1f}). "
             f"Frozen gate: {'passed' if summary['gatePassed'] else 'not passed'}.", fontsize=10.5)
fig.text(0.045, 0.088, "Exploratory convenience sample. Repeats are not independent cases. Confirmation cases were previously used by the host;", fontsize=9.5, color="#536277")
fig.text(0.045, 0.065, "fresh cases were reserved until this test. Exact-purchase customer variant; not official benchmark parity or a real-user result.", fontsize=9.5, color="#536277")
fig.text(0.045, 0.042, "All assigned trials retained. Candidates frozen before evaluation. No model-weight update or distributed transfer tested.", fontsize=9.5, color="#536277")

for extension in ["png", "svg"]:
    fig.savefig(output / f"results.{extension}", dpi=180, facecolor=fig.get_facecolor())
plt.close(fig)
source = Path(__file__)
(output / source.name).write_bytes(source.read_bytes())
manifest = {
    "kind": "audited-results-figure",
    "matplotlib": matplotlib.__version__,
    "numpy": np.__version__,
    "sourceHash": sha(source),
    "sources": [{"run": root.name, "files": {
        name: sha(root / name) for name in ["audit.json", "analysis.json", "measurement-review.json"]
    }} for root in [confirmation_root, fresh_root]],
    "panels": summaries,
    "outputs": {name: sha(output / name) for name in ["results.png", "results.svg"]},
    "newProviderCalls": 0,
}
(output / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
print(json.dumps({"status": "created", "output": str(output.resolve())}))
