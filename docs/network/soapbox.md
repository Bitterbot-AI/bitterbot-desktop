---
summary: "Install and use the private Soapbox Compute pilot"
read_when:
  - Setting up a Compute buyer or GPU operator
title: "Soapbox Compute"
---

# Soapbox Compute

Compute is enabled by default and appears in the main sidebar. Setup, worker
activation and payments require deliberate user actions. Soapbox runs approved CPU
hashing and GPU embedding workloads on explicitly admitted operators. Payments use
Base Sepolia test USDC. Mainnet settlement is disabled.

## Install the private test release

Download the Windows/WSL ZIP or Linux archive from the private
[Soapbox release](https://github.com/Bitterbot-AI/soapbox/releases/tag/v0.3.0-rc.3).
Extract the entire archive, then open **Soapbox-Setup.exe** on Windows or
**Soapbox-Setup** on Ubuntu. Choose Buyer or GPU operator and run the prerequisite
checks. Acknowledge the installation, install the wizard and follow the Open
Bitterbot link. Restart Bitterbot normally if it does not reconnect automatically.

The add-on supports Bitterbot 1.8.0 on Ubuntu 24.04 x64 or WSL2 Ubuntu 24.04.
Windows uses the default WSL distribution. Bitterbot supplies Node 22 or newer.
Buyers need 256 MiB free disk. Operators need at least 4 GiB, an NVIDIA GPU, working
Docker/NVIDIA Container Toolkit, cgroup v2 and enforced swap limits. The installer
checks these prerequisites; it does not install drivers or change Docker permissions.
This unsigned private preview includes a version-specific Control UI overlay.

## Buyer

Open **Compute → Set up buyer or operator**, choose Buyer and initialize a separate
test wallet. Supply your own CDP authentication or use the gateway's configured CDP
authentication. Give only the displayed public address to the coordinator owner.
Import the scoped buyer enrollment they provide, review it and activate.

Obtain Base Sepolia test USDC and test ETH for gas. Submit an approved workload,
review the returned quote and click Fund for that exact job. Limits remain 0.10
USDC per job and 1 USDC over a rolling day. Changed quotes require another review.
Funding and payment refresh require an admin connection. A timeout retains the
spend reservation; refresh the payment state before retrying.

New accounts use `bitterbot-compute-base-sepolia`. Main/Compute address collisions
and unexpected CDP identity changes are rejected before activation or funding.
Existing legacy test accounts retain their identities and funds while the main
wallet remains on Base; legacy accounts are blocked if the main wallet uses Base
Sepolia. Do not delete a wallet identity file to resolve a conflict. An intentional
migration needs a new Compute account, a new enrollment and separate handling of
remaining test funds. This installer does not migrate funds or identities.

The release pins the approved escrow address and deployed bytecode hash in
`src/infra/soapbox-payment-policy.ts`. Enrollment cannot substitute another contract
and may specify only the public Base Sepolia RPC endpoint. The explicit-click
private pilot approval gate is separate from the newer desktop main's AP2 mandate
integration, which remains required before general agent-initiated payments.

## GPU operator

Choose GPU operator and import the scoped operator enrollment from the coordinator.
Review the Base Sepolia payout address. No buyer wallet or signing key is needed.
Click **Prepare GPU runtime**. The bundled, checksum-pinned runtime builds its fixed
container image, downloads the approved model and verifies isolated GPU execution.
Acknowledge the resource allowance, then activate. Use **Pause new work** to stop
new allocations. The GUI enables approved paid test jobs; private/collective pool
membership still requires coordinator authorization.

## What is stored

- Installer deployments, rollback journals and private config backups live under
  the gateway state directory's `compute/` folder.
- Participant enrollment, worker configuration and runtime/model data live under
  `compute/setup/`. Enrollment contains a scoped API token, never a wallet key.
- The Compute wallet uses `~/.bitterbot-soapbox/wallet/base-sepolia/` with its own
  identity, transaction history and `funding-approvals.jsonl` review records.
- Supplied CDP credentials are stored in a private 0600 file. OS-backed secret
  storage is future work. Protect the local user account and disk accordingly.

## Rollback

Reopen the installer, acknowledge **Restore the previous Compute setup and keep my
wallet data**, then click **Roll back this installation**. Finish or cancel and
settle visible pending jobs first. The coordinator must be reachable to check an
activated participant. Conflicting Compute changes block automatic rollback.

Rollback restores the configuration fields owned by that installation and keeps
unrelated later edits. Wallet files, history, models and backups are retained. It
does not uninstall Docker or delete user data. Restart Bitterbot if necessary.

## Gateway permissions and lifecycle

The `soapbox-compute` plugin is the sole registrar for Compute gateway methods and
owns participant clients and worker service lifetimes. The old core env-based
Soapbox service is no longer started by the gateway.

| Methods                                                                                   | Required scope                           |
| ----------------------------------------------------------------------------------------- | ---------------------------------------- |
| `soapbox.status`, `soapbox.wallet`, `soapbox.jobs`, `soapbox.job`, `soapbox.artifact.get` | `operator.read` or stronger              |
| `soapbox.submit`, `soapbox.cancel`, `soapbox.artifact.put`                                | `operator.write` or admin                |
| `soapbox.worker.pause`, `soapbox.payment.fund`, `soapbox.payment.refresh`                 | `operator.admin`                         |
| All `soapbox.setup.*` methods                                                             | `operator.admin`, including setup status |

Operator enrollments cannot access the buyer wallet or submit buyer workloads.
Wallet funding requires the reviewed quote at both the gateway and Compute-wallet
boundary, then applies the spending caps before signing.

## Networking and release limits

The temporary installer binds only to loopback and uses an expiring session token.
Other machines need a coordinator with valid HTTPS or an agreed private tunnel;
the installer does not open public ports or change firewalls. Setup pulls its fixed
container base image and approved Ollama model. Buyer wallets contact CDP and the
public Base Sepolia RPC. See the Soapbox release guide for administrator preparation.

This release is a trusted private pilot. GPU evidence is worker-reported; embeddings
are checked for shape. Storage is temporary and coordinator-local. Signed CI
releases, public enrollment, stronger hostile-operator isolation, relayer recovery,
full AP2 integration and physical two-machine acceptance remain separate milestones.

See the [review disposition](https://github.com/Bitterbot-AI/soapbox/blob/main/docs/RC3-REVIEW-DISPOSITION.md)
for the selected corrections and remaining work.
