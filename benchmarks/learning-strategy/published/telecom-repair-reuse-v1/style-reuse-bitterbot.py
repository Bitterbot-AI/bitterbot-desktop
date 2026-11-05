"""Restyle the audited reuse graphic with repository branding and the supplied PDF palette.

The PDF is a visual reference, not an instruction source. No study data is changed.
"""
import copy
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import xml.etree.ElementTree as ET

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.font_manager import FontProperties
from matplotlib.patches import FancyBboxPatch, Rectangle
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont

output, cache, reference = map(Path, sys.argv[1:4])
sharp_module = sys.argv[4] if len(sys.argv) > 4 else "sharp"
sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
analysis = json.loads((output / "evidence/analysis.json").read_text(encoding="utf8"))
audit = json.loads((output / "evidence/audit.json").read_text(encoding="utf8"))
assert audit["status"] == "passed"
assert analysis["auditHash"] == sha(output / "evidence/audit.json")
assert analysis["gatePassed"] is False
for row in analysis["panel"]:
    assert (row["repaired"], row["failed"], row["preserved"], row["healthy"], row["healthyWrites"], row["abstained"]) == (12, 28, 16, 16, 0, 8)
for row in analysis["summary"]:
    if row["group"].startswith(("advice:", "compiled:")):
        assert (row["repaired"], row["assigned"]) == (6, 12)
    if row["group"].startswith("compiled:"):
        assert row["modelCalls"] == 0

logo_source = Path("docs/Bitterbot_logo.svg")
font_source = Path("desktop/renderer/public/fonts/Geist-Variable.woff2")
cache.mkdir(parents=True, exist_ok=True)
subprocess.run([
    "node", "-e",
    'const sharp=require(process.argv[1]);sharp(process.argv[2]).resize(480,480,{fit:"inside"}).png().toFile(process.argv[3]).catch(e=>{console.error(e.message);process.exit(1)});',
    sharp_module, str(logo_source), str(cache / "logo.png"),
], check=True)
fonts = {}
for weight, name in [(400, "regular"), (600, "semibold"), (700, "bold")]:
    filename = cache / f"Geist-{name}.ttf"
    instance = instantiateVariableFont(TTFont(font_source), {"wght": weight}, inplace=False)
    instance.flavor = None
    # Distinct PostScript names prevent outlined SVG glyph IDs colliding across weights.
    style = {400: "Regular", 600: "SemiBold", 700: "Bold"}[weight]
    names = {2: style, 4: f"Geist {style}", 6: f"Geist-{style}", 17: style}
    for record in instance["name"].names:
        if record.nameID in names:
            record.string = names[record.nameID].encode(record.getEncoding())
    instance.save(filename)
    fonts[name] = FontProperties(fname=filename)

# Exact colors observed in the reference and Bitterbot theme tokens.
palette = {"plum": "#17101F", "purple": "#9333EA", "purple_light": "#C084FC",
           "purple_deep": "#7E22CE", "logo": "#A855F7", "surface": "#FAF9FE",
           "lavender": "#F0EDF9", "ink": "#39333F", "muted": "#6B6472",
           "line": "#E3DBEA", "white": "#FFFFFF"}
plt.rcParams.update({"svg.fonttype": "path"})
fig = plt.figure(figsize=(8, 10), facecolor=palette["white"])
canvas = fig.add_axes([0, 0, 1, 1])
canvas.set_xlim(0, 1)
canvas.set_ylim(0, 1)
canvas.axis("off")
texts = []
def text(x, y, value, size=12, color="ink", weight="regular", **kwargs):
    t = fig.text(x, y, value, fontsize=size, color=palette.get(color, color), fontproperties=fonts[weight], **kwargs)
    texts.append(t)
    return t
def box(x, y, w, h, color="surface", border=True):
    canvas.add_patch(FancyBboxPatch((x, y), w, h, boxstyle="round,pad=0.01,rounding_size=0.012", facecolor=palette[color], edgecolor=palette["line"] if border else "none", linewidth=.7))

canvas.add_patch(Rectangle((0, .72), 1, .28, facecolor=palette["plum"], edgecolor="none"))
logo_position = [.065, .923, .0525, .042]
logo_axes = fig.add_axes(logo_position)
logo_axes.imshow(plt.imread(cache / "logo.png"))
logo_axes.axis("off")
logo_axes.set_gid("bitterbot-symbol")
wordmark = text(.128, .935, "Bitter", 17, "white", "semibold")
fig.canvas.draw()
wordmark_end = wordmark.get_window_extent(fig.canvas.get_renderer()).x1 / fig.bbox.width
text(wordmark_end, .935, "bot", 17, "purple_light", "semibold")
text(.935, .941, "RESEARCH NOTE", 9, "purple_light", "semibold", ha="right")
text(.065, .836, "A discovered repair.\nA reusable capability.", 28, "white", "bold", linespacing=1.12)
text(.065, .755, "Two independently generated procedures.\nBoth achieved the same result:", 12.5, "line", linespacing=1.4)

