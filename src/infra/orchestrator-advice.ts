/**
 * Install-kind aware advice about the P2P orchestrator binary, shared by the
 * onboarding wizard and `bitterbot doctor` (PLAN-56 drift pass). Each install
 * kind gets the binary a different way:
 *
 * - `git`: `pnpm install` (postinstall) fetches the signed prebuilt for the
 *   version in orchestrator/Cargo.toml into ~/.bitterbot/bin, or the
 *   developer builds it with cargo.
 * - `container`: the image carries it at /app/orchestrator/target/release,
 *   fetched and minisign-verified when the image was built.
 * - `tarball`: the release tarball bundles it at
 *   `$BITTERBOT_INSTALL_ROOT/bin`, verified when the tarball was built.
 * - `package`: the package's postinstall fetches it like a checkout does.
 */

import {
  CONTAINER_UPDATE_COMMAND,
  type InstallKind,
  TARBALL_INSTALLER_COMMAND,
  TARBALL_REINSTALL_COMMAND,
} from "./install-kind.js";
import { type BinarySource, INSTALL_ROOT_ENV } from "./orchestrator-binary.js";

const CARGO_BUILD = "cargo build --release --manifest-path orchestrator/Cargo.toml";

/** Remediation lines for "orchestrator binary not found", per install kind. */
export function orchestratorMissingAdvice(kind: InstallKind): string[] {
  switch (kind) {
    case "container":
      return [
        "The image ships it at /app/orchestrator/target/release/bitterbot-orchestrator",
        "(images 1.5.0 and later). Pull a current image on the Docker host:",
        `  ${CONTAINER_UPDATE_COMMAND}`,
      ];
    case "tarball":
      return [
        `The release tarball bundles it at $${INSTALL_ROOT_ENV}/bin; the \`bitterbot\``,
        `launcher sets ${INSTALL_ROOT_ENV}. A gateway started another way must set it.`,
        "To restore a missing binary, reinstall this version (verified download):",
        `  ${TARBALL_REINSTALL_COMMAND}`,
        `  (or re-run the installer: ${TARBALL_INSTALLER_COMMAND})`,
      ];
    case "git":
      return [
        "  Download:  `pnpm install` fetches the signed prebuilt for the version in",
        "             orchestrator/Cargo.toml (minisign-verified, refuses a bad signature)",
        `  Build:     ${CARGO_BUILD}`,
      ];
    case "package":
    case "unknown":
      return [
        "The package's postinstall downloads it into ~/.bitterbot/bin; reinstalling",
        "fetches it again. Or point p2p.orchestratorBinary at a binary you built.",
      ];
  }
}

/**
 * Where the binary's integrity guarantee comes from, per resolved source.
 * Bitterbot keeps no per-file verification record, so this names the gate
 * the binary had to pass to get there (all of them fail closed on a bad or
 * missing signature since the key was pinned for 1.5.0).
 */
export function orchestratorSignatureStatus(source: BinarySource, kind: InstallKind): string {
  switch (source) {
    case "config":
      return "operator-supplied (p2p.orchestratorBinary); Bitterbot does not verify it";
    case "bundled":
      return "minisign-verified when the release tarball was built; install.sh verified the tarball";
    case "release":
      return kind === "container"
        ? "minisign-verified when the image was built"
        : "built from source with cargo; no signature applies";
    case "debug":
      return "built from source with cargo; no signature applies";
    case "prebuilt":
      return (
        "downloaded by the postinstall fetch, which requires a valid minisign signature " +
        "from 1.5.0 on (an older download was checked by SHA-256 only; reinstall to refetch)"
      );
  }
}
