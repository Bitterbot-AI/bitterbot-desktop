"""Acquire official BIRD SQLite bytes without executing upstream images or scripts.

Inventory pins mutable image tags to manifests and the seed-only final layer.
Fetch verifies every content digest and extracts exactly the regular seed file.
The upstream dataset is CC BY-SA 4.0; preserve README and manifest attribution.
"""
import argparse
import hashlib
import json
import pathlib
import re
import tarfile
import urllib.request

REVISION = "5b256b5a9c17478f06ed6912612e9a14d17065c8"
HF = f"https://huggingface.co/datasets/birdsql/bird_mini_dev/resolve/{REVISION}/"
REPO = "3036197201/bird-mini-dev-sqlite"
REGISTRY = f"https://registry-1.docker.io/v2/{REPO}/"
MEDIA = ", ".join([
    "application/vnd.docker.distribution.manifest.list.v2+json",
    "application/vnd.docker.distribution.manifest.v2+json",
    "application/vnd.oci.image.index.v1+json",
    "application/vnd.oci.image.manifest.v1+json",
])


def digest(data):
    return hashlib.sha256(data).hexdigest()


def get(url, limit=2_000_000, headers=None):
    with urllib.request.urlopen(urllib.request.Request(url, headers=headers or {}), timeout=60) as r:
        data = r.read(limit + 1)
    if len(data) > limit:
        raise ValueError("Download exceeds bound")
    return data


def write_new(file, data):
    with file.open("xb") as f:
        f.write(data)


def registry_headers():
    token = json.loads(get(f"https://auth.docker.io/token?service=registry.docker.io&scope=repository:{REPO}:pull"))["token"]
    return {"Authorization": "Bearer " + token, "Accept": MEDIA}


def pinned_json(route, expected, headers):
    data = get(REGISTRY + route, headers=headers)
    if expected and "sha256:" + digest(data) != expected:
        raise ValueError("Registry digest mismatch")
    return json.loads(data), "sha256:" + digest(data)


def inventory(output):
    headers = registry_headers()
    tags, _ = pinned_json("tags/list", None, headers)
    pins = []
    for tag in sorted(tags["tags"]):
        match = re.fullmatch(r"harbor-minidev1024-r1-([a-z0-9_]+)-[0-9a-f]{12}-[0-9a-f]{8}", tag)
        if not match:
            continue
        index, index_hash = pinned_json("manifests/" + tag, None, headers)
        platform = next(m for m in index["manifests"] if m["platform"] == {"architecture": "amd64", "os": "linux"})
        manifest, manifest_hash = pinned_json("manifests/" + platform["digest"], platform["digest"], headers)
        config, _ = pinned_json("blobs/" + manifest["config"]["digest"], manifest["config"]["digest"], headers)
        nonempty = [h for h in config["history"] if not h.get("empty_layer")]
        if len(nonempty) != len(manifest["layers"]) or nonempty[-1]["created_by"] != "COPY seed.sqlite /opt/dii/seed.sqlite # buildkit":
            raise ValueError("Expected a final seed-only layer")
        pins.append({"database": match[1], "tag": tag, "indexDigest": index_hash,
                     "imageDigest": manifest_hash, "configDigest": manifest["config"]["digest"],
                     "seedLayer": manifest["layers"][-1]})
    if len(pins) != 11 or len({p["database"] for p in pins}) != 11:
        raise ValueError("Unexpected database inventory")
    body = {"schemaVersion": 1, "source": "https://huggingface.co/datasets/birdsql/bird_mini_dev",
            "revision": REVISION, "license": "CC-BY-SA-4.0", "registry": REPO,
            "annotationSha256": "926af2a0d1b47e5d0d15a7aa8a34d4721007f4550a881555b6a89496b54a2606",
            "databases": pins}
    write_new(output, (json.dumps(body, indent=2) + "\n").encode())
    print(json.dumps({"databases": len(pins), "compressedBytes": sum(p["seedLayer"]["size"] for p in pins)}))


def fetch(manifest_path, root):
    pins = json.loads(manifest_path.read_text())
    if pins["revision"] != REVISION:
        raise ValueError("Unexpected revision")
    root.mkdir(mode=0o700)  # No implicit overwrite/resume of partial acquisition.
    headers = registry_headers()
    receipts = []
    for source, target in [("README.md", "README.upstream.md"), ("data/manifest.json", "manifest.upstream.json"), ("data/mini_dev_sqlite.jsonl", "annotations.jsonl"), ("baseline_inference/schemas/sqlite.json", "schemas.json")]:
        data = get(HF + source)
        if target == "annotations.jsonl" and digest(data) != pins["annotationSha256"]:
            raise ValueError("Annotation digest mismatch")
        write_new(root / target, data)
        receipts.append({"file": target, "source": HF + source, "sha256": digest(data), "bytes": len(data)})
    total = 0
    for pin in pins["databases"]:
        name = pin["database"]
        if not re.fullmatch(r"[a-z0-9_]+", name):
            raise ValueError("Invalid database name")
        layer = pin["seedLayer"]
        if layer["size"] > 300_000_000:
            raise ValueError("Compressed layer too large")
        archive = root / (name + ".tar.gz")
        sha = hashlib.sha256()
        count = 0
        with urllib.request.urlopen(urllib.request.Request(REGISTRY + "blobs/" + layer["digest"], headers=headers), timeout=60) as r, archive.open("xb") as f:
            while chunk := r.read(1024 * 1024):
                count += len(chunk)
                if count > layer["size"]:
                    raise ValueError("Layer exceeds declared size")
                sha.update(chunk)
                f.write(chunk)
        if count != layer["size"] or "sha256:" + sha.hexdigest() != layer["digest"]:
            raise ValueError("Layer digest/size mismatch")
        # Never extract paths from the archive; accept precisely two dirs + one regular file.
        with tarfile.open(archive, "r:gz") as tar:
            members = tar.getmembers()
            if len(members) > 4 or any(m.name not in {"opt", "opt/dii", "opt/dii/seed.sqlite"} for m in members):
                raise ValueError("Unexpected seed layer entries")
            seeds = [m for m in members if m.name == "opt/dii/seed.sqlite"]
            if len(seeds) != 1 or not seeds[0].isreg() or not 0 < seeds[0].size <= 1_000_000_000:
                raise ValueError("Invalid SQLite seed")
            total += seeds[0].size
            if total > 3_000_000_000:
                raise ValueError("Total database quota exceeded")
            data = tar.extractfile(seeds[0]).read()
        if not data.startswith(b"SQLite format 3\x00"):
            raise ValueError("Invalid SQLite header")
        write_new(root / (name + ".sqlite"), data)
        receipts.append({"file": name + ".sqlite", "sha256": digest(data), "bytes": len(data), **pin})
        print(json.dumps({"database": name, "bytes": len(data), "sha256": digest(data)}), flush=True)
    write_new(root / "provenance.json", (json.dumps({"manifestSha256": digest(manifest_path.read_bytes()), "files": receipts}, indent=2) + "\n").encode())


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("operation", choices=["inventory", "fetch"])
    parser.add_argument("manifest", type=pathlib.Path)
    parser.add_argument("destination", nargs="?", type=pathlib.Path)
    args = parser.parse_args()
    if args.operation == "inventory":
        inventory(args.manifest)
    else:
        fetch(args.manifest, args.destination)