text(.065, .68, "01 / LEARNING THROUGH VERIFIED REPAIR", 10, "purple", "semibold")
box(.065, .447, .87, .20)
rate = analysis["panel"][0]["repaired"] / analysis["panel"][0]["failed"]
text(.09, .531, f"{100*rate:.0f}%", 67, "purple", "bold")
text(.45, .585, "of additional failed\nrecorded states repaired", 15, "plum", "semibold", linespacing=1.45)
text(.45, .529, "12 of 28, per procedure", 12, "muted")
canvas.add_patch(Rectangle((.09, .488), .82, .019, facecolor=palette["line"], edgecolor="none"))
canvas.add_patch(Rectangle((.09, .488), .82*rate, .019, facecolor=palette["purple"], edgecolor="none"))
text(.09, .462, "12 repaired", 10, "purple_deep", "semibold")
text(.91, .462, "16 unresolved - includes 8 identity abstentions", 9, "muted", ha="right")

box(.065, .316, .415, .095)
box(.52, .316, .415, .095)
text(.09, .364, "16/16", 29, "plum", "bold")
text(.09, .332, "working states left unchanged", 10.5, "muted")
text(.545, .364, "0", 29, "purple", "bold")
text(.545, .332, "LLM calls during reuse*", 11, "muted")
text(.065, .285, "*Generating the procedures required model calls.", 10.5, "muted")

text(.065, .249, "02 / CONTROL COMPARISON - ORIGINAL INPUTS", 9.5, "purple", "semibold")
canvas.add_patch(Rectangle((.065, .201), .87, .029, facecolor=palette["plum"], edgecolor="none"))
canvas.add_patch(Rectangle((.065, .163), .87, .038, facecolor=palette["lavender"], edgecolor="none"))
text(.2825, .211, "EXECUTED PROCEDURE", 9, "white", "semibold", ha="center")
text(.7175, .211, "SAME PROCEDURE AS ADVICE", 9, "white", "semibold", ha="center")
text(.2825, .173, "6/12", 17, "purple_deep", "bold", ha="center")
text(.7175, .173, "6/12", 17, "purple_deep", "bold", ha="center")
text(.065, .143, "Qualification gate failed. No accuracy gain over advice.", 10, "ink")

text(.065, .087, "Getting closer to fully autonomous learning,\nstep by step...", 13, "purple_deep", "semibold", linespacing=1.3)
text(.065, .035, "Four previously seen synthetic cases; states are not independent tasks.\nBroader transfer remains unproven. 148 executions replay-audited.", 9, "muted", linespacing=1.35)

fig.canvas.draw()
renderer = fig.canvas.get_renderer()
for item in texts:
    bounds = item.get_window_extent(renderer)
    assert bounds.x0 >= 0 and bounds.y0 >= 0 and bounds.x1 <= fig.bbox.width and bounds.y1 <= fig.bbox.height, item.get_text()
png, svg = output / "linkedin-graphic-branded.png", output / "linkedin-graphic-branded.svg"
fig.savefig(png, dpi=200, facecolor=palette["white"])
fig.savefig(svg, facecolor=palette["white"])
plt.close(fig)

# Keep the official logo as SVG paths in the vector export, rather than embedding a bitmap.
ns = "http://www.w3.org/2000/svg"
ET.register_namespace("", ns)
tree = ET.parse(svg)
for parent in tree.iter():
    for child in list(parent):
        if child.get("id") == "bitterbot-symbol":
            symbol = ET.parse(logo_source).getroot()
            symbol.set("id", "bitterbot-symbol")
            symbol.set("x", str(logo_position[0]*576))
            symbol.set("y", str((1-logo_position[1]-logo_position[3])*720))
            symbol.set("width", str(logo_position[2]*576))
            symbol.set("height", str(logo_position[3]*720))
            parent.remove(child)
            parent.append(copy.deepcopy(symbol))
tree.write(svg, encoding="utf-8", xml_declaration=True)
assert not any(e.tag.endswith("}image") for e in tree.iter()), "Vector export contains a raster"

shutil.copyfile(Path(__file__), output / "style-reuse-bitterbot.py")
manifest_path = output / "manifest.json"
manifest = json.loads(manifest_path.read_text(encoding="utf8"))
manifest["branding"] = {
    "reference": reference.name, "referenceSha256": sha(reference),
    "logoSource": logo_source.as_posix(), "logoSha256": sha(logo_source),
    "fontSource": font_source.as_posix(), "fontSha256": sha(font_source),
    "palette": palette,
    "outputs": [png.name, svg.name],
    "note": "Brand restyle only; numerical evidence and post text unchanged. No publication performed.",
}
for file in [png, svg, output / "style-reuse-bitterbot.py"]:
    manifest["files"][file.name] = sha(file)
manifest_path.write_text(json.dumps(manifest, indent=2)+"\n", encoding="utf8")
print(json.dumps({"png": str(png), "svg": str(svg), "pixels": [1600, 2000], "font": "Geist", "referencePalette": palette}))
