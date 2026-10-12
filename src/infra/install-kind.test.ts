import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CONTAINER_UPDATE_COMMAND,
  detectInstallKind,
  externalUpdateCommand,
  gatewayStartCommand,
  hasTarballMarker,
  installKindLabel,
  isSourceTree,
  looksLikeContainer,
  readDeclaredInstallKind,
  resolveInstallKind,
  TARBALL_INSTALL_MARKER,
  TARBALL_UPDATE_COMMAND,
  TARBALL_UPDATE_REFUSAL,
  tarballAssetName,
  tarballPlatformId,
  type ContainerProbe,
} from "./install-kind.js";

function probe(params: {
  env?: Record<string, string>;
  files?: string[];
  cgroup?: string | null;
  /** Readable file contents by path. */
  contents?: Record<string, string>;
}): ContainerProbe {
  const files = new Set(params.files ?? []);
  return {
    env: (params.env ?? {}) as NodeJS.ProcessEnv,
    existsSync: (p) => files.has(p),
    readFileSync: (p) => {
      if (p === "/proc/1/cgroup" && params.cgroup != null) {
        return params.cgroup;
      }
      const content = params.contents?.[p];
      if (content != null) {
        return content;
      }
      throw new Error("ENOENT");
    },
  };
}

describe("readDeclaredInstallKind", () => {
  it("reads BITTERBOT_INSTALL_KIND case-insensitively and ignores junk", () => {
    expect(readDeclaredInstallKind({ BITTERBOT_INSTALL_KIND: "container" })).toBe("container");
    expect(readDeclaredInstallKind({ BITTERBOT_INSTALL_KIND: " Package " })).toBe("package");
    expect(readDeclaredInstallKind({ BITTERBOT_INSTALL_KIND: "vm" })).toBeNull();
    expect(readDeclaredInstallKind({})).toBeNull();
  });
});

describe("looksLikeContainer", () => {
  it("detects Docker and Podman marker files", () => {
    expect(looksLikeContainer(probe({ files: ["/.dockerenv"] }))).toBe(true);
    expect(looksLikeContainer(probe({ files: ["/run/.containerenv"] }))).toBe(true);
  });

  it("detects container runtimes in a cgroup v1 PID 1 entry", () => {
    expect(looksLikeContainer(probe({ cgroup: "12:memory:/docker/0123abcd\n" }))).toBe(true);
    expect(looksLikeContainer(probe({ cgroup: "3:cpu:/kubepods/burstable/pod1/abc\n" }))).toBe(
      true,
    );
  });

  it("does not misfire on WSL2 or a GitHub-hosted runner (VMs, cgroup v2 root)", () => {
    expect(looksLikeContainer(probe({ cgroup: "0::/\n" }))).toBe(false);
    expect(looksLikeContainer(probe({ cgroup: "0::/init.scope\n" }))).toBe(false);
    // A host that merely RUNS Docker: PID 1 is systemd, not a container.
    expect(looksLikeContainer(probe({ cgroup: "0::/init.scope\n", files: [] }))).toBe(false);
  });

  it("is false when nothing can be read", () => {
    expect(looksLikeContainer(probe({ cgroup: null }))).toBe(false);
  });
});

describe("resolveInstallKind", () => {
  it("the image's env declaration wins, even without a root", () => {
    const p = probe({ env: { BITTERBOT_INSTALL_KIND: "container" } });
    expect(resolveInstallKind({ isGit: false, hasRoot: true, probe: p })).toBe("container");
    expect(resolveInstallKind({ isGit: false, hasRoot: false, probe: p })).toBe("container");
  });

  it("a git checkout stays git inside a dev container or CI job (heuristic is skipped)", () => {
    const p = probe({ files: ["/.dockerenv"] });
    expect(resolveInstallKind({ isGit: true, hasRoot: true, probe: p })).toBe("git");
  });

  it("falls back to the heuristic for a package install in an image without the env", () => {
    const p = probe({ files: ["/.dockerenv"] });
    expect(resolveInstallKind({ isGit: false, hasRoot: true, probe: p })).toBe("container");
  });

  it("an explicit package declaration skips the heuristic", () => {
    const p = probe({ env: { BITTERBOT_INSTALL_KIND: "package" }, files: ["/.dockerenv"] });
    expect(resolveInstallKind({ isGit: false, hasRoot: true, probe: p })).toBe("package");
  });

  it("keeps git / package / unknown as before outside containers", () => {
    const p = probe({ cgroup: "0::/init.scope\n" });
    expect(resolveInstallKind({ isGit: true, hasRoot: true, probe: p })).toBe("git");
    expect(resolveInstallKind({ isGit: false, hasRoot: true, probe: p })).toBe("package");
    expect(resolveInstallKind({ isGit: false, hasRoot: false, probe: p })).toBe("unknown");
  });
});

