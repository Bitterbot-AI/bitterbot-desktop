---
summary: "Set up Compute buyers and GPU operators in the integrated release"
read_when:
  - Installing Compute or setting up a buyer or GPU operator
title: "Soapbox Compute"
---

# Soapbox Compute

Compute is enabled by default in Bitterbot's main sidebar. This public beta
runs approved CPU hashing and GPU embedding workloads. Private and collective
work uses the Bitterbot P2P mesh. Paid single jobs use a coordinator and
**Base Sepolia test USDC only (chain 84532)**, with a separate Compute wallet.
Mainnet settlement and paid P2P batches are not available in this beta.

Opening Compute does not start a worker or fund a job. Operator activation,
peer access and each payment require deliberate actions in the UI.

## Install Compute

Use [Bitterbot v1.11.0-beta.1](https://github.com/Bitterbot-AI/bitterbot-desktop/releases/tag/v1.11.0-beta.1).
This release includes the gateway, Control UI, signed orchestrator 0.2.4 and Soapbox rc9.
Linux x64 also includes the checksum-pinned Soapbox runtime required by the
operator wizard. Node is bundled; a separate source checkout is unnecessary.
The older Soapbox rc4/rc5/rc6 overlays are for their recorded Bitterbot versions
and must not be installed over this integrated release.

Existing installs upgrade with `bitterbot update` or the in-app update; the
previous app version is retained for rollback. The native Tauri installer is
not part of this release.

### Windows with WSL2

In PowerShell, run:

```powershell
.\install.ps1 -Version 1.11.0-beta.1
```

The installer uses your default WSL2 distribution; use `-Distro Ubuntu` to select
one. It checks for WSL2 and explains missing prerequisites. It does not install
WSL, GPU drivers or Docker for you. An existing native Windows gateway is
reported separately; the installer does not stop its scheduled task. To pin a
release, download **install.ps1** from that release and pass `-Version 1.10.0`.

### Linux or macOS

```bash
bash install.sh --version 1.11.0-beta.1 --require-signature
```

The installer verifies the release signature and archive checksum, installs the
bundled runtime and offers onboarding. Existing users are offered a gateway
switch; the previous app version is retained. `--no-switch` (Windows:
`-NoSwitch`) leaves an existing gateway running. To pin a release, download
**install.sh** from that release and run
`bash install.sh --version 1.10.0 --require-signature`. Normal updates select
stable releases only; a beta build, when one is published, is installed by its
explicit `X.Y.Z-beta.N` version and never replaces latest.

## Choose how to use Compute

| Use                                     | Setup                                                                      | Wallet                                                   |
| --------------------------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------- |
| Buy private or collective work over P2P | Enable P2P; ask an operator to grant your peer access                      | None                                                     |
| Host a private or collective GPU pool   | Enable the local GPU operator; grant selected peers access                 | None                                                     |
| Buy a paid test job                     | Create a Compute test wallet and import a buyer enrollment                 | Separate Base Sepolia account                            |
| Earn test USDC as an operator           | Connect to an existing paid coordinator and import its operator enrollment | Public Base Sepolia payout address; no buyer signing key |

A release download does not provide a public paid coordinator or enrollment.
The coordinator owner supplies the scoped enrollment for paid tests. Never
share wallet secrets or use a mainnet deposit to fund this beta.

## Host a P2P GPU operator

The current operator supports an **Ubuntu 24.04 x64 gateway**, including WSL2,
with an NVIDIA GPU, working Docker/NVIDIA Container Toolkit, cgroup v2 and
enforced swap limits. Allow at least 4 GiB free disk. macOS and Linux ARM can
act as buyers; they cannot run this beta's NVIDIA operator runtime.

1. Open **Compute → Set up buyer or operator** and choose **GPU operator**.
2. Under **Host a P2P compute pool**, click **Enable this GPU operator**.
   Setup verifies the bundled runtime, checks Docker/NVIDIA, prepares the
   pinned model and verifies isolated GPU execution. The first preparation
   downloads the container/model and can take several minutes.
3. Wait for successful activation. The gateway supervises a local coordinator
   and worker. The initial allowance is one CPU thread and 2 GiB of host memory;
   GPU VRAM is a separate resource. No wallet or enrollment file is needed.
4. Enable Bitterbot P2P and grant the intended buyer's peer ID access in
   **P2P Compute**. The default private pool is `private`; the collective
   project is `community`. Circle membership alone does not grant execution.
5. Use **Pause new work** when you want to stop accepting allocations.

If setup fails, read its prerequisite/progress message, correct the underlying
Docker, GPU or disk issue and retry. Setup does not change Docker permissions
or install drivers. A damaged runtime requires reinstalling the release.

## Submit private or collective work

1. Open **Compute → P2P Compute** on the buyer and ensure P2P is connected.
2. Have the operator grant your Bitterbot peer ID the matching pool/project.
3. Select an available operator, choose Private or Collective, and enter
   `private` or `community` to match the grant.
4. Start with CPU SHA-256 and one input. Then try GPU embeddings using a model
   advertised by every selected operator. Follow batch progress and results
   in Compute; the P2P dashboard shows the same local activity.

Buyers need no local GPU or coordinator for P2P work. Capacity announcements
expire when an operator goes offline. Cancel finishes immediately if no submission
was sent. Otherwise it stays pending until the operator confirms, including after
access is revoked. Pending cancellation retries automatically after reconnection
or a gateway restart; it never submits new work or requests access again.
Only send data that the selected operators are allowed to see.

## Buy a paid Base Sepolia test job

1. Open **Compute → Set up buyer or operator**, choose **Buyer**, and create
   the Compute test wallet. Use configured CDP authentication or supply your
   own in the wizard. Sharing CDP authentication does not merge wallet accounts.
2. Confirm the displayed wallet is the Compute Base Sepolia address. Share
   only that public address with the coordinator owner to obtain a buyer
   enrollment. Import, review and activate the enrollment.
3. Fund that address with **Base Sepolia test USDC and test ETH for gas**.
4. Submit an approved workload. Review the job's exact quote and click Fund.
   Limits are 0.10 test USDC per job and 1 test USDC over a rolling day.
5. Follow execution and payment status, then verify settlement to the
   operator's displayed payout address. After a timeout, refresh payment
   state before retrying; the spending reservation is deliberately retained.

Funding requires an owner/admin UI connection, a reviewed quote and the shared
wallet spending gate. Changed quotes require another review. Chat/backend
requests cannot approve funding. The release pins the allowed escrow contract
and bytecode hash; an enrollment cannot substitute another contract or chain.

The account name is `bitterbot-compute-base-sepolia`. Compute uses its own
identity, ledger and review records under
`~/.bitterbot-soapbox/wallet/base-sepolia/`. Main/Compute address collisions
and unexpected CDP identity changes are rejected. Legacy test identities keep
their existing funds; do not delete identity files to resolve a conflict.
This release never migrates or transfers mainnet funds.

## Earn test USDC through an existing coordinator

In the GPU operator wizard, select **Connect to an existing coordinator for
paid Base Sepolia jobs instead**. Import the scoped operator enrollment,
review the payout address, click **Prepare GPU runtime**, then activate after
verification. This enrollment cannot access the buyer wallet or submit jobs.
No buyer signing key is required on the operator.

The one-click local P2P pool does not automatically become a paid operator.
Paid coordinator jobs and private/collective mesh batches are distinct paths.

## Data, recovery and rollback

### Permission changes and revocation

With the authorization-recovery update installed in both the gateway and Soapbox
runtime, narrowing a peer grant cancels its queued or running jobs in the removed
pools/projects. Work in scopes that remain granted is preserved. The runtime
rechecks the current admission at submission, claim, lease renewal and result
commit; an HTTP request authenticated before a change cannot enqueue using a
revoked credential. Grant updates rotate the local runtime credential.

Revocation immediately persists local denial in the gateway. If the coordinator
is unavailable, Compute reports revocation as pending and retries automatically
on its service cycle and after restart. No manual revoke retry is required once
the coordinator is reachable. Re-admission waits for pending cleanup to finish.
The runtime commits credential removal and cancellation together. Until that
commit succeeds, gateway denial alone does not establish that a remote worker
has stopped. Cancellation rejects further results; already executed effects
cannot be undone, and physical GPU shutdown can lag.

These changes do not enable paid mesh work, alter the default-on Compute setting,
or change the dedicated Base Sepolia wallet. Upgrade both components together;
1.10.1-beta.1 introduced both fixes. Beta.2 bundles rc8 and adds cancellation
recovery without re-admission or submission replay.

### Cancellation after lost replies, offline periods or revocation

The operator authenticates the cancelling peer's P2P identity and accepts only
its own batch/shard identifier. The runtime records a durable cancellation fence
before acknowledging it. A delayed submission using that identifier is refused,
even after restart or a later access grant. This narrow cancellation route grants
no submission/read access and returns no inputs or results. If work already
completed, the UI reports that fact; cancellation cannot undo its effects.

Both gateways and the operator runtime must have this update. An older operator
cannot acknowledge the new cancellation request, so it remains pending until
the operator upgrades. Do not restore access simply to clear a cancelled job.

Setup data, local coordinator state and verified runtime/model files live under
the gateway state directory's `compute/setup/`. The buyer's durable mesh journal
stores job inputs/results locally; selected operators also process and store
their assigned inputs. Operator credentials and supplied CDP authentication
are local private files. OS-backed secret storage is not implemented yet.

For an app upgrade, retain the installer's previous version and use
`bitterbot update --rollback` to return to it. Stop or settle outstanding work
before deliberately switching versions. Soapbox rc8 upgrades its coordinator
database to schema 2. Older runtimes refuse that database to protect cancellation
records; a desktop rollback to a release bundling rc7 cannot resume that operator.
Reinstall the matching rc8-or-newer release to resume. Do not delete the database
or restore an older snapshot to clear this check: that loses cancellation fences.
Rollback keeps wallet data; it is not
a reversal of a transaction or completed job. Do not use the old overlay's
**Soapbox-Setup** rollback against an integrated installation. Keep a backup of
the gateway state and separate Compute wallet identity before moving machines.

## Beta scope and validation

The beta exposes signed capacity discovery, explicit admission, encrypted peer
submission and durable private/collective batches. Announced capacity is
self-reported. CPU results are recomputed; GPU results have shape and pinned
runtime checks and require trusted operators. Current workloads pool batch
throughput; they do not combine GPU memory into a single device.

The release notes record the checks actually run on the packaged build.
Multiple local P2P identities are not evidence of a physical two-machine/NAT
test. Paid P2P settlement, durable distributed storage, independent GPU result
verification and fleet-scale discovery remain follow-ups. A paid coordinator
on another machine needs HTTPS or an agreed private tunnel; setup does not
open firewall ports.

See [Compute mesh architecture](./soapbox-compute-mesh.md) for protocol,
resource limits and the rollout roadmap.
