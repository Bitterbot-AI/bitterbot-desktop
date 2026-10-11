import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useGatewayStore } from "../../stores/gateway-store";
import {
  parseUpdateEvent,
  shouldShowUpdateBanner,
  useUpdateStore,
  type UpdateInfo,
} from "../../stores/update-store";
import { UpdateCard } from "./UpdateCard";

function containerInfo(partial: Partial<UpdateInfo>): UpdateInfo {
  return {
    version: "1.4.0",
    installKind: "container",
    sha: null,
    branch: null,
    registryLatest: "1.5.0",
    staleness: { behind: null, threshold: 20, stale: true, reason: "image-version" },
    checkedAt: Date.now(),
    ...partial,
  };
}

describe("UpdateCard in a container (PLAN-56 Phase 2)", () => {
  beforeEach(() => {
    useGatewayStore.setState({ status: "connected", request: vi.fn(), hello: null } as never);
    useUpdateStore.setState({ info: null, outcome: null, updating: false, checking: false });
  });

  it("names the newer image and the pull command, and offers no in-place update", () => {
    useUpdateStore.setState({ info: containerInfo({}) });
    render(<UpdateCard />);
    expect(screen.getByText("Image 1.5.0 available; pull to update.")).toBeTruthy();
    expect(screen.getByText("docker compose pull && docker compose up -d")).toBeTruthy();
    expect(screen.queryByText("Update now")).toBeNull();
  });

  it("says up to date when the latest image is the running one", () => {
    useUpdateStore.setState({
      info: containerInfo({
        registryLatest: "1.4.0",
        staleness: { behind: null, threshold: 20, stale: false, reason: "fresh" },
      }),
    });
    render(<UpdateCard />);
    expect(screen.getByText(/Up to date with the latest image \(v1\.4\.0\)/)).toBeTruthy();
  });

  it("says unknown when GitHub could not be asked", () => {
    useUpdateStore.setState({
      info: containerInfo({
        registryLatest: null,
        staleness: { behind: null, threshold: 20, stale: false, reason: "unknown" },
      }),
    });
    render(<UpdateCard />);
    expect(screen.getByText(/Latest image unknown/)).toBeTruthy();
  });

  it("warns that the :1 tag will not pull a new major", () => {
    useUpdateStore.setState({ info: containerInfo({ registryLatest: "2.0.0" }) });
    render(<UpdateCard />);
    expect(screen.getByText(/new major version/)).toBeTruthy();
  });

  it("keeps the in-place update button for git installs", () => {
    useUpdateStore.setState({
      info: {
        version: "1.4.0",
        installKind: "git",
        sha: "abcdef1234",
        branch: "main",
        registryLatest: null,
        staleness: { behind: 3, threshold: 20, stale: false, reason: "fresh" },
        checkedAt: Date.now(),
      },
    });
    render(<UpdateCard />);
    expect(screen.getByText("Update now")).toBeTruthy();
    expect(screen.queryByTestId("update-card-container")).toBeNull();
  });

  it("the update event keeps installKind container", () => {
    const parsed = parseUpdateEvent({
      version: "1.4.0",
      installKind: "container",
      staleness: { behind: null, threshold: 20, stale: true, reason: "image-version" },
    });
    expect(parsed?.installKind).toBe("container");
  });

  it("dismissing the banner for image 1.5.0 does not hide 1.6.0", () => {
    useUpdateStore.setState({
      info: containerInfo({ registryLatest: "1.5.0" }),
      dismissedSha: null,
    });
    useUpdateStore.getState().dismissBanner();
    const dismissed = useUpdateStore.getState().dismissedSha;
    expect(
      shouldShowUpdateBanner({
        info: containerInfo({ registryLatest: "1.5.0" }),
        updating: false,
        dismissedSha: dismissed,
      }),
    ).toBe(false);
    expect(
      shouldShowUpdateBanner({
        info: containerInfo({ registryLatest: "1.6.0" }),
        updating: false,
        dismissedSha: dismissed,
      }),
    ).toBe(true);
  });
});

describe("UpdateCard for a release-tarball install (PLAN-56 Phase 3a)", () => {
  function tarballInfo(partial: Partial<UpdateInfo>): UpdateInfo {
    return containerInfo({
      installKind: "tarball",
      staleness: { behind: null, threshold: 20, stale: true, reason: "package-version" },
      ...partial,
    });
  }

  beforeEach(() => {
    useGatewayStore.setState({ status: "connected", request: vi.fn(), hello: null } as never);
    useUpdateStore.setState({ info: null, outcome: null, updating: false, checking: false });
  });

  it("names the newer release and the installer command, and offers no in-place update", () => {
    useUpdateStore.setState({ info: tarballInfo({}) });
    render(<UpdateCard />);
    expect(screen.getByText("Release 1.5.0 available; re-run the installer.")).toBeTruthy();
    expect(screen.getByText(/main\/scripts\/install\.sh \| bash/)).toBeTruthy();
    expect(screen.queryByText("Update now")).toBeNull();
    expect(screen.queryByTestId("update-card-container")).toBeNull();
  });

  it("says up to date when the latest release is the running one", () => {
    useUpdateStore.setState({
      info: tarballInfo({
        registryLatest: "1.4.0",
        staleness: { behind: null, threshold: 20, stale: false, reason: "fresh" },
      }),
    });
    render(<UpdateCard />);
    expect(screen.getByText(/Up to date with the latest release \(v1\.4\.0\)/)).toBeTruthy();
  });

  it("the update event keeps installKind tarball", () => {
    const parsed = parseUpdateEvent({
      version: "1.4.0",
      installKind: "tarball",
      staleness: { behind: null, threshold: 20, stale: true, reason: "package-version" },
    });
    expect(parsed?.installKind).toBe("tarball");
  });
});
