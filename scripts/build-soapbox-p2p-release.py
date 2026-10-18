"""Stage Compute changes on the supported desktop release without replacing its other features."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import re

root = Path(__file__).resolve().parent.parent
base = Path(sys.argv[1]).resolve()
stage = Path(tempfile.mkdtemp(prefix="soapbox-rc5-source-"))
git = "/usr/bin/git"
ancestor_ref = "268c765e84b233312e3924c427dbfba46c5ba57c"
archive = stage / "source.tar"
subprocess.run([git, "-C", str(base), "archive", "--format=tar", f"--output={archive}", "HEAD"], check=True)
subprocess.run(["tar", "-xf", str(archive), "-C", str(stage)], check=True)
archive.unlink()

# Three-way integration retains changes unique to the installed release.
for name in ["src/gateway/server-startup.ts", "src/gateway/server.impl.ts", "src/gateway/server-close.ts",
             "src/gateway/server-methods/types.ts", "src/circles/circle-p2p-transport.ts", "src/infra/orchestrator-bridge.ts"]:
    ancestor = stage / "ancestor.tmp"
    ancestor.write_bytes(subprocess.check_output([git, "-C", str(root), "show", f"{ancestor_ref}:{name}"]))
    result = subprocess.run([git, "merge-file", str(stage/name), str(ancestor), str(root/name)])
    if result.returncode and name == "src/gateway/server-startup.ts":
        merged = (stage/name).read_text()
        pattern = r'<<<<<<<[^\n]*\n(.*?)=======\n(.*?)>>>>>>>[^\n]*\n'
        conflicts = list(re.finditer(pattern, merged, re.S))
        if len(conflicts) == 1 and 'startMonitorEngine' in conflicts[0][1] and 'computeMesh,' in conflicts[0][2]:
            keep_monitor = conflicts[0][1].split('  return {')[0]
            (stage/name).write_text(merged[:conflicts[0].start()] + keep_monitor + conflicts[0][2] + merged[conflicts[0].end():])
            result.returncode = 0
    if result.returncode:
        raise RuntimeError(f"Release integration conflict: {stage/name}")
    ancestor.unlink()

for folder in ["src/compute", "desktop/renderer/src/components/compute", "extensions/soapbox-compute"]:
    shutil.copytree(root/folder, stage/folder, dirs_exist_ok=True)
for folder in ["src/infra", "src/services", "src/gateway/server-methods"]:
    for file in (root/folder).glob("soapbox*.ts"):
        shutil.copyfile(file, stage/folder/file.name)
for name in ["src/gateway/server-methods/compute-mesh.ts", "scripts/build-gateway-entry.mjs"]:
    shutil.copyfile(root/name, stage/name)

def replace(name, before, after):
    file = stage/name
    text = file.read_text()
    assert text.count(before) == 1, (name, before)
    file.write_text(text.replace(before, after))

methods = 'src/gateway/server-methods.ts'
replace(methods, 'const ADMIN_METHOD_PREFIXES = ["exec.approvals."];', 'const ADMIN_METHOD_PREFIXES = ["exec.approvals.", "soapbox.setup.", "soapbox.mesh."];')
replace(methods, 'const READ_METHODS = new Set([', 'const READ_METHODS = new Set(["soapbox.wallet", "soapbox.status", "soapbox.jobs", "soapbox.job", "soapbox.artifact.get",')
replace(methods, 'const WRITE_METHODS = new Set([', 'const WRITE_METHODS = new Set(["soapbox.submit", "soapbox.cancel", "soapbox.artifact.put",')
replace(methods, 'import { configHandlers }', 'import { computeMeshHandlers } from "./server-methods/compute-mesh.js";\nimport { configHandlers }')
replace(methods, '  ...configHandlers,', '  ...configHandlers,\n  ...computeMeshHandlers,')
source = (root/'src/gateway/server-methods-list.ts').read_text()
prefix = source[source.index('  "soapbox.setup.status",'):source.index('  "health",')]
replace('src/gateway/server-methods-list.ts', 'const BASE_METHODS = [', 'const BASE_METHODS = [\n'+prefix)
replace('desktop/renderer/src/components/layout/AppShell.tsx', 'const VIEW_MAP:', 'import { ComputeView } from "../compute/ComputeView";\nconst VIEW_MAP:')
replace('desktop/renderer/src/components/layout/AppShell.tsx', '  chat: () => <ChatView />,', '  compute: () => <ComputeView />,\n  chat: () => <ChatView />,')
replace('desktop/renderer/src/nav-manifest.ts', '  // ── Advanced ──', '  { id: "compute", label: "Compute", icon: Server, group: "main" },\n  // ── Advanced ──')
# Only insert the Compute panel into the installed P2P dashboard; retain other release UI.
local = (root/'desktop/renderer/src/components/p2p/P2pDashboard.tsx').read_text()
target = stage/'desktop/renderer/src/components/p2p/P2pDashboard.tsx'
text = target.read_text()
text = 'import { MeshPanel } from "../compute/MeshPanel";\n'+text
# Match the insertion context from the source change instead of copying the older dashboard.
diff = subprocess.check_output([git, '-C', str(root), 'diff', '--unified=3', ancestor_ref, '--', 'desktop/renderer/src/components/p2p/P2pDashboard.tsx'], text=True)
lines = diff.splitlines()
for i,line in enumerate(lines):
    if line.startswith('+') and '<MeshPanel' in line:
        anchor = '\n'.join(l[1:] for l in lines[i+1:i+4] if l.startswith(' '))
        assert anchor and text.count(anchor)==1, 'P2P panel insertion anchor changed'
        text=text.replace(anchor,line[1:]+'\n'+anchor)
target.write_text(text)
for name in ['node_modules', 'desktop/node_modules']:
    os.symlink(base/name,stage/name,target_is_directory=True)
output = root/'dist/soapbox-integration'
output.mkdir(parents=True,exist_ok=True)
(output/'source-stage.json').write_text(json.dumps({'stage':str(stage),'base':str(base)}))
print(stage,flush=True)
