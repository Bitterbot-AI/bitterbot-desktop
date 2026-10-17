---
summary: "Connect Bitterbot to the standalone Soapbox trusted compute pilot"
read_when:
  - Configuring shared CPU/GPU workloads or the Compute view
title: "Soapbox Compute"
---

# Soapbox Compute

Soapbox is an independent Rust service for paid, private and collective compute pools.
The desktop integration is **Compute** in the main sidebar and is disabled by default.

Version 0.2 supports isolated CPU SHA-256 batches, real GPU embeddings through a digest-pinned
Ollama model, persistent job accounting, and temporary account-scoped artifacts. Paid jobs can
use Base Sepolia USDC escrow when configured; legacy coordinators use non-redeemable test credits.
This release is a trusted compute pilot. Mainnet settlement and commercial storage remain future work.

## Compute in the main desktop app

Open the normal app at `http://127.0.0.1:19001` and select **Compute**. The local
`soapbox-compute` plugin runs the coordinator, isolated worker and settlement relayer.
There is no second gateway or testnet window. The main Wallet continues to use its existing
network, account and spending history. Compute uses the separate Base Sepolia account
`bitterbot-owner-base-sepolia`, with its ledger in `~/.bitterbot-soapbox/wallet/base-sepolia`.
Its balance and full address appear at the top of Compute. It never uses the main wallet's
`RPC_URL`, `NETWORK_ID`, network setting, ledger or spend limits.

Select **Paid · test USDC** and **GPU embeddings**, and submit
one or more lines of text. Review the quote, then select **Fund … test USDC**. The result
changes to **succeeded** only after the operator's payment is confirmed on Base Sepolia.
The rate is 0.001 test USDC per line. The dedicated test wallet has a 0.1 test USDC
per-transaction cap and a 1 test USDC rolling daily cap.

Jobs, credentials, accounting and logs persist in WSL at `~/.bitterbot-soapbox-pilot`.
The plugin uses the reviewed escrow and separate test accounts from the completed pilot.
Closing the UI leaves the worker and relayer running; gateway shutdown stops its children.
Use **Pause** in the operator panel to stop accepting new work. Docker and the NVIDIA runtime
must be running in WSL; after a host reboot start the container engine before testing.
The Linux worker binary is installed at the sibling repository's `.local/bin/soapbox-linux`.
Normal chat, channels and Compute share the main gateway. The old PowerShell pilot shortcut
opens the main app after integration has been activated.

### Build and install against an existing release

The working checkout and installed release may differ. Build the additive UI against source
matching the installed version, preserving its newer views. The installer checks that version
and never replaces the installed gateway binary or edits the main wallet configuration.

```sh
node scripts/build-soapbox-integration.mjs /home/vicmg/bitterbot-desktop
node scripts/install-soapbox-main.mjs prepare
BITTERBOT_CONFIG_PATH="$HOME/.bitterbot/compute/prepared.json" bitterbot plugins list
node scripts/install-soapbox-main.mjs activate
```

Activation stops the old pilot, migrates only its test-wallet identity and ledger, and writes
the plugin/UI configuration atomically. The gateway config watcher restarts the app.
Versioned assets and `before-config.json` are retained under `~/.bitterbot/compute/release-*`.
To roll back, restore that configuration and restart the gateway; existing jobs and test funds
remain in their state stores. The plugin uses native CommonJS packaging so the extension
loader does not transpile the bundled wallet SDK at startup.

If an existing gateway shutdown hook times out before respawn, relaunch the installed
app normally; `scripts/soapbox-main-gateway.sh` provides the same local WSL recovery path.