describe("release-tarball install kind (PLAN-56 Phase 3a)", () => {
  const root = "/home/u/.bitterbot/app/1.5.0";
  const marker = path.join(root, TARBALL_INSTALL_MARKER);

  it("reads a tarball declaration from the launcher's env", () => {
    expect(readDeclaredInstallKind({ BITTERBOT_INSTALL_KIND: "tarball" })).toBe("tarball");
  });

  it("the launcher's declaration or the root marker makes it a tarball install", () => {
    const declared = probe({ env: { BITTERBOT_INSTALL_KIND: "tarball" } });
    expect(resolveInstallKind({ isGit: false, hasRoot: true, root, probe: declared })).toBe(
      "tarball",
    );
    const marked = probe({ contents: { [marker]: "tarball\n" } });
    expect(resolveInstallKind({ isGit: false, hasRoot: true, root, probe: marked })).toBe(
      "tarball",
    );
    expect(hasTarballMarker(root, marked)).toBe(true);
    expect(hasTarballMarker(root, probe({ contents: { [marker]: "something-else" } }))).toBe(false);
  });

  it("an inherited tarball env can never turn a git checkout into a tarball install", () => {
    const p = probe({ env: { BITTERBOT_INSTALL_KIND: "tarball" } });
    expect(resolveInstallKind({ isGit: true, hasRoot: true, root, probe: p })).toBe("git");
  });

  it("an explicit package declaration overrides the marker (the documented escape hatch)", () => {
    const p = probe({
      env: { BITTERBOT_INSTALL_KIND: "package" },
      contents: { [marker]: "tarball" },
    });
    expect(resolveInstallKind({ isGit: false, hasRoot: true, root, probe: p })).toBe("package");
  });

  it("names the installer as the update path and keeps containers on compose", () => {
    expect(externalUpdateCommand("tarball")).toBe(TARBALL_UPDATE_COMMAND);
    expect(externalUpdateCommand("container")).toBe(CONTAINER_UPDATE_COMMAND);
    expect(externalUpdateCommand("git")).toBeNull();
    expect(externalUpdateCommand("package")).toBeNull();
    expect(TARBALL_UPDATE_COMMAND).toBe(
      "curl -fsSL https://raw.githubusercontent.com/Bitterbot-AI/bitterbot-desktop/main/scripts/install.sh | bash",
    );
    expect(TARBALL_UPDATE_REFUSAL).toContain(TARBALL_UPDATE_COMMAND);
    expect(TARBALL_UPDATE_REFUSAL).toContain("BITTERBOT_INSTALL_KIND=package");
  });

  it("maps only the published platforms to tarball assets", () => {
    expect(tarballPlatformId("linux", "x64")).toBe("linux-x64");
    expect(tarballPlatformId("linux", "arm64")).toBe("linux-arm64");
    expect(tarballPlatformId("darwin", "arm64")).toBe("darwin-arm64");
    expect(tarballPlatformId("darwin", "x64")).toBeNull();
    expect(tarballPlatformId("win32", "x64")).toBeNull();
    expect(tarballAssetName("1.5.0", "linux-x64")).toBe("bitterbot-1.5.0-linux-x64.tar.gz");
  });
});

describe("detectInstallKind (advice text, drift pass)", () => {
  it("a .git entry at the root is a checkout, even with a container env", () => {
    const root = "/src/bitterbot";
    expect(detectInstallKind(root, probe({ files: [path.join(root, ".git")] }))).toBe("git");
  });

  it("the tarball marker without .git is a tarball install", () => {
    const root = "/home/u/.bitterbot/app/1.5.0";
    expect(
      detectInstallKind(
        root,
        probe({ contents: { [path.join(root, TARBALL_INSTALL_MARKER)]: "tarball\n" } }),
      ),
    ).toBe("tarball");
  });

  it("the image env declares a container; no root is unknown", () => {
    expect(detectInstallKind("/app", probe({ env: { BITTERBOT_INSTALL_KIND: "container" } }))).toBe(
      "container",
    );
    expect(detectInstallKind(null, probe({}))).toBe("unknown");
  });
});

describe("gatewayStartCommand / installKindLabel", () => {
  it("names the start command each install kind actually has", () => {
    expect(gatewayStartCommand("git")).toBe("pnpm start gateway");
    expect(gatewayStartCommand("container")).toBe("docker compose up -d");
    expect(gatewayStartCommand("tarball")).toBe("bitterbot gateway");
    expect(gatewayStartCommand("package")).toBe("bitterbot gateway");
  });

  it("labels every kind", () => {
    for (const kind of ["git", "package", "container", "tarball", "unknown"] as const) {
      expect(installKindLabel(kind).length).toBeGreaterThan(0);
    }
    expect(installKindLabel("tarball")).toContain("install.sh");
  });
});

describe("isSourceTree (LOW-3: ZIP downloads still auto-spawn)", () => {
  const root = "/home/u/bitterbot-desktop-main";
  const zipFiles = [
    path.join(root, "pnpm-workspace.yaml"),
    path.join(root, "scripts", "start-all.mjs"),
  ];
  it("a non-git repository copy with the stack scripts is a source tree", () => {
    expect(isSourceTree(root, "package", probe({ files: zipFiles }))).toBe(true);
  });
  it("a tarball, container or package without scripts/ is not", () => {
    expect(isSourceTree(root, "tarball", probe({ files: zipFiles }))).toBe(false);
    expect(isSourceTree(root, "container", probe({ files: zipFiles }))).toBe(false);
    expect(isSourceTree(root, "package", probe({ files: [] }))).toBe(false);
    expect(isSourceTree(null, "package", probe({ files: zipFiles }))).toBe(false);
  });
  it("a git checkout always is", () => {
    expect(isSourceTree(root, "git", probe({}))).toBe(true);
  });
});
