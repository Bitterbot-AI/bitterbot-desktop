import { describe, expect, it } from "vitest";
import {
  looksLikeContainer,
  readDeclaredInstallKind,
  resolveInstallKind,
  type ContainerProbe,
} from "./install-kind.js";

function probe(params: {
  env?: Record<string, string>;
  files?: string[];
  cgroup?: string | null;
}): ContainerProbe {
  const files = new Set(params.files ?? []);
  return {
    env: (params.env ?? {}) as NodeJS.ProcessEnv,
    existsSync: (p) => files.has(p),
    readFileSync: (p) => {
      if (p === "/proc/1/cgroup" && params.cgroup != null) {
        return params.cgroup;
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