The integrated main app was verified on 2026-10-17: job
`d253cbe2-1433-4462-98ac-5c6936f362bf` produced two 384-dimensional vectors on the RTX 4080
and paid the operator [0.002 test USDC](https://sepolia.basescan.org/tx/0x829f8341b96709acf82ebb4091c520a7f8c8729f385efd55928a4b8c4dee3320).
The mainnet wallet configuration and identity file were unchanged, and its UI balance
remained $8.99. See [main app validation evidence](soapbox-main-app-validation.json).

The desktop form was exercised on 2026-10-16 (Toronto): job
`6731f66e-e1d1-4e3d-9e3a-c8c3803568ba` produced two 384-dimensional vectors on the RTX 4080
and reached **succeeded** on its first attempt after funding through the UI.
The [0.002 test USDC payout](https://sepolia.basescan.org/tx/0xf1ae180706ba158ac67544ad53ef16bba1340a8e28fbe4538789d5e5f9c13d8e)
was independently confirmed, increasing the operator balance from 0.033 to 0.035 test USDC.
See [UI validation evidence](soapbox-ui-validation.json). During periodic model warmup,
the worker may briefly appear offline; wait for **Online** and **GPU probe passed** before submission.

## Connect an existing coordinator

Set these in the gateway process environment and restart the gateway:

```sh
BITTERBOT_SOAPBOX_ENABLED=1
BITTERBOT_SOAPBOX_URL=http://127.0.0.1:8787
BITTERBOT_SOAPBOX_TOKEN=<provisioned-submitters-token>
```

The service token must have at least 32 characters. Provision a unique credential in the
Soapbox coordinator; keep it out of the renderer, localStorage, build variables and Git.
Remote coordinators require HTTPS. Clients refuse redirects and credential-bearing URLs.

The gateway credential identifies one Soapbox account. This integration is for trusted
gateway operators; it does not delegate separate Soapbox identities to individual chat users.
Pool and project memberships come from the coordinator's ACL. Circle membership alone
does not grant compute access in this release.

## Optional gateway-managed processes

- `BITTERBOT_SOAPBOX_BINARY`: absolute native executable path.
- `BITTERBOT_SOAPBOX_CONFIG`: coordinator configuration; setting it opts into starting a coordinator.
- `BITTERBOT_SOAPBOX_DB`: required database path for that coordinator.
- `BITTERBOT_SOAPBOX_WORKER_CONFIG`: separate opt-in to contribute this machine as a worker.
- `SOAPBOX_WORKER_TOKEN`: worker credential. Other coordinator credentials must use a
  `SOAPBOX_` or `BITTERBOT_SOAPBOX_` environment-variable prefix so the managed process receives them.

A managed coordinator must use an HTTP `127.0.0.1` URL. Use absolute configuration/database paths.
The gateway only stops processes it launched. A Windows gateway requires a native Windows
binary; during WSL development, run the service externally and connect over loopback.

## Operator workflow

1. Start the coordinator and explicitly admitted workers.
2. Open Compute and verify online offers and account membership.
3. Select Private, Collective or Paid; paid jobs reserve the fixed test-credit quote.
4. Submit a CPU batch or choose a ready GPU embedding model. The desktop includes its exact digest.
5. Inspect the job result and acceptance receipt. Cancel queued/running work when needed.
6. An administrator can pause new allocations; existing work drains.

Temporary artifacts are UTF-8 text, owner-only, at most 1 MiB, with a configurable account
quota and expiry. They live on the coordinator and are not replicated or encrypted by Soapbox.
Do not use them as backups. GPU residency is observed, not attested. Embedding results are
checked for shape, while CPU hash results are independently recomputed.

## Gateway permissions

| RPC                                                             | Scope          |
| --------------------------------------------------------------- | -------------- |
| soapbox.status, soapbox.jobs, soapbox.job, soapbox.artifact.get | operator.read  |
| soapbox.submit, soapbox.cancel, soapbox.artifact.put            | operator.write |
| soapbox.payment.fund, soapbox.payment.refresh                   | operator.write |
| soapbox.worker.pause                                            | operator.admin |

All service requests originate in the gateway. The browser never receives the token or
an arbitrary URL proxy. The standalone service independently checks roles and membership.

## Local source and plan

The standalone checkout is `D:\Bitterbot\soapbox`; the legacy Java reference is `D:\Soapbox`.
Read the standalone README, `docs/ARCHITECTURE.md`, `docs/MVP-PLAN.md`, and `docs/RUNBOOK.md`
for the demo, deployment instructions and production acceptance gates. No Java files are modified.

## GPU pilot

On this development machine, the native binary, model and renderer are built. From the
repository root, run `./scripts/soapbox-gpu-pilot.ps1` to start the isolated pilot and get
its desktop URL. `-TestOnly` runs the automated GPU checks and exits. The launcher starts
the dedicated runtime if necessary and stops only the runtime it started when finished.

The first physically verified service is 384-dimensional `all-minilm:latest` embeddings on
Windows with an NVIDIA RTX 4080. In the Soapbox repository, run `scripts/setup-gpu.ps1` and
then `scripts/start-gpu-runtime.ps1`. Configure the gateway-managed worker using
`examples/worker-gpu.json`, with pool/project memberships matching the coordinator. The worker
warms the locally installed pinned model automatically; it never downloads buyer-selected models.

The Compute view shows GPU temperature, utilization, free VRAM, model readiness and admission
diagnostics. GPU jobs require full model residency before and after execution. Inputs run in
ordered batches of up to 16, with a 100-second execution timeout. Selected job results refresh
automatically. Receipts include worker-reported model/runtime binding and duration measurements.
Model digest checks and full-residency observations are not hardware attestation or hard GPU limits.

From this repository, with the native Soapbox binary and Ollama available:

```powershell
$env:SOAPBOX_BINARY = 'D:\Bitterbot\soapbox\.local\bin\soapbox.exe'
node --import tsx scripts/soapbox-smoke.ts --gpu
```

This runs real GPU work through an authenticated gateway WebSocket in all three modes,
compares results with direct inference, checks accounting/cancellation and stops its isolated
services. Add `--keep` to open the built desktop against that temporary pilot. It prints a local
URL and ends after one hour or Ctrl+C. Build `desktop/dist-renderer` first. No existing gateway
configuration is changed. A native Windows Node dependency installation is needed; the Soapbox
`docs/PHASE-2-GPU.md` records the local WSL-checkout accommodations used during validation.

The broader customer rollout still requires signed receipts, multi-worker workload partitioning,
independent security review and SLA qualification. The isolation and payment increment follows.

## Phase 2 isolation and USDC

The current extension supports per-job Linux/WSL containers and Base Sepolia USDC escrow.
See the standalone repository's `docs/PHASE-2-ISOLATION-PAYMENTS.md` for setup and trust boundaries.
Run `scripts/soapbox-payment-smoke.ts --gpu` with `SOAPBOX_REPO`, `SOAPBOX_BINARY`, and
`SOAPBOX_SANDBOX_CONFIG` for gateway-to-GPU-to-escrow validation; add `--testnet` after
running `scripts/soapbox-testnet-provision.ts` to use Circle test USDC.

Compute now separates submission from funding. The funding RPC retrieves the immutable quote
from Soapbox, checks the current Base Sepolia wallet, exact micro-USDC amount, operator-pinned
escrow address/bytecode, and wallet spending caps. Set `BITTERBOT_SOAPBOX_ESCROW`,
`BITTERBOT_SOAPBOX_ESCROW_CODE_SHA256`, and optionally `BITTERBOT_SOAPBOX_RPC_URL` on the
gateway. A separate relayer signs payouts; the coordinator checks confirmed on-chain state.
Private and collective jobs remain free. Mainnet funding is disabled for this pilot.

The earlier sections describe the original development integration. Shared-host execution now
requires explicit `allow_unsafe_host: true`; it cannot accept USDC jobs. Managed child
processes receive only OS/runtime and Soapbox environment variables, excluding wallet keys.

The funded RTX 4080 pilot paid the node operator 0.033 test USDC and verified refunds and
recovery without duplicate payout. See the standalone repository's
`docs/PHASE-2-PAYMENT-VALIDATION.md` for transaction links, evidence and reproduction details.
For repeat validation, `SOAPBOX_TESTNET_REUSE_REPORT` can point to a previous testnet report;
the harness rechecks the escrow code, token and settlement signer before reusing it.
