# V1 Release Audit: Second-Pass Verification Addendum (2026-08-21)

Companion to `docs/reviews/v1-release-audit-2026-08-21.md` (HEAD c5e1f97 at the time of verification). This document records what a second, independent verification pass found when it re-checked the audit's claims and recommendations against the repository, the running node, GitHub, and the cited external sources. The main report is corrected in place from the "corrections" list that accompanies this addendum; this file keeps the evidence.

## 1. Method

Extraction and dedupe. The main report was split into 22 slices along its section boundaries (executive summary and decisions; product map 2.1-2.6; findings tables 3.1-3.11; peer patterns 4; deep research 4b; plan, install matrix, versioning and definition of done 5; appendix 6.1-6.12). From each slice an extractor listed every checkable factual claim (a file, line, count, default, command, release, URL or external-source statement) together with the recommendation the report attaches to it, keyed by slice and ordinal (`3.2-11`, `6.9-6.10-08`). Claims repeated across sections (the same finding appears in the executive summary, a 3.x table, the P0 list and an appendix overview) were merged so that each fact was checked once; the merged recommendation text joins the variants with `|`. The result was 337 claims.

Two-lens verification and tiebreak. Every claim was checked by two independent verifiers with different briefs: a skeptic, instructed to look for the way the claim could be wrong, overstated, stale or mis-anchored, and a reproducer, instructed to re-derive the fact from scratch with read-only commands (`grep`, `sed -n`, `git log`/`git show`/`git ls-remote`, `gh api`/`gh release`, `node -e`, `curl`, WebFetch for external sources). Both returned a claim verdict, a recommendation verdict, the evidence they relied on, and a corrected statement. When the two disagreed on either verdict a third verifier read both reports and the primary evidence and cast the deciding vote; 10 claims needed a tiebreak. Claim verdicts: **confirmed** (the statement is exact as written), **partially-confirmed** (the substance holds but a number, path, line, default, scope, cause or severity is wrong and the statement had to be rewritten), **refuted** (the statement is false), **unverifiable** (no available evidence either way). Recommendation verdicts: **sound** (do it as written), **needs-change** (right direction, wrong mechanism, scope, ordering, cost or prerequisite), **unsound** (would not achieve its purpose or would cause harm), **already-done** (the recommended change already exists in the tree), **n/a** (no recommendation attached). A claim can be confirmed while its recommendation needs change, and vice versa.

### Stats

| Measure                                                                   | Count |
| ------------------------------------------------------------------------- | ----- |
| Claims extracted and verified                                             | 337   |
| Claim: confirmed                                                          | 133   |
| Claim: partially-confirmed                                                | 199   |
| Claim: refuted                                                            | 5     |
| Claim: unverifiable                                                       | 0     |
| Recommendation: sound                                                     | 87    |
| Recommendation: needs-change                                              | 243   |
| Recommendation: unsound                                                   | 1     |
| Recommendation: already-done                                              | 5     |
| Recommendation: n/a                                                       | 1     |
| Claims needing a tiebreak                                                 | 10    |
| Items listed in section 2 below (changed claim or changed recommendation) | 285   |
| Corrections applied to the main report                                    | 301   |

The five refuted claims: `2.3-2.4-24` (tools.wallet is not default-OFF), `3.9-06` (the wallet swap stub and `trade` action quoted as a live docs-vs-code example were removed in a5db7bf on 2026-06-10), `6.5-6.6-09` (`skills incoming list/accept/reject` is a live, wired flow; F6/F16 were fixed on 2026-08-09 and only F15 remains open), and `4b-15` and `4b-20` (the deep-research harness's own refutations of the Open WebUI auto-connect claim and of three Jan claims were wrong; the refuted claims are supported by the cited pages). The high partial rate (199 of 337) is mostly precision: counts, line numbers, file paths and defaults that drifted, plus a recurring pattern where the audit described as missing something that exists in a different place (consent step, quarantine sweeper, formatDocsLink repoint, Custom Provider Ollama default, install receipt equivalents, update channel config). Five recommendations were already done before the audit ran. Nothing was unverifiable.

## 2. What changed

Every claim whose final verdict is not "confirmed" and every recommendation judged needs-change, unsound or already-done, grouped by report section. For each item: the original claim and recommendation as extracted, the final verdicts, what the verifiers actually found (quoted from their evidence, trimmed; the lens whose verdicts carried the final result is quoted first), and the corrected statement or recommendation. Refuted items are marked **REFUTED**. Items whose recommendation was already done are marked **ALREADY DONE**.

### 1. Executive summary and the 10 decisions

11 item(s) changed in this section (of 11 verified).

#### 1-01

- Verdict: claim **partially-confirmed**; recommendation **n/a**. Weight: low. Anchor: `desktop/renderer/src; src/`
- Original claim: Source hygiene counts: exactly 3 TODO markers in source, zero heritage (OpenClaw/clawdbot-style) names in non-test code, and zero console.log calls in desktop/renderer/src.
- What the verifiers found: (skeptic: partially-confirmed / n/a) "Recounted. `grep -rnE '\b(TODO|FIXME|XXX|HACK)\b' src desktop/renderer/src --include=*.ts --include=*.tsx | grep -v .test.` = 3: src/auto-reply/heartbeat.ts:39 (a prose comment about the literal string "#TODO", not a work marker), src/config/types.wallet.ts:48 `// TODO: Phase 2, contract allowlist validation`, src/infra/orchestrator-bridge.ts:753 `(named pipe TODO)`. [...]" (reproducer agrees: partially-confirmed / n/a) "Re-derived: `git ls-files src desktop/renderer/src | grep -E '\.(ts|tsx|js|mjs|rs)$' | grep -vE '\.test\.|\.e2e [...]"
- Corrected statement / recommendation: '3 TODO markers' is accurate only for src/ + desktop/renderer/src (the scope the appendix at line 1083 actually states; the exec summary at line 16 drops the scope). Repo-wide shipped source has 6 (add desktop/src-tauri/src/main.rs:18,63 and orchestrator/src/ipc.rs:255), and one of the 3 (heartbeat.ts:39) is prose, not a marker. Zero heritage names and zero renderer console.log are confirmed.

#### 1-02

- Verdict: claim **confirmed**; recommendation **needs-change**. Weight: critical. Anchor: `orchestrator/Cargo.toml:3`
- Original claim: orchestrator/Cargo.toml line 3 declares package version 0.2.3.
- Original recommendation: Publish orchestrator-v0.2.3 (or pin fetch to 0.2.2) so fresh installs get the P2P orchestrator binary (P0, effort S). | Push tag orchestrator-v0.2.3 (after setting minisign secrets) and verify the release download URL returns 302.
- What the verifiers found: (reproducer: confirmed / needs-change) "`sed -n 1,12p orchestrator/Cargo.toml` -> line 3: `version = "0.2.3"`. `git log -1 -- orchestrator/Cargo.toml` -> 017761f 2026-08-15 "fix(circles): B3 mesh rate limiting + B4 relay hardening (security pass, orchestrator 0.2.3)"; `git merge-base --is-ancestor 017761f origin/main` -> on origin/main. [...]" (skeptic agrees: confirmed / needs-change) "`sed -n 1,5p orchestrator/Cargo.toml` -> line 3 is `version = "0.2.3"`. [...]"
- Corrected statement / recommendation: Claim is exact. Recommendation is directionally right but under-specified: pushing tag orchestrator-v0.2.3 today will build and then FAIL at the sign step, because .github/workflows/orchestrator-release.yml:143-145 exits 1 when MINISIGN_SECRET_KEY is empty and `gh api repos/Bitterbot-AI/bitterbot-desktop/actions/secrets` returns total_count 0 (no repo secrets at all). The job also declares `environment: release`, which does not exist yet (`gh api .../environments` lists only `bitterbot-p2p-mainnet / production`; `.../environments/release` -> 404); [...]

#### 1-03

- Verdict: claim **partially-confirmed**; recommendation **needs-change**. Weight: critical. Anchor: `gh release list (tags orchestrator-vX.Y.Z); scripts/fetch-orchestrator.mjs`
- Original claim: The newest published GitHub release of the orchestrator is tagged orchestrator-v0.2.2; no orchestrator-v0.2.3 release exists, so every fresh install since 2026-08-15 boots without the P2P orchestrator.
- Original recommendation: Publish orchestrator-v0.2.3 release assets before V1. | Set minisign secrets; push orchestrator-v0.2.3; verify 302. | P0-A.1: Publish orchestrator-v0.2.3 (set minisign secrets, push tag, verify 302); add CI guard comparing Cargo version vs published release; fetcher fallback with loud warning; [...]
- What the verifiers found: (reproducer: partially-confirmed / needs-change) "`gh release list --limit 100` -> Orchestrator 0.2.2 (Latest, orchestrator-v0.2.2, 2026-08-14T19:23:14Z), 0.2.1, 0.2.0, 0.1.0; nothing newer. `gh api repos/Bitterbot-AI/bitterbot-desktop/releases/tags/orchestrator-v0.2.3` -> HTTP 404. `gh run list --workflow=orchestrator-release.yml` shows no run for 0.2.3. `curl -sI .../releases/latest` -> location: .../releases/tag/orchestrator-v0.2.2. [...]" (skeptic: confirmed / needs-change) "`gh release list` today: Orchestrator 0.2.2 (Latest, orchestrator-v0.2.2, 2026-08-14T19:23:14Z), 0.2.1, 0.2.0, 0.1.0 - no 0.2.3. [...]"
- Corrected statement / recommendation: The release facts are exact (latest = orchestrator-v0.2.2; no 0.2.3; the Cargo bump dates to 2026-08-15). The consequence is slightly overstated: "every fresh install since 2026-08-15 boots without the P2P orchestrator" holds only for installs that rely on the postinstall prebuilt path. An install that runs `cargo build --release --manifest-path orchestrator/Cargo.toml` (or sets the config binary path) gets the binary via the release/debug/config candidates in orchestrator-binary.ts:54-70. [...] (skeptic adds: Claim stands. Of the merged recommendations, "publish orchestrator-v0.2.3" is sound (with the secret/environment prerequisites noted in 1-02). [...])

#### 1-04

- Verdict: claim **confirmed**; recommendation **needs-change**. Weight: critical. Anchor: `scripts/fetch-orchestrator.mjs`
- Original claim: The checksums URL for orchestrator-v0.2.3 (the URL built by scripts/fetch-orchestrator.mjs from the Cargo.toml version) returns HTTP 404.
- Original recommendation: Publish the 0.2.3 release or make the fetch version independent of Cargo.toml.
- What the verifiers found: (skeptic: confirmed / needs-change) "Re-fetched today: `curl -sI https://github.com/Bitterbot-AI/bitterbot-desktop/releases/download/orchestrator-v0.2.3/checksums.txt` -> 404 (and -L follow -> 404 at the same URL). Control: same URL for orchestrator-v0.2.2 -> 302 (redirect to the asset). [...]" (reproducer: confirmed / sound) "Re-derived the URL from scripts/fetch-orchestrator.mjs:32 (REPO = "Bitterbot-AI/bitterbot-desktop"), :172 (releaseBase = https://github.com/${REPO}/releases/download/orchestrator-v${version}), :174 (ch [...]"
- Corrected statement / recommendation: Claim stands. Keep only the first half of the recommendation (publish 0.2.3). "Make the fetch version independent of Cargo.toml" is a regression: the script header (fetch-orchestrator.mjs:19-21) deliberately makes Cargo.toml the single source of truth so gateway and daemon cannot drift; a second version knob is exactly the skew class the fail-fast IPC/capability latch work (orchestrator-bridge.ts:27-29, :704) was built to tolerate, not invite. (reproducer adds: Claim is exact. Recommendation is sound; of the two options, publishing 0.2.3 is the one that also delivers the B3 rate limiter (017761f is not in orchestrator-v0.2.2). [...])

#### 1-05

- Verdict: claim **confirmed**; recommendation **needs-change**. Weight: high. Anchor: `scripts/fetch-orchestrator.mjs`
- Original claim: The postinstall orchestrator fetch (scripts/fetch-orchestrator.mjs) only warns and exits 0 when the release download fails, so `pnpm install` succeeds without the orchestrator binary.
- Original recommendation: Fail loudly or surface the missing orchestrator in doctor/UI. | Doctor should report an error rather than a warning; consider bundling the binary in the release artifact.
- What the verifiers found: (skeptic: confirmed / needs-change) "package.json:108 `"postinstall": "node scripts/fetch-orchestrator.mjs"`. fetch-orchestrator.mjs:7-12 header: "Non-fatal by design: any failure (offline, release not yet published, flaky network, hash mismatch) logs a clear message and exits 0 so `pnpm install` still succeeds." Checksum failure path :187-194 warn() then return; download failure :216-219 warn + return; [...]" (reproducer agrees: confirmed / needs-change) "package.json:108 `"postinstall": "node scripts/fetch-orchestrator.mjs"`. [...]"
- Corrected statement / recommendation: Claim stands; the recommendation mostly asks for things that exist or would break things. (1) "Fail loudly" at postinstall: the non-fatal contract is intentional and load-bearing - the orchestrator release workflow runs pnpm install on runners without the release (it has an explicit skip at :146-151), unsupported platforms (:153-160) and offline installs would start failing, and the in-app update path re-runs pnpm install so a hard fail would break updates. [...]

#### 1-10

- Verdict: claim **confirmed**; recommendation **needs-change**. Weight: critical. Anchor: `docs/index.md:100; https://registry.npmjs.org/bitterbot`
- Original claim: docs/index.md line 100 says `npm install -g bitterbot@latest`, and the npm registry returns Not found for the package name `bitterbot`.
- Original recommendation: Remove the npm install instruction; npm package is explicitly post-V1 (D1). | Delete the npm install lines from docs; docs lint that greps for `npm i -g bitterbot`. | Delete or hide the npm distribution story for V1 (drop npm install -g from docs and RELEASING.md).
- What the verifiers found: (skeptic: confirmed / needs-change) "docs/index.md:100 is exactly ` npm install -g bitterbot@latest` inside the 'Install Bitterbot' Step. `curl -sS https://registry.npmjs.org/bitterbot` -> `{"error":"Not found"}` with HTTP 404 (re-fetched 2026-08-21); registry.npmjs.org/bitterbot-ai also 404. [...]" (reproducer: confirmed / sound) "docs/index.md:100 reads exactly ` npm install -g bitterbot@latest` inside the Quick start `<Step title="Install Bitterbot">`. [...]"
- Corrected statement / recommendation: Claim confirmed. Recommendation needs scoping: deleting the three `npm i -g` doc lines is correct and cheap, but 'drop the npm distribution story from RELEASING.md' would orphan the still-present `release:check` script and the `files`/`npm pack` checklist items (docs/reference/RELEASING.md:32,34,46,60,65). Either mark those RELEASING.md items 'post-V1 / not yet published' rather than deleting them, or delete them together with scripts/release-check.ts and the `release:check` npm script in the same commit. [...] (reproducer adds: Recommendation stands; scope it to all three doc sites (docs/index.md:100, docs/start/setup.md:71, docs/platforms/linux.md:19) and to RELEASING.md lines 32/34/46/60/65/77, not just index.md. [...])

#### 1-21

- Verdict: claim **partially-confirmed**; recommendation **needs-change** (tiebreak). Weight: medium. Anchor: `docs/reviews/wired-but-dead-audit-2026-08-09.md`
- Original claim: Several of the default-ON loops (skills economy, curiosity loop) were found structurally dead end-to-end by the 2026-08-09 wired-but-dead audit, which remains unfixed.
- Original recommendation: Turn dead loops off by default rather than shipping them ON.
- What the verifiers found: (reproducer: partially-confirmed / needs-change) "docs/reviews/wired-but-dead-audit-2026-08-09.md exists; Tier 2 (lines 28-58) = 'skills economy is structurally dead' (F5, F6, F7, F10-F16) and Tier 3 (lines 60-70) = 'curiosity loop never closes' (F8, F9, F17). 'Remains unfixed' is contradicted by the document's own 'Fix status' section (lines 134-157) and by git: fd59b1a 2026-08-09 'peer trust credit + stable curiosity regions (audit F6/F8)'; [...]" (skeptic: refuted / needs-change) "The audit doc itself carries a fix ledger that the V1 report ignored: docs/reviews/wired-but-dead-audit-2026-08-09.md:134-136 'Fix status (updated 2026-08-09) ... [...]" (tiebreak: partially-confirmed / needs-change) "Independent check. (1) The audit did say what the claim says: docs/reviews/wired-but-dead-audit-2026-08-09.md:7 'the entire skills economy and curiosity loop are structurally dead end-to-end'; Tier 2 (:28-58) = F5-F16 skills economy, Tier 3 (:60-70) = F8/F9/F17 curiosity. (2) 'Remains unfixed' is false for most of it. [...]"
- Corrected statement / recommendation: Corrected statement: the 2026-08-09 wired-but-dead audit found the skills economy and curiosity loop structurally dead end-to-end; within two days 9 of 17 findings (F1, F2, F3, F4, F5, F6, F8, F12, F16) were fixed with tests and several live-verified, so those loops are no longer dead end-to-end. Still open: F7 (EigenTrust write-only), F9 (curiosity targets never resolved; [...]

#### 1-22

- Verdict: claim **partially-confirmed**; recommendation **needs-change**. Weight: high. Anchor: `src/ (grep p2p.bitterbot.ai, mailbox.bitterbot.ai, relay multiaddrs, github.com)`
- Original claim: A fresh node makes outbound connections on first boot to p2p.bitterbot.ai, 4 hardcoded relay multiaddrs, mailbox.bitterbot.ai, and GitHub.
- Original recommendation: D4: add a wizard consent step ('Connect to the Bitterbot network?') and a network.localOnly switch.
- What the verifiers found: (reproducer: partially-confirmed / needs-change) "p2p.bitterbot.ai: defaults.ts:505 `bootstrapDns: "p2p.bitterbot.ai"`; 4 hardcoded multiaddrs: defaults.ts:478-494 FALLBACK_BOOTSTRAP_PEERS (142.93.113.64, 46.101.181.98, 139.59.233.83 on tcp/9100 + metro.proxy.rlwy.net:12838); bridge started when p2p.enabled (server-startup.ts:175-180). [...]" (skeptic: confirmed / needs-change) "p2p.bitterbot.ai: src/config/defaults.ts:508 `bootstrapDns: "p2p.bitterbot.ai"`; 4 hardcoded multiaddrs at defaults.ts:484-495 (142.93.113.64, 46.101.181.98, 139.59.233.83, metro.proxy.rlwy.net) merged [...]"
- Corrected statement / recommendation: Corrected statement: on first boot a fresh node dials p2p.bitterbot.ai (DNS) + the 4 fallback multiaddrs via the orchestrator, and GitHub (git fetch to origin, git checkouts only) plus registry.npmjs.org via the update check; mailbox.bitterbot.ai is only contacted once the node has at least one non-practice circle (scheduler.ts:112-119), and GitHub releases are hit at `pnpm install` postinstall, not boot. Recommendation: a wizard consent step already exists (onboarding.p2p.ts); the cheaper fix is to show its confirm in the quickstart flow too. [...] (skeptic adds: Claim stands (4 outbound targets: p2p.bitterbot.ai DNS, 4 fallback multiaddrs, mailbox.bitterbot.ai, github.com via git fetch). [...])

#### 1-35

- Verdict: claim **partially-confirmed**; recommendation **needs-change**. Weight: medium. Anchor: `src/gateway (bind, token, origin check, rate limit); src/security; src/commerce wallet cap`
- Original claim: The loopback gateway install has: loopback bind by default, a random 24-byte auth token, 0600 permissions on secret files, an Origin check, rate limiting, exec deny-by-default, and a $50/day wallet spend cap.
- Original recommendation: No change needed; security posture for loopback is sound.
- What the verifiers found: (reproducer: partially-confirmed / needs-change) "Loopback default: src/gateway/server-runtime-config.ts:40 `params.bind ?? params.cfg.gateway?.bind ?? 'loopback'`; net.ts:276-281 loopback -> 127.0.0.1. Token: src/commands/onboard-helpers.ts:68-70 `crypto.randomBytes(24).toString('hex')`, used at onboarding.gateway-config.ts:204/210. 0600: src/config/io.ts:1034-1037 config written mode 0o600 and chmod 0o600 at :1053; [...]" (skeptic agrees: partially-confirmed / needs-change) "Loopback default: src/gateway/server-runtime-config.ts:40 `params.bind ?? params.cfg.gateway?.bind ?? "loopback [...]"
- Corrected statement / recommendation: The '$50/day wallet spend cap' is actually a $50 per-session (per wallet-tool instance, in-memory) cap; the configured daily limit is advertised in the UI/doctor but not enforced anywhere. Either fix the audit wording to '$50/session cap; daily limit is informational only' or add a finding to implement dailySpendLimitUsd enforcement. The rest of the loopback posture statement reproduces. 'No change needed' should be downgraded to 'sound except the daily-cap claim'; [...]

#### 1-41

- Verdict: claim **partially-confirmed**; recommendation **needs-change**. Weight: medium. Anchor: `src/memory (local embedding model config / GGUF URL)`
- Original claim: The default local embedding model is a GGUF of roughly 300 MB that is not bundled or auto-downloaded.
- Original recommendation: D7: auto-download with a kill switch.
- What the verifiers found: (skeptic: partially-confirmed / needs-change) "src/memory/embeddings.ts:65-66 DEFAULT_LOCAL_MODEL = 'hf:ggml-org/embeddinggemma-300m-qat-q8_0-GGUF/embeddinggemma-300m-qat-Q8_0.gguf'. HF API tree for ggml-org/embeddinggemma-300m-qat-q8_0-GGUF reports size 328577056 bytes (313 MiB / 329 MB); HEAD on the resolve URL returned x-linked-size: 328577056 and content-length: 328577056. [...]" (reproducer: confirmed / needs-change) "Model: src/memory/embeddings.ts:65-66 DEFAULT_LOCAL_MODEL = `hf:ggml-org/embeddinggemma-300m-qat-q8_0-GGUF/embeddinggemma-300m-qat-Q8_0.gguf`. [...]"
- Corrected statement / recommendation: Correct statement: the default local model is a ~329 MB (313 MiB) GGUF that is not bundled and is only downloaded (lazily, on first embed) when provider is explicitly 'local'; it is never auto-selected. D7 therefore is not 'add auto-download' (exists) but 'auto-select local in the auto chain + make the lazy download visible'; the kill switch should gate the auto-selection, and the download should happen with progress logging rather than silently inside the first embedQuery. (reproducer adds: Claim stands. Recommendation D7 should be reframed: download code already exists (node-llama-cpp resolveModelFile at embeddings.ts:107 with DEFAULT_LOCAL_MODEL as default and an optional `local.modelCa [...])

#### 1-42

- Verdict: claim **confirmed**; recommendation **needs-change**. Weight: low. Anchor: `docker-compose.yml; docker-setup.sh; Dockerfile`
- Original claim: docker-compose.yml and docker-setup.sh exist in the repo root alongside the broken Dockerfile.
- Original recommendation: D8: fix Docker (effort M) because the compose/setup files already exist; otherwise delete all of it.
- What the verifiers found: (skeptic: confirmed / needs-change) "`ls -la Dockerfile docker-compose.yml docker-setup.sh` -> all three present in repo root and tracked (`git ls-files | grep -i docker`). Dockerfile broken as in 5-06 (Dockerfile:20 copies nonexistent `ui/package.json`; Dockerfile:30 runs nonexistent `pnpm ui:build`). docker-compose.yml:18 and :39 run `node dist/index.js`, which tsdown does produce (tsdown.config.ts entry src/index.ts; [...]" (reproducer: confirmed / sound) "`ls -la Dockerfile docker-compose.yml docker-setup.sh` at repo root: Dockerfile (1553 B, Feb 19 2026), docker-compose.yml (1060 B, Mar 28), docker-setup.sh (6307 B, Mar 28); [...]"
- Corrected statement / recommendation: The rationale 'fix because compose/setup files already exist' is weak: those two files have not been edited since 2026-03-28 (35b3a0f) and are themselves untested against a real image; their existence is not evidence the path is close to working. Effort for the minimal image fix is S (two Dockerfile lines), while a GHCR publish pipeline plus CI build job is M. Also reconcile with PLAN-37 row 39 (keep bitterbot.podman.env) before the 'delete all of it' branch is exercised. (reproducer adds: Claim is accurate. On the recommendation: the existence of compose/setup files is not by itself a reason to fix rather than delete -- they are consistent with each other (both assume `bitterbot:local` [...])

### 2.1-2.2 Control UI navigation and orphan views

9 item(s) changed in this section (of 11 verified).

#### 2.1-2.2-01

- Verdict: claim **confirmed**; recommendation **needs-change**. Weight: high. Anchor: `desktop/renderer/src/components/layout/Sidebar.tsx:57-82`
- Original claim: The Control UI top-level navigation is defined by a NAV_ITEMS array at desktop/renderer/src/components/layout/Sidebar.tsx lines 57-82 containing exactly 12 entries: overview, channels, people (Circles), p2p, management, agents, skills, guards, cron, dreams, models, config.
- Original recommendation: Collapse to a target nav of 8 items: Chat, Channels, Agents (Agents / Skills / Schedules), Overview, Settings (Models & Keys / Config), Advanced (P2P, Safety rules, Dreams, Circles, Wallet, Workspace, Logs, Sessions, Usage, Nodes). [...]
- What the verifiers found: (reproducer: confirmed / needs-change) "Reproduced from scratch: `git ls-files | grep Sidebar.tsx` -> desktop/renderer/src/components/layout/Sidebar.tsx (661 lines). `const NAV_ITEMS: NavItem[] = [` is at line 56 and the closing `];` at line 83 (claim says 57-82; 57 is a comment line, entries actually span 61-82). [...]" (skeptic agrees: confirmed / needs-change) "desktop/renderer/src/components/layout/Sidebar.tsx:57 `const NAV_ITEMS: NavItem[] = [` through :82 `];`. [...]"
- Corrected statement / recommendation: Claim stands (line anchor should read 56-83). Recommendation adjustments: (1) the visible count today is 11 (12 on a management node), not 12/13; (2) 'Advanced' group contents Workspace/Logs/Sessions/Usage/Nodes are not being 're-homed' -- they are currently unreachable (no setActiveTab caller anywhere), so the plan is exposing them for the first time and should decide whether each deserves exposure or deletion alongside Debug/Instances/Projects; (3) Circles carries the only consent-approval/unread badge in the nav (Sidebar.tsx:500-542); [...]

#### 2.1-2.2-06

- Verdict: claim **partially-confirmed**; recommendation **needs-change**. Weight: medium. Anchor: `desktop/renderer/src/components/layout/Sidebar.tsx`
- Original claim: When circles.enabled is off, the Control UI still performs global Circles badge polling (RPC calls from the sidebar/badge regardless of the feature flag).
- Original recommendation: No global badge polling when Circles is off.
- What the verifiers found: (skeptic: partially-confirmed / needs-change) "desktop/renderer/src/components/layout/AppShell.tsx:67 mounts `<CirclesGlobalSync />` for the app lifetime. CirclesGlobalSync.tsx:19-25: `if (status !== "connected") return; void refreshList(); const timer = setInterval(() => void refreshList(), 45_000);`, no check of circles.enabled. But circles-store.ts:88-94 `refreshList`: `const status = await request("circles.status", {}); [...]" (reproducer agrees: partially-confirmed / needs-change) "The poller is not in Sidebar.tsx; it is the headless component desktop/renderer/src/components/circles/CirclesG [...]"
- Corrected statement / recommendation: Precise statement: when circles.enabled is off, CirclesGlobalSync still issues one cheap `circles.status` RPC every 45s (plus on reconnect); it does NOT poll `circles.list` and no badge is computed, so 'badge polling' and 'from the sidebar' are overstated, it is a status probe from AppShell. 'No global polling when off' as written would leave the UI unable to notice the flag flipping on (circles.ts:122 re-reads config per request, so enabling is hot); [...]

#### 2.1-2.2-17

- Verdict: claim **partially-confirmed**; recommendation **needs-change**. Weight: medium. Anchor: `desktop/renderer/src/components/models/ModelsView.tsx`
- Original claim: desktop/renderer/src/components/models/ModelsView.tsx takes the provider as a free-text field rather than a provider picker and has no "Use a local model" option.
- Original recommendation: SHIP Models & Keys; provider picker instead of free-text; add "Use a local model".
- What the verifiers found: (skeptic: partially-confirmed / needs-change) "The free-text provider field is NOT in ModelsView.tsx; it lives in KeyEntryModal.tsx:115-123 and only renders when the modal is opened without a provider. ModelsView.tsx:217-222 renders a ProviderRow per entry from models.auth.list with `onAddKey={() => openModal(p.provider)}`, so the per-provider 'Add key' path prefills the provider (KeyEntryModal.tsx:105 title 'Add key for {provider}') and shows [...]" (reproducer: partially-confirmed / sound) "The free-text provider field is in KeyEntryModal.tsx:114-124, not in ModelsView.tsx itself; ModelsView hosts the modal (`import { KeyEntryModal } from "./KeyEntryModal"` at :22, rendered at :230-233, o [...]"
- Corrected statement / recommendation: Corrected statement: ModelsView opens KeyEntryModal with the provider prefilled from provider rows; only the generic 'Add key' path (KeyEntryModal.tsx:115-123) is free-text. The 'no local model option' part is accurate for the UI. Corrected recommendation: the provider picker belongs in KeyEntryModal (same fix as 3.5-19, do not double-count effort). [...] (reproducer adds: Corrected statement: the free-text provider field lives in models/KeyEntryModal.tsx (rendered from ModelsView's provider-less 'Add provider key' button), not in ModelsView.tsx directly. [...])

#### 2.1-2.2-21

- Verdict: claim **partially-confirmed**; recommendation **needs-change**. Weight: low. Anchor: `desktop/renderer/src/components/layout/Sidebar.tsx:524-585`
- Original claim: Sidebar.tsx lines 524-585 render About / X / LinkedIn / Email social links directly in the sidebar, and there is no Help & Docs link.
- Original recommendation: Move social links into an About dialog; add Help & Docs link. | Add 'Help & Docs' footer link; 'Run diagnostics' hint on Disconnected. | Add a Docs/Help link in the UI once a real docs destination exists.
- What the verifiers found: (reproducer: partially-confirmed / needs-change) "Social links block is at Sidebar.tsx:552-616 (`{/* Social Links */}` comment at 552, closing div at 616), not 524-585; lines 524-551 are the tail of the nav button rendering. Links reproduced: About https://about.bitterbot.ai (562/590), X https://x.com/Bitterbot_AI (568/596), LinkedIn https://www.linkedin.com/company/106800101 (574/602), mailto:team@bitterbot.net (580/608), rendered twice for colla [...]" (skeptic agrees: partially-confirmed / needs-change) "Line anchor is wrong: the `{/* Social Links */}` block starts at Sidebar.tsx:552 and ends at :616 (next block ` [...]"
- Corrected statement / recommendation: Fix the anchor to Sidebar.tsx:552-616; the substance (About/X/LinkedIn/Email present, no Help & Docs) is correct. Of the three merged recommendation variants, only the conditional one ('add a Docs/Help link once a real docs destination exists') is actionable today: docs.bitterbot.ai does not resolve, so an unconditional 'Help & Docs' footer link would be dead on arrival. Either stand up docs.bitterbot.ai first (the code already hardcodes that host in several places) or point Help at about.bitterbot.ai / the repo docs. [...]

#### 2.1-2.2-23

- Verdict: claim **partially-confirmed**; recommendation **needs-change**. Weight: critical. Anchor: `desktop/renderer/src/components`
- Original claim: The Control UI compiles in 10 views whose TabIds have no NAV_ITEMS entry and no `setActiveTab` caller anywhere in desktop/renderer/src: chat, wallet, debug, instances, projects, logs, sessions, usage, nodes, workspace (chat and wallet are reachable via Conversations/New Conversation and the wallet sidebar panel respectively; the other 8 are unreachable).
- Original recommendation: Classify each orphan: chat SHIP, wallet SHIP-ADVANCED, debug REMOVE, instances REMOVE, projects REMOVE UI, logs/sessions/usage/nodes/workspace SHIP-ADVANCED. | D6: remove Debug, Instances, Projects UI (keep backend); put Workspace/Logs/Sessions/Usage/Nodes under Labs/Advanced. [...]
- What the verifiers found: (skeptic: partially-confirmed / needs-change) "TabId union at desktop/renderer/src/stores/ui-store.ts:3-25 has 22 ids; NAV_ITEMS at desktop/renderer/src/components/layout/Sidebar.tsx:56-83 has 12 (overview, channels, people, p2p, management, agents, skills, guards, cron, dreams, models, config). Difference = exactly 10: chat, instances, sessions, usage, nodes, projects, workspace, wallet, debug, logs. [...]" (reproducer: partially-confirmed / sound) "Reproduced from scratch. TabId union at desktop/renderer/src/stores/ui-store.ts:3-25 has 22 members. NAV_ITEMS at desktop/renderer/src/components/layout/Sidebar.tsx:56-84 lists exactly 12 ids (overview [...]"
- Corrected statement / recommendation: Claim: the 10 TabIds have no NAV_ITEMS entry; only 8 of them (not 10) also lack a setActiveTab caller, chat (Sidebar.tsx:231/287/366) and wallet (WalletSidebarPanel.tsx:69/85) have callers. Recommendation: (a) Projects should not be lumped with Instances/Debug as 'dead': the gateway side (projects.\* handlers + chat.send projectId -> project RAG) is wired and the UI is one mount away (nav entry + <ProjectSwitcher/> in ChatInput); [...] (reproducer adds: Corrected statement: 10 TabIds have no NAV_ITEMS entry (chat, wallet, instances, sessions, usage, nodes, projects, workspace, debug, logs). [...])

#### 2.1-2.2-26

- Verdict: claim **partially-confirmed**; recommendation **needs-change**. Weight: medium. Anchor: `desktop/renderer/src/components/projects/ProjectsView.tsx`
- Original claim: desktop/renderer/src/components/projects/ProjectsView.tsx (341 lines) and the ProjectSwitcher component are never mounted anywhere in the renderer, while the backend `projects.*` RPC methods in src/gateway/server-methods/projects.ts work.
- Original recommendation: REMOVE the projects UI; keep src/gateway/server-methods/projects.ts.
- What the verifiers found: (skeptic: partially-confirmed / needs-change) "ProjectsView.tsx = 341 lines (wc). Mount check: ProjectsView is imported only by AppShell.tsx:21 into VIEW_MAP (:43), which no nav/setActiveTab path reaches; ProjectSwitcher (86 lines) is imported by no file. Backend: projectsHandlers (src/gateway/server-methods/projects.ts:145-154: projects.list/get/create/update/delete/files.list/files.upload/files.delete/projects.context) are registered via src/ [...]" (reproducer: confirmed / sound) "`wc -l` ProjectsView.tsx = 341, ProjectSwitcher.tsx = 86. `grep -rn 'ProjectSwitcher\|ProjectsView' desktop/renderer/src` outside components/projects/ hits only AppShell.tsx:21 (import) and :43 (`proje [...]"
- Corrected statement / recommendation: Claim: 'never mounted' confirmed; 'backend works' should read 'backend is registered and wired into chat.send/project RAG but has no tests and was not exercised'. Recommendation: 'REMOVE the projects UI; keep server-methods/projects.ts' leaves projects.\*, src/agents/projects.ts and project-rag.ts with zero callers, exactly the wired-but-dead pattern the 2026-08-09 audit flagged. Either wire the UI (nav entry + mount ProjectSwitcher in ChatInput; ChatInput already forwards projectId) or remove the feature on both sides; do not keep a caller-less backend. (reproducer adds: Minor precision: 'never mounted' is correct; 'never imported' is true only for ProjectSwitcher (ProjectsView IS imported by AppShell but only reachable via an orphan TabId). [...])

#### 2.1-2.2-28

- Verdict: claim **confirmed**; recommendation **needs-change**. Weight: low. Anchor: `desktop/renderer/src/components/sessions/SessionsView.tsx`
- Original claim: desktop/renderer/src/components/sessions/SessionsView.tsx is 255 lines and is backed by sessions.list/patch/delete/reset RPCs; desktop/renderer/src/components/usage/UsageView.tsx is 250 lines backed by sessions.usage; desktop/renderer/src/components/nodes/NodesView.tsx is 241 lines backed by node.list and node.pair.\*.
- Original recommendation: SHIP-ADVANCED for sessions, usage, nodes (optionally fold thinking/verbose controls into the chat header).
- What the verifiers found: (skeptic: confirmed / needs-change) "Line counts via wc -l: SessionsView.tsx 255, UsageView.tsx 250, NodesView.tsx 241. RPCs (grep `request("`): SessionsView.tsx:140 sessions.list, :161 sessions.patch, :173 sessions.delete, :185 sessions.reset; UsageView.tsx:131 sessions.usage; NodesView.tsx:134 node.list, :135 node.pair.list, :166 node.pair.approve, :178 node.pair.reject. [...]" (reproducer: confirmed / sound) "Line counts reproduced: SessionsView.tsx 255, UsageView.tsx 250, NodesView.tsx 241. RPCs reproduced by grep: SessionsView calls sessions.list (140), sessions.patch (161), sessions.delete (173), session [...]"
- Corrected statement / recommendation: SHIP-ADVANCED is fine, but the parenthetical should read 'fold the thinking-level control into the chat header'; there is no verbose control to fold (verboseLevel is a dead type field). docs/web/control-ui.md:75 ('per-session thinking/verbose overrides') overclaims the same way. The ModelPicker's sessions.patch pattern is the obvious host for a thinking-level Select.

#### 2.1-2.2-29

- Verdict: claim **partially-confirmed**; recommendation **sound**. Weight: medium. Anchor: `desktop/renderer/src/components/workspace`
- Original claim: The workspace view (desktop/renderer/src/components/workspace/\*.tsx) totals roughly 1,300 lines, is fully wired to the workspace.tree/read/stat/search/write gateway RPCs, and is the largest unreachable (orphan) view in the Control UI.
- Original recommendation: SHIP-ADVANCED; decide explicitly whether to surface it.
- What the verifiers found: (skeptic: partially-confirmed / sound) "Recount: the 9 .tsx files in desktop/renderer/src/components/workspace total 1,229 lines (WorkspaceView 400, WorkspaceFilesPanel 284, ContentSearchPanel 150, SyntaxViewer 102, FileEditor 91, FileTabBar 73, QuickOpenDialog 55, FileBreadcrumb 44, TreeFilterInput 30); plus workspace-utils.ts 111 = 1,340. 'Roughly 1,300' holds. [...]" (reproducer agrees: partially-confirmed / sound) "Line count re-derived: the nine .tsx files in desktop/renderer/src/components/workspace total 1,229 lines (Work [...]"
- Corrected statement / recommendation: Correct statement: ~1,230 lines of .tsx (1,340 with workspace-utils.ts), wired to workspace.tree/read/search/write plus the workspace.fileChanged event; `workspace.stat` is not used by the UI. WorkspaceView itself is unreachable, but WorkspaceFilesPanel is already surfaced in the chat ToolCallPanel, so the decision is really 'surface the full editor/search view or keep only the Files tab', not 'surface or strip 1,300 lines'.

#### 2.1-2.2-30

- Verdict: claim **partially-confirmed**; recommendation **sound**. Weight: medium. Anchor: `desktop/renderer/src/components/chat/ChatView.tsx`
- Original claim: desktop/renderer/src/components/chat/ChatView.tsx has no nav entry and is reached only via the Conversations list / New Conversation action, backed by chat.\* RPCs.
- Original recommendation: SHIP; make Chat the first item in the target 8-item nav.
- What the verifiers found: (skeptic: partially-confirmed / sound) "Sidebar.tsx:56-83 NAV_ITEMS contains no `chat` item (confirmed). Reach paths found: ui-store.ts:60 `activeTab: "chat"` is the boot default, so every launch lands on ChatView without any click; Sidebar.tsx:231 switchToSession, :287 New Conversation, and :366 a 'Current Session' placeholder button rendered when `sessions.length === 0`, all call setActiveTab('chat'). [...]" (reproducer agrees: partially-confirmed / sound) "No nav entry: `chat` is absent from Sidebar NAV_ITEMS (lines 56-83) though present in TabId and VIEW_MAP (AppSh [...]"
- Corrected statement / recommendation: Chat is reached by default at boot (ui-store.ts:60) and via the 'Current Session' placeholder when no sessions exist, not only via the Conversations list / New Conversation. The nav recommendation is sound but partly redundant: the Conversations block above NAV_ITEMS already functions as the Chat entry with active-state highlighting, so a 'Chat' nav item mainly buys discoverability/consistency rather than reachability.

### 2.3-2.4 CLI commands and config sections

4 item(s) changed in this section (of 4 verified).

#### 2.3-2.4-09

- Verdict: claim **confirmed**; recommendation **needs-change**. Weight: medium. Anchor: `src/cli/program/command-registry.ts`
- Original claim: The commands acp, checkpoints, heartbeat, system, hooks, webhooks, dns, daemon are currently visible in root help (not registered with hidden: true), and no BITTERBOT_SHOW_DEV_COMMANDS env toggle exists.
- Original recommendation: Mark these `hidden: true`, revealed by `BITTERBOT_SHOW_DEV_COMMANDS=1`.
- What the verifiers found: (skeptic: confirmed / needs-change) "All eight are plain SubCliEntry objects with no hidden flag (the type at register.subclis.ts:9-13 cannot carry one): acp :36, daemon :52, system :68, dns :124, hooks :140, heartbeat :148, webhooks :156, checkpoints :243; their placeholders are created visible at :278. The only hidden commands in the whole CLI are boot-watchdog and ui-restart (command-registry.ts:62-67; [...]" (reproducer: confirmed / sound) "All eight names are SubCliEntry records in src/cli/program/register.subclis.ts with no hidden field and none possible (type at :9-13 has only name/description/register): acp :36, daemon :52, system :68 [...]"
- Corrected statement / recommendation: Anchor: src/cli/program/register.subclis.ts (not command-registry.ts). Recommendation needs the same adjustments as 3.7-3.8-19: a placeholder-level `hidden` does not survive the eager path (BITTERBOT_DISABLE_LAZY_SUBCOMMANDS, register.subclis.ts:289-293) or completion generation (completion-cli.ts:246-257 force-registers everything and enumerates program.commands at :385), so the real registrars must set `{ hidden: true }` too; and docs/cli/index.md lists acp/system/dns/heartbeat/hooks/webhooks as first-class pages and must be updated in the same change. (reproducer adds: None to the claim. Implementation caveat for the recommendation: the hidden flag must be honoured both on the lazy placeholder (register.subclis.ts:278) and on the real `.command()` inside each sub-CLI [...])

#### 2.3-2.4-23

- Verdict: claim **partially-confirmed**; recommendation **sound**. Weight: low. Anchor: `src/config/zod-schema.ts`
- Original claim: update.autoRollback and update.uiRestart are config keys that only take effect on git-based installs.
- Original recommendation: autoRollback/uiRestart advanced, git installs only.
- What the verifiers found: (reproducer: partially-confirmed / sound) "Keys exist: src/config/zod-schema.ts:154-165 `update.autoRollback.enabled` and `update.uiRestart.enabled` (both strict objects). autoRollback: consumed at src/gateway/server-methods/update.ts:184-188 and src/cli/update-cli/update-command.ts:414-418 via spawnBootWatchdog with prevSha = result.before?.sha; [...]" (skeptic agrees: partially-confirmed / sound) "Keys exist: src/config/zod-schema.ts:154-165 (`update.autoRollback.enabled`, `update.uiRestart.enabled`), src/c [...]"
- Corrected statement / recommendation: Corrected statement: autoRollback is git-only by construction (no prevSha on package updates); uiRestart is not gated on install kind in code but only acts on a running vite dev server, so it is git/source-checkout-only in practice. Recommendation (mark both advanced, git installs only) stands; note the `advanced` hint is unpopulated and unconsumed today (see 3.3-22), so marking them requires that plumbing first.

#### 2.3-2.4-24 **REFUTED**

- Verdict: claim **refuted**; recommendation **needs-change**. Weight: medium. Anchor: `src/config/zod-schema.ts`
- Original claim: tools.wallet.enabled defaults to false.
- Original recommendation: Ship tools (web keys) as core; policy/sandbox/wallet advanced.
- What the verifiers found: (skeptic: refuted / needs-change) "src/config/zod-schema.ts has no default for tools.wallet.enabled (all flags are `z.boolean().optional()`); the consumer is src/agents/tools/wallet-tool.ts:73-78: `// Wallet is on by default, user must explicitly set enabled=false to disable. // Safe because wallet starts empty; user must fund it to transact. if (walletConfig?.enabled === false) { return undefined; [...]" (reproducer agrees: refuted / needs-change) "src/config/zod-schema.agent-runtime.ts:642-645 `wallet: z.object({ enabled: z.boolean().optional(), ...` (no de [...]"
- Corrected statement / recommendation: tools.wallet.enabled defaults to TRUE (wallet tool registered unless explicitly `enabled: false`, wallet-tool.ts:73-78, on base-sepolia testnet). Fix doc line 126. Recommendation 'ship tools (web keys) core; policy/sandbox/wallet advanced' is fine as a classification, but if wallet is meant to be advanced/OFF for V1 that requires an actual default flip in wallet-tool.ts (and onboarding.wallet.ts:294), which the row currently presents as already the case.

#### 2.3-2.4-28

- Verdict: claim **partially-confirmed**; recommendation **needs-change**. Weight: medium. Anchor: `src/config/zod-schema.ts`
- Original claim: skills.skillSeekers, skills.marketability (predictor), skills.agentskills, and skills p2p ingest are all enabled by default.
- Original recommendation: SHIP entries/install; HIDE economy knobs; skillSeekers + predictor OFF.
- What the verifiers found: (skeptic: partially-confirmed / needs-change) "skillSeekers: src/agents/tools/skill-seekers-tool.ts:69 `if (cfg.skills?.skillSeekers?.enabled === false)` -> default ON (confirmed). marketability predictor: src/memory/manager.ts:3094-3097 'Default-on: only skip when explicitly disabled' -> ON (confirmed). [...]" (reproducer: partially-confirmed / sound) "skillSeekers ON: src/memory/manager.ts:6066-6070 `if (ssConfig?.enabled !== false) { ... new SkillSeekersAdapter(...)`; [...]"
- Corrected statement / recommendation: Corrected claim: skillSeekers and marketability.predictor are ON by default; skills.agentskills is OFF by default (agentskills-ingest.ts:39); p2p ingest has no enable flag -- it is ON whenever p2p.enabled is ON but defaults to quarantine-only `ingestPolicy: "review"` (ingest.ts:97). Recommendation: 'skillSeekers + predictor OFF' is actionable (both are `=== false` gates); 'HIDE economy knobs' should not include agentskills (already opt-in). [...] (reproducer adds: skills.agentskills is OFF by default (opt-in), not ON. 'skills p2p ingest enabled' is true only in the sense that the ingest path runs whenever p2p is on; [...])

### 2.5-2.6 Channels, extensions and features by plan

5 item(s) changed in this section (of 9 verified).

#### 2.5-2.6-14

- Verdict: claim **partially-confirmed**; recommendation **needs-change**. Weight: medium. Anchor: `src/memory`
- Original claim: The PLAN-15 memory curator/scrubber module is shipped in the tree but is not wired into any runtime path and is OFF by default.
- Original recommendation: HIDE PLAN-15 curator/scrubber for V1.
- What the verifiers found: (reproducer: partially-confirmed / needs-change) "PLAN-15 has three distinct shipped pieces. (a) Memory-fence scrubber (Phase 3): src/agents/streaming-context-scrubber.ts is instantiated at src/agents/pi-embedded-subscribe.ts:609-610 `params.memoryFenceWrapping ? new StreamingContextScrubber(DEFAULT_MEMORY_FENCE) : ...`, but `grep -rn 'memoryFenceWrapping:' src` (non-test) returns no production setter, so it is a no-op; [...]" (skeptic agrees: partially-confirmed / needs-change) "PLAN-15 is two separate things and the claim conflates them. (1) The A-MAC skill CURATOR is wired and ON: src/m [...]"
- Corrected statement / recommendation: Corrected statement: PLAN-15's memory-fence StreamingContextScrubber is shipped but unwired (no caller sets memoryFenceWrapping) and effectively OFF; the PLAN-15 A-MAC skill curator runs every dream cycle ON by default (dream-engine.ts:975, opt-out via dream.skillCurator.enabled=false), and the Phase 2 staging-gate skill_manage surface is live. Corrected recommendation: HIDE only the fencing scrubber (already hidden: nothing to do). [...]

#### 2.5-2.6-20

- Verdict: claim **partially-confirmed**; recommendation **sound**. Weight: low. Anchor: `src/memory`
- Original claim: PLAN-24 HORMA has phases 0/1/3/5 landed and ON by default.
- Original recommendation: SHIP-ADVANCED.
- What the verifiers found: (reproducer: partially-confirmed / sound) "Code markers: `grep -rhoE 'PLAN-24[ A-Za-z]*Phase [0-9]+' src | sort | uniq -c` gives Phase 0 x16, Phase 1 x3, Phase 3 x8, Phase 4 x1 (src/memory/memory-architect.ts:97 'state-conditional rule activation (the moat)'), Phase 5 x8. docs/plans/PLAN-24-HORMA-MEMORY-SCAFFOLDING.md records: Phase 2 'GATE PASSED 2026-06-14' (line 124), Phase 3 'landed 2026-06-13' (149), Phase 4 'landed 2026-06-13 ... [...]" (skeptic agrees: partially-confirmed / sound) "ON by default: confirmed, src/config/types.memory.ts:74-96 provenance/architectEvolution/graphAbstraction and : [...]"
- Corrected statement / recommendation: Corrected statement: PLAN-24 HORMA phases 0, 1, 3, 4 and 5 are landed and ON by default (Phase 4 hormonal rule activation is wired into runSessionExtraction per memory-architect.ts:97 and the plan doc line 172; Phase 2 is the offline LongMemEval gate, passed 2026-06-14, not a runtime feature). The SHIP-ADVANCED recommendation stands; just count Phase 4 among the shipped phases.

#### 2.5-2.6-24

- Verdict: claim **partially-confirmed**; recommendation **sound**. Weight: high. Anchor: `src/circles`
- Original claim: PLAN-31/35/36/38 Circles + canvas sandbox span 71 commits, are ON by default, security batches B3/B4/B5 landed 2026-08-15, and the key-rotation gap remains open.
- Original recommendation: SHIP-ADVANCED: make Circles opt-in for V1.
- What the verifiers found: (reproducer: partially-confirmed / sound) "`git log --oneline -- src/circles | wc -l` = 71 (reproduced exactly; note `--grep=circles -i` across the repo gives 131 and src/circles + renderer circles paths together give 92, so '71' is specifically the src/circles path count). Latest src/circles commit: 2ae2233 2026-08-17. [...]" (skeptic agrees: partially-confirmed / sound) "71 commits: `git log --oneline -- src/circles | wc -l` = 71 exactly (broader circles paths incl. [...]"
- Corrected statement / recommendation: 71 commits (src/circles path), latest 2026-08-17, ON by default at defaults.ts:628/633/634 are all correct. Replace 'B3/B4/B5 landed 2026-08-15' with 'B3/B4/B5 code merged 2026-08-15; B5 not activated (placeholder signing key, relays still on v0.2.2) and orchestrator-v0.2.3 not yet released'. Replace 'key-rotation gap remains open' with 'sender-key rotation is per-node only (by design); B7 hardening batch open'. The SHIP-ADVANCED / opt-in recommendation stands on the defaults evidence alone; [...]

#### 2.5-2.6-25 **UNSOUND RECOMMENDATION**

- Verdict: claim **partially-confirmed**; recommendation **unsound**. Weight: low. Anchor: `docs/plans/PLAN-32-FLEET-SYNC.md`
- Original claim: PLAN-32 fleet sync, PLAN-14 and PLAN-39 exist only as docs (docs/plans/PLAN-32-FLEET-SYNC.md, PLAN-14-USER-IMPACT-AND-DIFFERENTIATION.md, PLAN-39-CONTROL-UI-GATEWAY-SERVING.md) with no code landed.
- Original recommendation: Mark these plans as backlog in docs.
- What the verifiers found: (skeptic: partially-confirmed / unsound) "Files exist on disk (ls docs/plans | grep -E 'PLAN-(14|32|39)' lists all three) but are NOT in the repo: `git ls-files docs/plans | wc -l` = 0; .gitignore:238 `docs/plans/`; commit 58ba9bc (2026-07-29) 'chore(docs): move docs/plans out of the repo, internal planning stays local ... the folder is gitignored'. Status headers: PLAN-32:3 'DRAFT v1 (2026-07-10)'; PLAN-39:3 'DRAFT v1.1, 2026-07-28. [...]" (reproducer agrees: partially-confirmed / unsound) "All three files exist on disk (`ls docs/plans | grep -E 'PLAN-(14|32|39)'`). [...]"
- Corrected statement / recommendation: PLAN-14/32/39 are local, gitignored draft files (docs/plans/ excluded since 58ba9bc), not repo docs; no code has landed. Recommendation 'mark these plans as backlog in docs' is unsound: there is nothing in the published docs tree or git to mark, and each file already carries a DRAFT / FUTURE WORK status line. Drop this item or re-scope it to the internal plans index.

#### 2.5-2.6-26

- Verdict: claim **partially-confirmed**; recommendation **needs-change**. Weight: medium. Anchor: `src/memory`
- Original claim: PLAN-33 canonical ledger is landed and ON by default, but has produced 0 auto-pins across 26 dream cycles.
- Original recommendation: SHIP but fix auto-pin calibration.
- What the verifiers found: (skeptic: partially-confirmed / needs-change) "Landed + ON: confirmed. src/memory/dream-types.ts:66 `canonical_promotion: { enabled: true ... }`; docs/plans/PLAN-33-CANONICAL-MEMORY-LEDGER.md:3 'PHASES 0-3 LANDED (2026-07-10)'; manager.ts:3771 logs 'canonical auto-pin' from session extraction. The '0 auto-pins across 26 dream cycles' figure is a verbatim copy of docs/reviews/dream-engine-utility-2026-08-10.md:54 ('canonical_promotion | 26 | ... [...]" (reproducer agrees: partially-confirmed / needs-change) "Landed + ON: docs/plans/PLAN-33-CANONICAL-MEMORY-LEDGER.md:3 `**Status:** PHASES 0-3 LANDED (2026-07-10)` ... [...]"
- Corrected statement / recommendation: Corrected statement: PLAN-33 ledger is landed and ON; extraction auto-pinning works (219 pins, 40 active); the dream-mode `canonical_promotion` has produced 1 pin in 40 cycles (pinned 2026-08-13, since retired). Corrected recommendation: SHIP the ledger as-is; for the promotion mode execute PLAN-40 §5.3's pre-registered calibrate-or-retire pilot on a DB copy rather than a blanket 'fix calibration' -- a 1-pin-in-40-cycles bias-to-reject mode is by design, and loosening it without the pilot reintroduces the fuzzy auto-key failure mode PLAN-33 explicitly rej [...]

### 3.1 Security and defaults

19 item(s) changed in this section (of 26 verified).

#### 3.1-01

- Verdict: claim **confirmed**; recommendation **needs-change**. Weight: critical. Anchor: `src/config/zod-schema.ts:539`
- Original claim: In src/config/zod-schema.ts at about line 539 the `circles` zod object is declared `.strict()` and does not include the sub-keys `dial`, `meshTopic`, or `p2pDial`.
- Original recommendation: Add the three sub-objects (dial, meshTopic, p2pDial) to the zod schema; add a positive-case test in config.circles-settings.test.ts; derive CirclesConfig via z.infer. | Add the three keys to the zod schema (P0, effort S). | Fix circles schema; default circles OFF for V1. [...]
- What the verifiers found: (skeptic: confirmed / needs-change) "src/config/zod-schema.ts:539 is `circles: z` and the object (lines 540-575) declares only enabled, a2aPublicUrl, displayName, mailbox, briefing, practicePartner, agentDrafts, sandbox, then `.strict().optional()` (lines 576-577). No `dial`, `meshTopic`, or `p2pDial` anywhere in the file (`grep -n circles src/config/zod-schema.ts` returns only line 539). [...]" (reproducer agrees: confirmed / needs-change) "Reproduced from scratch. `grep -n circles src/config/zod-schema.ts` -> single hit at line 539 (`circles: z`). [...]"
- Corrected statement / recommendation: Claim stands as written. Recommendation split: (a) adding the three sub-objects + a positive test in config.circles-settings.test.ts is sound and trivial. (b) 'derive CirclesConfig via z.infer' is inconsistent with the codebase: `grep z.infer src/config/*.ts` returns nothing; every types.\*.ts is hand-maintained with doc comments (types.circles.ts carries the kill-switch rationale in JSDoc), so switching one block to z.infer would lose those comments and diverge from the pattern. [...]

#### 3.1-05

- Verdict: claim **confirmed**; recommendation **needs-change**. Weight: high. Anchor: `src/gateway/a2a/a2a-http.ts:706`
- Original claim: In src/gateway/a2a/a2a-http.ts:706-716 the comment says the auth waiver applies to loopback only, but the code calls `isPrivateOrLoopbackAddress`, which also matches 10/8, 172.16/12, 192.168/16, 169.254/16 and 100.64/10.
- Original recommendation: Replace with isLoopbackAddress; add optional a2a.authentication.allowPrivateNetwork defaulting to false; add an audit check when bind != loopback; test with 192.168.1.10 and 100.64.0.5. | Restrict the auth waiver to loopback only (confirmed high, effort S). [...]
- What the verifiers found: (skeptic: confirmed / needs-change) "src/gateway/a2a/a2a-http.ts:706 comment `// Allow local loopback without token.`; :713 `if (clientIp && isPrivateOrLoopbackAddress(clientIp)) { return { ok: true }; }`. src/gateway/net.ts:70-103 isPrivateOrLoopbackAddress: loopback (:74), `o1 === 10 || (o1 === 172 && o2 >= 16 && o2 <= 31) || (o1 === 192 && o2 === 168)` (:88), `(o1 === 169 && o2 === 254) || (o1 === 100 && o2 >= 64 && o2 <= 127)` (:9 [...]" (reproducer agrees: confirmed / needs-change) "Reproduced from scratch. src/gateway/a2a/a2a-http.ts:706 `// Allow local loopback without token.`; [...]"
- Corrected statement / recommendation: Claim stands (and is slightly understated: IPv6 ULA + link-local are also waived). Recommendation is incomplete in two ways. (1) Swapping to isLoopbackAddress does NOT close the tailscale-serve path: tailscaled proxies from 127.0.0.1 with X-Forwarded-For, and with the default gateway.trustedProxies=[] (net.ts:206-210 returns false when empty) resolveGatewayClientIp returns 127.0.0.1 (net.ts:230-235), so every tailnet peer still looks like loopback. [...]

#### 3.1-06

- Verdict: claim **partially-confirmed**; recommendation **needs-change**. Weight: high. Anchor: `src/config/defaults.ts:547`
- Original claim: A2A is enabled by default (src/config/defaults.ts:547 `a2a.enabled ?? true`), its `message/send` endpoint spawns real agent runs and `tasks/list` exposes run outputs; the wizard offers `bind=lan` and `security audit` recommends tailscale serve (a CGNAT 100.64/10 address).
- Original recommendation: Restrict the unauthenticated A2A waiver to loopback and add an audit check when bind is not loopback.
- What the verifiers found: (reproducer: partially-confirmed / needs-change) "src/config/defaults.ts:542-547 applyA2aDefaults: `enabled: a2a.enabled ?? true`; called from src/config/io.ts:586, :647, :787 (load paths), so the effective default is ON. docs/marketplace/a2a-integration.md:5 confirms 'A2A is on by default as of 2026-04-30'. [...]" (skeptic agrees: partially-confirmed / needs-change) "src/config/defaults.ts:547 `enabled: a2a.enabled ?? true,` inside applyA2aDefaults (:542), applied in src/confi [...]"
- Corrected statement / recommendation: 'security audit recommends tailscale serve' overstates: serve is only recommended as the downgrade from funnel; the bind=lan remediation says bind loopback or set auth. More importantly the CGNAT angle is the wrong mechanism for the tailscale case: tailscale serve forces bind=loopback (server-runtime-config.ts:84-86) and proxies via 127.0.0.1, so A2A sees loopback (net.ts:222-236, trustedProxies default []) and the waiver fires on the loopback branch, not the 100.64/10 branch. [...]

#### 3.1-08

- Verdict: claim **partially-confirmed**; recommendation **needs-change**. Weight: high. Anchor: `src/config/defaults.ts:547`
- Original claim: src/config/defaults.ts enables red-team/network features by default: `a2a.enabled ?? true` (line 547), `marketplace.enabled: true` (573), `payment.enabled: isEarningCapable` (504), `p2p.enabled: true` with `p2p.bitterbot.ai` and 4 relays, `circles.enabled ?? true` (628) with briefing/practicePartner/agentDrafts/sandbox, and `forage.nightShift !== false`; [...]
- Original recommendation: Flip marketplace/payment/forage/circles OFF by default; keep p2p only if it is in the V1 story; add one wizard consent step. | SHIP-ADVANCED; a2a marketplace/payment OFF for V1. [...]
- What the verifiers found: (skeptic: partially-confirmed / needs-change) "Verified in src/config/defaults.ts at HEAD c5e1f97: line 547 `enabled: a2a.enabled ?? true`; line 573 `marketplace: { enabled: true` (572-573); line 628 `enabled: circles.enabled ?? true`; lines 633-634 briefing/practicePartner `{ enabled: true }`; [...]" (reproducer agrees: partially-confirmed / needs-change) "Reproduced from scratch in src/config/defaults.ts (641 lines): line 547 `enabled: a2a.enabled ?? true`; [...]"
- Corrected statement / recommendation: Corrected claim: a2a.enabled (defaults.ts:547), a2a.marketplace.enabled (573), p2p.enabled + p2p.bitterbot.ai + 3 DO relays + 1 Railway bootnode (500-511, 478-495), circles.enabled/briefing/practicePartner (628-634) are ON in defaults.ts; a2a.payment.enabled is at line 560 and is DERIVED (ON only with full CDP creds, else OFF); forage.nightShift, circles.agentDrafts and circles.sandbox defaults live in forage-client.ts:111 / service.ts:1930 / service.ts:2092 (`!== false`), and nightShift no-ops without a wallet address (manager.ts:2522). [...]

#### 3.1-09

- Verdict: claim **partially-confirmed**; recommendation **needs-change**. Weight: high. Anchor: `src/memory/manager.ts:2788`
- Original claim: Experimental memory features default ON with no 'experimental' label: `harnessEvolve ?? true` at src/memory/manager.ts:2788, `DEFAULT_CURIOSITY_CONFIG.enabled: true` at curiosity-types.ts:157, RLM on at rlm/types.ts:38, architectEvolution/provenance/graphAbstraction on at src/config/types.memory.ts:96, and the dream engine runs 4 LLM modes every 120 minutes with 8 LLM calls.
- Original recommendation: Default harnessEvolve/curiosity/rlm/architectEvolution OFF; keep dream+consolidation+extraction; mark the rest as `advanced`. | harnessEvolve OFF for V1; toolCache/compression/heartbeat advanced. | curiosity/rlm/architectEvolution OFF for V1.
- What the verifiers found: (reproducer: partially-confirmed / needs-change) "Reproduced the four anchors: src/memory/manager.ts:2788 `enabled: this.cfg.agents?.defaults?.harnessEvolve?.enabled ?? true`; src/memory/curiosity-types.ts:156-157 `export const DEFAULT_CURIOSITY_CONFIG = { enabled: true`; src/agents/rlm/types.ts:37-38 `DEFAULT_RLM_CONFIG ... enabled: true` (path is src/agents/rlm, not src/memory/rlm); [...]" (skeptic agrees: partially-confirmed / needs-change) "Anchors check out individually but the picture they paint is stale/overstated. [...]"
- Corrected statement / recommendation: Corrected statement: curiosity engine, RLM deep recall, and all four HORMA flags (provenance, architectEvolution, graphAbstraction, coverageDiagnostics) default ON via `?? true` / `=== false` opt-outs with no experimental label anywhere in config or Control UI; harnessEvolve context defaults ON at manager.ts:2788 but the harness_evolve dream mode is disabled by default (dream-types.ts:64, PLAN-40 hold) so it does not run; the dream engine runs up to 3 of 10 enabled modes (7 LLM-requiring) every 120 min under an 8-call-per-cycle cap. [...]

#### 3.1-10

- Verdict: claim **partially-confirmed**; recommendation **needs-change**. Weight: medium. Anchor: `src/memory/curiosity-types.ts:157`
- Original claim: The curiosity loop (audit findings F8/F9) assigns fresh UUIDs to regions every 30 minutes and has resolved zero targets, i.e. it is effectively dead while enabled by default.
- Original recommendation: Default curiosity OFF for V1.
- What the verifiers found: (skeptic: partially-confirmed / needs-change) "The 'fresh UUIDs every 30 minutes' half (audit F8) was FIXED on 2026-08-09: commit fd59b1a 'fix(skills,curiosity): peer trust credit + stable curiosity regions (audit F6/F8)' touched src/memory/curiosity-engine.ts (+76) and added src/memory/curiosity-engine.region-identity.test.ts (57 lines). [...]" (reproducer agrees: partially-confirmed / needs-change) "The F8/F9 text comes from docs/reviews/wired-but-dead-audit-2026-08-09.md:62-66 ('rebuildRegions DELETEs all cu [...]"
- Corrected statement / recommendation: Corrected statement: F8 (region UUID churn) was fixed and live-verified 2026-08-09/10; learning_progress now accumulates. F9 (knowledge_gap targets never resolved because region_id is NULL at creation) remains open. Corrected recommendation: 'curiosity OFF' is a blunt instrument, the engine also supplies the dream-mode weight provider and the GCCRF/FSHO coupling (manager.ts:2775-2777, 6190-6192) and the exploration auto-trigger (dream-engine.ts:1180-1190), all of which silently stop. The targeted fix is F9 (set region_id at knowledge_gap creation; [...]

#### 3.1-11

- Verdict: claim **confirmed**; recommendation **needs-change**. Weight: high. Anchor: `src/memory/embeddings.ts:67`
- Original claim: In src/memory/embeddings.ts:67 `canAutoSelectLocal` returns false unless an on-disk local model path is configured, so the `auto` embedding provider only tries openai/gemini/voyage and then throws when no API key is present.
- Original recommendation: Make `auto` fall back to DEFAULT_LOCAL_MODEL with auto-download and a kill switch. | D7: auto-download the ~300 MB default local embedding GGUF with a kill switch and progress log; make it the wizard default when the chat provider is Anthropic. [...]
- What the verifiers found: (skeptic: confirmed / needs-change) "src/memory/embeddings.ts:68-81 `canAutoSelectLocal` returns false when modelPath is empty, when it matches /^(hf:|https?:)/, or when statSync fails (line 67 is the closing of DEFAULT_LOCAL_MODEL; function starts at 68, off by one). [...]" (reproducer: confirmed / sound) "Reproduced from scratch: `grep -rn canAutoSelectLocal src/` -> src/memory/embeddings.ts:68 (declaration; the cited :67 is off by one, line 67 is blank). [...]"
- Corrected statement / recommendation: Claim stands (anchor is line 68, not 67). Recommendation needs reshaping: (1) put local LAST in the auto chain, after remote keys, otherwise any user who later adds an OpenAI key flips provider -> embedding dimension change -> forced reindex; (2) node-llama-cpp is only a peerDependency (package.json:234-237) requiring a native build (`pnpm approve-builds`, see formatLocalSetupError embeddings.ts:229-253), so auto-selecting local must first verify importNodeLlamaCpp() + getLlama() succeed, else you trade a loud missing-key error for a lazy native-toolchain [...] (reproducer adds: Claim is correct except the anchor is embeddings.ts:68, not :67, and canAutoSelectLocal additionally rejects `hf:`/`https:` paths (not only unset paths). The recommendation's premise holds; [...])

#### 3.1-13

- Verdict: claim **partially-confirmed**; recommendation **needs-change**. Weight: medium. Anchor: `src/wizard`
- Original claim: node-llama-cpp is already a dependency and `resolveModelFile` can download `hf:` models, while the wizard, on blank embedding input, pins `provider: "openai"` with no key rather than offering a local option.
- Original recommendation: Add a wizard "Local (no API key)" embedding option, default for Anthropic users; leave `auto` on blank key.
- What the verifiers found: (skeptic: partially-confirmed / needs-change) "package.json:234-237: node-llama-cpp 3.15.1 is listed ONLY under `peerDependencies` (no hit in `dependencies`), plus pnpm-workspace.yaml:27 onlyBuiltDependencies; it is installed at node_modules/node-llama-cpp (version 3.15.1). The audit's own row at docs/reviews/v1-release-audit-2026-08-21.md:230 calls it a 'hard dep', internally inconsistent. [...]" (reproducer: confirmed / sound) "node-llama-cpp: package.json:236 under `dependencies` (`"node-llama-cpp": "3.15.1"`) and package.json:9 as peerDependency. [...]"
- Corrected statement / recommendation: node-llama-cpp is a peerDependency, not a dependency; wizard pins the selected provider (default openai) with no key. Recommendation: a 'Local (no API key)' option is reasonable but should (a) be offered only after probing importNodeLlamaCpp()/getLlama() succeeds on this machine (the very reason :14-16 excluded it), (b) warn about the ~329 MB download, and (c) fix the dead `configure --section memory` pointer. 'Leave auto on blank key' conflicts with current code, which writes the selected provider on blank input; that needs changing to omit `provider`. (reproducer adds: Minor precision: on blank key the wizard pins whichever provider was selected (openai by default), not unconditionally openai. Recommendation is sound; note that pinning e.g. [...])

#### 3.1-15

- Verdict: claim **partially-confirmed**; recommendation **sound**. Weight: high. Anchor: `src/daemon/program-args.ts:205`
- Original claim: src/daemon/program-args.ts:205-210 sets no workingDirectory for the daemon service, so under launchd the cwd is `/`, the orchestrator's `create_dir_all("/keys")` fails and it exits, the bridge does not retry; under systemd --user the keys land in `~/keys`.
- Original recommendation: Always pass --key-dir with an absolute stateDir path so service-manager cwd does not matter.
- What the verifiers found: (reproducer: partially-confirmed / sound) "src/daemon/program-args.ts: the non-dev return paths at lines 199-203 (bun runtime: `return { programArguments: [bunPath, cliEntrypointPath, ...params.args] }`) and 206-210 (node: `return { programArguments: [execPath, cliEntrypointPath, ...params.args] }`) set no workingDirectory; only the dev-mode paths (lines 195, 230, 238) set `workingDirectory: repoRoot`. [...]" (skeptic: confirmed / sound) "src/daemon/program-args.ts:205-210 (non-dev branch): `const cliEntrypointPath = await resolveCliEntrypointPathForService(); [...]"
- Corrected statement / recommendation: Anchor is slightly off: the no-workingDirectory returns are lines 199-203 (bun) and 206-210 (node), not '205-210'; dev-mode installs (bun src/index.ts) DO get workingDirectory=repoRoot. The launchd cwd='/' part is inferred from launchd behavior, not from a quoted source. Recommendation (always pass an absolute --key-dir) is sound; alternatively/also set workingDirectory for non-dev installs, but the key-dir fix is the more robust one.

#### 3.1-16

- Verdict: claim **partially-confirmed**; recommendation **needs-change**. Weight: medium. Anchor: `docs/gateway/configuration-reference.md:2128`
- Original claim: docs/gateway/configuration-reference.md:2128 shows `~/.bitterbot/keys` as the default p2p key dir, which is false; Circles memberships are keyed on `identity/device.json`, not the orchestrator key; doctor-identity.ts:39-52 reflects the wrong default.
- Original recommendation: Fix the doc and doctor-identity.ts:39-52; drop the circles-orphan rationale from the finding.
- What the verifiers found: (skeptic: partially-confirmed / needs-change) "docs/gateway/configuration-reference.md:2121-2128 is a json5 example block in which some lines carry `// default: true` / `// default if omitted` annotations; :2128 reads `keyDir: "~/.bitterbot/keys", // Ed25519 keypair for node identity` (no 'default' word) and :2152 `keyDir: directory for the Ed25519 keypair that determines the node's peer ID.` gives no default either, the doc implies but does no [...]" (reproducer agrees: partially-confirmed / needs-change) "docs/gateway/configuration-reference.md:2128 reads `keyDir: "~/.bitterbot/keys", // Ed25519 keypair for node id [...]"
- Corrected statement / recommendation: Corrected statement: the doc example implies `~/.bitterbot/keys` and documents no default; the true default is `./keys` relative to the orchestrator cwd. doctor-identity.ts:39-52 is already correct (it is the fix, not the bug), drop that from the action. Remaining action: fix configuration-reference.md:2128/2152 to state the real default (or, better, land the keyDir relocation first and then document that). The 'drop circles-orphan rationale' part is already done in the report; [...]

#### 3.1-18

- Verdict: claim **confirmed**; recommendation **needs-change**. Weight: medium. Anchor: `src/circles/service.ts:2184`
- Original claim: Circles is ON by default (src/config/defaults.ts:628,634), the practice-partner bot auto-seats in solo circles (src/circles/service.ts:2184-2200), there is no Settings toggle (CirclesView tells users to hand-edit config), and the default mailbox poll targets mailbox.bitterbot.ai.
- Original recommendation: Default circles.enabled=false and practicePartner.enabled=false; add a real toggle; make the mailbox opt-in with circles.
- What the verifiers found: (skeptic: confirmed / needs-change) "src/config/defaults.ts:628 `enabled: circles.enabled ?? true`, :632 `mailbox: { url: DEFAULT_CIRCLES_MAILBOX_URL, ...circles.mailbox }`, :621 `DEFAULT_CIRCLES_MAILBOX_URL = "https://mailbox.bitterbot.ai"`, :634 `practicePartner: { enabled: true, ...circles.practicePartner }`. [...]" (reproducer: confirmed / sound) "src/config/defaults.ts:628 `enabled: circles.enabled ?? true,`; :634 `practicePartner: { enabled: true, ...circles.practicePartner },`; [...]"
- Corrected statement / recommendation: Corrected recommendation: default `circles.enabled=false` and add a real Settings toggle (no prior art exists). Drop 'practicePartner.enabled=false', it is already scoped under circles and is the only thing making a solo circle usable; leave it ON inside an opt-in circles. 'Make the mailbox opt-in with circles' is already-done by construction (server-startup.ts:399). Also note the partner auto-seat fires on sandbox 'propose' enrollment (service.ts:2173), not on circle creation.

#### 3.1-19

- Verdict: claim **partially-confirmed**; recommendation **needs-change**. Weight: medium. Anchor: `src/circles/sender-keys.ts:24`
- Original claim: Circles security remediation items B3/B4/B5 landed in commits 017761f and 6633401, the mesh transport is already default-OFF, and the remaining gap is sender-key rotation on member removal at src/circles/sender-keys.ts:24-29.
- Original recommendation: Gate re-enabling circles on the sender-key rotation fix, not on B5. | Downgrade Circles default-ON from high to medium: config-default plus polish.
- What the verifiers found: (reproducer: partially-confirmed / needs-change) "Reproduced: `git show --stat 017761f` = 'fix(circles): B3 mesh rate limiting + B4 relay hardening (security pass, orchestrator 0.2.3)', dated Sat Aug 15 2026; `git show --stat 6633401` = 'fix(relay): sign the release chain + harden the fleet updater (security pass C1/C2/C6/C12/C13)' (= B5 code), Aug 15. [...]" (skeptic agrees: partially-confirmed / needs-change) "CONFIRMED pieces: mesh transport default-OFF, src/circles/service.ts:303 `return this.config.circles?.p2pDial?. [...]"
- Corrected statement / recommendation: Corrected statement: B3/B4 (017761f) and B5 (6633401) are code-complete on main as of 2026-08-15, but B5 is not activated (placeholder public key; updater fails closed; relays remain on orchestrator-v0.2.2) and orchestrator-v0.2.3 carrying the Rust rate-limiter has not been tagged or deployed. p2pDial and meshTopic are default-OFF in code (service.ts:302-312). Sender-key rotation on removal is implemented (service.ts:1619-1623); the documented limitation is that it is per-node and only propagates as each member independently removes the evictee. [...]

#### 3.1-20

- Verdict: claim **partially-confirmed**; recommendation **needs-change** (tiebreak). Weight: medium. Anchor: `src/memory/manager.ts:2525`
- Original claim: Forage Night Shift is opt-out (src/config/types.bitterbot.ts:114) and runs from the consolidation tick (src/memory/manager.ts:2515-2533), but no-ops without CDP wallet credentials (manager.ts:2525) and requires marketplace plus funded bounties; audit finding F10 concerns the skills x402 split, not the Forage payout path.
- Original recommendation: Flip Night Shift to explicit opt-in. | HIDE: set nightShift default OFF and drop the Forage dashboard tabs.
- What the verifiers found: (skeptic: partially-confirmed / needs-change) "Config: src/config/types.bitterbot.ts:114 is the doc comment `/** Default: true (monitoring-only, receive-only money flow). */`, the field `enabled?: boolean;` is line 115. Tick: src/memory/manager.ts:2511-2533 is the `11g. PLAN-29 Phase 5: Night Shift` block; the wallet no-op is at 2522 (`if (!wallet?.address) return; [...]" (tiebreak: partially-confirmed / needs-change) "Independently re-checked at HEAD c5e1f97 (git log --since=2026-08-19 on forage-client.ts/manager.ts/types.bitterbot.ts is empty, so the skeptic's line numbers are current). Config: src/config/types.bitterbot.ts:114 is the comment `/\*_ Default: true (monitoring-only, receive-only money flow). _/`; [...]"
- Corrected statement / recommendation: Claim: fix anchors -- no-op check is src/memory/manager.ts:2522 (2525 is `hunterPubkey: wallet.address`), config field is src/config/types.bitterbot.ts:115 (114 is the doc comment). Soften 'requires marketplace' to 'sits inside the marketplace block, which is itself on by default (manager.ts:6042), so that gate is not a real barrier'. [...]

#### 3.1-21

- Verdict: claim **partially-confirmed**; recommendation **needs-change** (tiebreak). Weight: medium. Anchor: `src/forage/forage-client.ts:140`
- Original claim: For wallet-configured nodes, forage-client.ts:140 GETs any gossiped `monitor_url` with global `fetch` and no private-IP guard (SSRF), and the Forage/Earnings tabs are visible under "Dreams (beta)" at dream-dashboard-page.ts:106-107.
- Original recommendation: Hide Forage/Earnings tabs (dream-dashboard-page.ts:106-107); add a private-IP guard before forage-client.ts:140. | Hide Forage/Earnings behind advanced; keep the P2P keypair location finding at high.
- What the verifiers found: (skeptic: partially-confirmed / needs-change) "Path is wrong: `ls src/forage` -> No such file; the file is src/memory/forage-client.ts. Line 140 there is exactly `const res = await opts.fetchImpl(hunt.monitor_url, { method: "GET" });` and the manager passes the global fetch (`fetchImpl: fetch`, manager.ts:2527). parseMonitorUrl (forage-client.ts:46-48) accepts any `https?://` string from spec_public; [...]" (tiebreak: partially-confirmed / needs-change) "Independently verified, siding with the skeptic on every point. (1) Path: `ls src/forage` -> 'No such file or directory'; `git ls-files | grep forage-client` -> src/memory/forage-client.ts only. [...]"
- Corrected statement / recommendation: Corrected statement: For wallet-configured nodes, src/memory/forage-client.ts:140 (not src/forage/) GETs any gossiped `monitor_url` (regex-extracted from mesh bounty spec_public, skill-network-bridge.ts:890 -> bounty_posts is_local=0) with the global `fetch` passed at manager.ts:2527 and no private-IP/hostname guard; exploitation requires the attacker's bounty to reach status 'open' (funding/solvency check in bounty-funding.ts) so it is a gated SSRF, not an unauthenticated one. [...]

#### 3.1-23

- Verdict: claim **partially-confirmed**; recommendation **needs-change**. Weight: medium. Anchor: `src/wizard/onboarding.p2p.ts:77`
- Original claim: The Quickstart onboarding path silently joins the mesh, mailbox and A2A with `skills.expose: "all"` (src/config/defaults.ts:485-505,547,621); the opt-out exists only in the advanced flow (src/wizard/onboarding.p2p.ts:77); and the orchestrator binds 0.0.0.0:9100.
- Original recommendation: Add one consent step; add a network.localOnly switch; document outbound hosts in docs/gateway/security.
- What the verifiers found: (skeptic: partially-confirmed / needs-change) "src/wizard/onboarding.ts:492-504 calls `setupP2pForOnboarding` unconditionally for every flow. src/wizard/onboarding.p2p.ts:50-73 shows an intro note in BOTH flows, ending with `"Disable later via `p2p.enabled = false` in your gateway config."` for non-advanced (line 70); [...]" (reproducer: confirmed / sound) "src/config/defaults.ts:485-495 FALLBACK_BOOTSTRAP_PEERS (3 DO relays + Railway), :504-505 `enabled: true, bootstrapDns: "p2p.bitterbot.ai"`; :547 `enabled: a2a.enabled ?? true`; [...]"
- Corrected statement / recommendation: Corrected claim: Quickstart shows a P2P intro note that names the opt-out config key but offers no opt-out prompt (advanced-only at onboarding.p2p.ts:77); A2A (incl. skills.expose 'all') and Circles/mailbox are enabled by default with no wizard mention at all; the orchestrator's 0.0.0.0:9100 bind is the CLI default but p2p.listenAddrs already overrides it. [...] (reproducer adds: Minor path note only: the security doc is docs/gateway/security/index.md (a directory index), and the opt-out note for quickstart users is onboarding.p2p.ts:68-70. Recommendation stands; [...])

#### 3.1-24

- Verdict: claim **confirmed**; recommendation **needs-change**. Weight: medium. Anchor: `scripts/fetch-orchestrator.mjs:174`
- Original claim: scripts/fetch-orchestrator.mjs:174-199 verifies downloaded orchestrator binaries only against a same-origin checksums.txt (no signature); deploy/relay-fleet/scripts/update-orchestrator.sh:40 has a MINISIGN_PUBKEY placeholder (fails closed); and the GitHub orchestrator-v0.2.2 release carries no .minisig asset.
- Original recommendation: Complete SIGNING.md; verify .minisig in the fetcher; add actions/attest-build-provenance plus a cosign bundle. | add signature verification to the end-user orchestrator fetch | Reuse the existing checksum check from scripts/fetch-orchestrator.mjs in the P0 WP4 install.sh rather than adding a new one. [...]
- What the verifiers found: (skeptic: confirmed / needs-change) "Fetcher: scripts/fetch-orchestrator.mjs:172 `releaseBase = https://github.com/${REPO}/releases/download/orchestrator-v${version}`, :174 `checksumUrl = ${releaseBase}/checksums.txt`, :181-182 fetch + parseChecksums, :231 `if (actualHash !== expectedHash)`; `grep -n -i 'minisig|signature|verify'` over the file returns only the header comment (line 4 'verify its SHA-256'), no signature check; [...]" (reproducer agrees: confirmed / needs-change) "scripts/fetch-orchestrator.mjs:172 `const releaseBase = \`https://github.com/${REPO}/releases/download/orchestr [...]"
- Corrected statement / recommendation: Claim stands. Recommendation needs changes: (a) 'Complete SIGNING.md' is misworded, the doc is written; the one-time setup in it has not been performed. (b) 'add actions/attest-build-provenance plus a cosign bundle' ignores prior art: docs/reviews/circles-p2p-security-remediation-2026-08-14.md:31-32,49-51 already framed cosign-keyless vs minisign as a design call and 6633401 decided minisign; [...]

#### 3.1-26

- Verdict: claim **partially-confirmed**; recommendation **needs-change**. Weight: low. Anchor: `.github/workflows/ci.yml:82`
- Original claim: The repo has no dependabot.yml or renovate config, .github/workflows/ci.yml (around line 82) runs no `pnpm audit`, package.json has no pnpm overrides, and .secrets.baseline is dated 2026-03-28.
- Original recommendation: Add dependabot.yml (npm+cargo+actions) and a non-blocking audit job. | add dependabot and an audit step before public V1 | P0-B.11: fix SECURITY.md path and claim; add dependabot + audit job; commit or move the untracked docs/reviews/circles-p2p-security-remediation-2026-08-14.md.
- What the verifiers found: (reproducer: partially-confirmed / needs-change) "No dependabot/renovate config: `ls .github/dependabot.yml .github/dependabot.yaml renovate.json .renovaterc .github/renovate.json` all 'No such file'. GitHub-side too: `gh api repos/Bitterbot-AI/bitterbot-desktop/vulnerability-alerts` -> HTTP 404 (alerts off), `automated-security-fixes` -> {"enabled":false}, dependabot/alerts -> 403 'Dependabot alerts are disabled for this repository'. [...]" (skeptic: confirmed / needs-change) "`ls .github/dependabot.yml .github/dependabot.yaml renovate.json .renovaterc* .github/renovate.json` -> all 'No such file'. `grep -rn -iE 'pnpm audit|npm audit|cargo audit' .github/workflows/` -> none; [...]"
- Corrected statement / recommendation: The repo has six security overrides plus a 48-hour minimumReleaseAge in pnpm-workspace.yaml (the correct location for pnpm 10), so 'no pnpm overrides' should be dropped. The gap is real for alerting: Dependabot alerts/security updates are disabled at the GitHub repo level as well as absent as a config file, so enabling Dependabot alerts in repo settings is the cheapest first step (no yml needed); a dependabot.yml (npm+cargo+github-actions) and a non-blocking `pnpm audit` / `cargo audit` job remain reasonable additions. [...] (skeptic adds: Claim holds. Recommendation needs two adjustments: (1) dependabot.yml must cover TWO cargo directories (orchestrator/ and desktop/src-tauri/) plus npm (pnpm lockfile v9 is supported) and github-actions [...])

#### 3.1-27

- Verdict: claim **partially-confirmed**; recommendation **needs-change**. Weight: medium. Anchor: `docs/reviews/circles-p2p-security-remediation-2026-08-14.md:3`
- Original claim: docs/reviews/circles-p2p-security-remediation-2026-08-14.md is untracked in the repo tree, its lines 3-5 say "do not commit while CRITICAL items are open", and its status predates commits 017761f/6633401 which fixed those items.
- Original recommendation: Update the status and commit as a closed post-mortem, or move it out of tree; gitignore the pattern. | move the remediation doc out of the repo tree or gitignore it
- What the verifiers found: (reproducer: partially-confirmed / needs-change) "`git status --short` shows `?? docs/reviews/circles-p2p-security-remediation-2026-08-14.md`; `git ls-files docs/reviews | grep -i circles` returns nothing (exit 1); `git check-ignore -v` exit 1 (not ignored). Lines 3-5 of the doc read: '**LOCAL / UNTRACKED, do not commit while CRITICAL items are open.** This enumerates live, unfixed vulnerabilities in a public repo; publishing it is disclosure. [...]" (skeptic agrees: partially-confirmed / needs-change) "Untracked: `git status --short` shows `?? docs/reviews/circles-p2p-security-remediation-2026-08-14.md`; [...]"
- Corrected statement / recommendation: The doc is untracked, not gitignored, and stale relative to 017761f/6633401, but the items it lists are not all closed: B5 signing is unactivated (placeholder key), orchestrator-v0.2.3 is untagged and undeployed, and B7 items (Windows IPC 19002 unauthenticated, replay, peer_id self-claim) remain live as described. Committing it now as a 'closed post-mortem' would publish still-open findings. Cheaper/safer: keep it out of tree (move to the private tracker / docs/plans which is already gitignored at .gitignore:238) until B5 is activated and v0.2.3 deployed; [...]

#### 3.1-29

- Verdict: claim **partially-confirmed**; recommendation **sound**. Weight: low. Anchor: `desktop/src-tauri/tauri.conf.json:24`
- Original claim: desktop/src-tauri/tauri.conf.json sets `csp: null` at line 24 and has the updater active at lines 61-65 with the placeholder pubkey REPLACE_WITH_OUTPUT_OF_TAURI_SIGNER_GENERATE.
- Original recommendation: Not a V1 blocker (Tauri unreleased); generate the key and set a CSP before any desktop build.
- What the verifiers found: (skeptic: partially-confirmed / sound) "desktop/src-tauri/tauri.conf.json:23-25 `"security": { "csp": null }` (line 24 exact). Updater block is lines 59-66: `"active": true` at :60, endpoints :61-63, `"dialog": false` :64, `"pubkey": "REPLACE_WITH_OUTPUT_OF_TAURI_SIGNER_GENERATE"` :65. So 'active at lines 61-65' is off by one (active is :60; 61-63 are endpoints); substance correct. [...]" (reproducer: confirmed / sound) "`cat -n desktop/src-tauri/tauri.conf.json`: line 23 `"security": {`, line 24 `"csp": null`. Updater block is lines 59-66: 59 `"updater": {`, 60 `"active": true,`, 61-63 endpoints array, 64 `"dialog": f [...]"
- Corrected statement / recommendation: Corrected line refs: csp null at :24; updater active at :60, placeholder pubkey at :65. Recommendation is sound and matches existing TAURI.md guidance for the key; add that the CSP must allow ws:// and http:// to the local gateway origin plus the Vite dev origin (:5173) or the Control UI will not connect. (reproducer adds: Minor: cite the updater block as lines 59-66 (active flag at 60). Recommendation is sound; note the meta-tag CSP in desktop/index.html:20 is the currently enforced CSP, so 'set a CSP' means promoting i [...])

### 3.2 Install and self-containment

21 item(s) changed in this section (of 25 verified).

#### 3.2-02

- Verdict: claim **confirmed**; recommendation **needs-change**. Weight: critical. Anchor: `scripts/fetch-orchestrator.mjs:172`
- Original claim: scripts/fetch-orchestrator.mjs line 172 builds the GitHub release download URL from the Cargo.toml version with no fallback to an older published release.
- Original recommendation: Add a fetcher fallback to the newest published release with a loud warning (0.2.2 lacks the B3 rate limiter, stopgap only); add a CI guard that the Cargo version has a published release.
- What the verifiers found: (skeptic: confirmed / needs-change) "scripts/fetch-orchestrator.mjs:172 `const releaseBase = \`https://github.com/${REPO}/releases/download/orchestrator-v${version}\`;` with version from Cargo.toml (:162-168). On checksum fetch failure :187-194 the script warns ("may not be published yet") and returns; there is no retry against another tag and no call to the releases API. [...]" (reproducer: confirmed / sound) "`cat -n scripts/fetch-orchestrator.mjs` line 172: `const releaseBase = \`https://github.com/${REPO}/releases/download/orchestrator-v${version}\`;` where `version` comes solely from readOrchestratorVers [...]"
- Corrected statement / recommendation: Claim stands. The fallback recommendation should be rejected, not adopted as a stopgap: (a) discovering "newest published" needs either the GitHub REST API (unauthenticated 60 req/h - CI and classroom installs will hit it) or the `/releases/latest/download/` redirect, which resolves to the newest release of ANY kind in the repo and will break the moment an app release v1.0.0 is tagged; [...] (reproducer adds: Claim is exact. Recommendation is sound and both parts are genuinely missing today. Verified supporting caveat: `git merge-base --is-ancestor 017761f orchestrator-v0.2.2` -> not an ancestor, so 0.2.2 i [...])

#### 3.2-05

- Verdict: claim **partially-confirmed**; recommendation **needs-change**. Weight: high. Anchor: `src/gateway/server-startup.ts:484; src/commands/doctor-p2p.ts:152`
- Original claim: src/gateway/server-startup.ts line 484 logs "node will be isolated" when the orchestrator binary is missing, and src/commands/doctor-p2p.ts line 152 only emits a warning (not an error) for the missing binary.
- Original recommendation: Doctor error, not warn. | Treat as confirmed critical; fix via release publish (P0).
- What the verifiers found: (reproducer: partially-confirmed / needs-change) "`grep -n isolated src/gateway/server-startup.ts` -> line 484 exactly: `P2P orchestrator bridge FAILED to start, node will be isolated from the network.\n${String(err)}` inside `params.log.warn(` (line 483), with the comment at 480-481 "P2P is core, not optional. Surface the failure loudly". In src/commands/doctor-p2p.ts the missing-binary branch `} else {` begins at line 152; [...]" (skeptic agrees: partially-confirmed / needs-change) "`grep -n "node will be isolated" src/gateway/server-startup.ts` -> exactly line 484 (inside params.log.warn at [...]"
- Corrected statement / recommendation: Line 484 is exact. "doctor-p2p.ts line 152" is off by five lines: 152 is the `} else {`, the warn() emission is at 157. Substance (warn, not error, in both places) is correct. Recommendation "Doctor error, not warn" is NOT sound as stated: it would flip blocksUpdate to true for every node missing the binary, blocking the very update path whose `pnpm install` postinstall re-fetches the binary (the rationale is written in the code at 153-155). [...]

#### 3.2-06

- Verdict: claim **confirmed**; recommendation **needs-change**. Weight: high. Anchor: `.github/workflows (orchestrator release workflow)`
- Original claim: The release workflow in .github/workflows refuses to publish an unsigned orchestrator release until the MINISIGN_SECRET_KEY secret is set.
- Original recommendation: Set minisign secrets so orchestrator-v0.2.3 can be published.
- What the verifiers found: (skeptic: confirmed / needs-change) ".github/workflows/orchestrator-release.yml:141-146 in the `release` job: `MINISIGN_SECRET_KEY: ${{ secrets.MINISIGN_SECRET_KEY }}` then `if [ -z "$MINISIGN_SECRET_KEY" ]; then echo "::error::MINISIGN_SECRET_KEY secret is not set, refusing to publish an unsigned release" >&2; exit 1; fi`, and :177-181 lists `release/checksums.txt.minisig` with `fail_on_unmatched_files: true`. [...]" (reproducer agrees: confirmed / needs-change) "cat -n .github/workflows/orchestrator-release.yml -> lines 141-146 in the `release` job: `MINISIGN_SECRET_KEY: [...]"
- Corrected statement / recommendation: Recommendation is incomplete. Setting the secret alone is not enough to get a useful 0.2.3 out: (1) a keypair must first be generated (`minisign -G -W`, SIGNING.md step 1); (2) deploy/relay-fleet/scripts/update-orchestrator.sh:40 still has `MINISIGN_PUBKEY="RWQ__REPLACE_...PLACEHOLDER"` and :51-53 dies on it, so the relays will refuse the signed release until the public key is committed there (SIGNING.md step 2); [...]

#### 3.2-07

- Verdict: claim **partially-confirmed**; recommendation **needs-change**. Weight: medium. Anchor: `README.md:431; src/wizard/onboarding.p2p.ts:119-122`
- Original claim: README.md line 431 and src/wizard/onboarding.p2p.ts line 122 give advice about the missing orchestrator binary that is wrong (e.g. "normal on fresh clones before pnpm install" shown from a command that already requires node_modules).
- Original recommendation: Fix README:431 and onboarding.p2p.ts:122 advice; say the prebuilt for v<X> could not be downloaded and offer to re-run the fetcher.
- What the verifiers found: (reproducer: partially-confirmed / needs-change) "`grep -n "Orchestrator binary NOT FOUND" README.md` -> 431: `either re-run \`pnpm install\` to trigger the postinstall downloader or \`cargo build --release ...\` to build it locally.` `grep -n "normal on fresh clones" src/wizard/onboarding.p2p.ts`-> line 118 (the cited 122 is`"Options:"`/`"Wait for pnpm install postinstall..."`at 122-123; the misleading sentence is at 118-120). [...]" (skeptic: partially-confirmed / sound) "README.md:431 (exact):`- **"Orchestrator binary NOT FOUND"**: either re-run \`pnpm install\` to trigger the postinstall downloader or \`cargo build --release ...\``. [...]"
- Corrected statement / recommendation: Corrected statement: onboarding.p2p.ts:118-120 gives a logically impossible explanation ('before pnpm install') from inside a command that requires pnpm install; README:431 is accurate when the release exists but misleading today because the fetcher 404s on orchestrator-v0.2.3 and exits 0 with only a warning. Corrected recommendation: fix all four sites (README:431, onboarding.p2p.ts:118-123, doctor-p2p.ts:160, orchestrator-binary.ts:105) to say 'the prebuilt for v<Cargo version> could not be downloaded; [...] (skeptic adds: Claim should read: the onboarding note's 'before pnpm install' framing is self-contradictory (it runs after install), and both README:431 and doctor-p2p.ts:158-160 give 're-run pnpm install' advice tha [...])

#### 3.2-08

- Verdict: claim **partially-confirmed**; recommendation **needs-change**. Weight: critical. Anchor: `docs/start/getting-started.md:35,40; docs/index.md:100; docs/start/setup.md:71; docs/platforms/linux.md:19`
- Original claim: docs/start/getting-started.md lines 35 and 40, docs/index.md line 100, docs/start/setup.md line 71 and docs/platforms/linux.md line 19 instruct users to run `curl -fsSL https://bitterbot.ai/install.sh | bash`.
- Original recommendation: Rewrite Step 1 to the README flow (or ship a real installer served as text/plain); add a docs lint that greps for bitterbot.ai/install. | Either ship a real install.sh/install.ps1 at that URL or remove the command from docs (D1; P0, effort S for docs-only fix). [...]
- What the verifiers found: (reproducer: partially-confirmed / needs-change) "Reproduced with `grep -rn "bitterbot.ai/install"` over the repo (excluding node_modules and docs/reviews): only THREE hits exist: docs/start/getting-started.md:35 `curl -fsSL https://bitterbot.ai/install.sh | bash`, docs/start/getting-started.md:40 `iwr -useb https://bitterbot.ai/install.ps1 | iex`, and docs/reference/RELEASING.md:50 (the optional installer E2E checklist item). [...]" (skeptic agrees: partially-confirmed / needs-change) "Only docs/start/getting-started.md carries the curl-pipe: line 35 `curl -fsSL https://bitterbot.ai/install.sh | [...]"
- Corrected statement / recommendation: Corrected claim: the curl-pipe installer command appears only at docs/start/getting-started.md:35 (bash) and :40 (PowerShell) plus docs/reference/RELEASING.md:50; docs/index.md:100, docs/start/setup.md:71 and docs/platforms/linux.md:19 instead instruct `npm install -g bitterbot@latest` (a separate, equally dead path, see 1-10). [...]

#### 3.2-11

- Verdict: claim **confirmed**; recommendation **needs-change**. Weight: high. Anchor: `git log --all -- '*install.sh' '*install.ps1'`
- Original claim: No file named install.sh or install.ps1 exists anywhere in the repository's git history.
- Original recommendation: Ship a real installer or remove the curl-pipe instructions. | Ship scripts/install.sh and install.ps1 served from bitterbot.ai/install.sh as text/plain: Node >= 22 check, corepack pnpm, clone-or-update, setup-deps.sh non-interactive, pnpm install with PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 NODE_LLAMA_CPP [...]
- What the verifiers found: (skeptic: confirmed / needs-change) "`git log --all --diff-filter=A --name-only --pretty=format: | grep -iE '(^|/)install\.(sh|ps1)$|test-install-sh'` returns nothing; `git log --all --oneline -- '*install.sh' '*install.ps1'` returns nothing; `git ls-files | grep -i 'install\.(sh|ps1)'` returns nothing (the only install-named files are src/_install_.ts, scripts/preinstall-check.mjs, docs/cli/uninstall.md). [...]" (reproducer: confirmed / sound) "`git log --all --oneline --name-only --diff-filter=A -- '*install.sh' '*install.ps1'` returns nothing (no file matching either name was ever added in any branch). [...]"
- Corrected statement / recommendation: Claim stands. The detailed installer spec in the recommendation is over-specified for V1 and partly conflicts with existing code: (1) 're-run = update' duplicates the existing `bitterbot update` command and the shipped in-UI updater; the script should delegate to those, not implement its own update path; (2) `bitterbot onboard` assumes a global bin that a clone-based install never produces, README uses `pnpm bitterbot onboard`; (3) the skip-download env vars are not used anywhere in the repo today, so including them is untested speculation; [...] (reproducer adds: The either/or recommendation is supported by the evidence. Note the detailed installer spec (Node>=22 check, corepack pnpm, setup-deps.sh, PLAYWRIGHT/NODE_LLAMA_CPP skip vars, install-receipt.json) is [...])

#### 3.2-13

- Verdict: claim **confirmed**; recommendation **needs-change**. Weight: medium. Anchor: `docs/platforms/windows.md:145`
- Original claim: docs/platforms/windows.md line 145 tells users to clone github.com/bitterbot/bitterbot.git, which is not this project's repository.
- Original recommendation: Fix the windows.md clone URL. | P0-A.3: fix windows.md clone URL.
- What the verifiers found: (reproducer: confirmed / needs-change) "docs/platforms/windows.md:145 reads `git clone https://github.com/bitterbot/bitterbot.git` (followed by `cd bitterbot`, and a duplicated `pnpm build` at lines 148-149). `git remote -v` -> `origin https://github.com/Bitterbot-AI/bitterbot-desktop.git`; `gh api repos/Bitterbot-AI/bitterbot-desktop` -> full_name `Bitterbot-AI/bitterbot-desktop`, private=false. [...]" (skeptic agrees: confirmed / needs-change) "docs/platforms/windows.md:145 is `git clone https://github.com/bitterbot/bitterbot.git`. [...]"
- Corrected statement / recommendation: Corrected recommendation: fix all 14 occurrences of github.com/bitterbot/bitterbot (package.json bugs/repository URLs, docs.json nav links, and 9 doc pages), not only windows.md:145; a sed replace to https://github.com/Bitterbot-AI/bitterbot-desktop is a single mechanical change. While editing windows.md, also change `cd bitterbot` to `cd bitterbot-desktop` (line 146) and drop the duplicated `pnpm build` (lines 148-149). [...]

#### 3.2-14

- Verdict: claim **partially-confirmed**; recommendation **sound**. Weight: medium. Anchor: `package.json:134-137; RELEASING.md:50`
- Original claim: package.json lines 134-137 define `test:install:*` scripts and RELEASING.md line 50 references the install script flow, both referring to an installer that does not exist.
- Original recommendation: Delete `test:install:*` scripts and fix RELEASING.md. | There is no installer artifact today; V1 needs a real one-command install or docs must stop advertising install.sh.
- What the verifiers found: (skeptic: partially-confirmed / sound) "package.json:134-137 are exactly: `"test:install:e2e": "bash scripts/test-install-sh-e2e-docker.sh"`, `"test:install:e2e:anthropic": ...`, `"test:install:e2e:openai": ...`, `"test:install:smoke": "bash scripts/test-install-sh-docker.sh"`. [...]" (reproducer agrees: partially-confirmed / sound) "package.json:134 `"test:install:e2e": "bash scripts/test-install-sh-e2e-docker.sh"`, :135 `test:install:e2e:ant [...]"
- Corrected statement / recommendation: Corrected statement: package.json:134-137 (test:install:_) and 128-130 (test:docker:_) all invoke scripts that do not exist and never existed; the RELEASING reference is docs/reference/RELEASING.md lines 47-52 (not a single line 50), and line 47 makes a non-existent smoke test a 'required before release' gate. Recommendation sound: delete the seven dead npm scripts and rewrite RELEASING.md 47-52; the 'V1 needs a real one-command install' half is a D1 decision, not a consequence of this finding.

#### 3.2-15

- Verdict: claim **confirmed**; recommendation **needs-change**. Weight: high. Anchor: `Dockerfile:20-21`
- Original claim: Dockerfile lines 20-21 run `COPY ui/package.json` and `COPY patches`, and neither a `ui/` directory nor a `patches/` directory exists in the repo, so `docker build` fails.
- Original recommendation: Fix the Dockerfile (drop ui/patches/Bun, copy desktop/package.json + extensions/\*/package.json) or delete it and its docs entries. | D8: fix the Dockerfile (effort M) and publish to GHCR, or delete Dockerfile, docker-compose.yml, docker-setup.sh and their docs nav entries. [...]
- What the verifiers found: (skeptic: confirmed / needs-change) "Dockerfile:20 `COPY ui/package.json ./ui/package.json`, Dockerfile:21 `COPY patches ./patches` (cat -n). `ls ui patches` -> both 'No such file or directory'; `git ls-files | grep -E '^(ui/|patches/)'` -> empty. Could not break it: the build fails at line 20 before anything else. [...]" (reproducer: confirmed / sound) "Reproduced from scratch. `cat -n Dockerfile` -> line 20 `COPY ui/package.json ./ui/package.json`, line 21 `COPY patches ./patches`. `ls -d ui patches` -> both 'No such file or directory'; [...]"
- Corrected statement / recommendation: Claim stands. Recommendation needs two corrections: (1) it is not 'four lines'/effort M as described, the UI-build step (`pnpm --filter bitterbot-control-ui build`) should be dropped, not renamed, because nothing in src/gateway serves built UI assets (grep of src/gateway for renderer/dist|desktop/dist|index.html serving hits only avatar-http.ts; PLAN-39 gateway-served UI is unbuilt), so a gateway image would carry ~12 MB of unserved assets; a fixed image is a headless gateway image until PLAN-39 lands. [...] (reproducer adds: Recommendation holds. Two additions: (1) if the 'delete' branch is chosen, also delete src/docker-setup.test.ts (it reads docker-setup.sh and docker-compose.yml and runs in CI via test:fast) and the do [...])

#### 3.2-16

- Verdict: claim **confirmed**; recommendation **needs-change**. Weight: high. Anchor: `Dockerfile:30; package.json scripts`
- Original claim: Dockerfile line 30 runs `pnpm ui:build`, but no `ui:build` script is defined in package.json.
- Original recommendation: Use `pnpm --filter bitterbot-control-ui build` instead.
- What the verifiers found: (skeptic: confirmed / needs-change) "Dockerfile:30 `RUN pnpm ui:build`. `node -e` dump of package.json scripts: no `ui:build` key (scripts list includes build, build:plugin-sdk:dts, canvas:a2ui:bundle ... no ui:\*). Repo-wide grep for `ui:build` hits only Dockerfile:30, the audit doc itself, scripts/package-mac-app.sh:120 (an echo string in a dead apps/macos script; [...]" (reproducer: confirmed / sound) "Dockerfile:30 `RUN pnpm ui:build`. Dumped root package.json scripts via `node -e` (full list of ~95 keys): no `ui:build` key; the only `ui`-prefixed entries do not exist at all. [...]"
- Corrected statement / recommendation: `pnpm --filter bitterbot-control-ui build` would run, but it is the wrong fix: the image is a gateway image (CMD runs `gateway`) and src/gateway has no static-serving path for desktop/dist (only avatar PNGs, server-http.ts:560), so the built UI would never be served from the container. Either delete lines 28-30 outright (plus the dead BITTERBOT_PREFER_PNPM env), or make the step conditional on PLAN-39 gateway-served UI actually landing. PLAN-39 lines 248-257 already spell out this dependency.

#### 3.2-18

- Verdict: claim **partially-confirmed**; recommendation **needs-change**. Weight: high. Anchor: `Dockerfile:48`
- Original claim: The Dockerfile runs the orchestrator postinstall as root (binary lands in /root/.bitterbot/bin) before the `USER node` switch at line 48 changes HOME, so the runtime user cannot find the binary.
- Original recommendation: Set `ENV HOME=/home/node` before install.
- What the verifiers found: (reproducer: partially-confirmed / needs-change) "Mechanism reproduced: package.json `postinstall` = `node scripts/fetch-orchestrator.mjs`; scripts/fetch-orchestrator.mjs:33 `const INSTALL_DIR = join(homedir(), ".bitterbot", "bin")`, header comment line 5 `~/.bitterbot/bin/bitterbot-orchestrator`. Dockerfile:24 `RUN pnpm install --frozen-lockfile` runs before any USER switch, i.e. [...]" (skeptic agrees: partially-confirmed / needs-change) "Mechanism is real: package.json `"postinstall": "node scripts/fetch-orchestrator.mjs"`; [...]"
- Corrected statement / recommendation: Corrected statement: `RUN pnpm install` (Dockerfile:24) runs as root, so the orchestrator postinstall would write to /root/.bitterbot/bin, which the `node` user (USER node at line 40, HOME=/home/node via passwd/compose env) neither reads nor looks in; today nothing is downloaded at all because no orchestrator-v0.2.3 release exists. Corrected recommendation: `ENV HOME=/home/node` before install is NOT sufficient, because docker-compose.yml:9/:34 mounts the host config dir over /home/node/.bitterbot and would hide the baked binary. [...]

#### 3.2-20 **ALREADY DONE**

- Verdict: claim **partially-confirmed**; recommendation **already-done**. Weight: medium. Anchor: `docs/docs.json:355,784,1269`
- Original claim: docs/docs.json lines 355, 784 and 1269 reference a page `install/docker` that does not exist in docs/.
- Original recommendation: Fix or delete the docker docs entries.
- What the verifiers found: (reproducer: partially-confirmed / already-done) "docs/docs.json:355-356 is a redirect `"source": "/docker"` -> `"destination": "/install/docker"`; :784 is the nav page entry `"install/docker"` under group 'Other install methods'; :1269 is `"zh-CN/install/docker"` (the Chinese-language variant, not `install/docker` as claimed). `git ls-files docs | grep -E 'docs/(install|zh-CN/install)/'` -> no files; [...]" (skeptic: confirmed / needs-change) "docs/docs.json:355-356 `"source": "/docker", "destination": "/install/docker"`; :784 `"install/docker"` in the Install tab 'Other install methods' pages; [...]"
- Corrected statement / recommendation: Line 1269 references `zh-CN/install/docker`, not `install/docker`; both are missing. The recommendation is correct but is a strict subset of 3.7-3.8-16 (delete the Install nav tab and /install/\* redirects); no separate action is needed beyond that one. (skeptic adds: Statement accurate; add docs/start/setup.md:27 as a fourth reference. Recommendation should not be 'fix or delete' open-ended: until the Dockerfile itself is fixed (line-215 finding) there is nothing t [...])

#### 3.2-21

- Verdict: claim **confirmed**; recommendation **needs-change**. Weight: medium. Anchor: `.github/workflows; git log -- Dockerfile`
- Original claim: No workflow in .github/workflows runs `docker build`, and the Dockerfile has not been modified since the repository's initial commit.
- Original recommendation: Add a `docker build` CI job and GHCR publish on tag, or delete the Docker files.
- What the verifiers found: (reproducer: confirmed / needs-change) "`ls .github/workflows` -> ci.yml, desktop-release.yml, orchestrator-release.yml, skill-review.yml. `grep -rn -iE 'docker (build|buildx)|docker/build-push|docker/setup-buildx|ghcr|Dockerfile' .github/workflows/` -> no matches; `grep -n -i docker ci.yml desktop-release.yml` -> no matches. [...]" (skeptic: confirmed / sound) "`ls .github/workflows` -> ci.yml, desktop-release.yml, orchestrator-release.yml, skill-review.yml; `grep -rln -i docker .github/workflows/` -> no matches; [...]"
- Corrected statement / recommendation: Statement stands. Recommendation needs ordering: adding a `docker build` CI job today would fail immediately at Dockerfile:20 (see 3.2-15), so it only makes sense after the Dockerfile fix, as a regression guard; GHCR publish on tag additionally presupposes a tagging scheme the repo does not yet have (no app tags exist). If Docker is dropped for V1, the cheaper action is to delete Dockerfile, docker-compose.yml, docker-setup.sh, src/docker-setup.test.ts and the docs.json nav/redirect entries rather than add CI. (skeptic adds: Recommendation is sound but must be sequenced: a `docker build` CI job added before 3.2-15/16/18 are fixed just turns CI red; [...])

#### 3.2-22

- Verdict: claim **partially-confirmed**; recommendation **needs-change**. Weight: high. Anchor: `setup-podman.sh:20-21,82; bitterbot.podman.env:4; docs/docs.json:359-360,785`
- Original claim: setup-podman.sh lines 20-21 reference scripts/run-bitterbot-podman.sh and scripts/podman/bitterbot.container.in, neither of which exists in any commit of the repo, and the script hard-exits at line 82; bitterbot.podman.env line 4 repeats the dead command; docs/docs.json lines 359-360 and 785 advertise an `install/podman` page.
- Original recommendation: Delete both podman files and the docs entries. | Delete the Podman installer (D1).
- What the verifiers found: (skeptic: confirmed / needs-change) "setup-podman.sh:20 `RUN_SCRIPT_SRC="$REPO_PATH/scripts/run-bitterbot-podman.sh"`, :21 `QUADLET_TEMPLATE="$REPO_PATH/scripts/podman/bitterbot.container.in"`; :82-85 `if [[ ! -f "$RUN_SCRIPT_SRC" ]]; then echo "Launch script not found..."; exit 1; fi` (check at 82, exit at 84). `git log --all --diff-filter=A -- '*run-bitterbot-podman*' '*bitterbot.container*'` -> empty; [...]" (reproducer: partially-confirmed / sound) "setup-podman.sh:20 `RUN_SCRIPT_SRC="$REPO_PATH/scripts/run-bitterbot-podman.sh"`, :21 `QUADLET_TEMPLATE="$REPO_PATH/scripts/podman/bitterbot.container.in"` -- confirmed. [...]"
- Corrected statement / recommendation: Claim fully holds. Recommendation is directionally right but (1) contradicts docs/plans/PLAN-37-SECRET-CONSOLIDATION.md row 39 / line 663, which decided to KEEP bitterbot.podman.env as the gateway-token template and add a gitignored `.local` variant; D1 must explicitly supersede that. (2) Deleting docs.json:359-360 and :785 alone is inconsistent: `install/docker`, `install/nix`, `install/ansible`, and 266 other docs.json pages are equally missing (270/463 listed pages have no file, counted via node over docs.json), and the `/podman` redirect source is tre [...] (reproducer adds: Line detail: the guard is at line 82 and the actual `exit 1` is at line 84. Broader: the dead docs.json entries are not podman-specific -- the entire install/\* page group has no backing files. [...])

#### 3.2-23

- Verdict: claim **partially-confirmed**; recommendation **needs-change**. Weight: high. Anchor: `src/commands/dashboard.ts:37; src/wizard/onboard-helpers.ts:482`
- Original claim: src/commands/dashboard.ts line 37 and src/wizard/onboard-helpers.ts line 482 open http://127.0.0.1:19001/#token=..., but the gateway on port 19001 serves no UI; docs/start/getting-started.md:14 and docs/start/wizard.md:22 repeat the 19001 URL while README says the UI is on 5173.
- Original recommendation: Point `bitterbot dashboard` at the UI port until D5 lands; then both collapse to 19001. | Fix via PLAN-39 phase 1 (D5). | One canonical install/getting-started doc pointing at the real UI URL. | P0-A.5: bitterbot dashboard and docs point at the real UI port; P0-D.20: remove port 5173 from docs.
- What the verifiers found: (skeptic: partially-confirmed / needs-change) "Core mechanism holds: src/commands/dashboard.ts:30-39 calls resolveControlUiLinks({port: resolveGatewayPort(cfg), ...}) and builds `${links.httpUrl}#token=...` (line 37-39). resolveControlUiLinks lives at src/commands/onboard-helpers.ts:456-485 (NOT src/wizard/onboard-helpers.ts, which does not exist; [...]" (reproducer: partially-confirmed / sound) "Core claim reproduced. src/commands/dashboard.ts:22 `const port = resolveGatewayPort(cfg);` -> :30-35 `resolveControlUiLinks({port, ...})` -> :37-39 `const dashboardUrl = token ? `${links.httpUrl}#toke [...]"
- Corrected statement / recommendation: Corrected claim: `bitterbot dashboard` (src/commands/dashboard.ts:37 via src/commands/onboard-helpers.ts:482), plus `status`, `status --all`, `configure` and non-interactive onboard, print/open http://127.0.0.1:19001/ where the gateway returns 404 at `/` (server-http.ts:710); the interactive wizard already opens :5173. docs/start/getting-started.md:15 and docs/start/hubs.md:24 repeat 19001; wizard.md does not. Corrected recommendation: do not patch dashboard.ts alone; [...] (reproducer adds: Corrected statement: `bitterbot dashboard` (src/commands/dashboard.ts:22-39) and resolveControlUiLinks (src/commands/onboard-helpers.ts:482, not src/wizard/) build http://127.0.0.1:19001/#token=..., an [...])

#### 3.2-24

- Verdict: claim **confirmed**; recommendation **needs-change**. Weight: high. Anchor: `scripts/start-all.mjs:171; desktop/package.json:9; src/wizard/onboarding.finalize.ts:226`
- Original claim: scripts/start-all.mjs line 171 launches the 'production' Control UI via `pnpm dev` (a Vite dev server, desktop/package.json:9, with strictPort 5173), the gateway token is passed via VITE_GATEWAY_TOKEN in desktop/.env, and src/wizard/onboarding.finalize.ts:226 documents this as the product.
- Original recommendation: D5: gateway serves dist-renderer (PLAN-39 phase 1); minimum: `vite preview` of built output. | D5: implement PLAN-39 phase 1 so the gateway serves dist-renderer on 19001, removing port 5173, desktop/.env, and the define-embedded token (P0, effort M). [...]
- What the verifiers found: (skeptic: confirmed / needs-change) "scripts/start-all.mjs:170: `startChild("ui", colors.ui, "pnpm", ["dev"], { cwd: path.join(repoRoot, "desktop") })` (the `startChild` call opens at line 169; the `pnpm`/`dev` args are on line 170, not 171; one line off, same statement) while the gateway child at :161 is `pnpm start gateway` (production gateway + dev UI). [...]" (reproducer: confirmed / sound) "Reproduced: scripts/start-all.mjs:171 `startChild("ui", colors.ui, "pnpm", ["dev"], { cwd: path.join(repoRoot, "desktop") })` (and again at :227 for respawn); [...]"
- Corrected statement / recommendation: Claim stands (minor: start-all anchor is line 169-170, and VITE_GATEWAY_TOKEN also comes from ~/.bitterbot/bitterbot.json via vite.config.ts:21-31, not only desktop/.env). Recommendation mis-cites PLAN-39: per docs/plans/PLAN-39-CONTROL-UI-GATEWAY-SERVING.md, Phase 1 (§5, line 213) is only the build pipeline (`ui:build` + copy to dist/control-ui); [...]

#### 3.2-25

- Verdict: claim **partially-confirmed**; recommendation **needs-change**. Weight: high. Anchor: `scripts/setup-deps.sh:77; package.json playwright`
- Original claim: scripts/setup-deps.sh line 77 runs an unpinned interactive `npx playwright install --with-deps chromium` before `pnpm install`, while package.json pins playwright 1.58.2 as a regular (non-dev) dependency.
- Original recommendation: Remove from setup-deps; lazy `bitterbot browser install`; move playwright to devDependencies (keep playwright-core). | Make Chromium/ffmpeg lazy/optional rather than installed up front in setup-deps.sh. | P0-A.5: remove npx playwright from setup-deps; fix preinstall-check promise; [...]
- What the verifiers found: (reproducer: partially-confirmed / needs-change) "Reproduced from scratch with `cat -n scripts/setup-deps.sh`: line 77 is `if npx playwright --version &>/dev/null 2>&1; then` (a version probe, also via npx); the actual install is line 81 `npx playwright install --with-deps chromium`. Both run before `pnpm install` (README.md:43-44 orders `bash scripts/setup-deps.sh` then `pnpm install`; setup-deps.sh:113-115 prints 'Next steps: 1. pnpm install'). [...]" (skeptic: partially-confirmed / sound) "scripts/setup-deps.sh:77 is `if npx playwright --version &>/dev/null 2>&1; then` (a version probe); the install command `npx playwright install --with-deps chromium` is at line 81, not 77. [...]"
- Corrected statement / recommendation: Corrected claim: setup-deps.sh line 77 probes `npx playwright --version` (output suppressed, so the npx install prompt is invisible) and line 81 runs the unpinned `npx playwright install --with-deps chromium`; both run before `pnpm install`, so npx pulls playwright@latest (1.62.1 today) rather than the pinned 1.58.2. Recommendation corrections: (a) `bitterbot browser install` does not exist; [...] (skeptic adds: Correct the anchor: the probe is line 77, the install is line 81. Add: the probe's redirected prompt and the 'version succeeds -> Chromium never installed' branch. [...])

#### 3.2-27

- Verdict: claim **partially-confirmed**; recommendation **needs-change**. Weight: high. Anchor: `src/wizard/onboarding.ts:121; src/wizard/onboarding.wallet.ts:294; src/wizard/onboarding.embeddings.ts:146`
- Original claim: The QuickStart onboarding path in src/wizard/onboarding.ts (line 121 et al.) presents roughly 14 prompts including forced embeddings and web-search key prompts (onboarding.embeddings.ts:146, onboarding.web-search.ts:120), wallet CDP setup enabled by default (onboarding.wallet.ts:294), skills/hooks multiselects and a GitHub-star prompt.
- Original recommendation: Reduce QuickStart to 3 prompts (risk, provider+key, go); default tools.wallet.enabled=false; reuse the OpenAI key for embeddings; defer the rest to the UI. | Replace with a 3-question QuickStart (risk ack, provider+key, go).
- What the verifiers found: (skeptic: partially-confirmed / needs-change) "Recount of a clean-machine QuickStart with a non-OpenAI provider and no env keys: risk confirm (src/wizard/onboarding.ts:73), flow select (:164, skipped only with --flow), provider select + method select (src/commands/auth-choice-prompt.ts:26, :49), API-key text, default-model select (onboarding.ts:444 → model-picker.ts:347, not flow-gated), embeddings provider select + key text (onboarding.embeddi [...]" (reproducer: partially-confirmed / sound) "Re-derived the QuickStart prompt list from src/wizard/onboarding.ts and its sub-steps (fresh machine, no env keys, no --flow): flow select (onboarding.ts:~165); [...]"
- Corrected statement / recommendation: Corrected statement: QuickStart asks 16-17 prompts on a clean machine (not ~14); the embeddings prompt is forced only for non-OpenAI/Gemini providers, the 'reuse the OpenAI key for embeddings' recommendation is already implemented (auth-choice.apply.openai.ts:98 + embeddings.ts:64-124). Recommendation otherwise directionally sound but '3 prompts' is optimistic: provider+key alone is 2-3 prompts (provider, method, key) plus risk ack, so realistic floor is 4-5. [...] (reproducer adds: 'Roughly 14' is an undercount: 15-19 prompts on a fresh QuickStart. All cited specifics (forced embeddings/web-search, wallet enabled by default at wallet.ts:294, skills/hooks multiselects, star prompt [...])

#### 3.2-28

- Verdict: claim **confirmed**; recommendation **needs-change**. Weight: high. Anchor: `src/wizard/onboarding.finalize.ts:201,89,68-80`
- Original claim: src/wizard/onboarding.finalize.ts line 201 runs a gateway health check 2 seconds after service install with a 10 second timeout, while the same file states cold start is ~60 s, and lines 68-89 install a system service pointed at the git checkout and run `loginctl enable-linger` with sudo without confirmation.
- Original recommendation: Use the existing 90 s waitForGatewayReachable poll; make foreground start:all the default, service opt-in, never sudo without confirm. | Daemon install should not be the QuickStart default for a source checkout; linger should require confirmation. [...]
- What the verifiers found: (skeptic: confirmed / needs-change) "src/wizard/onboarding.finalize.ts:197-202: `if (!opts.skipHealth && installDaemon) { ... await new Promise((resolve) => setTimeout(resolve, 2000)); await healthCommand({ json: false, timeoutMs: 10_000 }, runtime);` (claim's line 201 is the sleep; healthCommand is :202). Same file :648 `// Measured end-to-end ~60s on WSL2; 90s gives comfortable headroom.` and :651-656 `waitForGatewayReachable({... [...]" (reproducer: confirmed / sound) "src/wizard/onboarding.finalize.ts:197-202: `if (!opts.skipHealth && installDaemon) { ... await new Promise((resolve) => setTimeout(resolve, 2000)); [...]"
- Corrected statement / recommendation: Keep the claim. Recommendation fixes: (a) replace the 2 s + 10 s check with `waitForGatewayReachable({deadlineMs: 90_000})` (helper exists, src/commands/onboard-helpers.ts:403-430) but keep the existing soft 'still starting' note since cold boots can exceed 90 s; (b) pass `requireConfirm: true` to ensureSystemdUserLingerInteractive (already supported at systemd-linger.ts:56) instead of rewriting the flow; [...] (reproducer adds: Minor: the 2 s sleep is line 201 and the health call line 202; the health failure is non-fatal (caught, advisory note). [...])

#### 3.2-29

- Verdict: claim **partially-confirmed**; recommendation **needs-change**. Weight: high. Anchor: `README.md:21,39; scripts/setup-deps.sh:27`
- Original claim: README.md line 21 shows a 'macOS · Linux · Windows' badge, but scripts/setup-deps.sh line 27 exits 1 on Windows and nothing in the repo documents or tests native Windows; also README.md:39 requires pnpm (packageManager pnpm@10.23.0) without provisioning it.
- Original recommendation: State 'Windows via WSL2' (D10); add `corepack enable && corepack prepare pnpm@10.23.0 --activate` to setup-deps and README. | D10: say 'Windows via WSL2' everywhere for V1; native Windows post-V1.
- What the verifiers found: (reproducer: partially-confirmed / needs-change) "README.md:21 badge `platform-macOS · Linux · Windows` -- confirmed. setup-deps.sh:27-30: the non-linux/non-darwin branch prints 'Unsupported OS' and `exit 1` (cited line 27 is the `else`; exit is line 30). README.md:39 '**Runtime: Node >= 22** · **Package manager: pnpm**' and README.md:41-45 quick start never installs pnpm; package.json:241 `"packageManager": "pnpm@10.23.0"`; [...]" (skeptic agrees: partially-confirmed / needs-change) "Confirmed: README.md:21 `platform-macOS · Linux · Windows` badge; [...]"
- Corrected statement / recommendation: Corrected claim: README.md:21 advertises native Windows and setup-deps.sh:27-30 exits 1 on it; however the repo DOES test native Windows (ci.yml:22 windows-latest runs install, typechecks and unit tests; only builds are skipped) and the docs already say 'Windows (WSL2)' (docs/platforms/windows.md, docs/start/wizard.md:13, onboarding-overview.md:17), with one contradicting 'Windows (PowerShell)' tab in docs/start/getting-started.md:38-40 that points to https://bitterbot.ai/install.ps1, which (like install.sh) currently serves the HTML homepage, not a scrip [...]

#### 3.2-30

- Verdict: claim **partially-confirmed**; recommendation **needs-change**. Weight: medium. Anchor: `package.json:236; src/infra/orchestrator-bridge.ts:17; orchestrator/src/ipc.rs:238; desktop/src-tauri/tauri.conf.json:65`
- Original claim: package.json (around line 236) lists node-llama-cpp 3.15.1, @lydell/node-pty (beta), sharp, @napi-rs/canvas, matrix crypto and sqlite-vec (alpha) as hard dependencies with zero optionalDependencies; src/infra/orchestrator-bridge.ts:17 and orchestrator/src/ipc.rs:238 use a fixed global /tmp/bitterbot-orchestrator.sock that Rust unlinks on start; [...]
- Original recommendation: Move node-llama-cpp/canvas/matrix crypto to optionalDependencies with runtime detection; use <stateDir>/run/orchestrator.sock; mark TAURI.md internal/experimental.
- What the verifiers found: (skeptic: partially-confirmed / needs-change) "package.json section starts: `"dependencies"` line 145, `"devDependencies"` line 210, `"peerDependencies"` line 234; NO `optionalDependencies` or `peerDependenciesMeta` block (grep). In dependencies: line 157 `"@lydell/node-pty": "1.2.0-beta.3"`, 198 `"sharp": "^0.34.5"`, 200 `"sqlite-vec": "0.1.7-alpha.2"` (confirmed hard deps). [...]" (reproducer agrees: partially-confirmed / needs-change) "package.json section headers via grep: dependencies at line 145, devDependencies at 210, peerDependencies at 23 [...]"
- Corrected statement / recommendation: Corrected statement: node-llama-cpp and @napi-rs/canvas are peerDependencies only (not hard deps, not devDeps); matrix crypto is not a dependency anywhere (only a stale pnpm-workspace.yaml onlyBuiltDependencies line that should be deleted); node-pty (beta), sharp and sqlite-vec (alpha) are the real hard native deps. Corrected recommendation: (1) drop 'matrix crypto' from the action; [...]

### 3.3 Configuration model

17 item(s) changed in this section (of 25 verified).

#### 3.3-01

- Verdict: claim **confirmed**; recommendation **needs-change**. Weight: critical. Anchor: `src/commands/configure.shared.ts:10`
- Original claim: The CONFIGURE_WIZARD_SECTIONS list in src/commands/configure.shared.ts (around line 10) contains no `wallet` entry and no `memory` entry.
- Original recommendation: Add `wallet` and `memory` sections wired to setupWalletForOnboarding / embeddings step, or rewrite all 12 strings that reference them.
- What the verifiers found: (skeptic: confirmed / needs-change) "src/commands/configure.shared.ts:10-19 `CONFIGURE_WIZARD_SECTIONS = ["workspace","model","web","gateway","daemon","channels","skills","health"]`, no `wallet`, no `memory`. `git log --oneline -- src/commands/configure.shared.ts` shows only `33f9833 Initial commit`, so no later commit changed it. [...]" (reproducer: confirmed / sound) "Reproduced from scratch: `grep -rn CONFIGURE_WIZARD_SECTIONS src/` -> definition at src/commands/configure.shared.ts:10. [...]"
- Corrected statement / recommendation: Claim holds. Recommendation is directionally right but 'wired to setupWalletForOnboarding / embeddings step' is not a drop-in: both functions take `{config, flow, prompter}` with an onboarding `flow` argument (src/wizard/onboarding.ts:468,553), so a configure section needs a flow value chosen (or the functions made flow-optional) and must be added to both the `opts.sections` branch (configure.wizard.ts:415ff) and CONFIGURE_SECTION_OPTIONS (configure.shared.ts:47ff) to keep the interactive menu and --section help text in sync. [...]

#### 3.3-02

- Verdict: claim **partially-confirmed**; recommendation **needs-change**. Weight: high. Anchor: `src/commands/configure.commands.ts:27-33`
- Original claim: src/commands/configure.commands.ts lines 27-33 exit with code 1 and the message "Invalid --section" when `bitterbot configure --section <name>` is given a name not in CONFIGURE_WIZARD_SECTIONS.
- Original recommendation: Add `wallet` and `memory` sections, or rewrite the referencing strings. | Mirror the six settings groups as 'configure --section <group>'.
- What the verifiers found: (skeptic: partially-confirmed / needs-change) "src/commands/configure.commands.ts:28-33 does contain `runtime.error("Invalid --section: ...")` + `runtime.exit(1)`. BUT lines 22-26 run first: `const { sections, invalid } = parseConfigureWizardSections(rawSections); if (sections.length === 0) { await configureCommand(runtime); return; }`. [...]" (reproducer: confirmed / sound) "src/commands/configure.commands.ts:22-33: `const { sections, invalid } = parseConfigureWizardSections(rawSections);` ... [...]"
- Corrected statement / recommendation: Corrected statement: `bitterbot configure --section wallet` (or `--section memory`) on its own does NOT exit 1, it silently drops the unknown section and launches the full interactive configure wizard, which has no wallet/memory step. The exit-1 'Invalid --section' path only triggers when at least one valid section is mixed with an invalid one (e.g. docs/cli/configure.md:32's `--section models --section channels`). Arguably worse UX than an error. [...] (reproducer adds: Claim is accurate about the code on lines 27-33, but the runtime behaviour for the documented commands is slightly different: `bitterbot configure --section wallet` (invalid only) hits the `sections.le [...])

#### 3.3-04

- Verdict: claim **partially-confirmed**; recommendation **sound**. Weight: medium. Anchor: `src/commands/onboarding.embeddings.ts:158`
- Original claim: src/commands/onboarding.embeddings.ts line 158 tells users to run `--section memory`, which is not a valid configure section.
- Original recommendation: Add a `memory` section wired to the embeddings step, or rewrite the string.
- What the verifiers found: (reproducer: partially-confirmed / sound) "`git grep -n -- "--section memory"` returns exactly one hit: src/wizard/onboarding.embeddings.ts:158 `" bitterbot configure --section memory",` inside the 'Memory embeddings skipped' note shown when the user declines embeddings setup (lines 154-162). `memory` is not in CONFIGURE_WIZARD_SECTIONS (configure.shared.ts:10-19). [...]" (skeptic: confirmed / sound) "src/wizard/onboarding.embeddings.ts:154-162: on declining embeddings, prompter.note prints `"Skipped. Set one up later via:", " bitterbot configure --section memory", "Or export OPENAI_API_KEY / GEMINI [...]"
- Corrected statement / recommendation: Correct path is src/wizard/onboarding.embeddings.ts:158 (not src/commands/). Substance of the claim stands. (skeptic adds: Effect is worse than 'invalid': the command silently opens the wrong wizard. Either add a `memory` section (needs the onboarding `flow` param resolved, see 3.3-01) or repoint the string to `bitterbot o [...])

#### 3.3-07

- Verdict: claim **partially-confirmed**; recommendation **needs-change**. Weight: critical. Anchor: `src/config/zod-schema.ts:31-41`
- Original claim: MemorySchema in src/config/zod-schema.ts lines 31-41 is defined as `{backend, citations}.passthrough()`, so the 16 memory sub-objects declared in src/config/types.memory.ts lines 33-141 are never validated; a config such as `{memory:{dream:{bogus:1},curiosity:"yes"}}` parses successfully.
- Original recommendation: Mirror MemoryConfig into strict zod with labels/help for kill-switch paths; tests for rejection. | Mirror memory config into zod as strict; expose one 'Memory' toggle plus dream schedule/model. | Validate memory config; expose a single memory.enabled-style toggle plus dream schedule/model as core.
- What the verifiers found: (skeptic: partially-confirmed / needs-change) "src/config/zod-schema.ts:31-41 is exactly `const MemorySchema = z.object({ backend: z.literal("builtin").optional(), citations: z.union([...]).optional() }) ... .passthrough().optional()` (line 39 `.passthrough()`), with a comment at 35-38 saying passthrough is deliberate 'until the schema catches up'. Introduced by 0154e13 (2026-04-14, 'request-frequency analyzer + schema cleanup'); [...]" (reproducer: partially-confirmed / sound) "Reproduced. src/config/zod-schema.ts:31-41 reads `const MemorySchema = z.object({ backend: z.literal("builtin").optional(), citations: z.union([...]).optional() }) /_ comment _/ .passthrough().optional [...]"
- Corrected statement / recommendation: Claim: 15 sub-objects (17 keys), not 16. Recommendation caveats: (1) five of the sub-objects are typed by imports from src/memory/\* (CuriosityConfig, EmotionalConfig, DreamEngineConfig, GCCRFConfig, BudgetConfig) and src/agents/rlm (RLMConfig), so 'mirror MemoryConfig' means mirroring those large external types too; [...] (reproducer adds: The claim is correct except the count: MemoryConfig declares 15 unvalidated sub-objects (17 keys total including backend/citations), not 16. Recommendation stands; [...])

#### 3.3-09

- Verdict: claim **partially-confirmed**; recommendation **needs-change**. Weight: medium. Anchor: `src/memory/curiosity-tool.ts:27`
- Original claim: Memory config read sites disagree on the enabled semantics: src/memory/curiosity-tool.ts:27 uses `!enabled` while src/commands/doctor-memory-system.ts:525 uses `!== false`.
- Original recommendation: Mirror MemoryConfig into strict zod with explicit defaults.
- What the verifiers found: (skeptic: partially-confirmed / needs-change) "The file path is wrong: there is no src/memory/curiosity-tool.ts (`find src -name 'curiosity-tool*'` -> src/agents/tools/curiosity-tool.ts only). At src/agents/tools/curiosity-tool.ts:27 the code is `if (!cfg.memory?.curiosity?.enabled) { return null; [...]" (reproducer: partially-confirmed / sound) "The cited path is wrong: `git ls-files | grep -i curiosity-tool` -> only src/agents/tools/curiosity-tool.ts; src/memory/curiosity-tool.ts does not exist (`sed: can't read`). [...]"
- Corrected statement / recommendation: Claim: the file is src/agents/tools/curiosity-tool.ts:27, and the consequence is that the curiosity_state/curiosity_resolve tools never activate on a default config (wired-but-dead), which should be rated high, not medium. Recommendation: 'strict zod with explicit defaults' does not fix it -- a zod `.default()` on an optional sub-object does not populate memory.curiosity.enabled unless defaults are attached at every nesting level and the loader uses the parsed output. [...] (reproducer adds: Corrected statement: src/agents/tools/curiosity-tool.ts:27 (not src/memory/curiosity-tool.ts) uses `!enabled` (default off) while src/commands/doctor-memory-system.ts:525 and the engine at src/memory/m [...])

#### 3.3-10

- Verdict: claim **partially-confirmed**; recommendation **needs-change** (tiebreak). Weight: low. Anchor: `src/config/types.memory.ts:33-141`
- Original claim: A comment in the memory config code mentions a `requestFrequency` key that does not exist in src/config/types.memory.ts.
- Original recommendation: Grep live configs first before tightening the schema.
- What the verifiers found: (reproducer: partially-confirmed / sound) "The comment exists at src/config/zod-schema.ts:36: `// Memory subsystems (dream, curiosity, consolidation, digest, requestFrequency, etc.)`. `grep -rn requestFrequency src/config/` -> only that comment; it is not a top-level key in src/config/types.memory.ts (17 top-level keys listed, none named requestFrequency). [...]" (skeptic: refuted / needs-change) "The comment is src/config/zod-schema.ts:36: `// Memory subsystems (dream, curiosity, consolidation, digest, requestFrequency, etc.)`. [...]" (tiebreak: partially-confirmed / needs-change) "Checked independently. `grep -rn requestFrequency src/` returns exactly three hits: src/config/zod-schema.ts:36 (`// Memory subsystems (dream, curiosity, consolidation, digest, requestFrequency, etc.)` followed by `// are typed in src/config/types.memory.ts but haven't all been mirrored into zod.`), src/memory/curiosity [...]"
- Corrected statement / recommendation: Corrected statement: the zod-schema.ts:36 comment is accurate about existence but imprecise about nesting: `requestFrequency` is not a top-level MemoryConfig key, it is `memory.curiosity.requestFrequency` (declared src/memory/curiosity-types.ts:135, read at src/memory/manager.ts:3190), which is reachable from types.memory.ts via the imported CuriosityConfig at line 40. Corrected recommendation: keep 'grep live configs before tightening the schema' as general advice, but remove the parenthetical citing requestFrequency as an example of comment/type drift; [...]

#### 3.3-11

- Verdict: claim **confirmed**; recommendation **needs-change**. Weight: critical. Anchor: `desktop/renderer/src/components/config/ConfigView.tsx:6-64`
- Original claim: In desktop/renderer/src/components/config/ConfigView.tsx (lines 6-64 and 99-118), ConfigFormView ignores its `onSave`/`saving` props and renders `Object.entries` as plain text; only the raw `<textarea>` path writes config, via the `config.apply` RPC.
- Original recommendation: Curated form driven by config.schema hints for gateway auth/bind, circles/wallet/p2p/sandbox toggles, update policy via config.patch (restart-aware); raw JSON under Advanced. | Configuration is the weakest V1 story; [...]
- What the verifiers found: (skeptic: confirmed / needs-change) "desktop/renderer/src/components/config/ConfigView.tsx (254 lines, only 2 commits: 35b3a0f 'Electron App', 8b13436 formatting). ConfigFormView at :6-64 destructures `onSave, saving` (:8-9) and never references them in the body; :37-48 `Object.entries(value).map(([key, val]) => <span>…String(val)</span>)` renders read-only text, no inputs/onChange. [...]" (reproducer: confirmed / sound) "Reproduced from scratch with `cat -n desktop/renderer/src/components/config/ConfigView.tsx` (254 lines). `ConfigFormView` spans lines 6-64 exactly; [...]"
- Corrected statement / recommendation: Claim stands. Recommendation should be adjusted: (1) do not route keys that already have typed RPCs (trust settings, agentDrafts, models keys, channels) through config.patch a second time; use config.patch only for keys with no dedicated RPC (gateway.auth/bind, p2p.enabled, tools.wallet.enabled, update._); (2) explicitly surface the restart consequence per toggle, since p2p._ and gateway._ resolve to restart while circles._/tools.\* are hot/none; [...] (reproducer adds: Claim text should cite the raw path as lines 66-118 (ConfigRawView) with the write at line 159 (`config.apply`), not "99-118". Recommendation stands; [...])

#### 3.3-14

- Verdict: claim **partially-confirmed**; recommendation **needs-change**. Weight: medium. Anchor: `desktop/renderer/src/components/CirclesView.tsx:84`
- Original claim: Four Control UI views instruct users to hand-edit config keys: CirclesView.tsx:84, WalletView.tsx:271, CircleCanvas.tsx:228, and P2pDashboard.tsx:91.
- Original recommendation: Replace the 4 hand-edit strings with toggles. | P0-C.15: settings form via config.schema + config.patch for a curated key set; raw JSON under Advanced; replace the four strings with toggles; Labs section from a manifest.
- What the verifiers found: (skeptic: partially-confirmed / needs-change) "All four anchor paths are wrong at the directory level: actual files are desktop/renderer/src/components/circles/CirclesView.tsx, wallet/WalletView.tsx, circles/CircleCanvas.tsx, p2p/P2pDashboard.tsx (find output). Line numbers hold: CirclesView.tsx:84 `<code>circles.enabled = true</code> in your config.`; [...]" (reproducer agrees: partially-confirmed / needs-change) "The cited paths are wrong (files live in subdirectories) but the line numbers are right: `find` gives desktop/r [...]"
- Corrected statement / recommendation: Corrected statement: three views give explicit hand-edit instructions (circles/CirclesView.tsx:84, wallet/WalletView.tsx:269-273, p2p/P2pDashboard.tsx:91); wallet/WalletView.tsx:421 adds a fourth 'enable in config' hint; circles/CircleCanvas.tsx:228 only names the key. Corrected recommendation: replace the 4 real strings (CirclesView:84, WalletView:269-273, WalletView:421, P2pDashboard:91) with toggles; leave CircleCanvas:228 as a status note (it is already a consent-posture explanation, not an instruction). [...]

#### 3.3-17

- Verdict: claim **confirmed**; recommendation **needs-change**. Weight: high. Anchor: `docs/gateway/configuration-reference.md:14`
- Original claim: docs/gateway/configuration-reference.md is 2,553 lines long and contains zero occurrences of circles, `a2a.`, `memory.`, forage, commerce, harnessEvolve, curiosity, dream, autoRollback, liveDiscovery, `update.`, or skillSeekers.
- Original recommendation: Add "Memory & biology" and "Network" sections; generate a keys appendix from the schema. | Generate a keys appendix from the schema (script next to write-build-info.ts); add 'Bitterbot settings' section at top. | Document or hide the undocumented sections before V1.
- What the verifiers found: (reproducer: confirmed / needs-change) "Reproduced: `wc -l docs/gateway/configuration-reference.md` = 2553. Case-insensitive grep -c per term: circles 0, `a2a\.` 0, forage 0, commerce 0, harnessEvolve 0, curiosity 0, dream 0, autoRollback 0, liveDiscovery 0, `update\.` 0, skillSeekers 0. `memory\.` case-insensitive = 1 hit, but it is line 572 `MEMORY.md` (a workspace bootstrap filename), not a config key; case-sensitive `memory\.` = 0. [...]" (skeptic agrees: confirmed / needs-change) "`wc -l docs/gateway/configuration-reference.md` = 2553. Case-insensitive grep -c per term: circles 0, `a2a\.` 0 [...]"
- Corrected statement / recommendation: Claim stands (the single `memory.` false-positive is MEMORY.md). Recommendation tweak: a keys-appendix generator should reuse the already-existing `config.schema` builder (src/config/schema.ts / server-methods/config.ts:254) rather than re-walking zod; also note the hint tables it would draw labels/help from are empty for the missing groups (schema.labels.ts / schema.help.ts have 2 memory.\* entries and 0 for circles/p2p/a2a/forage/commerce), so generated output will be key names only unless those tables are filled. [...]

#### 3.3-18

- Verdict: claim **confirmed**; recommendation **needs-change**. Weight: medium. Anchor: `src/config/schema.hints.ts:22`
- Original claim: GROUP_LABELS in src/config/schema.hints.ts (around line 22) lacks entries for memory, circles, p2p, and a2a but includes entries for `presence` and `voicewake`, which are dead config groups.
- Original recommendation: Fix GROUP_LABELS.
- What the verifiers found: (skeptic: confirmed / needs-change) "src/config/schema.hints.ts:22-48 GROUP_LABELS keys: wizard, update, diagnostics, logging, gateway, nodeHost, agents, tools, bindings, audio, models, messages, commands, session, cron, hooks, ui, browser, talk, channels, skills, plugins, discovery, presence, voicewake. No memory/circles/p2p/a2a (also missing: forage, commerce, auth, web, media, approvals, broadcast, canvasHost, env, meta). [...]" (reproducer: confirmed / sound) "src/config/schema.hints.ts:22-48 GROUP_LABELS contains: wizard, update, diagnostics, logging, gateway, nodeHost, agents, tools, bindings, audio, models, messages, commands, session, cron, hooks, ui, br [...]"
- Corrected statement / recommendation: The table is wrong as stated, but 'Fix GROUP_LABELS' alone is a no-op for users: nothing in the Control UI reads uiHints.group today. Either pair the fix with making ConfigFormView consume hint groups/labels, or drop it from the V1 list. Also add the other missing root groups (forage, commerce, auth, web, media, approvals, broadcast, canvasHost), not just the four named.

#### 3.3-19

- Verdict: claim **partially-confirmed**; recommendation **needs-change**. Weight: high. Anchor: `docs/plans/PLAN-37-SECRET-CONSOLIDATION.md:38`
- Original claim: Per docs/plans/PLAN-37-SECRET-CONSOLIDATION.md:38, the codebase has 37 on-disk secret locations, 263 distinct `process.env.*` keys (113 of them `BITTERBOT_*`), and 35 `writeConfigFile` call sites, and the wizard still writes `.env` files.
- Original recommendation: Land PLAN-37 Phase 0-1 only: read-only auth loader, stop wizard writing .env, `bitterbot doctor auth` as the which-key-wins tool. | Remove legacy migration shims; consolidate secret stores per PLAN-37 before or soon after V1.
- What the verifiers found: (reproducer: partially-confirmed / needs-change) "Anchor divergence: docs/plans/PLAN-37-SECRET-CONSOLIDATION.md:34-37 says "at least 37 distinct on-disk locations across three filesystems ... ~41 provider env vars plus ~26 secret-shaped config fields plus 4 free-form env Records". The doc contains NO '263', '113', or 'writeConfigFile' anywhere (grep -n -E '263|113|writeConfigFile' returns only '.env:35' PAT references). [...]" (skeptic agrees: partially-confirmed / needs-change) "Anchor misattribution: docs/plans/PLAN-37-SECRET-CONSOLIDATION.md:38 says only 'at least 37 distinct on-disk lo [...]"
- Corrected statement / recommendation: Corrected statement: PLAN-37 (a gitignored local doc, not in the repo) counts 37 on-disk locations and ~41 env vars + ~26 secret config fields; independent counting gives 263 distinct process.env keys in src/ (112 BITTERBOT\_\*; 113 only if extensions/ is included, where the total is 266), 63 writeConfigFile call sites across 35 files, and the wizard writes desktop/.env at two sites (control-ui-env.ts:99, p2p.ts:257). [...]

#### 3.3-20

- Verdict: claim **partially-confirmed**; recommendation **needs-change**. Weight: medium. Anchor: `docs/plans/PLAN-37-SECRET-CONSOLIDATION.md`
- Original claim: Only one PLAN-37 (secret consolidation) commit has landed in git history.
- Original recommendation: Land PLAN-37 Phase 0-1 only. | Backlog; do Phase 0-1 for V1.
- What the verifiers found: (reproducer: partially-confirmed / needs-change) "`git log --all -i --grep='PLAN-37'` and `--grep='secret consolidation'` return exactly one commit: dd57ae8 (2026-07-31) 'feat(ui-usability): models.auth.\* RPC family + shared auth-probe module'. Its body mentions PLAN-37 only in passing ('clears cooldown/failure state on rotation (PLAN-37 H2)'); it is a UI-usability Phase 2 commit, not a PLAN-37 phase commit. [...]" (skeptic agrees: partially-confirmed / needs-change) "`git log --oneline --all -i --grep='PLAN-37'` returns exactly one commit: dd57ae8 2026-07-31 'feat(ui-usability [...]"
- Corrected statement / recommendation: Corrected statement: zero commits are PLAN-37 phase work; one commit (dd57ae8) references PLAN-37 tangentially while delivering the winning-source provenance RPC that Phase 0 G5 calls for. The plan doc is not in git (docs/plans/ gitignored). Recommendation stays 'Phase 0-1 for V1' but should credit that the provenance resolver already exists in models-auth.ts and scope Phase 0 to: read-only loader + `doctor auth` CLI wrapper over that resolver + stop wizard desktop/.env writes. [...]

#### 3.3-21

- Verdict: claim **partially-confirmed**; recommendation **needs-change**. Weight: high. Anchor: `src/memory/dream-types.ts:278`
- Original claim: The dream-engine model is hard-coded to `openai/gpt-4o-mini` in src/memory/dream-types.ts:278 (used at src/memory/manager.ts:2613 and :3104) regardless of the configured provider, and the first dream cycle fires at +5 minutes after boot (manager.ts:2800), so Anthropic-only installs log `dream cycle failed` on every cycle and OpenAI-keyed installs start spending within 5 minutes. [...]
- Original recommendation: Default to the resolved primary model (or cheap sibling via alias table); skip first cycle on an empty DB; log once which model dreams use; expose in Models view. | As in 3.3 (change dream model default / first-cycle timing). [...]
- What the verifiers found: (skeptic: partially-confirmed / needs-change) "CONFIRMED parts: src/memory/dream-types.ts:278-279 `model: "openai/gpt-4o-mini"`, `synthesisModel: "openai/gpt-4o-mini"`; src/memory/manager.ts:2613 `this.buildLlmCallFn(dreamCfg?.model ?? "openai/gpt-4o-mini")`, :3104 (predictor) and also :3331 (discovery agent) and :6169, the fallback is hard-coded in 5 places, not 2. [...]" (reproducer agrees: partially-confirmed / needs-change) "Reproduced from scratch (grep 'gpt-4o-mini' src/memory): src/memory/dream-types.ts:278 `model: "openai/gpt-4o-m [...]"
- Corrected statement / recommendation: Corrected claim: the dream/predictor/discovery fallback model is hard-coded to openai/gpt-4o-mini in 5 sites (dream-types.ts:278-279; manager.ts:2613, 3104, 3331, 6169) unless memory.dream.model is set (documented, accepted by config). On Anthropic-only installs the LLM modes fail per-cycle with `<mode> mode failed: No API key resolved for provider "openai"`, while non-LLM modes still run; the cycle itself does not fail. Cycles already skip on DBs with <5 eligible chunks. Corrected recommendation: drop 'skip first cycle on empty DB' (already done). [...]

#### 3.3-22

- Verdict: claim **partially-confirmed**; recommendation **needs-change**. Weight: medium. Anchor: `src/config/schema.hints.ts:14`
- Original claim: src/config/schema.hints.ts:14 declares an `advanced?: boolean` hint field that is never populated anywhere, so expert keys (allowInsecureAuth, dangerouslyDisableDeviceAuth, trusted-proxy, tls, http.endpoints, nodes, diagnostics, update.channel=dev, browser.profiles, nodeHost, canvasHost, discovery.wideArea, skills.p2p, p2p.nodeTier/genesisTrustList) are presented alongside port/ [...]
- Original recommendation: Add an ADVANCED_PATHS prefix list covering those plus all memory.\* except enabled/dream.model/dream.intervalMinutes. | Mark those gateway keys as advanced. | Populate the already-declared advanced hint (ADVANCED_PATHS); ConfigView opens common fields with advanced under a per-section disclosure; [...]
- What the verifiers found: (reproducer: partially-confirmed / needs-change) "`advanced?: boolean` is declared at src/config/schema.hints.ts:14 and re-exposed in schema.ts:78 (Pick<ConfigUiHint,...'advanced'...>) and gateway protocol schema (src/gateway/protocol/schema/config.ts:55). `grep -rn '\badvanced\b' src` shows no site ever sets `advanced:` on a hint (other hits are wizard flow names, plugin types, Tavily depth). [...]" (skeptic: confirmed / needs-change) "src/config/schema.hints.ts:14 `advanced?: boolean;` in ConfigUiHint; src/config/schema.ts:78 picks 'advanced' into the hint type. [...]"
- Corrected statement / recommendation: Corrected statement: the `advanced` hint is declared, plumbed through config.schema, and never populated; but no UI currently consumes hints at all, ConfigView is a flat dump of the file's keys plus a raw editor with baseHash guard (ConfigView.tsx:156-161 already passes baseHash). Recommendation: populating ADVANCED_PATHS alone changes nothing visible; it must be paired with the renderer work (ConfigFormView consuming config.schema hints for grouping/disclosure). [...] (skeptic adds: Claim holds. Recommendation: the 'raw JSON5 editor stays as second view with base-hash guard' part is ALREADY DONE (ConfigView.tsx:66-120, 188-207). [...])

#### 3.3-23

- Verdict: claim **partially-confirmed**; recommendation **needs-change**. Weight: medium. Anchor: `src/config/legacy.rules.ts:3`
- Original claim: src/config/legacy.rules.ts plus legacy.migrations.part-1/2/3.ts total roughly 1,300 lines migrating top-level whatsapp/telegram/routing/agent/identity/msteams keys dating from the initial commit; the migration runs on every config load, and two e2e tests exist only to exercise it.
- Original recommendation: Delete (keep a one-line gateway.token -> gateway.auth.token rule if fleet nodes need it). | REMOVE the legacy migrations.
- What the verifiers found: (skeptic: partially-confirmed / needs-change) "Line counts (`wc -l src/config/legacy*.ts`): legacy.rules.ts 136, part-1 384, part-2 421, part-3 221 => the four named files total 1,162 (not ~1,300); whole legacy family incl. shared/legacy.ts/legacy-migrate.ts = 1,362. All date from 33f9833 'Initial commit' 2026-03-28 (git log --diff-filter=A). [...]" (reproducer agrees: partially-confirmed / needs-change) "Line counts: legacy.rules.ts 136 + part-1 384 + part-2 421 + part-3 221 = 1162 (full legacy.\* family incl. [...]"
- Corrected statement / recommendation: Corrected claim: ~1,160 lines across the four files (1,360 with legacy.ts/legacy.shared.ts/legacy-migrate.ts); the migration is NOT applied on load, load only detects legacy keys and fails validation (io.ts:753, validation.ts:93), migrations run via `bitterbot doctor` (doctor-config-flow.ts:431) and the gateway config-restore RPC (server-methods/config.ts:344); at least 5 test files cover it. [...]

#### 3.3-24

- Verdict: claim **partially-confirmed**; recommendation **needs-change**. Weight: medium. Anchor: `src/agents/models-config.ts:111`
- Original claim: Config defaults are scattered across 114 `?? true` / `!== false` sites, and bitterbot.json competes with per-agent models.json (src/agents/models-config.ts:111), auth-profiles.json, three `.env` files, the daemon unit env, and in-memory runtime-overrides.ts.
- Original recommendation: Single DEFAULTS table with a test that every zod `enabled` flag has an entry; `bitterbot config explain <path>`.
- What the verifiers found: (skeptic: partially-confirmed / needs-change) "Count recheck: `grep -rhoE '\?\? true|!== false' src --include=*.ts --exclude=*.test.ts | wc -l` = 280 (287 incl. tests); restricting to `enabled ?? true|enabled !== false` = 106. Neither equals 114; the report's number only roughly matches the `enabled`-scoped count. [...]" (reproducer agrees: partially-confirmed / needs-change) "Counts I reproduced (src, _.ts, excluding _.test.ts): `?? true` = 106 (110 incl. tests; [...]"
- Corrected statement / recommendation: Corrected claim: 280 `?? true`/`!== false` sites in non-test src (106 of them on an `enabled` flag); the '114' figure is unreproducible. Recommendation: a single DEFAULTS table for every zod `enabled` flag is a large refactor touching ~106 call sites; for V1 the cheaper, already-planned path is (a) the schema-derived keys appendix (3.3-17) which would list defaults, and (b) PLAN-37 for the secret/env-file precedence half. [...]

#### 3.3-25

- Verdict: claim **partially-confirmed**; recommendation **needs-change**. Weight: medium. Anchor: `src/config/defaults.ts:621`
- Original claim: By default (src/config/defaults.ts:621) a fresh install contacts four bitterbot.ai services: mailbox, p2p DNS + relays, onramp, and update check + live model discovery; and .env.example (dated May 22, line 77) lists only 7 BITTERBOT\_\* variables while src reads 113; [...]
- Original recommendation: Document outbound endpoints and add a network.offline / Local-only wizard choice; regenerate .env.example from a curated allowlist; set skills-economy defaults OFF, mark advanced, remove from docs until Tier 2 fixes land.
- What the verifiers found: (skeptic: partially-confirmed / needs-change) "Mailbox: src/config/defaults.ts:621 `DEFAULT_CIRCLES_MAILBOX_URL = "https://mailbox.bitterbot.ai"`, applied at defaults.ts:626-632 with `circles.enabled ?? true` and `mailbox: { url: DEFAULT_CIRCLES_MAILBOX_URL, ...circles.mailbox }` -> CONFIRMED default-on outbound. [...]" (reproducer agrees: partially-confirmed / needs-change) "Reproduced from scratch. (a) src/config/defaults.ts:621 `export const DEFAULT_CIRCLES_MAILBOX_URL = "https://ma [...]"
- Corrected statement / recommendation: Corrected claim: a fresh install contacts TWO bitterbot.ai services by default (mailbox.bitterbot.ai and p2p.bitterbot.ai DNS) plus three hard-coded DigitalOcean relay IPs; onramp.bitterbot.ai is contacted only when the user invokes wallet.stripeOnramp; the update check goes to registry.npmjs.org and live model discovery goes to api.anthropic.com / provider baseUrls. .env.example (2026-05-22) lists 9 BITTERBOT\_\* vars vs ~120-141 read in non-test src. [...]

### 3.4 UI cleanup: experimental and debug surface removal

17 item(s) changed in this section (of 21 verified).

#### 3.4-01

- Verdict: claim **confirmed**; recommendation **needs-change**. Weight: high. Anchor: `desktop/renderer/src/components/dreams/DreamsView.tsx:27-36`
- Original claim: desktop/renderer/src/components/dreams/DreamsView.tsx lines 27-36 render the "Dreams (beta)" view as an iframe that loads the gateway dream dashboard page (src/gateway/dream-dashboard-page.ts) rather than native React UI.
- Original recommendation: Replace with a native React summary (last dream, next scheduled, utility KPI) plus Status/Utility/History tabs; drop the "(beta)" label. | Classify Dreams EXPERIMENTAL; remove '(beta)' iframe from primary nav for V1.
- What the verifiers found: (skeptic: confirmed / needs-change) "desktop/renderer/src/components/dreams/DreamsView.tsx:26-39, `export function DreamsView()`; line 27 `const src = useMemo(() => \`${resolveGatewayHttpUrl()}/dreams\`, [])`; lines 31-36 `<iframe src={src} className="flex-1 w-full border-0" title="Dream Engine Dashboard" allow="autoplay" />`. No other JSX in the component. [...]" (reproducer: confirmed / sound) "Reproduced at HEAD c5e1f97. `cat -n desktop/renderer/src/components/dreams/DreamsView.tsx` lines 26-39: `export function DreamsView() { const src = useMemo(() => `${resolveGatewayHttpUrl()}/dreams`, [] [...]"
- Corrected statement / recommendation: The claim stands. The merged recommendation is self-contradictory: one half says rebuild natively and drop '(beta)', the other says classify EXPERIMENTAL and remove the '(beta)' iframe from primary nav. Pick one. Prior art the report ignored: docs/plans/PLAN-39-CONTROL-UI-GATEWAY-SERVING.md (DRAFT, 'FUTURE WORK, not scheduled') line 394 explicitly plans to 'Keep DreamsView/ArtifactPanel iframes pointed at the derived origin', i.e. the standing plan keeps the iframe and fixes its auth by serving the UI same-origin. [...]

#### 3.4-02

- Verdict: claim **confirmed**; recommendation **needs-change**. Weight: medium. Anchor: `src/gateway/dream-dashboard-page.ts:99-108`
- Original claim: src/gateway/dream-dashboard-page.ts lines 99-108 define ten tabs: Status, Utility, History, Analytics, Emotional, Curiosity, Retrieval, Earnings, Forage, Live.
- Original recommendation: Keep Status/Utility/History; put Analytics/Emotional/Curiosity/Retrieval/Live behind Advanced; remove Earnings and Forage tabs. | Remove Forage/Earnings tabs from the V1 Dreams surface. | Trim the Dreams dashboard UI: drop the Forage and Earnings tabs from the V1 surface.
- What the verifiers found: (skeptic: confirmed / needs-change) "`grep -n 'data-tab=' src/gateway/dream-dashboard-page.ts` returns exactly 10 lines, 99-108: status, utility, history, analytics, emotional, curiosity, retrieval, earnings, forage, live (line 99 `<button class="tab active" data-tab="status">Status</button>` ... line 108 `data-tab="live">Live`). File last touched e965cd5 (PLAN-40 Phases 1-3); tab block unchanged since. [...]" (reproducer: confirmed / sound) "`sed -n 98,109p src/gateway/dream-dashboard-page.ts` shows `<div class="tabs">` at line 98 followed by exactly ten `<button class="tab" data-tab=...>` elements at lines 99-108 in this order: status/Sta [...]"
- Corrected statement / recommendation: Counts and line numbers are exact. But 'remove Forage/Earnings tabs' deletes the only UI surface for PLAN-29 Forage (memory: Forage LIVE 2026-07-06, seed tranche funded), the renderer has zero forage components to fall back to. Better: gate the two tabs on the backend actually being enabled (forage config under src/config/zod-schema.ts:505-520 `forage.nightShift.enabled` / `forage.pools.enabled`; marketplace already self-reports `enabled:false`) so a default install hides them while operators running Forage keep the scoreboard. [...]

#### 3.4-03

- Verdict: claim **partially-confirmed**; recommendation **sound**. Weight: medium. Anchor: `src/gateway/dream-dashboard-page.ts`
- Original claim: src/gateway/dream-dashboard-page.ts contains the customer-visible headings "Review queue, rate lane outputs (D1 pilot)", "Closed-loop cognition (PLAN-34)" and "Canonical memory ledger (PLAN-33)", and the strings cortisol (9 occurrences), dopamine (9 occurrences) and GCCRF (7 occurrences).
- Original recommendation: Strip PLAN/D1 labels and internal jargon from any customer-facing page. | Trim Dreams dashboard to Status/Utility/History as native React under Labs (D6). | P0-C.14: native summary + trimmed tabs; remove Forage/Earnings; drop '(beta)'; strip PLAN/D1 labels. [...]
- What the verifiers found: (skeptic: partially-confirmed / sound) "Headings, exact: dream-dashboard-page.ts:123 `<h3 ...>Review queue, rate lane outputs (D1 pilot)</h3>`, :167 `Closed-loop cognition (PLAN-34)`, :170 `Canonical memory ledger (PLAN-33)`. Counts (my `grep -o | wc -l`): case-INsensitive cortisol=9, dopamine=9, gccrf=7, matches the report; [...]" (reproducer: confirmed / sound) "Headings (all inside `<h3>` elements, i.e. rendered/customer-visible): line 123 `<h3 ...>Review queue, rate lane outputs (D1 pilot)</h3>` (note: actual text uses an em-dash, not the comma in the claim) [...]"
- Corrected statement / recommendation: Restate as: three PLAN/D1 headings (lines 123/167/170) plus a visible 'PLAN-40 Phases 1-3' empty-state at line 574 and two visible 'GCCRF' strings (155, 709); hormone names appear in two parenthetical labels only, the rest are code. Recommendation to strip labels is sound; note memory (project_audit_continuation) records PLAN-40 Lane 1 parked / Lane 2 deleted, so the 'Review queue (D1 pilot)' card is dead UI and should be removed, not just relabeled. [...] (reproducer adds: Heading text is "Review queue, rate lane outputs (D1 pilot)" (em-dash, not comma). Counts are case-insensitive (case-sensitive: cortisol 8, dopamine 8, GCCRF 5). [...])

#### 3.4-04

- Verdict: claim **confirmed**; recommendation **needs-change**. Weight: high. Anchor: `src/gateway/server-http.ts:514-533`
- Original claim: src/gateway/server-http.ts lines 514-533 waive authentication for the dream dashboard page only for loopback requests, so a user loading the Control UI from a LAN (non-loopback) address gets an auth error inside the Dreams iframe.
- Original recommendation: Replace the iframe with native React views so the dashboard does not depend on the loopback auth waiver. | SHIP-ADVANCED: replace with a native summary (last dream, next scheduled, utility); drop "(beta)" from the nav label; remove Forage/Earnings tabs.
- What the verifiers found: (skeptic: confirmed / needs-change) "src/gateway/server-http.ts:514 `if (requestPath === "/dreams" && req.method === "GET")` ... :522 `if (!authResult.ok && !isLocalDirectRequest(req, trustedProxies)) { sendGatewayAuthFailure(res, authResult); return; }` ... :533 `res.end(renderDreamDashboardPage(wsUrl, gatewayToken))`, anchor exact. [...]" (reproducer: confirmed / sound) "src/gateway/server-http.ts:514-533 reproduced: the `/dreams` GET handler calls `authorizeGatewayConnect` with `connectAuth: token ? {token, password: token} : null` where `token = getBearerToken(req)`, [...]"
- Corrected statement / recommendation: Claim holds (LAN/bind=lan users get `sendGatewayAuthFailure` inside the iframe). Recommendation should not present the native rewrite as the only fix: two cheaper, already-planned options exist, (a) PLAN-39 same-origin serving so the iframe inherits the page's auth (PLAN-39:393-394), (b) the derived read-scoped dashboard token noted at server-http.ts:512 (never shipped; PLAN-40 Lane 2 was deleted). Also scope the severity: default bind is loopback, so only operators who opted into LAN/auto bind hit this. (reproducer adds: Claim holds, but narrow the premise: this only bites when gateway.bind is non-loopback AND an auth token/password is configured AND the UI is opened from a non-loopback origin; [...])

#### 3.4-06

- Verdict: claim **partially-confirmed**; recommendation **sound**. Weight: medium. Anchor: `desktop/renderer/src/components/guards/ActiveGuardsView.tsx:91`
- Original claim: desktop/renderer/src/components/guards/ActiveGuardsView.tsx contains the user-facing string "Restart the gateway to load PLAN-20", which is the only user-facing "PLAN-" reference anywhere in the renderer source.
- Original recommendation: Rewrite the copy to remove the PLAN-20 reference. | Rename Active Guards to 'Safety rules' and remove plan-number copy.
- What the verifiers found: (reproducer: partially-confirmed / sound) "Reproduced with `grep -rn "PLAN-" desktop/renderer/src --include=*.tsx --include=*.ts` (35 hits), then filtered out comment lines (`*`, `//`, `/**`). Exactly two non-comment (string-literal) hits survive, BOTH in desktop/renderer/src/components/guards/ActiveGuardsView.tsx: line 91 `setError("Gateway did not return guard status. [...]" (skeptic agrees: partially-confirmed / sound) "desktop/renderer/src/components/guards/ActiveGuardsView.tsx:91 `setError("Gateway did not return guard status. [...]"
- Corrected statement / recommendation: ActiveGuardsView.tsx contains the only two user-facing "PLAN-" strings in the renderer (line 91 "Restart the gateway to load PLAN-20." and line 97 "Gateway needs a restart to expose guards.status (PLAN-20)."); no other renderer string literal references a plan number. Recommendation stands: rewrite both lines 91 and 97 (not just 91).

#### 3.4-07

- Verdict: claim **confirmed**; recommendation **needs-change**. Weight: medium. Anchor: `desktop/renderer/src/components/guards/ActiveGuardsView.tsx:239-246`
- Original claim: ActiveGuardsView.tsx (lines 97,133,158,162,239-246,270,330,392) exposes the internal path `src/agents/skills/builtin-interceptors/`, the labels "Registered Interceptors", "Recent Persisted Records" and "Promote to skills/", and renders the raw RPC error `msg` string directly to the user.
- Original recommendation: Rewrite copy and map raw RPC errors to user-facing messages. | Strip PLAN-20 and `src/` paths from the UI; rename the view "Safety rules". | Classify Active Guards ADVANCED (grade D); move out of primary nav and rewrite copy.
- What the verifiers found: (reproducer: confirmed / needs-change) "Re-read desktop/renderer/src/components/guards/ActiveGuardsView.tsx with cat -n. Line 97: "Gateway needs a restart to expose guards.status (PLAN-20)."; line 98: `: msg,` where `msg` (line 94) is `err instanceof Error ? err.message : String(err)` and is rendered raw at line 152 `{error}`. Line 133: "Pre-action interceptors enforcing your skill behavior deterministically."; [...]" (skeptic: confirmed / sound) "Verified each cited line with sed: 97 PLAN-20 string; 133 "Pre-action interceptors enforcing your skill behavior deterministically."; 158 "Registered Interceptors (...)"; [...]"
- Corrected statement / recommendation: Claim is accurate. Recommendation: the copy rewrite and raw-error mapping are sound, but note (a) lines 258 and 311 (`setError(String(err))`) also need the same treatment, and (b) there is no existing 'advanced' nav mechanism (Sidebar requireFeature only handles 'management'), so 'move out of primary nav' requires adding a new NavItem flag or folding the view into Skills as a tab, it is not a config-only change. (skeptic adds: One caveat for the copy rewrite: the `src/agents/skills/builtin-interceptors/` sentence is factually load-bearing (a promoted candidate is inert until a TypeScript implementation exists under that path [...])

#### 3.4-08

- Verdict: claim **confirmed**; recommendation **needs-change**. Weight: medium. Anchor: `desktop/renderer/src/layout/Sidebar.tsx:57-82`
- Original claim: Sidebar.tsx has no 'advanced' gating mechanism for nav items; the existing `requireFeature` NavItem flag handles only the management-node case.
- Original recommendation: Add an `advanced` NavItem flag and move Guards under it, or fold Guards into Skills as a tab. | SHIP-ADVANCED; already gated.
- What the verifiers found: (reproducer: confirmed / needs-change) "`grep -nE 'advanced|Advanced' desktop/renderer/src/components/layout/Sidebar.tsx` -> zero hits. NavItem interface (lines 47-54) has only id/label/icon/group/requireFeature. The only use of requireFeature is management (line 72), and the filter at line 488 is literally `item.requireFeature === 'management' && isManagementNode` -- i.e. the flag is not a generic feature check; [...]" (skeptic agrees: confirmed / needs-change) "Anchor path in the claim (desktop/renderer/src/layout/Sidebar.tsx) does not exist; [...]"
- Corrected statement / recommendation: Claim holds (fix anchor path to desktop/renderer/src/components/layout/Sidebar.tsx:47-54 and :485-489). The merged recommendation text 'SHIP-ADVANCED; already gated' is false for Guards -- it is not gated by anything today (line 77). Keep the first half: add an `advanced` (or generalize the hardcoded requireFeature check at line 488 into a real feature lookup) and either move Guards under Advanced or fold it into Skills. No cheaper existing mechanism: requireFeature cannot be reused as-is because the filter compares against the literal 'management'.

#### 3.4-11

- Verdict: claim **partially-confirmed**; recommendation **sound**. Weight: low. Anchor: `desktop/renderer/src/layout/AppShell.tsx:31-53`
- Original claim: The 8 unreachable tab views (instances, sessions, usage, nodes, projects, workspace, debug, logs) mapped in desktop/renderer/src/layout/AppShell.tsx lines 31-53 total 2,835 lines of code.
- Original recommendation: Delete or re-home the views; derive VIEW_MAP and NAV_ITEMS from a single list.
- What the verifiers found: (reproducer: partially-confirmed / sound) "Re-derived the count. Correct path is desktop/renderer/src/components/layout/AppShell.tsx (the cited path desktop/renderer/src/layout/AppShell.tsx does not exist: `ls desktop/renderer/src/layout` -> No such file or directory). VIEW_MAP does span lines 31-53 in the real file. [...]" (skeptic agrees: partially-confirmed / sound) "VIEW_MAP is at desktop/renderer/src/components/layout/AppShell.tsx:31-53 (anchor correct; [...]"
- Corrected statement / recommendation: Path should be desktop/renderer/src/components/layout/AppShell.tsx:31-53. The 2,835 figure is reproducible but should be described as 'all .tsx files under the 8 view directories' (2,946 including workspace-utils.ts; stores not counted). Recommendation to derive VIEW_MAP and NAV_ITEMS from one list is sound: both are hand-maintained against the same TabId union, and the Record<TabId,...> typing on VIEW_MAP already forces every TabId to have a view, which is what lets orphans accumulate silently.

#### 3.4-16

- Verdict: claim **partially-confirmed**; recommendation **needs-change**. Weight: medium. Anchor: `desktop/renderer/src/components/p2p/P2pDashboard.tsx:98`
- Original claim: desktop/renderer/src/components/p2p/P2pDashboard.tsx (line 98) displays cards "Skills Published", "Skills Received", "Contribution Score" and "Skills Verified" for the P2P skills economy, which the audit found structurally dead (F7: EigenTrust scores are write-only; F10, F11, F14 deferred).
- Original recommendation: Move P2P dashboard under Advanced and reduce it to connection status, peers, peer ID and NAT. | SHIP-ADVANCED: reduce P2P view to connection state, peer ID, peer count, NAT; drop Contribution Score / Skills Verified until F7/F11/F14 land.
- What the verifiers found: (skeptic: partially-confirmed / needs-change) "desktop/renderer/src/components/p2p/P2pDashboard.tsx: 'Contribution Cards' grid starts at :100-101 (line 98 is the loading-state block just above); cards 'Connected Peers' :103, 'Skills Published' :108, 'Skills Received' :113, 'Contribution Score' :118, and 'Skills Verified' :190 in the node-info panel -> card labels CONFIRMED. [...]" (reproducer: partially-confirmed / sound) "desktop/renderer/src/components/p2p/P2pDashboard.tsx:98 is `{/* Contribution Cards */}`; the card grid (:99-122) renders FOUR ContributionCards: 'Connected Peers' (:103), 'Skills Published' (:108), 'Sk [...]"
- Corrected statement / recommendation: Corrected claim: the cards exist (lines 103-121 and 190), but 'Contribution Score' is a local skills_published*10 + uptime*0.1 formula from orchestrator http.rs:239, unrelated to the dead EigenTrust loop (F7); 'Skills Verified' has no producer anywhere and is hard-wired to 0. Corrected recommendation: drop 'Skills Verified' outright (nothing will ever populate it, and it does not wait on F7/F11/F14); either drop 'Contribution Score' or relabel it honestly ('activity score') since F7 landing would not change it; [...] (reproducer adds: Corrected statement: P2pDashboard.tsx:99-122 shows cards 'Connected Peers', 'Skills Published', 'Skills Received', 'Contribution Score'; [...])

#### 3.4-17

- Verdict: claim **partially-confirmed**; recommendation **needs-change**. Weight: medium. Anchor: `desktop/renderer/src/components/skills/SkillsView.tsx:369`
- Original claim: desktop/renderer/src/components/skills/SkillsView.tsx line 369 and SkillEditor.tsx lines 558 and 571 expose Trust settings, an Incoming quarantine panel, "Sign and broadcast over P2P" and "POST to agentskills.io" to every user with no gating on p2p.enabled or peer count.
- Original recommendation: Put these behind an Advanced disclosure or show only when `p2p.enabled` is true and peers > 0. | SHIP list + editor; SHIP-ADVANCED Incoming / Trust settings / P2P publish; hide marketplace controls unless p2p.enabled and peers > 0.
- What the verifiers found: (skeptic: partially-confirmed / needs-change) "Line anchors are exact: SkillsView.tsx:369 `onClick={() => setShowTrustSettings(true)}` ('Trust settings' button :373), Incoming tab :404-415 (`<IncomingPanel …/>` :415), SkillEditor.tsx:558 `title="Sign and broadcast over P2P (requires p2p.enabled)"`, :571 `title="POST to agentskills.io (requires skills.agentskills.enabled + apiKey)"`. [...]" (reproducer: confirmed / needs-change) "desktop/renderer/src/components/skills/SkillsView.tsx:368-374 renders the "Trust settings" button (onClick line 369 `setShowTrustSettings(true)`) and lines 395-410 the "Incoming" tab (with quarantine c [...]"
- Corrected statement / recommendation: Corrected statement: the controls are ungated in the UI, but only 'Publish to P2P' and the p2p rows of Trust settings are P2P-specific; Incoming (agentskills.io import + review queue), the agentskills trust section and 'Upload to agentskills.io' are HTTP-registry features, and the server already blocks P2P publish when p2p is disabled. Corrected recommendation: hide/disable only 'Publish to P2P' and the p2p trust rows when p2p-store `enabled` is false or `connected_peers` is 0; [...] (reproducer adds: Gate only the "Publish to P2P" button (and optionally the Incoming tab) on `p2p.enabled && connected_peers > 0` from p2p-store; [...])

#### 3.4-19

- Verdict: claim **confirmed**; recommendation **needs-change**. Weight: medium. Anchor: `desktop/renderer/src/components/overview/GatewayControls.tsx:8`
- Original claim: desktop/renderer/src/components/overview/GatewayControls.tsx (lines 8, 76) implements the Start Gateway button by calling `/__gateway/start`, an endpoint that exists only under the Vite dev server, so release builds show the fallback message "Run `pnpm start gateway`".
- Original recommendation: Hide the button when the endpoint probe fails, or implement it via the packaged launcher; moot after decision D5. | Fix or hide the Start-gateway button for non-dev installs (note: HEAD c5e1f97 commit claims a Start button that works when only the UI is running).
- What the verifiers found: (reproducer: confirmed / needs-change) "GatewayControls.tsx:6-11 comment: 'Start posts to the Vite dev server's /**gateway/start endpoint ... In builds without that endpoint (packaged Tauri app), Start surfaces terminal guidance'; :61 `fetch("/**gateway/start", { method: "POST" ...})`; fallback text at :73-76 `Could not start the gateway from here (...). [...]" (skeptic agrees: confirmed / needs-change) "GatewayControls.tsx:8-9 comment names the Vite dev server's /\_\_gateway/start endpoint; [...]"
- Corrected statement / recommendation: Claim stands; the 'note' in the merged recommendation is moot since c5e1f97's own message acknowledges the dev-only limitation. Cheaper fix than an endpoint probe: the button is rendered unconditionally (GatewayControls.tsx:136-148); gate it on `import.meta.env.DEV` (Vite sets it false in `vite build`), a one-line change with no network probe. The existing hello-frame feature gate (:47-51) cannot help because Start is only relevant while the gateway is disconnected. [...]

#### 3.4-20

- Verdict: claim **partially-confirmed**; recommendation **sound**. Weight: medium. Anchor: `desktop/renderer/src/components/wallet/WalletSidebarPanel.tsx:137`
- Original claim: desktop/renderer/src/components/wallet/WalletSidebarPanel.tsx (lines 137, 178-183) renders a green `USDC $0.00` balance and a MAINNET/TESTNET pill even when the balance fetch errors or returns empty, and the panel is mounted for every user via Sidebar.tsx line 306.
- Original recommendation: Hide the panel unless `wallet.getAddress` succeeds; otherwise show a muted "Set up wallet" link. | SHIP-ADVANCED: hide the wallet panel unless `wallet.getAddress` succeeds; show a "Set up wallet" link otherwise.
- What the verifiers found: (reproducer: partially-confirmed / sound) "WalletSidebarPanel.tsx:136-140 error branch renders `<span ...text-emerald-400>$0.00</span>` labelled USDC (claim's 'line 137' is the wrapper div); :180-184 `balances.length === 0 && !loading` branch renders the same green `USDC $0.00`. MAINNET/TESTNET pill at :107-118 is rendered whenever `network` is truthy. [...]" (skeptic agrees: partially-confirmed / sound) "WalletSidebarPanel.tsx:135-140 error branch renders `USDC` + `$0.00` in `text-emerald-400`; [...]"
- Corrected statement / recommendation: Pill claim needs nuance: the MAINNET/TESTNET pill appears on empty/failed balance fetches but not on a failed `wallet.getAddress` (network never set). Correct Sidebar cite to components/layout/Sidebar.tsx:301. Recommendation is sound; an already-existing cheaper gate is the `wallet.getConfig` RPC (used by WalletView.tsx:144) to hide the panel when `tools.wallet.enabled` is false, avoiding a getAddress round-trip that fails on every disabled install.

#### 3.4-21 **ALREADY DONE**

- Verdict: claim **partially-confirmed**; recommendation **already-done**. Weight: medium. Anchor: `src/commerce/feature.ts:10`
- Original claim: The Aubaine group-buy commerce feature is default OFF in src/commerce/feature.ts line 10 and has never been run, yet docs/commerce/ and docs/protocol/aubaine-v1/ are published in the docs tree (docs/docs.json) alongside user guides.
- Original recommendation: Move Aubaine docs into an "Experimental protocols" group or remove them from docs.json. | HIDE forage/commerce; nightShift OFF; take Aubaine docs out of nav. | HIDE; move PLAN-26 docs out of the docs nav.
- What the verifiers found: (reproducer: partially-confirmed / already-done) "src/commerce/feature.ts:10-12: `export function isAubaineEnabled(config) { return config?.commerce?.groupbuy?.enabled ?? false; }` with header comment 'Off by default until Phase 3 ships', default OFF confirmed. docs/commerce/aubaine-group-buy.md and docs/protocol/aubaine-v1/{README.md,SPEC.md,schemas,test-vectors,tools,.well-known} exist and are git-tracked (14 files via `git ls-files docs/commerc [...]" (skeptic agrees: partially-confirmed / already-done) "src/commerce/feature.ts:10-12 `export function isAubaineEnabled(...) { return config?.commerce?.groupbuy?.enabl [...]"
- Corrected statement / recommendation: Aubaine is default-OFF (src/commerce/feature.ts:10-12) and its docs are tracked in the repo, but they are NOT in docs/docs.json navigation, they are orphaned pages. 'Take Aubaine docs out of nav' is therefore already the state of affairs; the remaining choice is whether to keep orphaned tracked pages (reachable by direct URL if the docs host serves unlisted pages) or move them under an explicit 'Experiments' group / out of docs/ entirely. The 'HIDE forage/commerce; [...]

#### 3.4-22

- Verdict: claim **partially-confirmed**; recommendation **needs-change**. Weight: medium. Anchor: `src/config/types.skill-seekers.ts:10`
- Original claim: The Skill Seekers trending sweep is enabled by default (src/config/types.skill-seekers.ts line 10) and is run by the dream engine (src/dream-engine.ts line 252); on the live node it produced a 268-item unreviewed quarantine backlog and 183 egress-log rows.
- Original recommendation: Default the trending sweep OFF; make it opt-in under Skills settings. | SHIP-ADVANCED with trending sweep default OFF. | Default Skill Seekers off (SHIP-ADVANCED); REMOVE the root research artifacts and the research/ CI reference.
- What the verifiers found: (reproducer: partially-confirmed / needs-change) "Default-ON reproduced, but at a different site: src/memory/manager.ts:3131-3137 `ensureTrendingSweepInterval` comments '// Default-on: only skip if explicitly disabled' and skips only when `trendingCfg?.enabled === false`; called unconditionally from manager.ts:568 at memory-manager start; interval default 24h, first run after 10 min, sources default `[{kind:'github'}]`, maxPerSweep 5 (:3165-3175). [...]" (skeptic agrees: partially-confirmed / needs-change) "Default-on is TRUE but for the wrong reason/citation: src/memory/manager.ts:3131-3137 `ensureTrendingSweepInter [...]"
- Corrected statement / recommendation: Corrected statement: the trending sweep is default-ON by code in src/memory/manager.ts:3135 (despite the type doc and the function comment claiming opt-in), scheduled by the memory manager (not the dream engine), and is live on this node; the '268-item backlog / 183 egress rows' figures are from the 2026-08-10 dream review, not today (now 20 quarantined, 240 egress rows, backlog held down by the existing 30-day quarantine sweeper). [...]

#### 3.4-23

- Verdict: claim **partially-confirmed**; recommendation **needs-change**. Weight: low. Anchor: `src/tasks/auto-initiate.ts:1`
- Original claim: src/tasks/auto-initiate.ts (PLAN-16/17/22 task spine) runs unconditionally: there is no `tasks.enabled` config key to disable it, and the corresponding plan docs still mark the plans as "Draft".
- Original recommendation: Add `agents.defaults.tasks.enabled`; update plan status; schedule an audit (coverage gap #9). | SHIP-ADVANCED: add an agents.defaults.tasks.enabled kill switch.
- What the verifiers found: (reproducer: partially-confirmed / needs-change) "src/tasks/auto-initiate.ts:1-20 header: "Auto-initiation of goal-oriented workflows (PLAN-22 Phase 2)"; `grep -n -i "enabled\|config\."` inside auto-initiate.ts = 0 hits (no config gating in that file). Caller: src/gateway/server.impl.ts:281 `registerAutoInitiation();` (unconditional call at startup). [...]" (skeptic agrees: partially-confirmed / needs-change) "No config key: grep -rn tasks/goalDrive/autoInitiate/complexity in src/config/zod-schema.ts and src/config/type [...]"
- Corrected statement / recommendation: Corrected statement: the task spine is registered unconditionally at boot (server.impl.ts:281) and has no config-file kill switch, but it is NOT ungated: env flags BITTERBOT_TASKS_AUTO_INITIATE=0 (disables task creation) and BITTERBOT_TASKS_COMPLEXITY_GATE=0 (disables appraisal), plus BITTERBOT_TASKS_HORMONAL_GATE/NUDGE/COMPLETION_NOTIFY, already exist (all default ON). Plan docs PLAN-16/17/22 are indeed still marked Draft. [...]

#### 3.4-24

- Verdict: claim **confirmed**; recommendation **needs-change**. Weight: low. Anchor: `desktop/renderer/src/components/circles/CircleCanvas.tsx:226`
- Original claim: Circles UI copy leaks config keys: desktop/renderer/src/components/circles/CircleCanvas.tsx line 226 shows "Agent generation is off (circles.sandbox.enabled)", InvitePanel.tsx line 398 uses the placeholder `bbc1.…`, and circles-store.ts line 664 tells the user to "change circles.agentDrafts.enabled in the config file".
- Original recommendation: Replace config-key messages with toggles or links to Settings; use a friendlier invite-code label.
- What the verifiers found: (skeptic: confirmed / needs-change) "CircleCanvas.tsx:226-228: `Agent generation is off on this node <span className="font-mono">(circles.sandbox.enabled)</span>` (the key is at line 228; 226 is the start of the sentence). InvitePanel.tsx:398 `placeholder="bbc1.…"`; the placeholder is accurate: src/circles/invites.ts:32 `INVITE_CODE_PREFIX = "bbc1"`. [...]" (reproducer agrees: confirmed / needs-change) "CircleCanvas.tsx:227-228 renders `Agent generation is off on this node <span className="font-mono">(circles.san [...]"
- Corrected statement / recommendation: The circles-store.ts:664 message is a degraded-gateway fallback, not the primary UX; a toggle (circles.agentDrafts.set) already exists, so 'replace with toggles' is already done for that case and the fallback text is arguably correct (the user literally must edit the file). Remaining actionable items: the CircleCanvas sandbox-off string (no node-level toggle exists; link to Settings/Labs instead of the raw key) and labeling the invite textarea ('Invite code') while keeping the accurate bbc1 placeholder.

#### 3.4-25

- Verdict: claim **partially-confirmed**; recommendation **needs-change**. Weight: low. Anchor: `desktop/renderer/src/layout/AppShell.tsx:31-53`
- Original claim: VIEW_MAP in desktop/renderer/src/layout/AppShell.tsx (lines 31-53) and NAV_ITEMS in Sidebar.tsx (lines 57-82) are maintained as two separate lists, which is how 8 TabIds ended up mapped to views but absent from the nav.
- Original recommendation: Derive VIEW_MAP and NAV_ITEMS from one list.
- What the verifiers found: (skeptic: partially-confirmed / needs-change) "VIEW_MAP spans AppShell.tsx:31-54 (closing `};` at line 54, not 53). Two separate lists: confirmed (VIEW_MAP in AppShell.tsx, NAV_ITEMS in Sidebar.tsx:57-82). Count: 10 TabIds are absent from NAV_ITEMS (chat, instances, sessions, usage, nodes, projects, workspace, wallet, debug, logs), not 8. [...]" (reproducer: partially-confirmed / sound) "AppShell.tsx: VIEW_MAP spans lines 31-54 (claim says 31-53; entries are 32-53, closing `};` at 54). Sidebar.tsx NAV_ITEMS spans 56-83. They are independent literals in two files; [...]"
- Corrected statement / recommendation: Say: 10 TabIds are outside NAV_ITEMS, 8 of which are unreachable from any UI (chat and wallet have dedicated sidebar affordances). Recommendation should be 'make one nav list the source of TabId (derive the union from it, with chat/wallet as explicit extras) and derive VIEW_MAP from that', since simply merging the two existing lists leaves ui-store.ts as a third list that can still drift. (reproducer adds: Restate as: 10 TabIds are absent from NAV_ITEMS; 8 of them (instances, sessions, usage, nodes, projects, workspace, debug, logs) have no entry point anywhere in the renderer, while chat and wallet are [...])

### 3.5 UI polish and copy

19 item(s) changed in this section (of 24 verified).

#### 3.5-01

- Verdict: claim **confirmed**; recommendation **needs-change**. Weight: high. Anchor: `desktop/renderer/src/components/cron/CronView.tsx:58`
- Original claim: There are exactly 28 native alert()/confirm()/prompt() calls across 9 feature files in desktop/renderer/src/components: cron/CronView.tsx (lines 58,177,189,201,213), agents/AgentsView.tsx:313, channels/ChannelsView.tsx:173,257, models/ModelsView.tsx:97, overview/GatewayControls.tsx:82,98, nodes/NodesView.tsx:169,181, sessions/SessionsView.tsx:87,100,109,164,176,188, skills/Incom [...]
- Original recommendation: Replace all 28 (toast.error on errors; AlertDialog or CircleChat local-state pattern for confirms; Select for the thinking-level prompt); add no-restricted-globals rule. | Replace native dialogs with in-app modals/toasts. | P0-C.16: replace 28 native dialogs; add no-restricted-globals rule. [...]
- What the verifiers found: (reproducer: confirmed / needs-change) "Reproduced from scratch with `grep -rnE '(^|[^A-Za-z0-9_.])(alert|confirm|prompt)\s*\(' desktop/renderer/src --include=*.tsx --include=*.ts`. 29 hits; one is a comment (circles/CircleChat.tsx:76 `// Phase D: message delete confirms IN-APP (native confirm() is gone)`), leaving exactly 28 real calls in 9 files, every cited line reproduced: cron/CronView.tsx:58,177,189,201,213 (5); [...]" (skeptic agrees: confirmed / needs-change) "Recounted with `grep -rnE '(^|[^A-Za-z0-9_.])(alert|confirm|prompt)\(' desktop/renderer/src` (plus a separate g [...]"
- Corrected statement / recommendation: The count and the replacement recommendation are sound, but the 'add no-restricted-globals rule' part needs rework: the repo does not use eslint. Lint is oxlint (package.json:98 `"lint": "oxlint --type-aware && ..."`) and `.oxlintrc.json` lists `"desktop/"` in `ignorePatterns`, so NO linter runs over the renderer at all; desktop/package.json only has `"typecheck": "tsc --noEmit"`. A rule added to .oxlintrc.json would be a no-op for these files. [...]

#### 3.5-03

- Verdict: claim **partially-confirmed**; recommendation **needs-change**. Weight: medium. Anchor: `desktop/renderer/src/components/models/ModelsView.tsx:96`
- Original claim: desktop/renderer/src/components/models/ModelsView.tsx lines 96-100 mix a native confirm() with a toast call in the same handler; CircleChat already replaced native dialogs; no eslint no-alert / no-restricted-globals rule is configured for the renderer.
- Original recommendation: Add no-restricted-globals eslint rule.
- What the verifiers found: (reproducer: partially-confirmed / needs-change) "ModelsView.tsx:96-104 reproduced: `const handleDelete = async (profileId: string) => { if (!confirm(\`Delete credential profile "${profileId}"? This cannot be undone.\`)) return; try { await deleteProfile(profileId); toast.success(\`Deleted ${profileId}\`); ...`, native confirm at :97 and toast.success at :100 in the same handler, confirmed. [...]" (skeptic agrees: partially-confirmed / needs-change) "ModelsView.tsx:96-103: line 97 `if (!confirm(\`Delete credential profile ...\`)) return;`then line 100`toast. [...]"
- Corrected statement / recommendation: Corrected statement: the renderer is not linted at all (oxlint is the only linter and .oxlintrc.json ignorePatterns includes "desktop/"); the absence of a no-alert rule is a symptom of that. Corrected recommendation: 'Add no-restricted-globals eslint rule' is unsound as written because there is no eslint. Either un-ignore desktop/renderer in .oxlintrc.json and enable `eslint/no-alert` (oxlint supports the eslint rule namespace, as the existing `eslint/no-await-in-loop` entry shows), or add a grep-based check to desktop/scripts/ which already runs under `p [...]

#### 3.5-04

- Verdict: claim **confirmed**; recommendation **needs-change**. Weight: high. Anchor: `desktop/renderer/src/components/chat/MessageList.tsx:35`
- Original claim: desktop/renderer/src/components/chat/MessageList.tsx:35 renders the welcome heading with gradient classes `from-white via-purple-200`, and desktop/renderer/index.html:2 sets `<html class="dark">` as the default.
- Original recommendation: Ship dark-only for V1 and hide the theme toggle, or do a light-mode pass. Recommend dark-only.
- What the verifiers found: (skeptic: confirmed / needs-change) "desktop/renderer/src/components/chat/MessageList.tsx:35 reads exactly `<h2 className="text-4xl font-bold bg-gradient-to-r from-white via-purple-200 to-purple-400 bg-clip-text text-transparent">` with no `dark:` variant; git log shows the file untouched since 8b13436/35b3a0f. desktop/renderer/index.html:2 reads `<html lang="en" class="dark">`. [...]" (reproducer: confirmed / sound) "desktop/renderer/src/components/chat/MessageList.tsx:35: `<h2 className="text-4xl font-bold bg-gradient-to-r from-white via-purple-200 to-purple-400 bg-clip-text text-transparent">` (inside the `messag [...]"
- Corrected statement / recommendation: Claim stands. Recommendation needs one addition: hiding the toggle alone is not dark-only. ui-store.ts:49-55 will restore `theme="light"` from localStorage for any user who has already clicked the toggle, leaving them stuck in the broken light theme with no way back. A dark-only ship must also hard-set `initialTheme = "dark"` (or drop the localStorage read) and remove/ignore the persisted key. Also note this is a product choice, not a technical necessity: the light token set already exists (globals.css:114-176); [...]

#### 3.5-05

- Verdict: claim **partially-confirmed**; recommendation **needs-change**. Weight: high. Anchor: `desktop/renderer/src`
- Original claim: In the renderer source (desktop/renderer/src) there are 131 `text-green/red/yellow-400` class uses without `dark:` pairs, 50 `text-purple-300` uses, 216 `zinc-*`/`text-white` literals, and only 43 `dark:` variants app-wide, while a theme toggle is prominently exposed.
- Original recommendation: Ship dark-only for V1 and hide the toggle (light mode is not actually supported by the styling). | Light theme is visibly broken in places; tokenize colors and adopt ui/ primitives (bitterbot-theme.css philosophy: 'Zero !important, zero per-component selectors').
- What the verifiers found: (skeptic: partially-confirmed / needs-change) "Recounted in desktop/renderer/src (_.tsx, HEAD c5e1f97): `text-(green|red|yellow)-400` = 79 occurrences on 78 lines, 0 of those lines contain `dark:` (the 'no dark: pairs' part holds). No counting method reproduces 131: any-prefix `-400` = 83; `text-_-(300|400|500)`= 121 occurrences / 112 lines; adding amber/emerald/orange`-400`= 166.`text-purple-300`= 50 (exact match). [...]" (reproducer: partially-confirmed / sound) "Re-derived from scratch with grep -rEo over desktop/renderer/src (*.tsx):`text-(green|red|yellow)-400` = 79 occurrences (not 131; [...]"
- Corrected statement / recommendation: Corrected statement: 79 `text-green/red/yellow-400` uses (none with a `dark:` pair), 50 `text-purple-300`, ~340 `zinc-*`/`text-white` literals (88 in unreachable workspace/), and `dark:` appears 66 times on 43 lines in 19 files (mostly ui/ and circles/); the theme toggle is a small icon button in the sidebar footer. Recommendation: pick one of the two merged actions for V1 (dark-only is the cheaper, defensible choice) and if hiding the toggle also force the store default (ui-store.ts:49-55 restores a persisted `light`). [...] (reproducer adds: Counts should read: 79 `text-green/red/yellow-400` (none with a dark: pair), 50 `text-purple-300`, ~340 zinc-\*/text-white occurrences (248 lines), 66 `dark:` variants (44 lines, 20 files). [...])

#### 3.5-06

- Verdict: claim **partially-confirmed**; recommendation **needs-change**. Weight: high. Anchor: `desktop/renderer/src/components/overview/OverviewView.tsx:166`
- Original claim: desktop/renderer/src/components/overview/OverviewView.tsx lines 166-172 collapse every truthy channel status to the string "configured" via a ternary, while ChannelCard (lines 137-152) colors green only for `connected`/`running`, so the green pill can never show; ChannelsView.tsx:99-105 has the correct status mapping.
- Original recommendation: Pass the real status (mirror ChannelsView.tsx:99-105). | SHIP Overview; fix the channel-status ternary, add Repairs cards from doctor, move Config/State Dir paths under Details. | Fix the channel status expression (Overview graded C).
- What the verifiers found: (skeptic: partially-confirmed / needs-change) "Ternary confirmed: OverviewView.tsx:163-172 renders `<ChannelCard ... status={ typeof data === "object" && data ? String(((data as any).status ?? (data as any).configured) ? "configured" : "idle") : "idle" }`, so every truthy status/configured value collapses to the literal "configured". [...]" (reproducer agrees: partially-confirmed / needs-change) "Reproduced from scratch. OverviewView.tsx:166-172 is exactly as claimed: `status={ typeof data === "object" && [...]"
- Corrected statement / recommendation: Claim: correct defect, but ChannelCard lives at OverviewView.tsx:35-36 (not 137-152). Recommendation: do not literally "mirror ChannelsView.tsx:99-105" because Overview consumes `health.channels` (ChannelHealthSummary), not the channels.status accounts payload; derive status from the keys that actually exist there: `running || connected || linked ? "connected" : configured ? "configured" : "idle"`, or switch Overview to the same channels.status RPC ChannelsView uses. The rest (Repairs cards, paths under Details) is opinion, not blocked.

#### 3.5-07

- Verdict: claim **partially-confirmed**; recommendation **sound**. Weight: low. Anchor: `desktop/renderer/src/components/overview/OverviewView.tsx:94`
- Original claim: desktop/renderer/src/components/overview/OverviewView.tsx prints Config and State Dir filesystem paths in monospace on a card (around lines 94,115) and carries the subtitle "Gateway dashboard".
- Original recommendation: Paths under Details; rename subtitle.
- What the verifiers found: (skeptic: partially-confirmed / sound) "OverviewView.tsx:94 `<p className="text-sm text-muted-foreground mt-1">Gateway dashboard</p>` confirmed. Config path at lines 137-142 (`font-mono text-xs` at :140, `String(statusData.configPath)`), State Dir at 145-150 (`font-mono` at :148). Line 115 cited in the claim is the Stats grid (`StatCard label="Platform"`), not a path; the paths are at ~140/148. [...]" (reproducer agrees: partially-confirmed / sound) "OverviewView.tsx:94 `<p className="text-sm text-muted-foreground mt-1">Gateway dashboard</p>` -- confirmed. [...]"
- Corrected statement / recommendation: Paths are at OverviewView.tsx:137-150 (not ~115). Recommendation is a low-stakes UX opinion; no code path already hides them, so it stands, though the paths are operator-useful (they sit next to the restart/shutdown controls) and a collapsible Details is preferable to removal.

#### 3.5-08

- Verdict: claim **confirmed**; recommendation **needs-change**. Weight: high. Anchor: `desktop/renderer/src/components/first-run/FirstRun.tsx:95`
- Original claim: desktop/renderer/src/components/first-run/FirstRun.tsx (lines 95-107,147,193-204) shows end-user copy containing "If you already ran `pnpm bitterbot onboard`, the wizard should have saved your token to `desktop/.env`", "~/.bitterbot/bitterbot.json -> gateway.auth.token", and a footer referencing `pnpm dev:all`.
- Original recommendation: 3-step card; `bitterbot dashboard` one-time token handoff so FirstRun is rarely seen; drop desktop/.env and pnpm mentions. | Grade C; rewrite first-run screen copy for end users instead of a developer README.
- What the verifiers found: (skeptic: confirmed / needs-change) "FirstRun.tsx:96 `already ran <code>pnpm bitterbot onboard</code>`, :98 `<code>desktop/.env</code> automatically`, :103 `pnpm start gateway`, :106 `~/.bitterbot/bitterbot.json → gateway.auth.token`, :147 `placeholder="paste from ~/.bitterbot/bitterbot.json"`, :195-196 `pnpm start gateway` or `pnpm dev:all`, :201-203 `pnpm bitterbot onboard` ... `desktop/.env`. [...]" (reproducer agrees: confirmed / needs-change) "FirstRun.tsx:95-99: 'The Control UI needs a running Bitterbot gateway and an auth token to connect. [...]"
- Corrected statement / recommendation: Claim stands. Recommendation must be rewritten: `bitterbot dashboard` is not a new command to add, it exists and already puts `#token=` in the URL; the missing piece is the renderer consuming `location.hash` token on boot (and the gateway actually serving the Vite bundle at that URL, which is PLAN-39 Phase 1, not started). Copy rewrite is fine, but the token-handoff item should reference PLAN-39 and the existing dashboard.ts rather than proposing it fresh.

#### 3.5-09

- Verdict: claim **partially-confirmed**; recommendation **needs-change**. Weight: medium. Anchor: `desktop/renderer/src/styles/bitterbot-theme.css:18`
- Original claim: desktop/renderer/src/styles/bitterbot-theme.css:18 claims "zero per-component selectors", yet the renderer contains 144 `purple-NNN` Tailwind literals, 32 hex color literals, cyan `#00D4E6` in 13 headings, a refresh-button recipe copy-pasted in 6 views, and `ui/button` is used in 7 files versus 68 hand-rolled `<button>` elements.
- Original recommendation: Section-heading token; ui/button variant; lint regex rejecting #[0-9a-f]{6} and purple-\d{3} outside components/ui.
- What the verifiers found: (skeptic: partially-confirmed / needs-change) "desktop/renderer/src/styles/bitterbot-theme.css:18 reads ` * - Zero !important, zero per-component selectors. Components consume` (anchor correct; it is a comment describing the theme file, not a claim about component code). Recounts: `purple-[0-9]{3}` = 247 occurrences on 144 lines in 38 files (the report's 144 is a line count; 4 of the occurrences are in components/ui, 0 in circles/). [...]" (reproducer: partially-confirmed / sound) "bitterbot-theme.css:18 reads `- Zero !important, zero per-component selectors. Components consume tokens; the theme sets tokens.` (confirmed). [...]"
- Corrected statement / recommendation: Corrected statement: 247 `purple-NNN` occurrences (144 lines, 38 files), 36 hex literals (32 lines, 10 files), 13 `#00D4E6`, ui/button in 7 files vs raw `<button>` in 68 files (248 elements). Recommendation mechanism must change: a `#[0-9a-f]{6}` / `purple-\d{3}` regex check cannot be an oxlint/eslint rule as written because oxlint ignores desktop/ entirely; implement it as desktop/scripts/check-color-literals.mjs wired into the `lint` script alongside check-px-text.mjs. [...] (reproducer adds: Restate as: 247 `purple-NNN` literals, 36 hex literals, 13 cyan headings, refresh/spin icon-button pattern hand-rolled in ~4-6 files, `ui/button` imported by 3 app views (7 files incl. [...])

#### 3.5-10

- Verdict: claim **partially-confirmed**; recommendation **needs-change**. Weight: medium. Anchor: `desktop/renderer/src/components/layout/UpdateBanner.tsx:114`
- Original claim: desktop/renderer/src/components/layout/UpdateBanner.tsx:114-125 and UpdateCard.tsx (lines 41,132,144) show the copy "This node is N commits behind the latest code. Out-of-date nodes drift from the fleet." and the label "Node Version".
- Original recommendation: "A new version of Bitterbot is available" + "Update now"; commit count in a detail line.
- What the verifiers found: (skeptic: partially-confirmed / needs-change) "desktop/renderer/src/components/layout/UpdateBanner.tsx:111-121: label is conditional, `info?.staleness.reason === "package-version" ? \`A newer release is available (v${info.registryLatest ?? "?"}).\` : \`This node is ${behind ?? "many"} commits behind the latest code.\``then`{label} Out-of-date nodes drift from the fleet.`and the button text 'Update from Overview'. [...]" (reproducer: partially-confirmed / sound) "desktop/renderer/src/components/layout/UpdateBanner.tsx:111-120:`label`is conditional:`info?.staleness.reason === "package-version" ? "A newer release is available (v...)" : "This node is ${behind ? [...]"
- Corrected statement / recommendation: Statement: the banner copy is already branched, 'A newer release is available (vX)' for package installs vs 'This node is N commits behind' for git installs; UpdateCard.tsx:41 is an unrelated reason string, 'Node Version' is at :132/:144 only. Recommendation: 'A new version of Bitterbot is available' is accurate only when a version number actually changes; for git-install nodes (all current users) the version string is constant, so the copy must either be gated on D2 release tags or keep an honest git-mode variant (e.g. [...] (reproducer adds: Corrected statement: UpdateBanner already shows 'A newer release is available (vX)' for package installs and only shows the commits-behind sentence for git installs; [...])

#### 3.5-12

- Verdict: claim **partially-confirmed**; recommendation **sound**. Weight: low. Anchor: `desktop/renderer/src/components/chat/MessageList.tsx:39`
- Original claim: desktop/renderer/src/components/chat/MessageList.tsx:39 uses the tagline "your AI development assistant" and ChatInput.tsx:110 uses the casing "BitterBot".
- Original recommendation: One tagline consistent with README; one casing.
- What the verifiers found: (skeptic: partially-confirmed / sound) "MessageList.tsx:39 `Start a conversation with BitterBot, your AI development assistant.` confirmed. ChatInput.tsx:110 `placeholder={isConnected ? "Message BitterBot..." : "Connecting to gateway..."}` confirmed. However the casing inconsistency is not between these two files (both say "BitterBot"); [...]" (reproducer: confirmed / sound) "grep -rn 'development assistant' desktop/renderer/src -> MessageList.tsx:39 `Start a conversation with BitterBot, your AI development assistant.` ChatInput.tsx:110 `placeholder={isConnected ? "Message [...]"
- Corrected statement / recommendation: Casing finding is real but mis-scoped: ChatInput:110 and MessageList:39 agree with each other ("BitterBot"); the split is 18 vs 16 across the renderer against README's consistent "Bitterbot". Recommendation (one tagline, one casing) is sound; the target casing should be "Bitterbot" to match README/logo alt text.

#### 3.5-13

- Verdict: claim **partially-confirmed**; recommendation **needs-change**. Weight: medium. Anchor: `desktop/renderer/src/components/layout/Sidebar.tsx:66`
- Original claim: Sidebar.tsx (lines 66,76-79,85) uses nav labels "Cron", "Active Guards", "P2P Network", "Dreams (beta)" and the group heading "CONTROL PANEL"; CronView.tsx:106,116 placeholders assume cron syntax; ManagementView.tsx:37 reads "Network oversight, anomaly detection, and economic monitoring".
- Original recommendation: Rename to "Schedules", "Network", "Safety rules"; groups Workspace/Agent/Settings; schedule preset picker.
- What the verifiers found: (skeptic: partially-confirmed / needs-change) "Sidebar.tsx:66 = `"P2P Network"` (correct). Lines 76-79: 76 is `skills "Skills"` (not a cited label); 77 = "Active Guards", 78 = "Cron", 79 = "Dreams (beta)". "CONTROL PANEL" is at :86 (line 85 is `const GROUP_LABELS`). CronView.tsx:106 = `placeholder="Cron schedule"` (correct; [...]" (reproducer: partially-confirmed / sound) "Sidebar.tsx labels reproduced: 'P2P Network' line 66, 'Active Guards' line 77, 'Cron' line 78, 'Dreams (beta)' line 79, 'CONTROL PANEL' line 86 (GROUP_LABELS.control). [...]"
- Corrected statement / recommendation: Line anchors: labels at 66,77-79; heading at 86; CronView only :106 assumes cron syntax (:116 is the message textarea). Rename recommendation is a judgment call (no prior art in docs/plans or docs/reviews); the preset picker is well-supported because src/cron/types.ts already has `every`/`at` schedule kinds the UI ignores - cite that instead of the placeholder. (reproducer adds: Corrected statement: Sidebar.tsx:66 'P2P Network', :77 'Active Guards', :78 'Cron', :79 'Dreams (beta)', :86 'CONTROL PANEL'; [...])

#### 3.5-14

- Verdict: claim **partially-confirmed**; recommendation **needs-change**. Weight: medium. Anchor: `desktop/renderer/src/components/layout/AppShell.tsx:72`
- Original claim: The renderer layout uses a fixed 256 px sidebar (AppShell.tsx:72, Sidebar.tsx:242) and a fixed 550 px tool panel (ToolCallPanel.tsx:214); there is only one `@media` rule in all renderer CSS (prefers-reduced-motion) and 36 responsive Tailwind utilities across 156 files.
- Original recommendation: Declare min width 1024 with a friendly overlay; auto-collapse sidebar < 1280; tool panel as sheet < 1400. | There is no responsive layout at all; add breakpoints before V1.
- What the verifiers found: (skeptic: partially-confirmed / needs-change) "desktop/renderer/src/components/layout/Sidebar.tsx:240-243: `className={cn("flex-shrink-0 h-full flex flex-col sidebar-bg transition-all duration-200", isCollapsed ? "w-12" : "w-64")}`; the sidebar is 256px only when expanded, collapses to 48px via `setSidebarCollapsed` (Sidebar.tsx:266 collapse button), and is removed entirely when `sidebarOpen` is false (AppShell.tsx:68 `{sidebarOpen && <Sidebar [...]" (reproducer: confirmed / needs-change) "AppShell.tsx:72 `isChat && toolPanelOpen && "mr-[550px]",`; Sidebar.tsx:242 `isCollapsed ? "w-12" : "w-64",` (w-64 = 16rem = 256px at 16px root); [...]"
- Corrected statement / recommendation: Corrected statement: expanded sidebar is 256px (`w-64`) but already collapses to 48px (`w-12`) and can be hidden; the 550px figure at AppShell.tsx:72 is the tool-panel margin; ~40 responsive utilities exist, one CSS media query. Recommendation: drop the 'min width 1024 with a friendly overlay' idea or make it dismissible; PLAN-39 serves this UI to phones/tablets over tailnet and a hard overlay would lock those users out. Auto-collapsing below 1280 is cheap because it only needs a matchMedia listener driving the existing `setSidebarCollapsed` state; [...] (reproducer adds: Claim is accurate apart from wording (38 responsive utilities in 17 of 156 tsx files). Recommendation: the Tauri window already has minWidth 800 (tauri.conf.json:18); [...])

#### 3.5-15

- Verdict: claim **partially-confirmed**; recommendation **needs-change**. Weight: medium. Anchor: `desktop/renderer/src/components/layout/Sidebar.tsx:266`
- Original claim: Outside desktop/renderer/src/components/ui there are 0 `focus-visible` uses; the renderer has 41 `aria-label` attributes for 259 buttons and 7 `htmlFor` for 40 inputs; Sidebar.tsx:266,458 and CronView.tsx:97-116 use `focus:outline-none` without a replacement ring.
- Original recommendation: Adopt ui/button, ui/input, ui/label; aria-labels on icon buttons; jsx-a11y rules. | Accessibility is thin; add focus-visible, aria-labels, and label associations.
- What the verifiers found: (skeptic: partially-confirmed / needs-change) "Confirmed counts (desktop/renderer/src, \*.tsx): `focus-visible` outside components/ui = 0 (grep over tsx+css returns nothing); `aria-label=` = 41; buttons = 248 raw `<button` + 11 `<Button` = 259 (exact); `htmlFor=` = 7; inputs = 34 raw `<input` + 5 `<Input` = 39 (report: 40); `<Label` = 5. REFUTED anchor: `grep -n "focus:" Sidebar.tsx` returns nothing; [...]" (reproducer: partially-confirmed / sound) "`focus-visible` outside components/ui = 0 (20 inside ui/) -> exact. `aria-label=` = 41 -> exact. `<button` + `<Button` = 248 + 11 = 259 -> exact. `htmlFor` = 7 -> exact. [...]"
- Corrected statement / recommendation: Corrected statement: Sidebar.tsx:266 and :458 do not use `focus:outline-none`; they have no focus styling at all. CronView.tsx:97-116 removes the outline but substitutes `focus:border-purple-500`. Counts otherwise hold (0 focus-visible outside ui/, 41 aria-label / 259 buttons, 7 htmlFor / 39-40 inputs). Recommendation: 'jsx-a11y rules' must be phrased as enabling oxlint's jsx-a11y plugin AND removing `desktop/` from .oxlintrc.json ignorePatterns (or adding a renderer-scoped oxlint config); there is no eslint to attach rules to. [...] (reproducer adds: Counts hold (0 focus-visible outside ui, 41 aria-label / 259 buttons, 7 htmlFor / ~39 inputs). Fix the anchors: Sidebar.tsx:266,458 are icon/text buttons with no aria-label and no explicit focus style, [...])

#### 3.5-16

- Verdict: claim **partially-confirmed**; recommendation **sound**. Weight: medium. Anchor: `desktop/renderer/src/components/guards/ActiveGuardsView.tsx:98`
- Original claim: ActiveGuardsView.tsx:98 plus 25 other `setError(err.message)` sites display raw RPC/transport error strings (e.g. "unknown method") to users, and DebugView.tsx:46 falls back to `JSON.stringify(err)`.
- Original recommendation: describeError() helper in lib/; raw text in a collapsible.
- What the verifiers found: (reproducer: partially-confirmed / sound) "Literal pattern does not exist: `grep -rn "setError(err.message)" desktop/renderer/src` = 0 hits; `grep -rnE "setError\((err|e|error)\.message\)"` = 0. What actually exists is the idiom `setError(err instanceof Error ? err.message : <fallback>)`. [...]" (skeptic agrees: partially-confirmed / sound) "Recount: literal `setError(<x>.message)` occurs once in the renderer (SkillEditor.tsx). [...]"
- Corrected statement / recommendation: Corrected statement: the renderer has ~22 `set*Error(...)` sites plus ~8 store-level `error:` assignments (about 30 total, not '1 + 25' and not literally `setError(err.message)`) that surface raw `err.message`/`String(err)` from RPC/transport failures; DebugView.tsx:46 falls back to `JSON.stringify(err, null, 2)`; ActiveGuardsView.tsx:98 passes raw `msg` unless it contains 'unknown method'. Recommendation (shared describeError() helper in lib/, raw text in a collapsible) is sound; no such helper exists yet.

#### 3.5-17

- Verdict: claim **partially-confirmed**; recommendation **needs-change**. Weight: medium. Anchor: `desktop/renderer/index.html:21`
- Original claim: desktop/renderer/index.html (lines 21,25-33) loads Geist fonts from cdn.jsdelivr.net, the CSP meta allows that host, and the UI renders with a different font when offline.
- Original recommendation: Vendor via the pinned `geist` npm package; CSP 'self'. | None (inventory fact); consider bundling fonts locally. | P0-D.21: vendor Geist fonts; CSP 'self'.
- What the verifiers found: (skeptic: partially-confirmed / needs-change) "Anchors: desktop/renderer/index.html:21 CSP `style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; font-src 'self' https://cdn.jsdelivr.net`; :23 `<link rel="preconnect" href="https://cdn.jsdelivr.net" />`; :24-31 two stylesheet links to `https://cdn.jsdelivr.net/npm/geist@1/dist/fonts/geist-sans/style.css` and `.../geist-mono/style.css`. [...]" (reproducer agrees: partially-confirmed / needs-change) "index.html:21 CSP includes `style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; [...]"
- Corrected statement / recommendation: Corrected statement: index.html loads Geist from cdn.jsdelivr.net and the CSP allows it, BUT both URLs have returned 404 since they were added (2026-03-28): the `geist` npm package ships only .woff2/.ttf files and no CSS in any 1.x release, so the UI has never rendered in Geist and looks identical offline and online (system-ui fallback). 'Renders with a different font when offline' is wrong. Corrected recommendation: vendoring 'via the pinned geist npm package' is insufficient on its own because the package has no stylesheet; [...]

#### 3.5-21

- Verdict: claim **partially-confirmed**; recommendation **needs-change**. Weight: low. Anchor: `desktop/renderer/src/components/agents/AgentsView.tsx:112`
- Original claim: Genome/Phenotype/Bond/Niche are the documented brand language (README.md lines 114 and 156-173, wizard, docs, file names); `#a855f7` equals the `--bb-purple-500` token; `#00D4E6` is the house cyan used 13 times; [...]
- Original recommendation: Lead each intro with a plain gloss; drop "Crystal Pointers"/"hormonal homeostasis" from one-liners; tokenize heading colors. | Rewrite Agents page copy in plain language. | SHIP Agents; soften intro prose (keep Genome/Phenotype vocabulary as brand language); replace hex heading literals. | Grade D; [...]
- What the verifiers found: (skeptic: partially-confirmed / needs-change) "README.md:114 'Evolving Identity ... (`GENOME.md`) ... the Phenotype' and :156-173 GENOME/MEMORY/Phenotype/Bond/Niche confirmed; wizard (src/wizard/onboarding.genome.ts) and docs/concepts/\* also use the terms. `--bb-purple-500: #a855f7` at desktop/renderer/src/styles/bitterbot-theme.css:30 confirmed. [...]" (reproducer: confirmed / sound) "README.md:114 'You define the immutable safety axioms (`GENOME.md`). The agent's actual personality (the Phenotype) evolves...'; [...]"
- Corrected statement / recommendation: Drop the 'no plain gloss' wording (Phenotype/Bond/Niche are glossed inline at AgentsView.tsx:134-136); the real gaps are 'hormonal homeostasis baselines' and 'Crystal Pointers' with no gloss. Keep: tokenize #a855f7 -> var(--bb-purple-500) and add a --bb-cyan token for #00D4E6; replace alert() at :313 with the existing sonner toast. Drop 'replace off-brand cyan': it is the house heading color site-wide, not an Agents-page deviation. (reproducer adds: Minor note only: 'tokenize heading colors' requires adding a new cyan token (none exists); purple can use existing --bb-purple-500. [...])

#### 3.5-22

- Verdict: claim **confirmed**; recommendation **needs-change**. Weight: low. Anchor: `desktop/renderer/src/components/skills/TrustSettings.tsx:137`
- Original claim: desktop/renderer/src/components/skills/TrustSettings.tsx:137-165 renders native <option> elements with labels such as "deny, drop everything (default)" and "off (transport crypto only)".
- Original recommendation: Radio group with title + description.
- What the verifiers found: (reproducer: confirmed / needs-change) "TrustSettings.tsx:137-139: `<option value="deny">deny, drop everything (default)</option>`, `review, quarantine, manual accept`, `auto, accept signed skills from trusted peers`; lines 164-165: `<option value="regex">regex (default)</option>`, `<option value="off">off (transport crypto only)</option>`. Native <select>/<option> confirmed. [...]" (skeptic: confirmed / sound) "TrustSettings.tsx:137 `<option value="deny">deny, drop everything (default)</option>`, :138 review, :139 auto, :163 `regex (default)`, :164 `<option value="off">off (transport crypto only)</option>`, i [...]"
- Corrected statement / recommendation: A radio group with title+description is fine but heavier than needed; the cheaper path is to keep the native select and rewrite the option labels to plain words (e.g. 'Deny (default)', 'Review manually', 'Auto-accept from trusted peers'; 'Regex scan (default)', 'Off') since Row already renders a hint/description beneath each control.

#### 3.5-23

- Verdict: claim **partially-confirmed**; recommendation **needs-change**. Weight: low. Anchor: `desktop/renderer/src/components/sessions/SessionsView.tsx:161`
- Original claim: desktop/renderer/src/components/p2p/P2pDashboard.tsx:89 and CirclesView.tsx:81 show disabled-state messages with instructions but no actionable control; sessions/SessionsView.tsx:161 holds the only per-session thinking/verbose controls and SessionsView is unreachable from the nav.
- Original recommendation: "Enable and restart" button or setActiveTab("config"); fold thinking/verbose into chat header next to ModelPicker.
- What the verifiers found: (skeptic: partially-confirmed / needs-change) "P2pDashboard.tsx:87-94: block rendered when `!connected && !loading && !error`, line 89 'The P2P orchestrator is not running.', line 91 'Enable P2P in your config and restart the gateway...'; no button. Note the condition is 'orchestrator not connected', not 'p2p disabled': the same copy shows when p2p.enabled is true but the orchestrator died (the audit itself documents that failure mode at report [...]" (reproducer agrees: partially-confirmed / needs-change) "P2pDashboard.tsx lines 87-94: 'Disconnected empty state' renders two <p> elements ('The P2P orchestrator is not [...]"
- Corrected statement / recommendation: Corrected statement: P2pDashboard:89 is a 'not connected' state (shown whether P2P is disabled OR the orchestrator crashed); CirclesView:81 is a true disabled state; SessionsView's only per-session control is a thinking-level prompt() at lines 84-95 (line 161 is the patch RPC), and there is no verbose control. Corrected recommendation: for Circles, an 'Enable' button must write config (config.apply/config.patch) AND explicitly call system.restart because the `circles` reload rule is kind 'none' while startup is boot-gated; [...]

#### 3.5-24

- Verdict: claim **partially-confirmed**; recommendation **needs-change**. Weight: low. Anchor: `src/cli/cli-name.ts:5`
- Original claim: src/cli/cli-name.ts:5-6 contains a duplicated regex alternation token `(bitterbot|bitterbot)`; src/cli/hooks-cli.ts:441,452 emit emoji in output; src/cli/banner.ts:48 uses an em-dash as the banner separator.
- Original recommendation: Collapse the regex; drop emoji; use `·`.
- What the verifiers found: (skeptic: partially-confirmed / needs-change) "cli-name.ts: line 5 is `KNOWN_CLI_NAMES = new Set([DEFAULT_CLI_NAME, "bitterbot"])` (duplicate entry, harmless in a Set) and line 6 is `CLI_PREFIX_RE = /^(?:((?:pnpm|npm|bunx|npx)\s+))?(bitterbot|bitterbot)\b/` -- duplicated alternation confirmed (rebrand residue; file untouched since Initial commit). [...]" (reproducer: confirmed / sound) "src/cli/cli-name.ts:6: `const CLI_PREFIX_RE = /^(?:((?:pnpm|npm|bunx|npx)\s+))?(bitterbot|bitterbot)\b/;` -- duplicated alternation confirmed; [...]"
- Corrected statement / recommendation: Corrected claim: regex duplication is at cli-name.ts:6 (and the Set at :5 has the same duplicate); banner em-dashes are at banner.ts:45 and :51. Corrected recommendation: collapse the regex and Set (sound, trivial). Do NOT strip ✓/⏸/🔗 from hooks-cli.ts in isolation: hook.emoji is a documented hook metadata field rendered everywhere in `hooks list/info`; either keep it or remove the emoji field product-wide. [...] (reproducer adds: Line references: cli-name.ts lines 5 AND 6 both carry the duplicate (Set and regex); banner.ts em-dashes are at lines 45 and 51, not 48. [...])

### 3.6 Code and repo hygiene

20 item(s) changed in this section (of 23 verified).

#### 3.6-01

- Verdict: claim **confirmed**; recommendation **needs-change**. Weight: high. Anchor: `package.json:79,107,115,133,123-130,134-137`
- Original claim: Root package.json contains 16 scripts that point at files which do not exist in the repo: census:dump, plugins:sync, release:check, test:force, eight test:docker:_ scripts, and four test:install:_ scripts (the scripts/e2e/ directory does not exist).
- Original recommendation: Delete ~32 dead scripts; add a CI one-liner asserting every scripts/ or apps/ path referenced in package.json exists. | Remove the 16 dangling package.json scripts from the V1 tree. | prune package.json scripts | P0-E.24: delete all of the above; untrack 56 MB of benchmark artifacts; [...]
- What the verifiers found: (skeptic: confirmed / needs-change) "Recounted from package.json (scripts block lines 61-144). Missing-file scripts, verified with a per-path existence loop: census:dump (L79 -> scripts/census-dump.ts MISSING), plugins:sync (L107 -> scripts/sync-plugin-versions.ts MISSING), release:check (L115 -> scripts/release-check.ts MISSING), test:force (L133 -> scripts/test-force.ts MISSING); [...]" (reproducer: confirmed / sound) "Reproduced from scratch with `node -e` over package.json scripts (82 total) + fs.existsSync on every scripts/|benchmarks/|desktop/|apps/ path: exactly 16 non-apps scripts point at missing files: census [...]"
- Corrected statement / recommendation: Claim stands (16 is exact). Fix the parenthetical: scripts/e2e/ is the target of 5 test:docker:_ scripts, not the test:install:_ scripts (those target scripts/test-install-sh-\*.sh). These scripts were never functional in this repo (present in root commit 33f9833, target files never tracked), so describe them as inherited-dead rather than broken-by-deletion. Recommendation: '~32' should be stated as 16 missing-file + 13 apps-targeting (see 3.6-02) with chain scripts trimmed rather than deleted; [...]

#### 3.6-02

- Verdict: claim **partially-confirmed**; recommendation **needs-change**. Weight: high. Anchor: `package.json:62-65,94-97,92,103,112,105,88,99,120,122`
- Original claim: Root package.json contains 12 scripts that target the deleted apps/ directory: android:_, ios:_, format:swift, lint:swift, protocol:check, protocol:gen:swift, and mac:package (via scripts/package-mac-app.sh lines 9,126,143,204,208).
- Original recommendation: Delete the apps/-targeting scripts; remove .swiftformat and .swiftlint.yml. | Delete Swift/Sparkle/iOS/Android scripts (D1). | prune ~14 scripts/ files and the apps/-targeting package.json scripts
- What the verifiers found: (skeptic: partially-confirmed / needs-change) "package.json: android:assemble/install/run/test L62-65 (`cd apps/android`), ios:build/gen/open/run L94-97 (`cd apps/ios`), format:swift L92 (apps/macos/Sources apps/ios/Sources apps/shared/...), lint:swift L103 (`cd apps/ios`), protocol:check L112 (git diff path apps/macos/Sources/BitterbotProtocol/GatewayModels.swift), mac:package L105 -> scripts/package-mac-app.sh whose lines 9,126,143,204,208 al [...]" (reproducer: partially-confirmed / sound) "`ls -d apps` -> No such file; `git ls-files apps` empty; `git log --all -- apps` empty (apps/ never existed in this repo's 586-commit history; the scripts are inherited). [...]"
- Corrected statement / recommendation: 13 scripts by the report's own list (add protocol:gen:swift L114), plus mac:restart (L106, scripts/restart-mac.sh) which also targets apps/macos -> 14. Replace 'deleted apps/ directory' with 'apps/ was never part of this repository (inherited scripts from the upstream import, root commit 33f9833)'. Recommendation: also remove the swiftlint/swiftformat hooks and the scripts/e2e and Swabble/ excludes from .pre-commit-config.yaml; keep scripts/bundle-a2ui.sh (guarded, part of pnpm build) and only prune the 7 other apps/-dependent scripts/ files. (reproducer adds: 14 scripts target the deleted apps/ tree, not 12: the 13 named in the claim plus mac:restart (scripts/restart-mac.sh:9-11,160-161). Recommendation stands; [...])

#### 3.6-03

- Verdict: claim **confirmed**; recommendation **needs-change**. Weight: medium. Anchor: `package.json`
- Original claim: The chain scripts format:all, lint:all, test:all, and test:docker:all in package.json fail when run because they invoke the missing-file scripts.
- Original recommendation: Trim the chain scripts to only existing sub-scripts.
- What the verifiers found: (skeptic: confirmed / needs-change) "package.json L88 format:all = `pnpm format && pnpm format:swift`; L92 format:swift runs `swiftformat ... apps/macos/Sources apps/ios/Sources ...` (apps/ missing; swiftformat not on PATH per `command -v`). L99 lint:all = `pnpm lint && pnpm lint:swift`; L103 lint:swift runs swiftlint + `cd apps/ios` (missing). [...]" (reproducer agrees: confirmed / needs-change) "package.json:88 format:all = `pnpm format && pnpm format:swift` (format:swift -> swiftformat binary absent + ap [...]"
- Corrected statement / recommendation: Claim holds. Nuance: test:all fails only at its last link (after lint/build/test/e2e/live complete); format:all and lint:all fail on the Swift link regardless of apps/ because neither swiftformat nor swiftlint is installed. Recommendation: 'trim' is right for test:all (drop test:docker:all), but format:all and lint:all would collapse to aliases of format and lint once the Swift halves are removed -- delete those two and test:docker:all outright instead of trimming.

#### 3.6-04

- Verdict: claim **partially-confirmed**; recommendation **sound**. Weight: medium. Anchor: `RELEASING.md:46-53`
- Original claim: RELEASING.md lines 46-53, docs/reference/test.md, and ci.md list release:check and/or test:install:smoke as required release steps, yet those scripts target missing files and no CI workflow runs them.
- Original recommendation: Update RELEASING, test, and ci docs to remove references to the dead scripts. | Remove the dead release:check script and rewrite RELEASING.md for the real V1 release flow.
- What the verifiers found: (skeptic: partially-confirmed / sound) "docs/reference/RELEASING.md L46 `pnpm release:check`, L47 `BITTERBOT_INSTALL_SMOKE_SKIP_NONROOT=1 pnpm test:install:smoke ... required before release`, L49-53 test:install:smoke / test:install:e2e\* (optional). docs/reference/ci.md L47 `pnpm release:check # validate npm pack` under '## Local Equivalents' (presented as CI equivalent, not a release step). [...]" (reproducer agrees: partially-confirmed / sound) "docs/reference/RELEASING.md (the only RELEASING.md; `git ls-files | grep -i releasing`) lines 46-53 reproduced: [...]"
- Corrected statement / recommendation: RELEASING.md L46-53 and ci.md L47 reference release:check/test:install:smoke; docs/reference/test.md does not -- it references the equally dead scripts/e2e/onboard-docker.sh (L40) and pnpm test:docker:qr (L50). Path is docs/reference/RELEASING.md (no root RELEASING.md). ci.md frames release:check as a 'local equivalent' of CI, not a required release step. Recommendation stands; [...]

#### 3.6-05

- Verdict: claim **partially-confirmed**; recommendation **sound**. Weight: high. Anchor: `benchmarks/longmemeval/.bench-runs-bio/adb4873b/store/benchmark.sqlite`
- Original claim: benchmarks/longmemeval/.bench-runs-bio/adb4873b/store/ contains git-tracked run artifacts totalling ~56 MB: two SQLite databases (32 MB and 22 MB) plus 53 generated .work-bio/\*.md files.
- Original recommendation: git rm --cached the artifacts; ignore _.sqlite_, .bench-runs-_/, .work-_/; consider history rewrite or moving benchmarks to its own repo. | untrack artifacts, add \*.sqlite to .gitignore; consider separate repo for benchmarks/
- What the verifiers found: (reproducer: partially-confirmed / sound) "Reproduced with `git ls-files` + `du -b`. Numbers hold: two tracked SQLite DBs, `benchmarks/longmemeval/.bench-runs-bio/adb4873b/store/benchmark.sqlite` = 33,144,832 bytes (31.6 MiB) and `benchmarks/longmemeval/.bench-runs-bio/25e5f2fe/store/benchmark.sqlite` = 22,622,208 bytes (21.6 MiB); [...]" (skeptic agrees: partially-confirmed / sound) "Recounted myself. `git ls-files benchmarks/longmemeval/.bench-runs-bio/` = 93 tracked files, `du -cb` = 56,700, [...]"
- Corrected statement / recommendation: Corrected statement: `benchmarks/longmemeval/` has ~57 MB of git-tracked run artifacts: two SQLite DBs (33.1 MB in `.bench-runs-bio/adb4873b/store/`, 22.6 MB in `.bench-runs-bio/25e5f2fe/store/`), 91 `.bench-runs-bio/*/workspace/memory/*.md` files, and 53 `.work-bio/*/*.md` files. Recommendation stands; cheapest precise form: `git rm -r --cached benchmarks/longmemeval/.bench-runs-bio benchmarks/longmemeval/.work-bio` and add `benchmarks/longmemeval/.bench-runs-*/` and `benchmarks/longmemeval/.work-*/` next to the existing `benchmarks/longmemeval/.work-con [...]

#### 3.6-07

- Verdict: claim **partially-confirmed**; recommendation **needs-change**. Weight: high. Anchor: `.github/workflows/ci.yml:56`
- Original claim: .github/workflows/ci.yml line 56 runs only `pnpm test:fast`, whose config vitest.unit.config.ts excludes src/gateway/** (95 test files) and extensions/** (12 test files).
- Original recommendation: Add gateway and extensions test steps to CI. | keep the 6 vitest configs but wire all of them into CI
- What the verifiers found: (skeptic: partially-confirmed / needs-change) ".github/workflows/ci.yml:55-56 `- name: Unit tests` / `run: pnpm test:fast`; package.json `test:fast => vitest run --config vitest.unit.config.ts`; vitest.unit.config.ts:8 filters `extensions/` out of include and :16 `exclude: [...exclude, "src/gateway/**", "extensions/**"]`. [...]" (reproducer: confirmed / needs-change) ".github/workflows/ci.yml:55-56 `- name: Unit tests` / `run: pnpm test:fast` is the only test step in any of the 4 workflows (grep across ci.yml, desktop-release.yml, orchestrator-release.yml, skill-rev [...]"
- Corrected statement / recommendation: Corrected statement: CI runs only test:fast, which skips 65 gateway unit test files (95 total .test.ts in src/gateway, of which 30 are live/e2e and excluded everywhere) and 12 extension test files. Corrected recommendation: do not add ad-hoc steps; switch ci.yml:56 from `pnpm test:fast` to the existing `pnpm test` (scripts/test-parallel.mjs), which already orchestrates unit + extensions + gateway with Windows-CI sharding. Budget a first run to check the 30-minute timeout on the 3-OS matrix. (reproducer adds: Premise supports the action, but a cheaper mechanism already exists: scripts/test-parallel.mjs (`pnpm test`) already orchestrates all three configs with CI-aware worker counts (vitest.config.ts:7-10) a [...])

#### 3.6-09

- Verdict: claim **partially-confirmed**; recommendation **needs-change**. Weight: high. Anchor: `.oxlintrc.json:24`
- Original claim: .oxlintrc.json line 24 ignorePatterns excludes desktop/, extensions/, skills/, and a nonexistent Swabble/ directory, so the Control UI (desktop/renderer) has no linter beyond three bespoke scripts.
- Original recommendation: Un-ignore desktop/ and extensions/; add the React/JSX oxlint plugin; drop the Swabble/ pattern. | fix the oxlint ignore list
- What the verifiers found: (reproducer: partially-confirmed / needs-change) ".oxlintrc.json: `"ignorePatterns": [` is line 23; line 24 is `"assets/"`; `"desktop/"` is line 26, `"extensions/"` line 29, `"skills/"` line 33, `"Swabble/"` line 36. `ls -d Swabble swabble` -> not found; `git ls-files | grep -ic swabble` = 0; `git log -S'Swabble' -- .oxlintrc.json` shows it has been there since the initial commit 33f9833. [...]" (skeptic: confirmed / sound) ".oxlintrc.json:23-38 ignorePatterns includes `desktop/` (:26), `extensions/` (:29), `skills/` (:33), `Swabble/` (:36); plugins at :3 are `["unicorn", "typescript", "oxc"]` (no react). [...]"
- Corrected statement / recommendation: Line reference should be .oxlintrc.json:23-38 (desktop/ at :26, extensions/ at :29, skills/ at :33, Swabble/ at :36). Recommendation direction is right but under-specified: (1) un-ignoring desktop/ with `--type-aware` requires oxlint to pick up desktop/tsconfig.json (root tsconfig excludes desktop/), so verify type-aware resolution or use an `overrides` block for desktop/\*\*; (2) add `"react"` to plugins and `"react-hooks"` if desired (oxlint 1.47.0 is installed, which supports these); [...]

#### 3.6-10

- Verdict: claim **partially-confirmed**; recommendation **needs-change**. Weight: medium. Anchor: `scripts/bundle-a2ui.sh:14`
- Original claim: scripts/bundle-a2ui.sh line 14 requires sources under apps/shared/.../CanvasA2UI which do not exist, so the bundler always falls back to the committed 592 KB bundle and the 173-file vendor/a2ui tree (with 3 vendored lockfiles) is dead; .dockerignore lines 45-57 whitelist the missing apps/shared path.
- Original recommendation: Restore the sources or drop vendor/a2ui and freeze the committed bundle with a README note. | remove vendor/a2ui or restore the app dir
- What the verifiers found: (skeptic: partially-confirmed / needs-change) "scripts/bundle-a2ui.sh:14 `A2UI_APP_DIR="$ROOT_DIR/apps/shared/BitterbotKit/Tools/CanvasA2UI"`; :18-22 `if [[ ! -d "$A2UI_RENDERER_DIR" || ! -d "$A2UI_APP_DIR" ]]` -> 'A2UI sources missing; keeping prebuilt bundle.' exit 0. apps/shared does not exist and never did (`git log --all -- apps` empty), so the fallback branch is the only branch ever taken; [...]" (reproducer: partially-confirmed / sound) "Reproduced scripts/bundle-a2ui.sh: line 13 `A2UI_RENDERER_DIR="$ROOT_DIR/vendor/a2ui/renderers/lit"`, line 14 `A2UI_APP_DIR="$ROOT_DIR/apps/shared/BitterbotKit/Tools/CanvasA2UI"`, lines 18-22: if eithe [...]"
- Corrected statement / recommendation: Corrected statement: 4 vendored lockfiles, not 3; bundle is 604 KB on disk. Corrected recommendation: 'restore the sources' is not an option, the CanvasA2UI app dir was never in this repo's history, so there is nothing to restore. The only viable path is: drop vendor/a2ui (2.7 MB, 173 files, zero consumers), delete bundle-a2ui.sh and the `canvas:a2ui:bundle` prefix in package.json:76 `build`, delete src/canvas-host/a2ui/.bundle.hash, drop .dockerignore:45-56, and add a README in src/canvas-host/a2ui/ stating the bundle is frozen and how it was produced. [...] (reproducer adds: Corrected statement: there are 4 vendored lockfiles (2 package-lock.json, 2 pnpm-lock.yaml), the bundle is 603,635 bytes (~590 KiB), and the .dockerignore whitelist is at lines 48-56. [...])

#### 3.6-11

- Verdict: claim **partially-confirmed**; recommendation **needs-change**. Weight: medium. Anchor: `scripts/check-ts-max-loc.ts:10`
- Original claim: scripts/check-ts-max-loc.ts enforces a 500-line cap but is never run by any package.json script or CI step; 194 files exceed 500 lines and 26 exceed 1000 lines, including manager.ts at 6472 lines and dream-engine.ts at 4293 lines.
- Original recommendation: Adopt the desktop package's 1000-line cap with a grandfather allowlist and wire the check into `pnpm lint`. | enforce the existing check:loc script rather than rewrite
- What the verifiers found: (reproducer: partially-confirmed / needs-change) "scripts/check-ts-max-loc.ts:10 `let maxLines = 500;`; it scans `git ls-files --cached --others --exclude-standard` (line 30) for all .ts/.tsx and counts `content.split("\n").length` (line 42). package.json:82 defines `"check:loc": "node --import tsx scripts/check-ts-max-loc.ts --max 500"` but it is not referenced by `lint`, `check`, `test:all`, any workflow (grep of .github/workflows), or any hook [...]" (skeptic agrees: partially-confirmed / needs-change) "scripts/check-ts-max-loc.ts:10 `let maxLines = 500;`; package.json `check:loc => node --import tsx scripts/chec [...]"
- Corrected statement / recommendation: Corrected statement: the script is defined as `pnpm check:loc` but never invoked by lint/check/CI/hooks; as written (500 cap, tests and vendor included) it would flag 293 files (46 over 1000); excluding test and vendor files, 195 exceed 500 and 26 exceed 1000. The two merged recommendations conflict: 'enforce the existing check:loc script rather than rewrite' is unsound because running it unchanged fails on 293 files and it has no allowlist. [...]

#### 3.6-12

- Verdict: claim **partially-confirmed**; recommendation **needs-change**. Weight: medium. Anchor: `package.json`
- Original claim: The dependencies @anthropic-ai/claude-agent-sdk, @modelcontextprotocol/sdk, @larksuiteoapi/node-sdk, @mariozechner/pi-tui, and signal-utils in package.json have no import anywhere in the repo outside benchmarks/; the renderer dependencies @radix-ui/react-navigation-menu and react-router-dom in desktop/package.json have no import in desktop/renderer/src.
- Original recommendation: Confirm with knip; remove the unused dependencies or move them to the benchmarks package.
- What the verifiers found: (reproducer: partially-confirmed / needs-change) "Declared: package.json:147 @anthropic-ai/claude-agent-sdk, :155 @larksuiteoapi/node-sdk, :161 @mariozechner/pi-tui (pinned 0.52.12), :162 @modelcontextprotocol/sdk, :199 signal-utils; desktop/package.json:27 @radix-ui/react-navigation-menu, :52 react-router-dom. [...]" (skeptic agrees: partially-confirmed / needs-change) "git grep over tracked files (excluding package.json/lockfiles): @anthropic-ai/claude-agent-sdk -> only benchmar [...]"
- Corrected statement / recommendation: Corrected claim: @anthropic-ai/claude-agent-sdk, @modelcontextprotocol/sdk, @larksuiteoapi/node-sdk and @mariozechner/pi-tui have no imports outside benchmarks/; signal-utils IS imported by vendor/a2ui/renderers/lit (compiled from root by scripts/bundle-a2ui.sh during `pnpm build`) and must stay. Corrected recommendation: remove @larksuiteoapi/node-sdk outright; remove @mariozechner/pi-tui only after fixing docs/reference/pi.md:503-507 (it is still installed transitively via pi-coding-agent); [...]

#### 3.6-13

- Verdict: claim **partially-confirmed**; recommendation **needs-change**. Weight: medium. Anchor: `package.json files`
- Original claim: The `files` array in package.json lists nonexistent README-header.png and assets/, and includes the ~15 MB docs/ directory (including docs/reviews and a 6 MB gif) and all 58 skills/ directories in the published npm tarball.
- Original recommendation: Prune `files`; add .npmignore for reviews/gifs; add `npm pack --dry-run` to the release check. | If npm is post-V1, drop the RELEASING npm checklist; otherwise precompile extensions and add an `npm pack --dry-run` check.
- What the verifiers found: (skeptic: partially-confirmed / needs-change) "package.json:35-45 `files`: LICENSE, bitterbot.mjs, README-header.png, README.md, assets/, dist/, docs/, extensions/, skills/. `ls README-header.png assets` -> both 'No such file or directory'; `git log --all -- README-header.png` is empty (never existed; inherited from Initial commit 33f9833). `du -sh docs` = 15M (tracked files 14M); [...]" (reproducer agrees: partially-confirmed / needs-change) "package.json `files` (via node -e): ["LICENSE","bitterbot.mjs","README-header.png","README.md","assets/","dist/ [...]"
- Corrected statement / recommendation: Corrected claim: `files` lists two nonexistent entries (README-header.png, assets/) and would ship ~14 MB of tracked docs/ (6.5 MB gif) plus 59 skill dirs, but no bitterbot package exists on npm today, so this is a latent issue, not a live one. Corrected recommendation: (1) drop README-header.png and assets/ from `files`; (2) the `npm pack --dry-run` step already exists in RELEASING.md (lines 34/46/65), the real gap is that `pnpm release:check` points at a missing scripts/release-check.ts; restore that script instead of adding a new checklist line; [...]

#### 3.6-14

- Verdict: claim **partially-confirmed**; recommendation **needs-change**. Weight: medium. Anchor: `.pre-commit-config.yaml:92`
- Original claim: .pre-commit-config.yaml (line 92) is a Python pre-commit config running swiftlint/swiftformat although the repo contains no Swift code; it duplicates git-hooks/pre-commit, and the 69 KB .secrets.baseline from January 2026 is not checked by any CI workflow.
- Original recommendation: Keep one hook mechanism; delete or trim pre-commit; run detect-secrets in CI if kept.
- What the verifiers found: (skeptic: partially-confirmed / needs-change) ".pre-commit-config.yaml:92-97 swiftlint hook, :100-105 swiftformat hook `entry: swiftformat --lint apps/macos/Sources`, both gated by `types: [swift]`, and `git ls-files | grep -c '\.swift$'` = 0, so these hooks never fire (harmless but dead). [...]" (reproducer: confirmed / sound) "Reproduced .pre-commit-config.yaml: lines 91-105 define local `swiftlint` (entry `swiftlint --config .swiftlint.yml`, line 94) and `swiftformat` (entry `swiftformat --lint apps/macos/Sources --config . [...]"
- Corrected statement / recommendation: Corrected statement: the Swift hooks are dead but inert (types: [swift] with zero .swift files); only the oxlint/oxfmt hooks duplicate git-hooks/pre-commit, the shellcheck/actionlint/zizmor/large-file/merge-conflict hooks have no equivalent anywhere else. SECURITY.md:92 falsely advertises detect-secrets in CI. Corrected recommendation: do not 'delete pre-commit' wholesale, that would drop the only shellcheck/actionlint/zizmor coverage the repo has. [...]

#### 3.6-15

- Verdict: claim **partially-confirmed**; recommendation **needs-change**. Weight: medium. Anchor: `scripts/package-mac-app.sh:9`
- Original claim: scripts/package-mac-app.sh and 9 sibling mac/iOS packaging scripts target the nonexistent apps/macos directory; make_appcast.sh requires a missing changelog-to-html.sh and a Sparkle feed at github.com/bitterbot/bitterbot, and carries a hard-coded SPARKLE_PUBLIC_ED_KEY default.
- Original recommendation: Delete all 10 mac/iOS packaging scripts; Tauri is the only native path. | Delete the dead Swift/Sparkle macOS toolchain and its package.json entries for V1.
- What the verifiers found: (reproducer: partially-confirmed / needs-change) "Reproduced: `ls apps` -> 'No such file or directory'; `git ls-files apps` empty. `grep -ln 'apps/macos' scripts/*` hits exactly 7 shell scripts: build-and-run-mac.sh:3, build_icon.sh:9/11/14, create-dmg.sh:112, make_appcast.sh:54, package-mac-app.sh:9/126/143/204/208, package-mac-dist.sh:12, restart-mac.sh:9-11/160-161. [...]" (skeptic agrees: partially-confirmed / needs-change) "apps/ has NEVER existed in this repo: `ls -d apps apps/macos apps/shared` all fail; [...]"
- Corrected statement / recommendation: Corrected statement: 7 shell scripts (package-mac-app, package-mac-dist, create-dmg, build_icon, build-and-run-mac, restart-mac, make_appcast) plus scripts/protocol-gen-swift.ts hard-code the nonexistent apps/macos tree; codesign-mac-app.sh, notarize-mac-artifact.sh, and ios-team-id.sh are dead only transitively/by purpose. The hard-coded Sparkle public-key default lives in package-mac-app.sh:25, not make_appcast.sh; [...]

#### 3.6-16

- Verdict: claim **partially-confirmed**; recommendation **needs-change**. Weight: low. Anchor: `scripts/setup-auth-system.sh:94`
- Original claim: scripts/setup-auth-system.sh line 94, auth-monitor.sh line 6, aubaine-demo.ts, and seed-forage-tranche.mts contain personal homelab tooling (hard-coded /home/admin/bitterbot paths and Termux widgets referencing missing scripts).
- Original recommendation: Move to an ignored ops/ directory or out of the repo.
- What the verifiers found: (reproducer: partially-confirmed / needs-change) "Reproduced scripts/auth-monitor.sh:6 `# Suggested cron: */30 * * * * /home/admin/bitterbot/scripts/auth-monitor.sh` and :81 `ssh l36 '~/bitterbot/scripts/mobile-reauth.sh'` (personal host alias 'l36'). scripts/setup-auth-system.sh:94-95 echo `scp $SCRIPT_DIR/termux-quick-auth.sh phone:~/.shortcuts/BitterbotAuth` / `termux-auth-widget.sh` (Termux:Widget instructions, lines 84-104); [...]" (skeptic agrees: partially-confirmed / needs-change) "scripts/setup-auth-system.sh:94-95 `scp $SCRIPT_DIR/termux-quick-auth.sh ...` / `termux-auth-widget.sh`, `ls sc [...]"
- Corrected statement / recommendation: Corrected statement: only setup-auth-system.sh and auth-monitor.sh are personal homelab tooling (hard-coded /home/admin path at auth-monitor.sh:6, `ssh l36` at :81, Termux widget instructions referencing five scripts that do not exist). aubaine-demo.ts is a wired, documented PLAN-26 demo/invariant harness and seed-forage-tranche.mts is the PLAN-29 operator tranche script; they should be removed from this finding (if they are to be moved at all, that is a separate product decision, not a hygiene one). [...]

#### 3.6-20

- Verdict: claim **confirmed**; recommendation **needs-change**. Weight: medium. Anchor: `src/wizard`
- Original claim: Test coverage by file count on the install path is: src/wizard 4 test files for 15 source files, src/sessions 1 for 7, and desktop/renderer/src 20 for 185 (and the renderer tests are not in CI).
- Original recommendation: Add smoke tests for non-interactive onboard and the FirstRun/Models/Channels screens; wire into CI.
- What the verifiers found: (skeptic: confirmed / needs-change) "Recounted with find: src/wizard = 19 .ts files, 4 are _.test.ts (onboarding.completion.test.ts, onboarding.gateway-config.test.ts, onboarding.test.ts, session.test.ts), 15 non-test -> 4/15 confirmed. src/sessions = 8 files, 1 test (send-policy.test.ts), 7 source -> 1/7 confirmed. desktop/renderer/src = 205 .ts/.tsx, 20 _.test.ts(x), 185 non-test, 0 .d.ts -> 20/185 confirmed. [...]" (reproducer: confirmed / sound) "Re-derived with `git ls-files <dir> | grep -E '\.(ts|tsx|js|mjs)$'` minus `\.(test|spec)\.`: src/wizard 19 tracked TS files, 4 tests (onboarding.completion.test.ts, onboarding.gateway-config.test.ts, o [...]"
- Corrected statement / recommendation: Counts stand. Recommendation should be: (1) the non-interactive onboard smoke tests already exist in src/commands/\*.e2e.test.ts -- wire `pnpm test:e2e` (or the onboard subset) into CI rather than writing new ones; (2) Models and Channels screens already have tests; only FirstRun needs a new one; (3) add `pnpm --filter bitterbot-control-ui test` to ci.yml so the 20 existing renderer tests run. Also note the src/wizard-only ratio understates install-path coverage because most onboarding logic and its tests live in src/commands/. (reproducer adds: Recommendation is sound; cheapest CI wiring already exists: add a step `pnpm --filter bitterbot-control-ui test` to ci.yml next to the existing typecheck/build steps (desktop/package.json:13 already de [...])

#### 3.6-21

- Verdict: claim **partially-confirmed**; recommendation **needs-change**. Weight: medium. Anchor: `src/line/config-schema.ts:1`
- Original claim: The 46-file LINE channel under src/line (config schema at src/line/config-schema.ts) is never registered as a channel anywhere in the gateway, yet @line/bot-sdk ^10.6.0 is a dependency in package.json (line 156) pulled into every install.
- Original recommendation: Delete src/line, line-directives.ts, the plugin-sdk re-exports, and the @line/bot-sdk dependency. | REMOVE src/line and the @line/bot-sdk dependency. | Remove all of these from the V1 tree (scope paragraph).
- What the verifiers found: (skeptic: partially-confirmed / needs-change) "`find src/line -type f | wc -l` = 46 (15 are _.test.ts). No registration: no "line" in src/channels/registry.ts or dock.ts, no extensions/line, no `line` key in ChannelsSchema (src/config/zod-schema.providers.ts:18-36). package.json:156 `"@line/bot-sdk": "^10.6.0"` sits under "dependencies" (section opens at 145), imported only from src/line/_. curl registry.npmjs.org/@bitterbot%2Fline = 404. [...]" (reproducer: confirmed / needs-change) "`git ls-files src/line | wc -l` = 46 (src/line/config-schema.ts present). package.json:156 `"@line/bot-sdk": "^10.6.0"` sits under `"dependencies"` (line 145), not dev/optional; [...]"
- Corrected statement / recommendation: 'Never registered as a channel' is true; the implied 'dead, safe to delete' is not. Deleting src/line + line-directives.ts as written breaks src/tts/tts.ts (stripMarkdown), src/plugins/runtime/index.ts (the `line` runtime namespace, a plugin-API surface), and normalize-reply.ts (which currently strips `[[quick_replies: ...]]`-style directives from all replies; removing it changes output text on every channel). [...] (reproducer adds: Statement is accurate but incomplete: src/line is unregistered as a channel yet is imported at runtime by TTS (tts.ts:25/883), the plugin runtime (runtime/index.ts:88-105, 415-430), normalize-reply (li [...])

#### 3.6-22

- Verdict: claim **partially-confirmed**; recommendation **needs-change**. Weight: low. Anchor: `.gitignore:60`
- Original claim: .gitignore begins with an unedited ~150-line Python/Django template (Django, Flask, Scrapy, Celery, SageMath rules, around line 60) before the project's real rules.
- Original recommendation: Rewrite .gitignore as a ~40-line Node/Tauri/Rust ignore.
- What the verifiers found: (skeptic: partially-confirmed / needs-change) ".gitignore is 238 lines. Lines 1-8 are project rules (.DS_Store, research/_-repo/, node_modules/); the GitHub Python template spans lines 9-167 (~159 lines): Django at 65-69, Flask 71-73, Scrapy 75-76, Celery 122-124, SageMath 126-127, PyCharm 162-167, so 'around line 60' and '~150 lines' hold, 'begins with' is approximately right. Project rules resume at 169. [...]" (reproducer agrees: partially-confirmed / needs-change) ".gitignore is 238 lines. It does NOT begin with the Python template: lines 1-8 are `.DS_Store`, `research/_-rep [...]"
- Corrected statement / recommendation: Corrected claim: .gitignore carries a near-verbatim ~159-line Python template (lines 9-167) after 8 lines of project rules, but that template is load-bearing: it is the only thing ignoring orchestrator/target (Rust), the Kaggle Python venv/egg-info/**pycache**, _.log and .env. Corrected recommendation: a rewrite is fine, but a '~40-line Node/Tauri/Rust' ignore must explicitly retain target/, dist/, build/, _.log, .env, .venv/, **pycache**/, \*.egg-info/, .pytest_cache/ (or add an orchestrator/.gitignore and a benchmarks/arc-agi-3/kaggle/.gitignore first), [...]

#### 3.6-23

- Verdict: claim **partially-confirmed**; recommendation **needs-change**. Weight: low. Anchor: `src/memory/scripts/skill-forge-test.ts:185`
- Original claim: Two dev scripts under src/ (including src/memory/scripts/skill-forge-test.ts, line 185) account for most of the 112 console.log occurrences in src/.
- Original recommendation: Move to scripts/diagnostics/; enable oxlint no-console as a warning for src.
- What the verifiers found: (reproducer: partially-confirmed / needs-change) "src/memory/scripts/skill-forge-test.ts:185 = `console.log("\nSkill Forge, End-to-End Skills Pipeline Test\n");` (CONFIRMED anchor). `ls src/memory/scripts` = pipeline-diagnostic.ts, skill-forge-test.ts (the two scripts). Counts I reproduced: `grep -rn 'console\.log' src --include=*.ts --include=*.tsx | wc -l` = 171 (all files incl. tests); excluding _.test._ = 127; [...]" (skeptic agrees: partially-confirmed / needs-change) "src/memory/scripts/skill-forge-test.ts:185 = `console.log("\nSkill Forge, End-to-End Skills Pipeline Test\n");` [...]"
- Corrected statement / recommendation: Corrected claim: ~115-127 non-test console.log occurrences in src (171 including tests); the two src/memory/scripts files account for 88 of them. Corrected recommendation: moving the two scripts out of src/ is sound (they are not wired into any package.json script or build). Enabling oxlint `eslint/no-console: warn` is possible (rule not currently set in .oxlintrc.json) but will still flag ~27 remaining non-test call sites (src/acp/client.ts, src/runtime.ts, src/web/login.ts, src/cli/completion-cli.ts, etc.), some of which are intentional CLI stdout; [...]

#### 3.6-24

- Verdict: claim **partially-confirmed**; recommendation **needs-change**. Weight: low. Anchor: `src/tasks/store.ts:637`
- Original claim: The codebase has nine separate truncate() implementations, five clamp() implementations (one exported from src/utils.ts line 37), and five formatDuration() implementations, e.g. src/tasks/store.ts line 637.
- Original recommendation: Consolidate into src/utils.ts.
- What the verifiers found: (skeptic: partially-confirmed / needs-change) "Recounted with `git grep -n -E '(function truncate\s*\(|\btruncate\s*=\s*(\(|function))'` excluding vendor/dist/tests: 9 hits, 8 in src (code-interpreter-tool.ts:25, cli/cron-cli.ts:157, commands/models/list.format.ts:49, commands/models/scan.ts:29, cron/isolated-agent.ts:144, tasks/completion-notifier.ts:86, tasks/judge.ts:180, tasks/store.ts:637) + desktop/renderer/src/lib/format.ts:54. [...]" (reproducer: confirmed / needs-change) "Re-derived with `grep -rnE '^\s*(export )?(async )?function NAME\s*[<(]|^\s*(export )?const NAME\s*=' src desktop/renderer/src extensions` excluding _.test._: truncate = 9 (src/agents/tools/code-interp [...]"
- Corrected statement / recommendation: Corrected statement: 9 truncate (8 src + 1 renderer), 6 clamp (5 duplicates + the utils alias), 5 formatDuration (2 src, 2 renderer, 1 extension). Corrected recommendation: 'consolidate into src/utils.ts' is the wrong target and partly infeasible. formatDuration already has a canonical home (src/infra/format-time/format-duration.ts), fold the two src copies into it, not utils. clamp duplicates in src can switch to the existing utils.ts clamp/clampNumber, but the memory/\* copies rely on default 0..1 bounds and the browser one is a closure-local helper; [...] (reproducer adds: Recommendation needs scoping: consolidating 'into src/utils.ts' only works for the src/ copies (4 clamp duplicates can switch to the already-exported `clamp` at src/utils.ts:37 today; [...])

#### 3.6-25

- Verdict: claim **confirmed**; recommendation **needs-change**. Weight: low. Anchor: `.github/workflows/desktop-release.yml:7`
- Original claim: .github/workflows/desktop-release.yml line 7 has a comment pointing at research/TAURI-PRODUCTION-PLAN.md, which is gitignored; .dockerignore line 45, vitest.config.ts, and .oxlintrc.json contain stale apps/shared/..., apps/macos/\*\*, and Swabble/ references.
- Original recommendation: Point the comment at PLAN-39 or a docs page; sweep and remove the stale apps/ and Swabble/ references.
- What the verifiers found: (reproducer: confirmed / needs-change) ".github/workflows/desktop-release.yml:7 = `# See research/TAURI-PRODUCTION-PLAN.md for the full design rationale.` `git check-ignore -v research/TAURI-PRODUCTION-PLAN.md` -> `.gitignore:212:research/`; the file exists locally but is untracked, so the comment points at a document not in the repo. [...]" (skeptic agrees: confirmed / needs-change) ".github/workflows/desktop-release.yml:7 `# See research/TAURI-PRODUCTION-PLAN.md for the full design rationale. [...]"
- Corrected statement / recommendation: The pointer target should not be PLAN-39: docs/plans/PLAN-39-CONTROL-UI-GATEWAY-SERVING.md is about the gateway serving the Control UI and only mentions Tauri in passing (lines 93, 98, 139); it contains no Tauri release/build rationale. Better: point the comment at the tracked desktop/TAURI.md or desktop/README.md (both exist), or un-ignore and commit research/TAURI-PRODUCTION-PLAN.md. The stale-reference sweep should also cover .oxfmtrc.jsonc, .pre-commit-config.yaml:70/102, .swiftlint.yml, and .swiftformat, not just the three files named.

### 3.7-3.8 Packaging, release and CLI

25 item(s) changed in this section (of 27 verified).

#### 3.7-3.8-02

- Verdict: claim **partially-confirmed**; recommendation **sound**. Weight: medium. Anchor: `docs/reference/RELEASING.md:21; package.json scripts`
- Original claim: docs/reference/RELEASING.md:21 instructs to bump to a CalVer version and to run a `plugins:sync` script that does not exist in package.json scripts.
- Original recommendation: One-page V1 runbook replacing RELEASING.md steps.
- What the verifiers found: (skeptic: partially-confirmed / sound) "docs/reference/RELEASING.md: L20 `1. **Version & metadata**`, L21 blank, L22 `Bump package.json version (e.g., 2026.1.29)` (CalVer example; current package.json L3 version is '2026.2.15'), L23 `Run pnpm plugins:sync to align extension package versions + changelogs`. package.json L107: `"plugins:sync": "node --import tsx scripts/sync-plugin-versions.ts"` -- the script DOES exist in package.json; [...]" (reproducer: confirmed / sound) "docs/reference/RELEASING.md:22 `Bump package.json version (e.g., 2026.1.29)` (CalVer) and :23 `Run pnpm plugins:sync to align extension package versions + changelogs`, the cited line 21 is a blank line [...]"
- Corrected statement / recommendation: Corrected statement: docs/reference/RELEASING.md L22-23 (not L21) instructs a CalVer bump and `pnpm plugins:sync`; the plugins:sync script is present in package.json (L107) but its target scripts/sync-plugin-versions.ts has never existed in the repo, so the step cannot run. Recommendation (one-page V1 runbook) is sound and under-argued: the npm package `bitterbot` does not exist on the registry (404) and no desktop-v\* tag has ever been cut, so the entire npm section is aspirational, not merely stale. (reproducer adds: Minor: the anchor is lines 22-23, not 21. The plugins:sync script name does exist in package.json; what is missing is its target file scripts/sync-plugin-versions.ts.)

#### 3.7-3.8-03

- Verdict: claim **partially-confirmed**; recommendation **needs-change**. Weight: high. Anchor: `src/cli/update-cli/update-command.ts compareSemverStrings`
- Original claim: The update-check version comparator `compareSemverStrings` (src/cli/update-cli/update-command.ts) would treat version 1.0.0 as older than 2026.2.15, so retagging V1 as 1.0.0 would make update checks think the new release is a downgrade.
- Original recommendation: Add a guard in update-check when moving to v1.0.0. | Add a one-line guard in compareSemverStrings when switching to SemVer (D2).
- What the verifiers found: (skeptic: partially-confirmed / needs-change) "compareSemverStrings is NOT defined in src/cli/update-cli/update-command.ts; it is defined in src/infra/update-check.ts:344-361 (update-command.ts:18 imports it, :557 calls it). It uses parseSemver (src/infra/runtime-guard.ts:23-37) and compares major first, so compare('2026.2.15','1.0.0') = 1, i.e. 1.0.0 is treated as older, the arithmetic claim holds. [...]" (reproducer agrees: partially-confirmed / needs-change) "`compareSemverStrings` is NOT defined in src/cli/update-cli/update-command.ts; [...]"
- Corrected statement / recommendation: Statement: compareSemverStrings (src/infra/update-check.ts:344) would rank 1.0.0 below 2026.2.15, but that comparator only runs for npm package installs (update-command.ts:546, update-startup.ts:125, update-staleness.ts:57); the npm package is unpublished (404) and git installs never hit it, so the real-world impact is a bypassable downgrade prompt on a hypothetical future npm install. [...]

#### 3.7-3.8-04

- Verdict: claim **confirmed**; recommendation **needs-change**. Weight: high. Anchor: `desktop/src-tauri/src/main.rs:93`
- Original claim: desktop/src-tauri/src/main.rs:93 spawns `node scripts/run-node.mjs`, which requires the repo source tree and therefore cannot work in a packaged Tauri app.
- Original recommendation: Scope the Tauri app out of V1 in README/TAURI.md.
- What the verifiers found: (skeptic: confirmed / needs-change) "desktop/src-tauri/src/main.rs:93-95: `Command::new("node").args(["scripts/run-node.mjs", "gateway"]).current_dir(&gateway_root)`; gateway_root is derived from process cwd (lines 75-89) by walking up from src-tauri/ or desktop/. The file's own comments concede it (lines 17-18, 22-24, 63-74: 'TODO(SEA-sidecar)... [...]" (reproducer agrees: confirmed / needs-change) "Reproduced from scratch. `grep -n Command::new desktop/src-tauri/src/main.rs` -> line 93 `Command::new("node")` [...]"
- Corrected statement / recommendation: Claim stands. Recommendation: the report contradicts itself. Row 336 says 'Scope out of V1 in README/TAURI.md', while the install matrix (line 673) says 'no user-facing mention'. README.md currently contains zero mentions of Tauri (`grep -in tauri README.md` is empty), so adding an out-of-scope note to README would CREATE a user-facing mention. Corrected recommendation: add a post-V1/internal banner to desktop/TAURI.md only (it already lists the gaps in its 'Still to do' section, lines 189-196, but never says out-of-scope), and leave README silent. [...]

#### 3.7-3.8-05

- Verdict: claim **partially-confirmed**; recommendation **needs-change**. Weight: medium. Anchor: `desktop/src-tauri/tauri.conf.json:30-36,66; desktop/src-tauri/icons`
- Original claim: desktop/src-tauri/tauri.conf.json:30-36,66 references an `icons/` directory that does not exist in desktop/src-tauri and contains a placeholder updater pubkey.
- Original recommendation: Scope Tauri out of V1; fix post-V1. | Tauri desktop is explicitly post-V1 (D1). | No published npm/SEA/Tauri artifact exists; do not count native app as a V1 surface. | Declare the Tauri app explicitly out of V1 scope. [...]
- What the verifiers found: (skeptic: partially-confirmed / needs-change) "`ls desktop/src-tauri/icons` -> 'No such file or directory'; `git ls-files desktop/src-tauri` lists 9 files, none under icons/. desktop/src-tauri/.gitignore has a comment block about icons (lines 16-18) but no ignore pattern, so the directory was simply never generated (TAURI.md:192 and research status doc line 20 both say 'Real app icons' still to do). [...]" (reproducer agrees: partially-confirmed / needs-change) "`cat -n desktop/src-tauri/tauri.conf.json`: the `icon` array is at lines 31-37 (line 31 `"icon": [`, 32-36 the [...]"
- Corrected statement / recommendation: Corrected claim: tauri.conf.json:31-37 lists five icons/ paths that do not exist, and :65 holds the placeholder pubkey. Recommendation bundle: 'scope Tauri out of V1' is sound and already the roadmap position (PLAN-39 line 139: Tauri Q3-Q4 2026). But (a) 'no user-facing mention' conflicts with row 336's 'scope out in README' (see 3.7-3.8-04), and (b) the P2 fix list says 'Node 24 for sidecar' with no stated reason while package.json:239 engines is >=22.12.0 and CI/desktop-release.yml pin node 22 (ci.yml:23, desktop-release.yml:124); [...]

#### 3.7-3.8-06

- Verdict: claim **confirmed**; recommendation **needs-change**. Weight: medium. Anchor: `scripts/build-sea.mjs:196`
- Original claim: scripts/build-sea.mjs:196 handles only better-sqlite3 as a native addon, while the repo now uses node:sqlite plus the sqlite-vec extension, and it bundles ESM into a Node 22 Single Executable Application which only supports CJS entry points.
- Original recommendation: Fix build-sea post-V1 (CJS entry, sqlite-vec file, Node 24 for sidecar).
- What the verifiers found: (reproducer: confirmed / needs-change) "scripts/build-sea.mjs: line 114 `"--format=esm"`, line 115 `"--target=node22"`, line 119 `"--external:better-sqlite3"`, lines 188-210 copy `node_modules/better-sqlite3/build/Release/better_sqlite3.node` (line 197 is the `"better-sqlite3",` path segment); no occurrence of 'sqlite-vec' or 'node:sqlite' anywhere in the script. Repo reality: `grep -n better-sqlite3 package.json` -> none; [...]" (skeptic agrees: confirmed / needs-change) "scripts/build-sea.mjs:116-119 `--external:better-sqlite3` with comment 'better-sqlite3 ships a native .node add [...]"
- Corrected statement / recommendation: Claim confirmed (and understated: the entry point itself is the dev runner, not the gateway bundle). Recommendation needs one fix: 'Node 24 for sidecar' does not buy ESM support. The Node v24.x docs still say 'currently only supports running a single embedded script using the CommonJS module system'; only the current (v26.7.0) docs say 'supports ... CommonJS or the ECMAScript Modules module system'. So either keep the CJS-entry fix (works on 22/24) or move to Node 26, not 24. [...]

#### 3.7-3.8-08

- Verdict: claim **confirmed**; recommendation **needs-change**. Weight: medium. Anchor: `https://github.com/Bitterbot-AI/bitterbot-desktop/releases/latest/download/latest.json`
- Original claim: The URL github.com/Bitterbot-AI/bitterbot-desktop/releases/latest/download/latest.json (used by the Tauri updater config) redirects to the orchestrator release, because the only GitHub releases are orchestrator-vX.Y.Z.
- Original recommendation: Scope Tauri updater out of V1.
- What the verifiers found: (skeptic: confirmed / needs-change) "Re-fetched today: `curl -sI https://github.com/Bitterbot-AI/bitterbot-desktop/releases/latest/download/latest.json` -> HTTP/2 302, `location: https://github.com/Bitterbot-AI/bitterbot-desktop/releases/download/orchestrator-v0.2.2/latest.json`; following the redirect returns 404. `gh release list --limit 50` -> only orchestrator-v0.2.2 (Latest), 0.2.1, 0.2.0, 0.1.0. [...]" (reproducer: confirmed / sound) "`gh release list --limit 50` -> exactly four releases: orchestrator-v0.2.2 (Latest, 2026-08-14), orchestrator-v0.2.1, orchestrator-v0.2.0, orchestrator-v0.1.0; no desktop-v\* release. [...]"
- Corrected statement / recommendation: Claim stands. Recommendation is fine for V1 but incomplete: scoping the updater out is not a fix. Post-V1 the endpoint must not use /releases/latest at all in a repo that also publishes orchestrator-v* releases; use a fixed-tag or per-channel URL (e.g. a moving `desktop-latest` release/tag, or a static latest.json on a site), or set `make_latest: false` on orchestrator releases. Also note the renderer only calls check() under Tauri (desktop/renderer/src/lib/updater.ts:62-73), so the browser Control UI is unaffected today. (reproducer adds: Claim stands. Recommendation is sound for V1. Post-V1 note: `releases/latest` is shared between orchestrator-v* and any future desktop-v\* tags, so whichever was published most recently wins; [...])

#### 3.7-3.8-09

- Verdict: claim **partially-confirmed**; recommendation **needs-change**. Weight: high. Anchor: `scripts/start-all.mjs:171; src/wizard/onboarding.finalize.ts:226-229; .github/workflows/ci.yml:50-52`
- Original claim: The gateway never serves the built Control UI in dist-renderer (scripts/start-all.mjs:171, src/wizard/onboarding.finalize.ts:226-229), while CI builds dist-renderer at .github/workflows/ci.yml:50-52 and nothing consumes that build output.
- Original recommendation: D5 / PLAN-39 phase 1: gateway serves Control UI. | P0-D.20 / D5: gateway serves dist-renderer on 19001 (PLAN-39 phase 1); start:all and onboarding build the renderer once and stop spawning pnpm dev; remove port 5173 from docs. DoD 1: no `pnpm dev` appears in the install flow. [...]
- What the verifiers found: (skeptic: partially-confirmed / needs-change) "Gateway never serves dist-renderer: `grep -rn dist-renderer` across src/ returns nothing; src/gateway/server-http.ts has no `requestPath === "/"` handler (only 404s at :302/:430/:708); gateway.controlUi.{enabled,root} are read by nothing in src/gateway (only basePath, server-runtime-config.ts:49 / server.impl.ts:652); PLAN-39 §1 line 44-60 documents the same. [...]" (reproducer: partially-confirmed / sound) "Reproduced: gateway never serves dist-renderer: `grep -rn dist-renderer src/ scripts/` yields nothing; only hits repo-wide are desktop/.gitignore:2, desktop/vite.config.ts:109 (outDir), desktop/src-tau [...]"
- Corrected statement / recommendation: Restate: 'The gateway never serves the built Control UI; CI builds dist-renderer purely as a bundler smoke test, and the only runtime consumer is the unreleased Tauri shell (tauri.conf.json:8).' ci.yml anchor should be :51-53. Recommendation: same PLAN-39 phase misattribution as 3.2-24 (serving = Phase 2, gated by Phase 0 measurement). 'start:all and onboarding build the renderer once' must also cover src/infra/ui-restart.ts:337 (update path respawns `pnpm dev`), PLAN-39 §8 Phase 4, otherwise the first in-UI update re-spawns the dev server. [...] (reproducer adds: Gateway never serves dist-renderer (confirmed); CI builds it as a bundler-failure smoke test (ci.yml:47-52); the only consumer is the unreleased Tauri shell (desktop/src-tauri/tauri.conf.json:8 fronten [...])

#### 3.7-3.8-10

- Verdict: claim **partially-confirmed**; recommendation **needs-change**. Weight: medium. Anchor: `package.json:22; docs/docs.json:38-45; scripts/fetch-orchestrator.mjs:33; git remote`
- Original claim: package.json:22, docs/docs.json:38-45, SECURITY.md and CONTRIBUTING.md reference the repo as github.com/bitterbot/bitterbot, whereas the real git remote and scripts/fetch-orchestrator.mjs:33 use Bitterbot-AI/bitterbot-desktop.
- Original recommendation: Canonical URL everywhere; lint grep. | P0-E.29 / D2: repo identity sed; add CHANGELOG.md (Keep a Changelog), one-page RELEASING runbook, bump-version script, and v1.0.0 tag. DoD 9: a tagged v1.0.0 (or 2026.9.0) release exists with CHANGELOG entry and attested artifacts.
- What the verifiers found: (skeptic: partially-confirmed / needs-change) "git remote -v: origin https://github.com/Bitterbot-AI/bitterbot-desktop.git (fetch/push): CONFIRMED. package.json: line 22 is `"homepage": "https://about.bitterbot.ai"` (not a repo URL); the stale strings are line 24 `"url": "https://github.com/bitterbot/bitterbot/issues"` and line 30 `"url": "https://github.com/bitterbot/bitterbot.git"`. [...]" (reproducer agrees: partially-confirmed / needs-change) "package.json: the bitterbot/bitterbot URLs are at lines 24 (`bugs.url: https://github.com/bitterbot/bitterbot/i [...]"
- Corrected statement / recommendation: Corrected statement: the stale `github.com/bitterbot/bitterbot` identity appears in package.json:24,30 (bugs/repository), docs/docs.json:40,45, docs/reference/RELEASING.md x3, src/cli/update-cli/shared.ts:40 (functional: `bitterbot update` git-clone URL), src/agents/system-prompt.ts:649,651, scripts/make_appcast.sh:6,52 and ~12 other docs/src files (30 hits / 20 files total); SECURITY.md and CONTRIBUTING.md are already correct and should be removed from the finding; fetch-orchestrator.mjs REPO is at line 32. [...]

#### 3.7-3.8-12

- Verdict: claim **partially-confirmed**; recommendation **needs-change**. Weight: medium. Anchor: `.github/workflows/ci.yml:45; .github/workflows/`
- Original claim: .github/workflows/ci.yml:45 skips `pnpm build` and the renderer build on the Windows matrix leg, there is no workflow triggered on v\* tags, and CI produces no release artifact.
- Original recommendation: Add release.yml on v\*: full build, tarball + built UI, Docker push, GitHub Release; make the Windows leg real or drop Windows from the matrix. | Include Windows in the V1 install matrix fix (setup-deps + CI build) or document it as unsupported.
- What the verifiers found: (skeptic: partially-confirmed / needs-change) "ci.yml:44-46 `- name: Build / if: runner.os != 'Windows' / run: pnpm build` and :51-53 same guard on the renderer build: confirmed. Tag triggers: ci.yml:3-7 push/PR on main only; desktop-release.yml:9-12 `tags: ["desktop-v*"]`; orchestrator-release.yml:7-10 `tags: ["orchestrator-v*"]`; no workflow matches a bare `v*` tag: confirmed. [...]" (reproducer: confirmed / needs-change) ".github/workflows/ci.yml:44-46 `- name: Build / if: runner.os != 'Windows' / run: pnpm build` and :51-53 same guard on `pnpm --filter bitterbot-control-ui build`; [...]"
- Corrected statement / recommendation: Corrected statement: ci.yml skips only the two build steps on Windows (typecheck + unit tests still run and pass); there is no v*-triggered workflow and ci.yml emits no artifacts, but the repo already has two tag-triggered release workflows (orchestrator-v*, desktop-v*) with 4 published orchestrator releases. Recommendation: 'make the Windows leg real or drop Windows' is a false dichotomy; [...] (reproducer adds: Claim holds as stated. Recommendation needs adjustment: a new release.yml on `v*` would be a third, overlapping release pipeline next to the never-run desktop-release.yml (desktop-v\*) and the working o [...])

#### 3.7-3.8-13

- Verdict: claim **partially-confirmed**; recommendation **sound**. Weight: medium. Anchor: `scripts/setup-deps.sh:26-30; scripts/preinstall-check.mjs; package.json engines`
- Original claim: scripts/setup-deps.sh:26-30 enforces a Node floor of 22 whereas package.json engines / scripts/preinstall-check.mjs require >=22.12.0; setup-deps.sh never installs pnpm; and Windows is not supported by the setup script.
- Original recommendation: Installer owns prerequisites; align floor; document "Windows via WSL2". | Add pnpm provisioning to the one-command install.
- What the verifiers found: (reproducer: partially-confirmed / sound) "setup-deps.sh:102-110 (not 26-30, which is the OS branch): `NODE_MAJOR=$(... cut -d. -f1)`; `if [[ "$NODE_MAJOR" -ge 22 ]]` -- major-only floor of 22, and it only warns, never exits -- confirmed as a major-only floor. package.json:238-239 `"engines": { "node": ">=22.12.0" }` -- confirmed. REFUTED part: scripts/preinstall-check.mjs does NOT require >=22.12.0; lines 50-53 `const MIN_MAJOR = 22; ... [...]" (skeptic agrees: partially-confirmed / sound) "Anchor is wrong: scripts/setup-deps.sh:26-30 is the OS-detection else-branch; [...]"
- Corrected statement / recommendation: Corrected claim: setup-deps.sh:102-110 checks major >= 22 (warn only); scripts/preinstall-check.mjs:50-53 ALSO checks only major >= 22 (hard fail); only package.json engines (>=22.12.0) and src/wizard/onboarding.node-version.ts:36 (MIN_NODE 22.12.0) enforce the patch-level floor. The recommendation to align the floor should therefore touch preinstall-check.mjs too (the cheapest fix: have preinstall-check read engines.node from package.json and compare with full semver, and drop the duplicate check from setup-deps.sh). [...]

#### 3.7-3.8-14

- Verdict: claim **partially-confirmed**; recommendation **needs-change**. Weight: medium. Anchor: `docs/reference/RELEASING.md:47,60; .github/workflows/desktop-release.yml:56; CHANGELOG.md`
- Original claim: docs/reference/RELEASING.md:47,60 references `release:check` and `test:install:smoke` scripts that do not exist, includes "2.0.0-beta2" troubleshooting, and .github/workflows/desktop-release.yml:56 passes `--notes "See CHANGELOG"` although no CHANGELOG.md exists in the repo.
- Original recommendation: One-page V1 runbook; add CHANGELOG.md (Keep a Changelog). | Rewrite RELEASING.md for the V1 flow and add a CHANGELOG.md.
- What the verifiers found: (skeptic: partially-confirmed / needs-change) "docs/reference/RELEASING.md L46 `pnpm release:check`, L47 `pnpm test:install:smoke`; L60 is `npm publish --access public` (not a dead-script reference; anchor wrong). Both scripts exist in package.json (L115 release:check, L137 test:install:smoke); their targets scripts/release-check.ts and scripts/test-install-sh-docker.sh are MISSING, so 'scripts that do not exist' is inaccurate as phrased. [...]" (reproducer: partially-confirmed / sound) "RELEASING.md:46 `pnpm release:check`, :47 `pnpm test:install:smoke` (both script names exist in package.json at lines 115/137 but their targets scripts/release-check.ts and scripts/test-install-sh-dock [...]"
- Corrected statement / recommendation: Corrected statement: RELEASING.md L46-47 (not 47,60) reference release:check and test:install:smoke, which exist as package.json scripts (L115, L137) but point at files that were never tracked; L63 carries the 2.0.0-beta2 troubleshooting; desktop-release.yml L58 (not 56) passes `--notes "Automated release. See CHANGELOG."` while no root CHANGELOG.md exists (only extensions/twitch/CHANGELOG.md); RELEASING.md L38 itself acknowledges the file may be missing. [...] (reproducer adds: Dead-script references are at RELEASING.md:46-47 (not 47,60); the --notes line is desktop-release.yml:58 with text 'Automated release. [...])

#### 3.7-3.8-15

- Verdict: claim **partially-confirmed**; recommendation **needs-change**. Weight: low. Anchor: `research/TAURI-PHASE-1-STATUS.md:3; git ls-files desktop/src-tauri`
- Original claim: research/TAURI-PHASE-1-STATUS.md:3 states the Tauri work is "local only, not pushed" although the Tauri files are committed on main.
- Original recommendation: Move TAURI-\* docs under docs/plans with a post-V1 banner.
- What the verifiers found: (skeptic: partially-confirmed / needs-change) "research/TAURI-PHASE-1-STATUS.md:3 reads `*Branch: \`tauri/production-phase-1\` (local only, not pushed)*`and :10 'Done (on branch, not pushed)'. The Tauri commits are on main and pushed:`git branch --contains`for 6841af8 (tray/updater, 2026-04-20), d7e95a5 (externalBin/updater config), 05f3d5a (build-sea.mjs) all include main;`git branch -r --contains 6841af8`includes origin/main; [...]" (reproducer: confirmed / needs-change) "research/TAURI-PHASE-1-STATUS.md:3 reads`*Branch: \`tauri/production-phase-1\` (local only, not pushed)\*` and line 11 'Done (on branch, not pushed):'. [...]"
- Corrected statement / recommendation: Corrected claim: the stale 'local only, not pushed' line is in a gitignored, untracked file (research/ is ignored by .gitignore:212), so it is not a repo inconsistency; the real defect is that three tracked files (desktop/TAURI.md:108,177; scripts/build-sea.mjs:20; desktop-release.yml:7) point at docs that are not in git. [...] (reproducer adds: Claim is accurate but should add that research/ is gitignored (.gitignore:212), so the status doc is local-only while the code it describes is on main. [...])

#### 3.7-3.8-16

- Verdict: claim **partially-confirmed**; recommendation **needs-change**. Weight: low. Anchor: `docs/docs.json:67-72,355-360`
- Original claim: docs/docs.json:67-72,355-360 has /install pointing to a getting-started page that links back to /install (a loop), and nav entries /docker, /install/podman, /install/nix, /install/railway, /install/northflank and /install/updating point to pages that do not exist in docs/.
- Original recommendation: Delete the block; one real install page. | Fix the redirects as part of rewriting the install docs.
- What the verifiers found: (skeptic: partially-confirmed / needs-change) "docs/docs.json:67-72: `{"source": "/install", "destination": "/start/getting-started"}, {"source": "/install/:slug*", "destination": "/start/getting-started"}`; docs/start/getting-started.md:46 links `[Install](/install)` -> self-referential loop (confirmed). docs/docs.json:355-360: `/docker -> /install/docker`, `/podman -> /install/podman` (confirmed). [...]" (reproducer: confirmed / sound) "docs/docs.json:67-68 `"source": "/install", "destination": "/start/getting-started"`; :71-72 `"source": "/install/:slug*", "destination": "/start/getting-started"`. [...]"
- Corrected statement / recommendation: Corrected statement: the entire Install tab (20 en + zh-CN entries) is missing, not six pages; /docker and /podman are redirect sources at 355-360 whose targets are themselves dead but caught by the `/install/:slug*` catch-all at :71. Corrected recommendation: deleting the Install tab block is right, but also (a) delete or repoint the 17 `/install/*` redirect destinations (or keep the single catch-all and drop the rest), (b) fix docs/start/setup.md:27 and getting-started.md:46 inbound links, and (c) extend scripts/docs-link-audit.mjs to validate nav `page [...] (reproducer adds: Claim correct; scope is larger than six entries. Cheaper fix: delete the entire 'Install' navigation tab (docs.json ~775-812), the zh-CN install group (~1265-1272) and `install/node` (1205), and retarg [...])

#### 3.7-3.8-17

- Verdict: claim **partially-confirmed**; recommendation **needs-change**. Weight: medium. Anchor: `src/cli/program/help.ts:69-76; src/cli/argv.ts:2; src/cli/banner.ts:34-35; src/cli/skills-cli.ts:34; src/cli/hooks-cli.ts:471; src/acp/server.ts:137`
- Original claim: `-v` short-circuits to printing the version in three places (src/cli/program/help.ts:69-76, src/cli/argv.ts:2, src/cli/banner.ts:34-35) using a whole-argv `includes` check rather than argv[2], while src/cli/skills-cli.ts:34, src/cli/hooks-cli.ts:471 and src/acp/server.ts:137 declare `-v, --verbose`, so `-v` can never reach those subcommands; argv.test.ts never tests `-v`.
- Original recommendation: Remove -v from all three sites; scope to argv[2] or stop at `--`; add tests. | REMOVE `-v` as version alias. | Fix the one real CLI bug: stop hijacking -v globally. | P0-E.28: fix -v; real descriptions + tagline; hide the 8 dev commands and gateway call; hideHelp() on --dev/debug flags; [...]
- What the verifiers found: (skeptic: partially-confirmed / needs-change) "src/cli/program/help.ts:69-76 is the only site that PRINTS and exits: `if (process.argv.includes("-V") || includes("--version") || includes("-v")) { console.log(ctx.programVersion); process.exit(0); }`, called from build-program.ts:4 `configureProgramHelp` on every full-program run; whole-argv `includes`, not argv[2]. [...]" (reproducer: partially-confirmed / sound) "Three version-hijack sites confirmed: src/cli/program/help.ts:69-76 `if (process.argv.includes("-V") || process.argv.includes("--version") || process.argv.includes("-v")) { console.log(ctx.programVersi [...]"
- Corrected statement / recommendation: Corrected statement: `-v` is recognized as a version flag in three places (help.ts:69-76 prints+exits; argv.ts:2 and banner.ts:34-35 only gate routing/banner), so `skills list -v` and `hooks list -v` print the version; the acp/server.ts:137 `-v` is a standalone-entry parser and is not hijacked by the CLI. Recommendation: the -v fix is sound and should touch all three sites (removing it only from help.ts would leave argv.ts causing the `skills` sub-CLI to not register). [...] (reproducer adds: Corrected statement: the hijack sites are help.ts:69-76, argv.ts:2 (via hasHelpOrVersion, 7 call sites), banner.ts:34-35; [...])

#### 3.7-3.8-18

- Verdict: claim **partially-confirmed**; recommendation **sound**. Weight: medium. Anchor: `src/cli/program/register.subclis.ts:273; src/cli/program/command-registry.ts:151-155; src/cli/program/help.ts:36`
- Original claim: Top-level `bitterbot --help` shows placeholder descriptions from src/cli/program/register.subclis.ts:273 / command-registry.ts:151-155 ("Memory commands", "Agent commands", "Node commands", "Setup helpers", "Gateway service (legacy alias)") that differ from the subcommands' real descriptions, and the root program has `.description("")` (help.ts:36).
- Original recommendation: Single source of truth for descriptions; real root description; fixed DEFAULT_TAGLINE in help banner. | Polish descriptions for approvals, node, nodes, sandbox, directory, docs, completion. [...]
- What the verifiers found: (skeptic: partially-confirmed / sound) "Placeholder vs real descriptions, all checked: 'Memory commands' (command-registry.ts:88) vs 'Memory search tools' (memory-cli.ts:501-502); 'Agent commands' (command-registry.ts:96) vs 'Run an agent turn via the Gateway (use --local for embedded)' (register.agent.ts:22-23); 'Node commands' (register.subclis.ts:93) vs 'Manage gateway-owned node pairing' (nodes-cli/register.ts:15-16); [...]" (reproducer: confirmed / sound) "help.ts:36 is literally `.description("")` on the root program. With `--help`, hasHelpOrVersion(argv) makes shouldRegisterPrimaryOnly false (register.subclis.ts:19-21) and shouldRegisterCorePrimaryOnly [...]"
- Corrected statement / recommendation: Anchor should read register.subclis.ts:278 (not :273). Implementation note for the recommendation: the placeholders exist precisely so the real modules are not imported on the help path, so 'single source of truth' has to mean the registry string is the source and each registrar imports it (or a light shared constants module), not the reverse; otherwise the lazy-load perf win (register.subclis.ts:15-27) is lost. The '--dev example' and 'tagline' parts of this recommendation are assessed under 3.7-3.8-25 and 3.7-3.8-21. (reproducer adds: Minor anchor drift only: the sub-CLI placeholder description is at register.subclis.ts:278, not :273. Recommendation holds; [...])

#### 3.7-3.8-19

- Verdict: claim **partially-confirmed**; recommendation **needs-change**. Weight: medium. Anchor: `src/cli/program/register.subclis.ts:34-250; src/cli/program/command-registry.ts:19,154`
- Original claim: src/cli/program/register.subclis.ts:34-250 registers 42 visible top-level commands in a flat alphabetical list with only 2 hidden; a `hidden` option exists for core commands in command-registry.ts:19,154 but the SubCliEntry type has no `hidden` field.
- Original recommendation: Add `hidden` to SubCliEntry; hide acp, checkpoints, heartbeat, system, hooks, webhooks, dns, daemon, `gateway call`; BITTERBOT_SHOW_DEV_COMMANDS=1; grouped help text. | Serves as the inventory baseline for the SHIP / SHIP-ADVANCED / HIDE / REMOVE verdicts in section 2.3. [...]
- What the verifiers found: (skeptic: partially-confirmed / needs-change) "Recounted myself. src/cli/program/register.subclis.ts:34-250 holds only 26 SubCliEntry objects (acp, gateway, daemon, logs, system, models, approvals, nodes, devices, node, sandbox, dns, docs, hooks, heartbeat, webhooks, pairing, plugins, channels, directory, security, skills, update, completion, cron, checkpoints). [...]" (reproducer: confirmed / sound) "Re-derived the counts from source. src/cli/program/register.subclis.ts:34-250 `const entries: SubCliEntry[]` has 26 names (grep '^ name: "' count = 26: acp gateway daemon logs system models approvals n [...]"
- Corrected statement / recommendation: Claim: 'register.subclis.ts registers 26 lazy sub-CLIs and command-registry.ts registers 18 core commands (2 hidden); together 42 visible top-level commands.' Recommendation caveats: (1) a `hidden` flag on SubCliEntry only affects the lazy placeholder; under BITTERBOT_DISABLE_LAZY_SUBCOMMANDS (register.subclis.ts:25-27, :289-293) and in completion-cli.ts:246-257 the real registrars run directly, so the hidden flag must also be applied inside each registrar (e.g. acp-cli.ts:9, daemon-cli/register.ts:8) or it silently leaks in those paths. [...] (reproducer adds: Claim is accurate as stated; only the appendix figure '45 top-level commands' (doc line 963) should read 44 (42 visible + 2 hidden). [...])

#### 3.7-3.8-20

- Verdict: claim **partially-confirmed**; recommendation **needs-change**. Weight: high. Anchor: `src/commands/doctor.ts:334-400; src/commands/doctor-economy.ts:218,232; README.md`
- Original claim: `bitterbot doctor` (src/commands/doctor.ts:334-400, src/commands/doctor-economy.ts:218,232) runs 17 sections unconditionally, including Economy output such as "Forage Night Shift is enabled (default) but the node has no wallet credentials" and "A2A payment gate off", plus P2P Identity, Canvas, Liveness and Task spine sections, while README tells new users to run `doctor` first.
- Original recommendation: Gate Economy/Wallet/P2P Identity/Canvas/Liveness/Task-spine behind --deep or their `enabled` flag. | Put `doctor` economy/wallet/forage sections behind `--deep`. | Trim doctor output for fresh installs so it does not surface economy/wallet/P2P posture by default.
- What the verifiers found: (skeptic: partially-confirmed / needs-change) "Anchors hold: src/commands/doctor-economy.ts:218 = `info("A2A payment gate off (no wallet credentials, not explicitly enabled).")`, :232-237 = Forage Night Shift enabled-by-default info line; src/commands/doctor.ts:334-399 has 16 `// ──` section markers (P2P Network, P2P Identity, Skills, Agent runtime, Memory, Post-Q1 subsystems, Retrieval, Economy, Liveness, Task spine, Model check, Agent turn pr [...]" (reproducer agrees: partially-confirmed / needs-change) "src/commands/doctor.ts is 478 lines; top-level section calls grep'd: runRuntimeChecks:157, runSecurityChecks:23 [...]"
- Corrected statement / recommendation: Corrected statement: doctor prints roughly 30 checks (16 section blocks in doctor.ts:334-399 plus earlier ones); Identity/Canvas/Wallet are already gated by their `enabled` flags but those default ON; Economy, Liveness and Task-spine are ungated; economy lines are info-level and do not affect exit code. Recommendation needs change: `--deep` already exists with a different meaning ('Scan system services for extra gateway installs', register.maintenance.ts:27, docs/cli/doctor.md:23) - overloading it would silently change behaviour for existing users and the [...]

#### 3.7-3.8-21

- Verdict: claim **partially-confirmed**; recommendation **needs-change**. Weight: high. Anchor: `src/cli/tagline.ts:27; src/cli/banner.ts:121`
- Original claim: src/cli/tagline.ts:27 holds roughly 90 joke taglines (e.g. "Ah, the fruit tree company!", "Santa's little claw-sistant", "Greetings, Professor Falken") and src/cli/banner.ts:121 prints a random one on every TTY invocation of the CLI.
- Original recommendation: Fixed DEFAULT_TAGLINE; commit hash behind --verbose. | REMOVE the random tagline banner; use `DEFAULT_TAGLINE`.
- What the verifiers found: (skeptic: partially-confirmed / needs-change) "TAGLINES array starts at src/cli/tagline.ts:25 (not :27). Counted with node: 80 string literals plus 10 HOLIDAY_TAGLINES refs (:110-119) = 90 entries, so 'roughly 90' holds. Quoted examples exist: 'Ah, the fruit tree company!' :92, 'Greetings, Professor Falken' :93; [...]" (reproducer agrees: partially-confirmed / needs-change) "src/cli/tagline.ts:27 is `const TAGLINES: string[] = [` (sed 20-30 confirms). [...]"
- Corrected statement / recommendation: Claim: 'tagline.ts:25-120 holds 90 taglines (80 everyday + 10 date-gated holiday ones); banner.ts:40/:110 prints a random one on TTY invocations except --json/--version/update/completion/BITTERBOT_HIDE_BANNER.' Recommendation: switching to the existing DEFAULT_TAGLINE is a one-line change (make activeTaglines return [DEFAULT_TAGLINE]) and is sound, but the dead holiday/index machinery (HOLIDAY_RULES, BITTERBOT_TAGLINE_INDEX) should be deleted rather than left wired-but-dead. [...]

#### 3.7-3.8-22

- Verdict: claim **partially-confirmed**; recommendation **needs-change**. Weight: high. Anchor: `src/cli/config-cli.ts:283; src/cli/program/register.configure.ts:13; src/cli/program/register.setup.ts:32-44; src/cli/program/register.onboard.ts:49`
- Original claim: Four CLI entry points launch the same onboarding wizard: `onboard` (src/cli/program/register.onboard.ts:49), `configure` (register.configure.ts:13), `config` (src/cli/config-cli.ts:283) and `setup --wizard` (register.setup.ts:32-44).
- Original recommendation: Keep onboard + configure; `config` prints help; hide `setup`. | `config` with no subcommand should print help, not the wizard. | Hide `setup` (4 entry points to one wizard). | Consolidate wizard entry points to one happy-path command.
- What the verifiers found: (reproducer: partially-confirmed / needs-change) "Four entry points exist at the cited spots, reproduced: register.onboard.ts:48-50 `.command("onboard")`; register.configure.ts:13 `.command("configure")`; src/cli/config-cli.ts:281-298 `.command("config")` with a no-subcommand `.action` at :295-298; register.setup.ts:32-44 `if (opts.wizard || hasWizardFlags) await onboardCommand(...)`. But they do NOT all launch the same wizard. [...]" (skeptic agrees: partially-confirmed / needs-change) "Anchors are correct: register.onboard.ts:49 `.command("onboard")`, register.configure.ts:13 `.command("configur [...]"
- Corrected statement / recommendation: Corrected statement: four entry points fan into TWO wizards, not one: `onboard` and `setup --wizard` run the onboarding wizard (runOnboardingWizard); `configure` and bare `config` run the configure wizard (runConfigureWizard). Corrected recommendation: the consolidation target is 2->1 per wizard, not 4->1. Hiding `setup` (onboarding duplicate) and making bare `config` print help (configure duplicate) is still the right pair of moves, but the docs/cli/config.md:10-11 sentence and config-cli.ts:284 description ('Run without subcommand for the wizard') must [...]

#### 3.7-3.8-23

- Verdict: claim **partially-confirmed**; recommendation **needs-change**. Weight: high. Anchor: `docs/cli/index.md:916; docs/cli/tui.md; docs/cli/voicecall.md; docs/cli/gateway.md:167; src/cli/program/register.subclis.ts`
- Original claim: docs/cli/index.md:916, docs/cli/tui.md, docs/cli/voicecall.md and docs/cli/gateway.md:167 document commands that do not exist in the CLI (`tui`, `voicecall`, `gateway discover`, `cron rm/enable/disable`) and omit commands that do exist (`checkpoints`, `completion`, `gateway usage-cost`, `skills import/incoming`, `cron runs`); the `--skip-ui` help text mentions a TUI.
- Original recommendation: Delete/fix pages; generate index.md command tree from program.commands in CI. | Add missing `checkpoints`, `completion` doc pages or hide those commands. | Document or hide these commands so the docs match the command tree. | REMOVE those commands from docs. [...]
- What the verifiers found: (skeptic: partially-confirmed / needs-change) "CONFIRMED parts: (a) `tui` has no implementation anywhere: `ls src | grep -i tui` empty, no `pi-tui` import in src (only a dangling dep in package.json:161 and a dead `"tui": "node scripts/run-node.mjs tui"` script at package.json:142 that run-node.mjs never handles), yet docs/cli/tui.md + docs/web/tui.md exist and docs.json:1133/1136 lists cli/tui and cli/voicecall. [...]" (reproducer agrees: partially-confirmed / needs-change) "Reproduced the command tree from src/cli/program/register.subclis.ts (entry names at lines 36-243: acp, gateway [...]"
- Corrected statement / recommendation: Corrected claim: docs list four commands that do not exist (`tui`, `voicecall`, `gateway discover`, `cron rm/enable/disable`; `cron remove` exists with no aliases, enable/disable are `cron edit` flags) and omit `completion` and `gateway usage-cost`; `checkpoints` is documented under docs/tools (not docs/cli) and `skills import/incoming` and `cron runs` are already in docs/cli/index.md. [...]

#### 3.7-3.8-24

- Verdict: claim **confirmed**; recommendation **needs-change**. Weight: medium. Anchor: `src/cli/program/register.subclis.ts:53; scripts/write-cli-compat.ts:58-70`
- Original claim: src/cli/program/register.subclis.ts:53 registers a `daemon` legacy alias duplicating the `gateway` service commands, and the build step scripts/write-cli-compat.ts:58-70 writes a "Legacy shim for pre-tsdown update-cli imports" containing "Please upgrade Bitterbot" stubs.
- Original recommendation: Remove alias, shim, and build step. | Delete `scripts/write-cli-compat.ts` shim; treat `daemon` as legacy alias. | Remove the legacy daemon alias and the build-time compat shim.
- What the verifiers found: (skeptic: confirmed / needs-change) "src/cli/program/register.subclis.ts:51-58 registers `{ name: "daemon", description: "Gateway service (legacy alias)" }` importing ../daemon-cli.js; src/cli/daemon-cli/register.ts:6-19 builds the `daemon` command by calling the same `addGatewayServiceCommands()` that src/cli/gateway-cli/register.ts:11 uses, so the duplication is real. [...]" (reproducer: confirmed / sound) "src/cli/program/register.subclis.ts:51-58 `{ name: "daemon", description: "Gateway service (legacy alias)", register: ... import("../daemon-cli.js") ... [...]"
- Corrected statement / recommendation: Claim stands. Recommendation: deleting scripts/write-cli-compat.ts + the build step is safe (also delete src/cli/daemon-cli-compat.ts and its test; keep src/cli/daemon-cli.ts since gateway-cli/register.ts and update-command.ts import it). But the merged text is self-contradictory ("remove alias" vs "treat daemon as legacy alias"): if the `daemon` alias is removed, scripts/restart-mac.sh:220-221 must be updated to `gateway install/restart` (or deleted, as item 24 separately proposes) in the same commit; [...] (reproducer adds: Minor anchor drift only: the alias object spans register.subclis.ts:51-58 (not just :53); the shim's 'Please upgrade' text is at write-cli-compat.ts:55 with stubs at :61-64 and the header at :68. [...])

#### 3.7-3.8-25

- Verdict: claim **partially-confirmed**; recommendation **needs-change**. Weight: medium. Anchor: `src/cli/program/help.ts:21,45-48; src/cli/gateway-cli/run.ts:339-355`
- Original claim: src/cli/program/help.ts:21,45-48 shows a `--dev` flag and a `--dev gateway` example in top-level help (dev mode is banned by project rule), and src/cli/gateway-cli/run.ts:339-355 leaves `--reset`, `--claude-cli-logs`, `--ws-log`, `--raw-stream*` and `--allow-unconfigured` visible in help.
- Original recommendation: hideHelp() on those flags; happy-path examples (onboard, dashboard, doctor, channels add, update); drop the --dev gateway example. | `gateway call`, `usage-cost`, `--claude-cli-logs`, `--ws-log`, `--raw-stream*`, `--allow-unconfigured` get `hideHelp()`. | HIDE `--dev` via `hideHelp()`; [...]
- What the verifiers found: (skeptic: partially-confirmed / needs-change) "help.ts: the `--dev gateway` example is at :20 (not :21); the global `--dev` option is at :38-41 (:45-48 is actually `--profile` :42-45 and `--no-color` :47). gateway-cli/run.ts: `--dev` :339, `--reset` :340-344, `--claude-cli-logs` :347-351, `--ws-log` :352, `--raw-stream` :354, `--raw-stream-path` :355 are inside the cited range; `--allow-unconfigured` is at :334-338, outside it. [...]" (reproducer: confirmed / sound) "help.ts:20 is the example `["bitterbot --dev gateway", "Run a dev Gateway (isolated state/config) on ws://127.0.0.1:19001."]` (claim says :21; off by one). [...]"
- Corrected statement / recommendation: Anchors: help.ts:20 (example) and :38-41 (option); run.ts:334-355. Replace 'banned by project rule' with 'discouraged for local dev (stale ~/.bitterbot-dev token), still documented and scripted'. Recommendation: replacing the examples with onboard/dashboard/doctor/channels add/update is sound. Hiding `--dev`, `--allow-unconfigured` and `gateway call` via hideHelp without touching the docs that teach them creates help/docs drift; either decide --dev is deprecated (remove it plus tui:dev and the three docs references) or keep it visible. [...] (reproducer adds: Anchors drift: the --dev option is help.ts:38-41 and the example is help.ts:20; --allow-unconfigured is run.ts:333-337 (just outside the cited 339-355 range). Substance is accurate. [...])

#### 3.7-3.8-26

- Verdict: claim **partially-confirmed**; recommendation **needs-change**. Weight: medium. Anchor: `src/cli/skills-cli.ts:139; src/cli/memory-cli.ts:660`
- Original claim: src/cli/skills-cli.ts:139 exposes `skills incoming` (a quarantine flow with audit findings F6/F15/F16 still open) and src/cli/memory-cli.ts:660 exposes `memory backfill-embeddings`, an internal migration with the jargon description "fact\_\*, notes, briefs", both as visible user commands.
- Original recommendation: Move to a dev namespace; run backfill from `doctor --repair`. | Move `skills incoming`/`import` and `memory backfill-embeddings` to a dev namespace.
- What the verifiers found: (reproducer: partially-confirmed / needs-change) "src/cli/skills-cli.ts:138-140 `const incoming = skills.command("incoming").description("Review quarantined skills (P2P and imported)")` with list/accept/reject at :142-200; `import agentskills` at :83-90. No `hidden`/`hideHelp` anywhere in skills-cli.ts (grep = 0). [...]" (skeptic agrees: partially-confirmed / needs-change) "src/cli/skills-cli.ts:139-141 registers `skills incoming` ("Review quarantined skills (P2P and imported)") with [...]"
- Corrected statement / recommendation: Corrected statement: `skills incoming` is a visible, undocumented quarantine-review command whose audit findings F6 and F16 were FIXED on 2026-08-09; only F15 (self-loopback guard, low value) is still open. `memory backfill-embeddings` is visible with jargon description but is documented in docs/cli/memory.md and the gateway already auto-runs a bounded backfill every sync cycle. Recommendation: rewording the backfill description (or hiding it) is reasonable; [...]

#### 3.7-3.8-27

- Verdict: claim **confirmed**; recommendation **needs-change**. Weight: medium. Anchor: `src/cli/browser-cli.ts:21`
- Original claim: src/cli/browser-cli.ts:21 registers roughly 60 browser-automation leaf commands at the `browser` level (e.g. scrollintoview, waitfordownload, responsebody, cookies set, set geo), several in non-kebab-case naming.
- Original recommendation: Hide from root help; rename to kebab-case. | SHIP-ADVANCED: hide `browser` from root help; kebab-case leaves.
- What the verifiers found: (skeptic: confirmed / needs-change) "src/cli/browser-cli.ts:19-21 `registerBrowserCli` → `program.command("browser")`, no `hidden` option anywhere in src/cli/browser-cli*.ts or src/cli/browser-cli-actions-input/ (grep empty). Leaf recount by `.action(` per file: manage 15, extension 2, inspect 2, observe 3, debug 5, state 9, cookies-storage 3 + storage loop (local/session × get/set/clear = 6, src/cli/browser-cli-state.cookies-storage. [...]" (reproducer: confirmed / sound) "src/cli/browser-cli.ts:19-21 `export function registerBrowserCli(program: Command) { const browser = program.command("browser")` then :51-57 calls seven register* helpers. [...]"
- Corrected statement / recommendation: Claim stands. Recommendation: hiding `browser` from root help is fine, but renaming leaves to kebab-case without keeping the old names as aliases breaks documented invocations in docs/tools/browser.md:398-413 (and any agent skill text that copies them); add `.alias()` for the old spellings or update the docs in the same commit. (reproducer adds: Precision: 57 leaf commands (63 `.command()` registrations minus the `browser` root and 5 group parents), ~45 of them direct children of `browser`; [...])

#### 3.7-3.8-28

- Verdict: claim **partially-confirmed**; recommendation **needs-change**. Weight: medium. Anchor: `bitterbot.mjs:50; README.md:43-44`
- Original claim: bitterbot.mjs:50 (the package `bin`) requires a prior `pnpm build` to exist, and README.md:43-44 never shows `npm i -g` or `pnpm link`, so a fresh clone gets "bitterbot: command not found" unless commands are prefixed with `pnpm`.
- Original recommendation: Pick one install story (D1); bitterbot.mjs prints a one-line "run pnpm build" hint.
- What the verifiers found: (reproducer: partially-confirmed / needs-change) "package.json:32-34 `"bin": { "bitterbot": "bitterbot.mjs" }`. bitterbot.mjs:48-54: tries `./dist/entry.js` then `./dist/entry.mjs` and otherwise `throw new Error("bitterbot: missing dist/entry.(m)js (build output).")` - so the bin does need a prior build, but the failure is at :53 (claim says :50) and it already prints a hint naming the build output (just not the literal `pnpm build`). [...]" (skeptic agrees: partially-confirmed / needs-change) "bitterbot.mjs:48-54: `tryImport("./dist/entry.js")` / `entry.mjs` else `throw new Error("bitterbot: missing dis [...]"
- Corrected statement / recommendation: Corrected statement: bitterbot.mjs:53 (not :50) already throws `bitterbot: missing dist/entry.(m)js (build output).`; the real inconsistency is that README mixes `pnpm bitterbot ...` (auto-builds via scripts/run-node.mjs) with bare `bitterbot ...` (:379,:384,:435) and docs/index.md:100, docs/platforms/linux.md:19, docs/start/setup.md:71 instruct `npm install -g bitterbot@latest` for a package that does not exist on npm (404). [...]

### 3.9 Docs

20 item(s) changed in this section (of 23 verified).

#### 3.9-01

- Verdict: claim **partially-confirmed**; recommendation **needs-change**. Weight: critical. Anchor: `docs/docs.json`
- Original claim: docs/docs.json contains 463 navigation entries, of which 270 reference pages with no corresponding file on disk (en: 21 install/_, 6 help/_, 8 nodes/_, 5 experiments/_, plus concepts/features, concepts/sessions, start/bitterbot, start/lore, providers/litellm, security/formal-verification, reference/credits, templates/IDENTITY|USER; zh-Hans 219; [...]
- Original recommendation: Delete language blocks and Install tab (or repoint to real pages); drop dead groups; extend link audit to walk nav and run in CI. | Prune docs.json so nav only lists pages that exist; prerequisite to D9 deploy. | Cut the heritage nav down to pages that exist and are true; [...]
- What the verifiers found: (skeptic: partially-confirmed / needs-change) "Recounted with node over docs/docs.json navigation: 463 entries total, 270 with no docs/<page>.md|.mdx on disk. Per-prefix missing: install 20 (NOT 21: 19 in the Install tab + install/node in another group; `grep -o '"install/[^"]*"' docs/docs.json | sort -u` = 20 unique, none duplicated), help 6, nodes 8, experiments 5, concepts 2 (features, sessions), start 2 (bitterbot, lore), providers/litellm, [...]" (reproducer agrees: partially-confirmed / needs-change) "Re-derived from scratch with a node walker over docs/docs.json navigation (languages/tabs/groups/pages), checki [...]"
- Corrected statement / recommendation: Corrected statement: 463 nav entries, 270 missing, English breakdown is 20 install/_ (not 21); ~38 of the 48 English phantoms are covered by docs.json redirects (install/_, nodes/_, help/_, litellm, start/bitterbot, formal-verification, concepts/sessions) so they redirect rather than 404; redirect target /start is itself missing. Corrected recommendation: still prune docs.json and remove the zh-Hans/ja blocks, but (a) 'run in CI' is already done via check:docs (ci.yml:83); [...]

#### 3.9-02

- Verdict: claim **partially-confirmed**; recommendation **needs-change**. Weight: high. Anchor: `src/daemon-cli/status.print.ts:316`
- Original claim: The CLI prints docs.bitterbot.ai/troubleshooting at src/daemon-cli/status.print.ts:316 and a /start/faq link at openai-codex-oauth.ts:53, and both URLs redirect to pages that do not exist in docs/.
- Original recommendation: Create or repoint troubleshooting/faq pages.
- What the verifiers found: (reproducer: partially-confirmed / needs-change) "String located at src/cli/daemon-cli/status.print.ts:316 (claim's path `src/daemon-cli/` is missing the `cli/` segment): `defaultRuntime.log(`${label("Troubleshooting:")} https://docs.bitterbot.ai/troubleshooting`)`. The same URL is also printed from src/commands/status.command.ts:619 and src/commands/status-all/diagnosis.ts:245 (claim omits these two). [...]" (skeptic agrees: partially-confirmed / needs-change) "Strings confirmed: src/cli/daemon-cli/status.print.ts:316 (`https://docs.bitterbot.ai/troubleshooting`; [...]"
- Corrected statement / recommendation: Corrected claim: /start/faq redirects (two hops) to /help, which has no page; /troubleshooting redirects two hops to /gateway/troubleshooting, which DOES exist in docs/ (whether it renders depends on Mintlify following chained redirects; the single-hop target docs/help/troubleshooting.md is missing). In practice both are dead because docs.bitterbot.ai does not resolve. [...]

#### 3.9-03

- Verdict: claim **partially-confirmed**; recommendation **needs-change**. Weight: high. Anchor: `scripts/docs-link-audit.mjs:48`
- Original claim: scripts/docs-link-audit.mjs only checks redirects, never reads the docs.json navigation array, does not resolve <img src>, passes reporting 1233 links while nav/images are broken, and is not run in CI.
- Original recommendation: Assert nav pages and redirect destinations exist; resolve images; keep in check:docs and run in CI. | Extend the docs check to validate docs.json nav entries and image assets.
- What the verifiers found: (reproducer: partially-confirmed / needs-change) "Read scripts/docs-link-audit.mjs in full (530 lines). Confirmed: it loads docs.json only via loadRedirects() (lines 90-131, reads cfg.redirects) and `grep -n navigation` over the script returns nothing -- the navigation array is never read. Ran `node scripts/docs-link-audit.mjs -v`: 'Auditing 277 doc files (4848 tracked total). Redirects: 168 ... [...]" (skeptic agrees: partially-confirmed / needs-change) "Confirmed parts: scripts/docs-link-audit.mjs reads docs.json only in loadRedirects() (lines 90-131, `cfg.redire [...]"
- Corrected statement / recommendation: Statement: the script never reads the navigation array (true) and passes at 1233 links (true), but it IS run in CI (ci.yml:83 via `pnpm check:docs`) and it DOES extract and resolve <img src> / markdown images. The images slip through because the `docs/**/*.md` pathspec at line 47 skips the four top-level docs/\*.md files, so docs/index.md (with 3 missing images) is never scanned. [...]

#### 3.9-04

- Verdict: claim **partially-confirmed**; recommendation **needs-change**. Weight: medium. Anchor: `https://mintlify.com/docs`
- Original claim: Mintlify does not refuse to build when docs.json nav entries point to missing files; it renders those nav entries as 404 pages.
- Original recommendation: Severity downgraded from critical to high (partial verdict).
- What the verifiers found: (skeptic: partially-confirmed / needs-change) "Fetched https://www.mintlify.com/docs/llms-full.txt (1.5 MB, today). Supporting the 404 half: internationalization FAQ (source https://www.mintlify.com/docs/guides/internationalization): 'If you navigate to a translated URL that doesn't exist, you'll see a 404. To avoid this, either only include translated pages in your language-specific navigation or maintain parity...'. [...]" (reproducer: partially-confirmed / sound) "Checked Mintlify primary docs. https://www.mintlify.com/docs/cli/commands: `mint validate` -- 'Validate your documentation build in strict mode. [...]"
- Corrected statement / recommendation: Corrected statement: Mintlify documents missing nav file paths as a cause of FAILED preview deployments and `mint validate` exits non-zero on any warning; the only documented '404 instead of failure' case is the internationalization FAQ. So 'does not refuse to build' is not established; at best the production build may tolerate it while previews/strict validation do not. Corrected recommendation: do not downgrade on that premise; [...] (reproducer adds: Statement should read: Mintlify documents no deploy-time refusal for navigation entries whose files are missing; [...])

#### 3.9-06 **REFUTED**

- Verdict: claim **refuted**; recommendation **needs-change** (tiebreak). Weight: medium. Anchor: `src/commerce/wallet-service.ts:331`
- Original claim: wallet-service.ts line 331 throws 'Token swaps ... not yet implemented' while the wallet tool advertises a trade capability.
- Original recommendation: Move economy audit out of public docs tree.
- What the verifiers found: (skeptic: refuted / needs-change) "No src/commerce/wallet-service.ts exists; the file is src/services/wallet-service.ts. `grep -rn "Token swaps" src` returns nothing. `git log -S"Token swaps"` shows the string existed at the initial commit and was removed in a5db7bf (2026-06-10, 'feat(economy): close the skills-economy loop ... and the always-throwing wallet trade action'); [...]" (tiebreak: refuted / needs-change) "Independently checked at HEAD c5e1f97. (1) Anchor path is wrong: `find src -name wallet-service.ts` -> only src/services/wallet-service.ts; src/commerce/ has no wallet-service.ts. (2) The throw is gone: `grep -rn "Token swaps" src extensions` returns nothing; [...]"
- Corrected statement / recommendation: Corrected statement: there is no swap stub or trade action in the current wallet code. The `Token swaps ... not yet implemented` throw and the wallet tool's `trade` action were both removed in a5db7bf (2026-06-10), the day after the economy audit that reported them. The v1 audit row at docs/reviews/v1-release-audit-2026-08-21.md:370 quotes that June finding as if it were a live example; it should be flagged as stale (fixed) or replaced with a currently-open example such as the wired-but-dead audit's 17 HIGH unfixed findings. [...]

#### 3.9-07

- Verdict: claim **partially-confirmed**; recommendation **needs-change**. Weight: critical. Anchor: `src/terminal/links.ts:5`
- Original claim: DNS resolution of docs.bitterbot.ai returns ENOTFOUND (the host does not resolve), while 81 source files plus the agent system prompt (src/terminal/links.ts:5, src/commands/docs.ts:8, src/agents/system-prompt.ts:648) link to it.
- Original recommendation: D9: deploy docs after the prune, or repoint formatDocsLink at GitHub blob URLs and make `bitterbot docs` search local docs/. | D9: deploy Mintlify to docs.bitterbot.ai after the nav prune, rather than repointing formatDocsLink at the GitHub docs/ tree. [...]
- What the verifiers found: (skeptic: partially-confirmed / needs-change) "DNS part CONFIRMED externally: Cloudflare DoH and Google DoH both return Status 3 (NXDOMAIN) for docs.bitterbot.ai A and CNAME today; bitterbot.ai itself resolves (34.111.179.208, NS logan/ruth.ns.cloudflare.com) so the apex zone is live at Cloudflare and simply has no `docs` record; local getent exit=2 and curl `Could not resolve host`. [...]" (reproducer agrees: partially-confirmed / needs-change) "DNS reproduced three ways: `getent hosts docs.bitterbot.ai` exit 2; [...]"
- Corrected statement / recommendation: Corrected claim: docs.bitterbot.ai is NXDOMAIN (confirmed), but formatDocsLink/DOCS_ROOT was already repointed at the GitHub docs/ tree in commit 007db0a, so most of the ~60-64 source files that mention docs.bitterbot.ai only show it as a link label whose href is GitHub. The true dead surfaces are the raw strings (status.print.ts:316, openai-codex-oauth.ts:53, system-prompt.ts:648, docs.ts:8 MCP search endpoint) and the 6 docs/ pages that mention the host. Corrected recommendation: the 'repoint formatDocsLink' half of D9 is already-done; [...]

#### 3.9-08

- Verdict: claim **partially-confirmed**; recommendation **sound**. Weight: high. Anchor: `docs/index.md:24`
- Original claim: docs/index.md (lines 24,27,47,100,114,125) contains 'EXFOLIATE! EXFOLIATE!', describes a 'gateway for AI agents across WhatsApp, Telegram, Discord, iMessage', mentions 'AI coding agents like Pi', `npm install -g`, UI at :19001, a 'bundled Pi binary', two missing images, and has zero mention of memory/dreams/circles/wallet.
- Original recommendation: Replace with a landing page derived from README's first 40 lines; use docs/public/bitterbot-title-\*.svg. | Rewrite docs/index.md to describe Bitterbot. | Rewrite docs/index.md and install/quick-start to match README.
- What the verifiers found: (skeptic: partially-confirmed / sound) "cat -n docs/index.md: line 25 `> _"EXFOLIATE! EXFOLIATE!"_, A bot, probably`; line 28 `Any OS gateway for AI agents across WhatsApp, Telegram, Discord, iMessage, and more`; line 46 `to AI coding agents like Pi`; line 100 `npm install -g bitterbot@latest`; lines 111/122 port 19001; line 126 `<img src="whatsapp-bitterbot.jpg"`; line 133 `bundled Pi binary in RPC mode`. [...]" (reproducer agrees: partially-confirmed / sound) "Reproduced with `grep -n` on docs/index.md (191 lines): line 25 `> _"EXFOLIATE! EXFOLIATE!"_, A bot, probably`; [...]"
- Corrected statement / recommendation: docs/index.md line refs should be 25, 28, 46, 100, 111/122, 126, 133; it references three missing image files (two logo variants + whatsapp-bitterbot.jpg); it mentions 'memory' once generically (line 54) and never dreams/circles/wallet. Recommendation stands but should also rewrite docs.json:4 `description` (same fork text), and keep Pi references accurate rather than deleting them (Pi is the real embedded agent runtime).

#### 3.9-09

- Verdict: claim **partially-confirmed**; recommendation **sound**. Weight: high. Anchor: `docs/web/dashboard.md:10`
- Original claim: docs/web/dashboard.md:10,15, docs/web/control-ui.md:10, docs/start/getting-started.md:14,71 and docs/start/hubs.md:24 give five contradictory Control UI access stories (served at /, :5173 via pnpm dev, :19001, 'Vite + Lit', pnpm gateway:watch), whereas the UI is Vite + React.
- Original recommendation: One access story (D5 outcome); say 'Vite + React'; dev-mode commands to CONTRIBUTING only. | Correct the stale heritage statements (mode count, UI framework, ports) during the docs cut-down.
- What the verifiers found: (reproducer: partially-confirmed / sound) "Reproduced all five stories, with line-number drift: docs/web/dashboard.md:10-11 'browser Control UI served at `/` by default'; dashboard.md:15 'http://localhost:5173 (start gateway + cd desktop && pnpm dev)'; docs/web/control-ui.md:11 (claim says :10) 'small **Vite + Lit** single-page app served by the Gateway' and :13 'default: http://localhost:5173 (Vite Control UI)' (self-contradiction within 3 [...]" (skeptic agrees: partially-confirmed / sound) "All five statements exist, but two line numbers are wrong and the count is inflated. [...]"
- Corrected statement / recommendation: Line refs are off: control-ui.md 'Vite + Lit' is line 11 (not 10); getting-started.md's pnpm gateway:watch / pnpm dev / 5173 block is at lines 84-90 (line 71 is `</Steps>`). Contradictions are real and broader than listed: add docs/web/index.md:11,13 (second 'Vite + Lit' + 5173), docs/index.md:122 and docs/platforms/linux.md:22 (19001), docs/concepts/architecture.md:19,215,225 (5173). Recommendation is sound; the fix list should include these extra files.

#### 3.9-10

- Verdict: claim **partially-confirmed**; recommendation **needs-change**. Weight: high. Anchor: `src/wizard/onboarding.ts`
- Original claim: docs/start/wizard.md:60 and docs/reference/wizard.md document a step order and channels (Google Chat, Mattermost) that do not match src/wizard/onboarding.ts, whose real order is auth -> embeddings -> web search -> gateway -> P2P -> channels -> skills -> genome -> wallet -> hooks -> control-ui env -> finalize.
- Original recommendation: Rewrite from the real flow; collapse three wizard reference pages into one generated from register.onboard.ts.
- What the verifiers found: (reproducer: partially-confirmed / needs-change) "Docs side reproduced: docs/start/wizard.md:62-69 lists `1. Model/Auth 2. Workspace 3. Gateway 4. Channels, WhatsApp, Telegram, Discord, Google Chat, Mattermost, or Signal 5. Daemon 6. Health check 7. Skills` (last commit 2026-03-28 33f9833); [...]" (skeptic agrees: partially-confirmed / needs-change) "docs/start/wizard.md:63-71 lists 7 steps (Model/Auth, Workspace, Gateway, Channels, Daemon, Health check, Skill [...]"
- Corrected statement / recommendation: Corrected statement: the real local-mode order is mode select -> workspace -> auth/model -> embeddings -> web search -> gateway -> P2P -> channels -> skills -> genome -> wallet -> hooks -> finalize (daemon install -> health check -> control-ui env -> completion); docs/start/wizard.md is the stale one (2026-03-28), docs/reference/wizard.md already has Wallet but misses embeddings/web search/P2P/genome, and both list Google Chat/Mattermost which have no channel plugin. [...]

#### 3.9-12

- Verdict: claim **confirmed**; recommendation **needs-change**. Weight: medium. Anchor: `src/config/zod-schema.core.ts:359`
- Original claim: Config residue for the non-existent channels remains at src/config/schema.labels.ts:210,214,261-265, src/config/zod-schema.core.ts:359-364, plugin-auto-enable.ts:108-120,209 and group-mentions.ts:200,211.
- Original recommendation: Remove config residue for Google Chat/MS Teams/IRC/Matrix/Mattermost. | Drop irc/mattermost/msteams/googlechat residue from labels, queue keys, auto-enable. | Drop the irc/googlechat/msteams branches.
- What the verifiers found: (skeptic: confirmed / needs-change) "src/config/schema.labels.ts:210 '"channels.mattermost": "Mattermost"', :214 '"channels.msteams": "MS Teams"', :261-265 five channels.mattermost._ labels. src/config/zod-schema.core.ts:355-368 queue byChannel object: irc (359), mattermost (361), imessage (363), msteams (364), with `.strict()` at 367. [...]" (reproducer: confirmed / sound) "Reproduced each location. src/config/schema.labels.ts:210 `"channels.mattermost": "Mattermost"`, :214 `"channels.msteams": "MS Teams"`, :261-265 five `channels.mattermost._` labels. [...]"
- Corrected statement / recommendation: Removal is mostly safe, with one trap: the queue-mode object at zod-schema.core.ts:355-368 is `.strict()`, so dropping the irc/mattermost/msteams keys would make any existing user config carrying messages.queue.byChannel.irc|mattermost|msteams fail validation. Pair that removal with a legacy migration/strip rule (pattern in src/config/legacy.rules.ts / legacy.migrations.part-1.ts) or leave those queue keys in place. Also include the bluebubbles residue (schema.labels.ts:213, zod-schema.providers.ts:32) in the same sweep. (reproducer adds: Premise holds; add zod-schema.core.ts:342 MSTeamsReplyStyleSchema and schema.labels.ts:213 bluebubbles to the residue list. [...])

#### 3.9-13

- Verdict: claim **confirmed**; recommendation **needs-change**. Weight: medium. Anchor: `docs/providers/index.md:14`
- Original claim: docs/providers/index.md:14-22 says 'Highlight: Venice ... Best overall: venice/claude-opus-45' while the README default model is Anthropic Claude Opus 4.8; docs.json:994 links /providers/litellm which has no page.
- Original recommendation: Lead with Anthropic/OpenAI/Google/OpenRouter/Local; long tail under 'Other'; drop Venice highlight; add or drop litellm. | Fix provider docs: remove Venice highlight, add/remove the LiteLLM link, add Gemini page, drop Mattermost mention.
- What the verifiers found: (skeptic: confirmed / needs-change) "docs/providers/index.md:16-22: "## Highlight: Venice (Venice AI) ... Default: `venice/llama-3.3-70b` ... Best overall: `venice/claude-opus-45`" (heading is at :16, the Mattermost mention is at :14). README.md:392: "Recommended: **Anthropic Claude Opus 4.8** (the default)"; [...]" (reproducer: confirmed / sound) "docs/providers/index.md:14 `Looking for chat channel docs (WhatsApp/Telegram/Discord/Slack/Mattermost (plugin)/etc.)`; :16-22 `## Highlight: Venice (Venice AI) ... [...]"
- Corrected statement / recommendation: Claim holds (anchor line is :16 not :14 for the Venice heading). Recommendation adjustments: (1) LiteLLM - add a page rather than drop, since it is a supported auth flow (onboard-auth.config-litellm.ts) and a redirect already exists at docs.json:103; (2) Gemini page can be a thin page that lifts the existing docs/concepts/model-providers.md:79-93 content; (3) Mattermost removal must cover all mentions (docs/reference/wizard.md:81, docs/web/control-ui.md:69, cli docs, configuration-reference), not just providers/index.md; [...]

#### 3.9-14

- Verdict: claim **confirmed**; recommendation **needs-change**. Weight: high. Anchor: `docs/docs.json`
- Original claim: 119 on-disk docs pages are absent from the docs.json nav, including all 16 docs/memory/_ pages, network/circles, circle-gossip, mailbox-host, management-nodes, core-systems (the target of the /network redirect), agents/interceptors_, templates GENOME/MEMORY/PROTOCOLS, plugins/\*, and 11 provider pages; [...]
- Original recommendation: Add 'Memory & Dreams' and 'Circles & Network' groups, interceptors, plugins, GENOME/MEMORY/PROTOCOLS, Ollama/vLLM + 9 providers; exclude plans/reviews/SPECs; add nav-coverage check to link audit. | Add existing memory and circles pages to nav. | Put the memory/circles/wallet pages in nav.
- What the verifiers found: (skeptic: confirmed / needs-change) "Computed on-disk pages (find docs -name '_.md' -o -name '_.mdx' = 313) minus nav set: 120 orphans today, one of which is docs/reviews/v1-release-audit-2026-08-21.md (the audit itself, created 2026-08-21), so 119 at audit time matches. Orphans include all 16 docs/memory/\* pages (architecture-overview ... [...]" (reproducer: confirmed / sound) "Same node walker: 313 .md/.mdx files on disk under docs/; 120 not referenced by any nav entry today -- the 120th is docs/reviews/v1-release-audit-2026-08-21.md (the audit document itself, created after [...]"
- Corrected statement / recommendation: Recommendation adjustment: wallet pages are already in nav (docs.json:1013), drop that item; of the 119 orphans, ~30 are gitignored plans and ~11 are reviews, so the real nav-addition set is ~70 pages (memory 16, network 5, interceptors 4, templates 6 incl. .dev variants, plugins 2, providers 11, plus cli/_, start/_, tools/_, gateway/_ stragglers). 'Exclude plans' is moot (untracked); 'exclude reviews' only works if they are also moved/untracked, since hidden pages remain reachable by URL on Mintlify.

#### 3.9-15

- Verdict: claim **partially-confirmed**; recommendation **needs-change**. Weight: medium. Anchor: `docs/docs.json`
- Original claim: docs.json has no troubleshooting or FAQ page, and its redirects form a loop: /help/faq -> /help and /faq -> /help/faq; README holds the only Bitterbot-specific fixes.
- Original recommendation: Create docs/help/troubleshooting.md from README 'Common fast fixes' plus doctor guidance; short FAQ; delete circular redirects.
- What the verifiers found: (reproducer: partially-confirmed / needs-change) "Missing pages confirmed: `git ls-files docs/help` -> only docs/help/environment.md; docs.json:1193 nav lists `"help/index", "help/troubleshooting", "help/faq"`, none exist; no faq\*.md anywhere in docs (`git ls-files docs | grep -i faq` -> nothing). Redirects: docs.json:371-372 `/faq` -> `/help/faq`; :75-76 `/help/faq` -> `/help`; :131-132 `/help` -> `/help/environment` (exists). [...]" (skeptic agrees: partially-confirmed / needs-change) "docs.json Help tab :1193 `"pages": ["help/index", "help/troubleshooting", "help/faq"]` and :1201 `["help/enviro [...]"
- Corrected statement / recommendation: Corrected statement: docs.json's Help nav points at three nonexistent pages (help/index, help/troubleshooting, help/faq) and there is no FAQ page; /faq -> /help/faq -> /help -> /help/environment is a non-circular 3-hop chain; a Bitterbot-specific troubleshooting runbook already exists at docs/gateway/troubleshooting.md and is reachable via the /help/troubleshooting and /troubleshooting redirects. README's fast fixes are partly unique (desktop/.env, dist/entry, skip flags) but not the only Bitterbot-specific fixes. [...]

#### 3.9-16

- Verdict: claim **partially-confirmed**; recommendation **needs-change**. Weight: medium. Anchor: `docs/gateway/configuration-reference.md:190`
- Original claim: docs/gateway/configuration-reference.md (lines 190,381,486,1387), configuration-examples.md:202,317 and docs/start/personal-assistant.md:10 contain fork residue: `allowFrom: ["1234567890", "steipete"]`, an `### iMessage` section, 'Supported: ... imessage, msteams', and 'gateway for **Pi** agents. Plugins add Mattermost.'; 14 docs pages mention iMessage/Mattermost/Pi.
- Original recommendation: Grep-and-fix pass; retire personal-assistant.md.
- What the verifiers found: (reproducer: partially-confirmed / needs-change) "Reproduced every cited line exactly: docs/gateway/configuration-reference.md:190 `allowFrom: ["1234567890", "steipete"],`; :381 `### iMessage`; :486 `Supported: telegram, whatsapp, discord, slack, signal, imessage, msteams.`; :1387 `discord: ["steipete", "1234567890123"],`; configuration-examples.md:202 `allowFrom: ["steipete"]` and :317 `discord: ["steipete"]`; [...]" (skeptic agrees: partially-confirmed / needs-change) "sed -n: configuration-reference.md:190 `allowFrom: ["1234567890", "steipete"]`, :381 `### iMessage`, :486 `Supp [...]"
- Corrected statement / recommendation: Keep the steipete / msteams / Mattermost fix, but do NOT strip iMessage or Pi references as 'fork residue': iMessage is a registered channel (src/channels/registry.ts) and Pi is the embedded agent runtime the product actually runs on. The page count should read roughly 24 tracked non-zh pages mentioning iMessage/Mattermost (15 Mattermost, 12 msteams), not 14. Retiring personal-assistant.md is cheap because it is already absent from docs.json and unlinked; the rewrite of its line 11 is the alternative. [...]

#### 3.9-17

- Verdict: claim **partially-confirmed**; recommendation **needs-change**. Weight: medium. Anchor: `src/memory/dream-types.ts:12`
- Original claim: Dream mode counts disagree: docs/memory/dream-engine.md:79 says '7 Dream Modes', architecture-overview.md:637 says 'Twelve specialized modes', and src/memory/dream-types.ts:12 defines a 12-member union; README.md:118 lists 5 disabled modes (mutation, research, reconsolidation, interceptor_harvest, harness_evolve) as live and omits the 3 PLAN-40 lanes that actually run.
- Original recommendation: One table generated from dream-types.ts defaults; disabled modes under 'Experimental modes'.
- What the verifiers found: (skeptic: partially-confirmed / needs-change) "docs/memory/dream-engine.md:79 '## 7 Dream Modes' -- confirmed (table lists replay..research, then prose for hygiene). 'architecture-overview.md:637 says Twelve specialized modes' -- REFUTED: docs/memory/architecture-overview.md:637 reads '- [Dream Engine](./dream-engine.md), 7 modes, FSHO selector, ripple replay, emotional triggering'; [...]" (reproducer: partially-confirmed / sound) "docs/memory/dream-engine.md:79 `## 7 Dream Modes` (table :83-91 lists 7: replay, compression, mutation, simulation, extrapolation, exploration, research) - confirmed. [...]"
- Corrected statement / recommendation: Corrected statement: dream-engine.md:79 says 7, README.md:118 says twelve (architecture-overview.md:637 says 7, not twelve), dream-types.ts:12-27 defines 15 modes (5 disabled); README shows 5 disabled modes and omits hygiene/distillation/anticipation, of which only hygiene is enabled on the live node. Corrected recommendation: a table 'generated from dream-types.ts defaults' would itself overclaim (it would list distillation and anticipation as live while both are config-disabled and Lane 1 is parked pending a kill-or-fix call). [...] (reproducer adds: Corrected statement: counts disagree across dream-engine.md:79 ('7'), architecture-overview.md:156/637 ('7'), AGENTS.md:21 and docs/concepts/\* ('7'), README.md:118 ('Twelve'), dream-types.ts:2/11 heade [...])

#### 3.9-18

- Verdict: claim **partially-confirmed**; recommendation **needs-change**. Weight: medium. Anchor: `src/config/types.agent-defaults.ts:300`
- Original claim: docs/plans/PLAN-25-SELF-OPTIMIZING-HARNESS.md:6 states 'LANDED, on by default' while src/config/types.agent-defaults.ts:300 sets harness_evolve: { enabled: false } and the mode has never produced output.
- Original recommendation: Status HOLD; make the two switches agree.
- What the verifiers found: (skeptic: partially-confirmed / needs-change) "Anchor is wrong. src/config/types.agent-defaults.ts:297-300 is: `export type AgentHarnessEvolveConfig = { /** Kill switch for the harness_evolve dream mode (PLAN-25). Default: true. */ enabled?: boolean; };` Line 300 is the closing `};`; grep shows the file mentions harnessEvolve only at :175 and :298, and nowhere contains `harness_evolve: { enabled: false }`. [...]" (reproducer: partially-confirmed / sound) "The doc overclaim is confirmed (PLAN-25...md:6 'LANDED, on by default'). But the anchor is wrong: src/config/types.agent-defaults.ts:297-300 is a type declaration, `export type AgentHarnessEvolveConfig [...]"
- Corrected statement / recommendation: Corrected statement: the `enabled: false` default is at src/memory/dream-types.ts:64 (PLAN-40 hold), not types.agent-defaults.ts:300; types.agent-defaults.ts:298 only documents the separate kill switch as 'Default: true', which is accurate for that switch but misleading about whether the mode runs. Corrected recommendation: do not 'make the two switches agree' by defaulting the kill switch to false -- it adds nothing while the hold is on and would require a second config edit when the hold wakes at 25 completed executions. [...] (reproducer adds: Corrected statement: PLAN-25 doc line 6 says 'LANDED, on by default' while src/memory/dream-types.ts:64 sets harness_evolve enabled:false (authoritative); [...])

#### 3.9-19

- Verdict: claim **partially-confirmed**; recommendation **sound** (tiebreak). Weight: medium. Anchor: `README.md:269`
- Original claim: README.md:269,451 claims 'EigenTrust reputation scoring ensures skill quality', 'Revenue is split 70/20/10', 'Management nodes post bounties', 'Your agent literally dreams about what will sell', while economy-audit findings F7/F10/F11/F14 are open and the x402 -> revenue -> USDC path has never run end to end.
- Original recommendation: One 'Experimental: agent wallet and skill sharing' paragraph stating what works; drop 'The Loop'.
- What the verifiers found: (skeptic: partially-confirmed / sound) "Line anchors are off: README.md:270 has 'EigenTrust reputation scoring ensures skill quality' and 'Revenue is split 70/20/10'; :271 'Management nodes post bounties with USDC rewards'; :273 'Your agent literally dreams about what will sell'; :275 '**The Loop** Dream -> Discover -> ... -> Earn'; :453 'let ... the EigenTrust reputation system truly shine' (not 269/451). [...]" (tiebreak: partially-confirmed / sound) "Independently checked at HEAD c5e1f97. (1) Anchors: the quoted copy is at README.md:270 ('**EigenTrust reputation** scoring ensures skill quality ... Revenue is split 70/20/10 (publisher/author/contributors)'), :271 ('Management nodes post bounties with USDC rewards'), :273 ('Your agent literally dreams about what will [...]"
- Corrected statement / recommendation: Corrected statement: README.md:270-275 and :453 (not 269/451) make reputation/revenue/bounty/earning claims while wired-but-dead-audit-2026-08-09 findings F7/F10/F11/F14 (not 'economy-audit' findings) remain open with no commits touching the relevant files since 2026-08-09. Nuances: the 70/20/10 split is implemented (marketplace-economics.ts:355-371) but pays crystal UUIDs rather than wallets; bounties can be posted by any node (bounty-post.ts has no management gate), so 'Management nodes post bounties' is wrong in the opposite direction; [...]

#### 3.9-20

- Verdict: claim **partially-confirmed**; recommendation **needs-change**. Weight: medium. Anchor: `README.md:18`
- Original claim: Beta/stale version signalling is present: README.md:18 has a version-2026.2.15--beta badge, desktop/renderer/src/layout/Sidebar.tsx:79 has a '(beta)' nav label, docs/start/setup.md:16 says 'Last updated 2026-01-01', gateway-lock.md:11 says '2026.1.12 (unreleased at the time of writing)', providers/minimax.md:192 and RELEASING.md:60 reference --tag beta.
- Original recommendation: Decide the V1 version string; remove beta signalling and hand-maintained dates.
- What the verifiers found: (skeptic: partially-confirmed / needs-change) "README.md:18 badge `version-2026.2.15--beta`, confirmed. Sidebar: the file desktop/renderer/src/layout/Sidebar.tsx does not exist; the '(beta)' label is at desktop/renderer/src/components/layout/Sidebar.tsx:79 `label: "Dreams (beta)"` (line right, path wrong). docs/start/setup.md:16 `Last updated: 2026-01-01`, confirmed. [...]" (reproducer: partially-confirmed / sound) "README.md:18 confirmed: `img.shields.io/badge/version-2026.2.15--beta-...`. '(beta)' nav label confirmed but at desktop/renderer/src/components/layout/Sidebar.tsx:79 (`label: "Dreams (beta)"`); [...]"
- Corrected statement / recommendation: Statement: citations are shuffled, gateway-lock.md:11 is a 2025-12-11 'Last updated' line; the '2026.1.12 (unreleased)' text is minimax.md:192; `--tag beta` is in docs/reference/RELEASING.md:60 and docs/cli/update.md:23 (not minimax.md); Sidebar path is components/layout/Sidebar.tsx:79. Recommendation: remove the README badge, stale dates and the minimax.md unreleased-version note, but do NOT treat `--tag beta` as beta signalling, it documents the real beta update channel (update-channels.ts) and should stay; [...] (reproducer adds: Corrected statement: README.md:18 beta badge; components/layout/Sidebar.tsx:79 'Dreams (beta)'; docs/start/setup.md:16 'Last updated: 2026-01-01'; [...])

#### 3.9-24

- Verdict: claim **partially-confirmed**; recommendation **needs-change**. Weight: low. Anchor: `extensions/signal/src/channel.ts:85`
- Original claim: extensions/signal/src/channel.ts:85 requires signal-cli (Java) with no install story in the UI or platform docs; the only install path is CLI onboarding via Homebrew.
- Original recommendation: Actionable reason from the greyed card; per-platform doc; list Signal under Advanced channels. | Add an actionable install hint to the greyed Signal card.
- What the verifiers found: (skeptic: partially-confirmed / needs-change) "extensions/signal/src/channel.ts:79-85: probes `channels.signal.cliPath || "signal-cli"` and returns `reason: "signal-cli not found on the gateway host (looked for ...). Install it or set channels.signal.cliPath."`. The Control UI ALREADY renders that reason on the greyed card: desktop/renderer/src/components/channels/ChannelsView.tsx:85 `title={channel.capability?.reason}` and :111-112 renders `ch [...]" (reproducer agrees: partially-confirmed / needs-change) "Core premise reproduced: extensions/signal/src/channel.ts:79-86 `const cliPath = cfg.channels?.signal?.cliPath? [...]"
- Corrected statement / recommendation: Corrected claim: the greyed card already shows an actionable reason ("Install it or set channels.signal.cliPath"); the CLI installer is a GitHub native-release download (Linux x64 + macOS) with Homebrew as the arm fallback, not Homebrew-only; Windows has no auto-install. What is genuinely missing is (a) a per-platform install doc (docs/platforms has no Signal mention) and (b) the UI hint does not point at `bitterbot channels add signal` / the installer. [...]

#### 3.9-25

- Verdict: claim **partially-confirmed**; recommendation **needs-change**. Weight: low. Anchor: `src/discord/voice-message.ts:81`
- Original claim: No document (docs/reference/data-layout is missing) describes the ~/.bitterbot layout, what is safe to delete, or how to back up keys/, event-journal.sqlite, tasks.sqlite, identity/ and .bak rotation; separately, src/discord/voice-message.ts:81 shells out to ffmpeg as an undeclared prerequisite.
- Original recommendation: Write docs/reference/data-layout.md from the first-run audit inventory and link from reset/uninstall/doctor; document ffmpeg as optional or degrade gracefully. | Document ffmpeg as optional for Discord voice.
- What the verifiers found: (reproducer: partially-confirmed / needs-change) "Data-layout half reproduced: `git ls-files docs | grep -i data-layout` -> empty; no docs.json entry. The pieces are scattered: event-journal.sqlite/tasks.sqlite only in docs/automation/long-horizon-tasks.md, docs/cli/doctor.md, docs/gateway/doctor.md, PLAN-37; `.bak` only in docs/cli/doctor.md:30 (`--fix ... [...]" (skeptic agrees: partially-confirmed / needs-change) "Data layout: `ls docs/reference/data-layout\*`= No such file;`grep -rln 'event-journal.sqlite|tasks.sqlite' do [...]"
- Corrected statement / recommendation: Corrected statement: no doc describes the ~/.bitterbot layout, safe-to-delete items, or key/identity backup (confirmed); but ffmpeg is NOT undeclared, docs/channels/discord.md:599 and docs/start/setup.md:32 + scripts/setup-deps.sh:67 declare/install it, and the waveform path already falls back to a placeholder. Corrected recommendation: keep 'write docs/reference/data-layout.md and link from reset/uninstall/doctor'; [...]

### 3.10-3.11 First-run runtime, data layout, channels and providers

19 item(s) changed in this section (of 24 verified).

#### 3.10-3.11-01

- Verdict: claim **confirmed**; recommendation **needs-change**. Weight: critical. Anchor: `src/gateway/server.impl.ts:268-311`
- Original claim: Gateway structured logs on 2026-08-21 record {"label":"load-plugins","ms":1646406} (~27.4 min) and the 'listening' line only follows afterwards, reproduced on every restart log checked (src/gateway/server.impl.ts:268-311).
- Original recommendation: Add per-plugin timing in loadBitterbotPlugins; reproduce on ext4/macOS; if it reproduces, precompile bundled extensions to JS and async-load plugins with listen() earlier. | Profile and fix the load-plugins stall (see 3.10); it is the second most important first-run issue. [...]
- What the verifiers found: (reproducer: confirmed / needs-change) "Reproduced from /tmp/bitterbot/bitterbot-2026-08-21.log (structured file log, DEFAULT_LOG_DIR per src/logging/logger.ts:12-13,218): `{"label":"load-plugins","ms":1646406,"totalMs":1646673}` at 17:34:26.141Z; 1646406/60000 = 27.44 min. Preceding step `config-load` at 17:06:59.736Z; `listening on ws://127.0.0.1:19001 (PID 9795)` at 17:34:52.733Z, i.e. only after load-plugins. [...]" (skeptic agrees: confirmed / needs-change) "Structured file log /tmp/bitterbot/bitterbot-2026-08-21.log contains {"label":"load-plugins","ms":1646406,"tota [...]"
- Corrected statement / recommendation: Claim text stands (27.4 min, 30/30 boots, listen only afterwards). Recommendation should change order: before per-plugin timing or precompiling extensions, test the already-existing cheap lever: run the gateway with NODE_ENV=production (or flip loader.ts:58-61 to prefer dist/plugin-sdk/index.js when it exists; dist/plugin-sdk/index.js is already built, 134 KB, Aug 18) so jiti loads one prebuilt SDK bundle plus the 44 extension .ts files instead of ~1,900 src/ modules. 'Precompile bundled extensions to JS' alone does not remove the SDK-graph walk. [...]

#### 3.10-3.11-02

- Verdict: claim **partially-confirmed**; recommendation **needs-change**. Weight: high. Anchor: `src/plugins/loader.ts:323`
- Original claim: loadGatewayPlugins in src/plugins/loader.ts (around lines 323 and 439) is synchronous, jiti-loads 12 extensions/\*/index.ts files and runs register() inline, with no per-plugin timing.
- Original recommendation: Per-plugin timing in loadBitterbotPlugins; precompile bundled extensions to JS.
- What the verifiers found: (reproducer: partially-confirmed / needs-change) "Function naming/location is off: `loadGatewayPlugins` lives in src/gateway/server-plugins.ts:5-17 and is a thin wrapper; the loader in src/plugins/loader.ts is `loadBitterbotPlugins` (loader.ts:180, returns PluginRegistry synchronously). Lines reproduced: loader.ts:323 `mod = getJiti()(candidate.source)`; [...]" (skeptic agrees: partially-confirmed / needs-change) "src/gateway/server-plugins.ts:4-17 loadGatewayPlugins is a plain (non-async) function that calls loadBitterbotP [...]"
- Corrected statement / recommendation: Corrected statement: `loadBitterbotPlugins` (src/plugins/loader.ts:180; wrapped by `loadGatewayPlugins` in src/gateway/server-plugins.ts:5) is synchronous, jiti-loads the 9 bundled extensions enabled by default (of 12 present) plus their ./src/\*.ts and the whole src/plugin-sdk graph (NODE_ENV!==production), and runs register() inline with no per-plugin timing. Recommendation: per-plugin timing is sound; 'precompile bundled extensions to JS' needs change: the extension entry files are small, the heavy part is the SDK alias resolving to TypeScript src/; [...]

#### 3.10-3.11-03

- Verdict: claim **partially-confirmed**; recommendation **sound**. Weight: medium. Anchor: `src/gateway/server.impl.ts:268-311`
- Original claim: The hormonal accessor awaits dynamic imports before anything else and therefore cannot be the cause of the load-plugins stall; memory init ran after load-plugins and took 1.6-26 s.
- Original recommendation: Do not attribute the 27-minute boot to the hormonal accessor / jiti transpile.
- What the verifiers found: (reproducer: partially-confirmed / sound) "src/tasks/hormonal-accessor.ts:77-78 `void runRefresh(refresh)` fires immediately; runRefresh (:99-103) awaits refresh(); readDefaultAgentHormonalState (:113-120) first does `await Promise.all([import("../memory/manager.js"), import("../agents/agent-scope.js")])` and only then `await MemoryIndexManager.get({... purpose: "status"})`. [...]" (skeptic: confirmed / sound) "src/tasks/hormonal-accessor.ts:78 `void runRefresh(refresh)`; :115 `await Promise.all([import("../memory/manager.js"), import("../agents/agent-scope.js")])` precedes :120 `MemoryIndexManager.get(...)`, [...]"
- Corrected statement / recommendation: Memory init ran after load-plugins on every boot and took 0.2-26 s (24-26 s only on the three most recent boots; sub-second on most earlier ones). The conclusion (hormonal accessor / jiti transpile of memory modules is not the stall) holds; note however that the accessor's eager first refresh is what puts the 24-26 s memory build on the pre-listen path.

#### 3.10-3.11-04

- Verdict: claim **confirmed**; recommendation **needs-change**. Weight: high. Anchor: `src/memory/manager.ts:512`
- Original claim: The only measured environment for the ~27 min boot is WSL2 on /mnt/d (DrvFS); native-FS boot time is unmeasured; the comment at src/memory/manager.ts:512 calling memory init the 'dominant cold-boot cost' is wrong.
- Original recommendation: Fix the stale comment; if DrvFS-only, warn in onboarding when the repo path starts with /mnt/.
- What the verifiers found: (reproducer: confirmed / needs-change) "`mount | grep ' /mnt/d '` -> `D:\ on /mnt/d type 9p (rw,noatime,aname=drvfs;...)`; repo is /mnt/d/Bitterbot/bitterbot-desktop and every boot log (structured `fullFilePath` file:///mnt/d/Bitterbot/bitterbot-desktop/dist/entry.js, hostname "unknown") is from this machine; no log from any other FS exists under ~/.bitterbot/logs or /tmp/bitterbot. [...]" (skeptic agrees: confirmed / needs-change) "src/memory/manager.ts:511-513: '// Boot profiling: the constructor runs synchronously and is the gateway's domi [...]"
- Corrected statement / recommendation: Claim holds. Recommendation: fixing the stale comment is sound. The onboarding warning should not be the headline fix: the reproduced cause is jiti walking ~1,900 TypeScript src modules through the plugin-sdk alias (loader.ts:52-61) because NODE_ENV is 'development'/unset; use dist/plugin-sdk (NODE_ENV=production or reorder candidates) first. If a warning is still wanted, extend the existing doctor-runtime WSL2 hint to key on the repo/workspace path starting with /mnt/ and surface it from onboarding rather than writing a new one.

#### 3.10-3.11-05

- Verdict: claim **confirmed**; recommendation **needs-change**. Weight: medium. Anchor: `src/gateway/server.impl.ts:268-311`
- Original claim: A synchronous FTS-drift repair runs before the gateway calls listen().
- Original recommendation: Stop the sync FTS-drift repair before listen.
- What the verifiers found: (skeptic: confirmed / needs-change) "src/memory/memory-schema.ts:79-108: the backfill is a synchronous better-sqlite3 `params.db.exec(INSERT INTO fts ... WHERE c.id NOT IN (SELECT id FROM fts) ...)` with count() before/after, inside ensureMemoryIndexSchema; called from ensureSchema (src/memory/manager-sync-ops.ts:345-362, logs 'fts drift repaired') inside the MemoryIndexManager constructor (manager.ts:511-530 step timing, then openDat [...]" (reproducer agrees: confirmed / needs-change) "src/memory/memory-schema.ts:80-112: inside ensureMemoryIndexSchema, a synchronous better-sqlite3 `params.db.exe [...]"
- Corrected statement / recommendation: Do not simply 'stop' the repair: it is the only thing that restores keyword recall for chunks written outside the sync path (memory-schema.ts:79-83) and its PLAN-40 lifecycle fence (lines 90-103) was deliberately added. The lever is scheduling: defer the hormonal accessor's first refresh (hormonal-accessor.ts:78) until after listen, or schedule the backfill on the first sync tick rather than in the constructor, and make the NOT IN scan cheap (indexed anti-join / count compare) so a clean DB costs ms, not 25 s.

#### 3.10-3.11-07

- Verdict: claim **partially-confirmed**; recommendation **sound**. Weight: low. Anchor: `src/logging/subsystem.ts:150`
- Original claim: 'boot step'/'init step' logs pass {label, ms} as meta that the console formatter in src/logging/subsystem.ts:150 never renders, so every boot prints ~10 bare lines (server.impl.ts:178, manager.ts:525).
- Original recommendation: Put label and ms in the message string. | Make boot-profiling labels survive the console formatter so the culprit step is named in the log.
- What the verifiers found: (skeptic: partially-confirmed / sound) "src/logging/subsystem.ts:150 is inside formatSubsystemForConsole (prefix stripping), not the formatter; formatConsoleLine is :150-189. For style pretty/compact it returns only `${head} ${levelColor(displayMessage)}` (:188) and never touches opts.meta, so the console shows bare lines: gateway-ui-launch.log 2026-08-21 has 10 '[gateway] boot step', 4 '[memory] init step' and 1 '[memory] manager build [...]" (reproducer: confirmed / sound) "src/logging/subsystem.ts:147-190 formatConsoleLine: `opts.meta` is only used in the `if (opts.style === "json")` branch (:156-163, `...opts.meta`); [...]"
- Corrected statement / recommendation: Reword: 'the default pretty/compact console styles drop {label, ms}; they are visible in the file log and with logging.consoleStyle=json'. Putting label/ms into the message string is still the right fix (the memory-manager summary line 'manager build timing' has the same problem); count is ~15 bare lines per boot, manager.ts line is 526. (reproducer adds: Minor: line is manager.ts:526 (and :590 for the summary); count is 11-15 bare lines per boot, not ~10. Recommendation sound: put label/ms in the message string (cheapest, targeted); [...])

#### 3.10-3.11-08

- Verdict: claim **partially-confirmed**; recommendation **needs-change**. Weight: low. Anchor: `src/gateway/server-startup.ts:478`
- Original claim: Success messages such as 'P2P orchestrator bridge started' and 'Management node service started' are logged at warn level because the sidecar logger only exposes warn (src/gateway/server-startup.ts:478,38; server-startup-memory.ts:73).
- Original recommendation: Add an info channel to the sidecar logger.
- What the verifiers found: (reproducer: partially-confirmed / needs-change) "Reproduced by grep for the two message strings. src/gateway/server-startup.ts:36 declares `log: { warn: (msg: string) => void };` and :477-479 calls `params.log.warn(\`P2P orchestrator bridge started (binary: ...)\`)`. src/gateway/server-startup-memory.ts:23 declares `log: { info?: (msg: string) => void; [...]" (skeptic agrees: partially-confirmed / needs-change) "src/gateway/server-startup.ts:477-479: `params.log.warn(\`P2P orchestrator bridge started (binary: ...)\`)`; [...]"
- Corrected statement / recommendation: Corrected statement: both success messages are emitted via warn because startGatewaySidecars' `log` parameter type is narrowed to `{ warn }` (server-startup.ts:36); the real logger (createSubsystemLogger) already has info, and server-startup-memory.ts:23 already declares `info?`. Corrected recommendation: no new channel needed; widen the parameter type in server-startup.ts:36 to include `info` (the gateway logger already satisfies it), switch the two call sites to `log.info`, and pass the same object through to startGatewayMemoryBackend.

#### 3.10-3.11-10

- Verdict: claim **partially-confirmed**; recommendation **sound**. Weight: medium. Anchor: `src/infra/event-journal.ts:195`
- Original claim: The event journal (src/infra/event-journal.ts:195) is enabled by default with only per-task deletion and no retention sweep; the local journal reached 17.5 MB plus 4 MB WAL after ~2 months.
- Original recommendation: Add a 30-day retention sweep. | Add retention to the unbounded stores and reconsider the 24h log window.
- What the verifiers found: (reproducer: partially-confirmed / sound) "Enabled-by-default: src/infra/event-journal.ts:247-251 `isEventJournalEnabled()` returns true when BITTERBOT_EVENT_JOURNAL is unset; started unconditionally from src/gateway/server.impl.ts:205 `startEventJournal();`. Deletion: the only delete is `deleteTask` at event-journal.ts:194-197 (`DELETE FROM event_log WHERE task_id = ?`); [...]" (skeptic agrees: partially-confirmed / sound) "Enabled by default: src/infra/event-journal.ts:247-251 `if (v === undefined) return true; [...]"
- Corrected statement / recommendation: Corrected statement: the journal is on by default and grows unbounded; per-task deletion exists in code but is never invoked in production, and 99.9% of rows (33,505/33,544) carry no task_id so it would not help anyway; the 17.5 MB + 4 MB WAL accumulated over ~3 months (first event 2026-05-22), not ~2. Recommendation (30-day retention sweep on ts, plus a periodic WAL checkpoint) is sound and is the only mechanism that would work given the null task_ids.

#### 3.10-3.11-12

- Verdict: claim **partially-confirmed**; recommendation **needs-change**. Weight: high. Anchor: `src/memory/manager.ts:513`
- Original claim: The memory manager constructor (src/memory/manager.ts:513) blocks the event loop running 155 'IF NOT EXISTS' statements, migrations and FTS self-heal on every open (memory-schema.ts:79-100); this took 25.5 s on a 622 MB DB and produced 'event loop stalled: max=72410ms'.
- Original recommendation: Gate self-heal behind a meta flag; make heavy phases async.
- What the verifiers found: (reproducer: partially-confirmed / needs-change) "Constructor: src/memory/manager.ts:513-540 ('Boot profiling: the constructor runs synchronously and is the gateway's dominant cold-boot cost (it blocks the event loop until it returns)'); this.ensureSchema() at :538 with step() timing. [...]" (skeptic agrees: partially-confirmed / needs-change) "CONFIRMED: constructor is synchronous and self-describes as the dominant cold-boot cost (manager.ts:511-516 com [...]"
- Corrected statement / recommendation: Corrected statement: MemoryIndexManager's synchronous constructor spent 25,550 ms in ensureSchema (26,083 ms total) on the ~629 MB main.sqlite at the 2026-08-21 17:34Z boot. The per-open work is the 37 schema IF NOT EXISTS statements + ensureColumn PRAGMAs + the unconditional FTS self-heal backfill (memory-schema.ts:79-115), NOT the 155 migration statements (runMigrations skips everything <= current schema_version). [...]

#### 3.10-3.11-13 **ALREADY DONE**

- Verdict: claim **partially-confirmed**; recommendation **already-done**. Weight: low. Anchor: `src/memory/skill-curator.ts:38`
- Original claim: The skill curator (src/memory/skill-curator.ts:38) and agentskills-ingest.ts:135 accumulate curator-report dirs (160 on the local node) and quarantine entries (22) with no pruning.
- Original recommendation: Keep last 20 reports; expire quarantine after 30 days.
- What the verifiers found: (skeptic: partially-confirmed / already-done) "Curator half confirmed: src/memory/skill-curator.ts:38 `const REPORTS_SUBDIR = "curator-reports"`, :148-150 writes `CONFIG_DIR/curator-reports/<ts>/REPORT.md`, no readdir/rm/prune anywhere in the file (grep); invoked from src/memory/dream-engine.ts:2970. Count today: 158 dirs (not 160), 1.3 MB total, 2026-06-10 to 2026-08-21, 71 distinct days (~2/day). [...]" (reproducer: partially-confirmed / needs-change) "Curator reports: src/memory/skill-curator.ts:38 `const REPORTS_SUBDIR = "curator-reports"`; reports written at :146-153 and :339-349 whenever `options.writeReport ?? !options.dryRun`; [...]"
- Corrected statement / recommendation: Corrected claim: curator-reports (158 dirs, 1.3 MB) have no pruning; quarantine entries (20) are already expired after 30 days by the PLAN-13 Phase C sweeper, which is live. Recommendation: 'expire quarantine after 30 days' is already done (skills.p2p.quarantineTtlDays); only the 'keep last N curator reports' part is new, and at 1.3 MB it is cosmetic. [...] (reproducer adds: Corrected statement: curator-report dirs do accumulate with no pruning (158 today); quarantine entries do NOT accumulate without pruning, a 30-day TTL sweeper already exists and is active (skills-incom [...])

#### 3.10-3.11-14

- Verdict: claim **confirmed**; recommendation **needs-change**. Weight: low. Anchor: `src/commands/uninstall.ts:89`
- Original claim: src/commands/uninstall.ts:89 implements an --app flag that removes /Applications/Bitterbot.app although no native app has been released.
- Original recommendation: Hide --app until an installer ships.
- What the verifiers found: (skeptic: confirmed / needs-change) "src/commands/uninstall.ts:85-93 `removeMacApp` calls `removePath("/Applications/Bitterbot.app", ...)` at line 89 (guarded by `process.platform !== "darwin"`), with the `--app` option wired at src/cli/program/register.maintenance.ts:129 (`"Remove the macOS app"`) and folded into `--all` at :130; :123 also prints the path as a hint. [...]" (reproducer: confirmed / sound) "src/commands/uninstall.ts:85-93 `removeMacApp` returns early unless `process.platform === "darwin"`, then `removePath("/Applications/Bitterbot.app", ...)` (line 89); [...]"
- Corrected statement / recommendation: Hiding `--app` is acceptable but low value: the flag is already platform-guarded and harmless when the .app is absent, and developers building the Tauri app locally do get a Bitterbot.app. Cheaper option: `hideHelp()` on `--app` and drop 'app' from the `--all` description until the installer ships, rather than removing the code path. Do not touch docs (already undocumented). (reproducer adds: Hiding `--app` alone still leaves `--all` (uninstall.ts:48) and the interactive picker (121-123) selecting the app scope; hide those too or gate all three on the same flag. [...])

#### 3.10-3.11-15

- Verdict: claim **partially-confirmed**; recommendation **needs-change**. Weight: low. Anchor: `src/agents/memory-search.ts:131`
- Original claim: The local install has duplicate per-agent state: main.sqlite (622 MB) plus default.sqlite (44 MB), and both workspace and workspace-default directories, traceable to agent-id resolution in src/agents/memory-search.ts:131; the cause is unverified.
- Original recommendation: Have doctor detect orphaned DBs/workspaces; use a single resolveDefaultAgentId.
- What the verifiers found: (reproducer: partially-confirmed / needs-change) "Re-measured: ~/.bitterbot/memory/main.sqlite = 628,875,264 bytes (mtime 2026-08-21 22:05; ~629 MB, audit said 622 MB -- grew since), default.sqlite = 44,064,768 bytes (44.06 MB, mtime 2026-08-09 22:52 -- stale, not written in 12 days). Dirs: ~/.bitterbot/workspace, workspace-default, and also workspace-dev (not mentioned). [...]" (skeptic agrees: partially-confirmed / needs-change) "Local state confirmed: ls ~/.bitterbot/memory shows default.sqlite 44,064,768 B (mtime Aug 9 22:52) and main.sq [...]"
- Corrected statement / recommendation: Corrected statement: sizes are ~629 MB (main.sqlite, growing) and 44 MB (default.sqlite, last written 2026-08-09 22:52); there is also a workspace-dev dir. The cause is identifiable: several call sites pass a literal agentId "default" (a2a-http.ts:151/263, session-updates.ts:114/201, a2a-status-tool.ts:461, a2a-client-tool.ts:56, interceptor-runner.ts:246) while the resolved default agent is "main", so MemoryIndexManager.get creates memory/default.sqlite and workspace-default. [...]

#### 3.10-3.11-16

- Verdict: claim **partially-confirmed**; recommendation **needs-change**. Weight: low. Anchor: `src/config/backup-rotation.ts:13`
- Original claim: Named .bak-pre-\* config backups bypass the rotation cap in src/config/backup-rotation.ts:13 and accumulate.
- Original recommendation: Move to ~/.bitterbot/backups/config/ with the same cap.
- What the verifiers found: (reproducer: partially-confirmed / needs-change) "src/config/backup-rotation.ts: `CONFIG_BACKUP_COUNT = 5` is at line 1 (line 13 is `const backupBase = ...`); rotateConfigBackups only touches `<config>.bak`, `.bak.1`..`.bak.4`. `git grep -n bak-pre` over the whole repo returns no code, script, or workflow that writes `.bak-pre-*` files; [...]" (skeptic agrees: partially-confirmed / needs-change) "src/config/backup-rotation.ts:13 `const backupBase = \`${configPath}.bak\`;`and :1`CONFIG_BACKUP_COUNT = 5`; [...]"
- Corrected statement / recommendation: Corrected statement: the app never creates `.bak-pre-*` files; they are hand-made operator copies (PLAN-37 already flags them for deletion). They trivially 'bypass' rotation because nothing in the codebase knows about them. Corrected recommendation: there is nothing to move under the cap; either delete them per PLAN-37 item 9, or fold into the audit's own P1 'bitterbot backup / restore point' feature (row 14) so operators stop hand-copying the config. Also fix the citation to backup-rotation.ts:1.

#### 3.10-3.11-17

- Verdict: claim **confirmed**; recommendation **needs-change**. Weight: high. Anchor: `src/channels/registry.ts:7-14`
- Original claim: 'imessage' is listed in CHAT_CHANNEL_ORDER in src/channels/registry.ts:7-14 with the blurb 'this is still a work in progress', but no plugin registers it and extensions/imessage has never existed in the repo.
- Original recommendation: Remove imessage from registry/DOCKS/aliases and follow the ChatChannelId ripple; keep src/imessage for a future darwin plugin. | REMOVE imessage from the core channel registry (keep src/imessage behind a future darwin plugin). [...]
- What the verifiers found: (skeptic: confirmed / needs-change) "src/channels/registry.ts:7-14 CHAT_CHANNEL_ORDER = [telegram, whatsapp, discord, slack, signal, "imessage"]; registry.ts:82-90 meta with blurb "this is still a work in progress." (line 88) and selectionLabel "iMessage (imsg)" (84); CHAT_CHANNEL_ALIASES {imsg: "imessage"} at 93-95. [...]" (reproducer: confirmed / sound) "Reproduced from scratch at HEAD c5e1f97. `sed -n 7,14p src/channels/registry.ts` shows CHAT_CHANNEL_ORDER = [telegram, whatsapp, discord, slack, signal, "imessage"] (imessage at line 13); [...]"
- Corrected statement / recommendation: Ripple is larger than 'registry/DOCKS/aliases': ChatChannelId is referenced in 11 non-test files, with Record<ChatChannelId,...> at src/channels/dock.ts:102 (DOCKS, imessage entry at 296) and registry.ts:26; dead per-channel helpers exist at src/channels/plugins/onboarding/imessage.ts, normalize/imessage.ts, outbound/imessage.ts; config surface keeps imessage (and an unrelated 'bluebubbles') in ChannelsSchema (src/config/zod-schema.providers.ts:31-32), types.channels.ts:44, schema.labels.ts:212-213, group-mentions.ts:173,301; [...] (reproducer adds: Premise holds. Note the ripple is wider than 'registry/DOCKS/aliases': ChatChannelId is derived from CHAT_CHANNEL_ORDER, so CHAT_CHANNEL_META and DOCKS (both Record<ChatChannelId,...>) must drop their [...])

#### 3.10-3.11-18 **ALREADY DONE**

- Verdict: claim **partially-confirmed**; recommendation **already-done**. Weight: high. Anchor: `src/commands/onboard-channels.ts:420-443`
- Original claim: The onboarding wizard (src/commands/onboard-channels.ts:132-143,420-443,488-491) offers 'iMessage (imsg)' on every platform and dead-ends at 'does not support onboarding yet'; the CLI advertises --channel imessage (channel-options.ts:20-22).
- Original recommendation: Remove imessage from the wizard and CLI channel options.
- What the verifiers found: (reproducer: partially-confirmed / sound) "onboard-channels.ts:132-143 builds fallbackStatuses from listChatChannels() (registry.ts:101-103 maps CHAT_CHANNEL_ORDER, so imessage is included with 'iMessage: not configured'); :420-443 getChannelEntries() seeds the selection list from listChatChannels() with no platform filter (grep for darwin/process.platform/platforms in the wizard = 0 hits), label = meta.selectionLabel = 'iMessage (imsg)'. [...]" (skeptic: confirmed / already-done) "src/commands/onboard-channels.ts:132-143 fallbackStatuses = listChatChannels().filter(no plugin status) -> label 'not configured' (imessage always lands here since no plugin registers it); [...]"
- Corrected statement / recommendation: Corrected statement: the wizard offers 'iMessage (imsg)' on every platform and dead-ends at 'imessage plugin not available.' (onboard-channels.ts:480), not at 'does not support onboarding yet' (:490), which is unreachable for imessage. Recommendation unchanged: removing imessage from CHAT_CHANNEL_ORDER automatically removes it from both the wizard list (listChatChannels) and the CLI option string (resolveCliChannelOptions); no separate wizard/CLI edit is needed beyond the registry ripple. (skeptic adds: No separate edit is needed: both the wizard (onboard-channels.ts:425 listChatChannels) and the CLI (channel-options.ts:22 CHAT_CHANNEL_ORDER) derive from the registry, so removing imessage from CHAT_CH [...])

#### 3.10-3.11-19

- Verdict: claim **partially-confirmed**; recommendation **needs-change**. Weight: medium. Anchor: `docs/docs.json:90`
- Original claim: docs/docs.json line 90 redirects /channels/imessage to /channels, and onboard-channels.e2e.test.ts:6 imports the nonexistent extensions/imessage (passing only because e2e tests are excluded from the run).
- Original recommendation: Fix the stale e2e test.
- What the verifiers found: (skeptic: partially-confirmed / needs-change) "docs/docs.json: the imessage redirect `"source": "/channels/imessage"` is at line 91 (line 90 is the opening `{`); destination "/channels" at 92. src/commands/onboard-channels.e2e.test.ts:6 `import { imessagePlugin } from "../../extensions/imessage/src/channel.js"` confirmed. [...]" (reproducer: partially-confirmed / sound) "`grep -n imessage docs/docs.json` = line 91 `"source": "/channels/imessage"`, line 92 `"destination": "/channels"`; line 90 is the opening `{` of that redirect object (off by one, immaterial). [...]"
- Corrected statement / recommendation: Line is docs/docs.json:91, not 90. There are TWO stale e2e tests (onboard-channels.e2e.test.ts:6 and channels.adds-non-default-telegram-account.e2e.test.ts:4). The fix depends on the -17 decision: if imessage leaves the core registry, drop the import and its createTestRegistry entry in both files; the tests are not 'passing', they are unrun (no CI job invokes test:e2e). (reproducer adds: Corrected statement: the e2e test is never run (excluded by vitest.config.ts:52 and absent from every workflow), so it neither passes nor fails; it would fail on import if ever enabled. [...])

#### 3.10-3.11-22

- Verdict: claim **partially-confirmed**; recommendation **needs-change**. Weight: high. Anchor: `src/agents/models-config.providers.ts:764-773`
- Original claim: The Ollama provider is only constructed when an API key exists (src/agents/models-config.providers.ts:764-773); docs/providers/ollama.md:30-36 instructs export OLLAMA_API_KEY="ollama-local" ('any value works'); there is no wizard or UI option for Ollama (onboard-types.ts:5-50) even though the README claims local models are supported.
- Original recommendation: Add a first-class 'Local (Ollama)' wizard group probing 127.0.0.1:11434, a 'Use a local model' option in ModelsView, and treat an explicit models.providers.ollama entry as opt-in. | Add a first-class local-model (Ollama) path in wizard and UI; drop the fake-API-key requirement.
- What the verifiers found: (skeptic: partially-confirmed / needs-change) "src/agents/models-config.providers.ts:764-773 (verified with nl): `const ollamaKey = resolveEnvApiKeyVarName('ollama') ?? resolveApiKeyFromProfiles(...); if (ollamaKey) { providers.ollama = {...buildOllamaProvider(...), apiKey: ollamaKey} }`, gated on key. docs/providers/ollama.md:29-37 (nl) 'any value works; Ollama doesn't require a real key' + `export OLLAMA_API_KEY="ollama-local"`. [...]" (reproducer: confirmed / sound) "src/agents/models-config.providers.ts:764-773 reproduced verbatim: comment 'Ollama provider - only add if explicitly configured.' (764); [...]"
- Corrected statement / recommendation: Correct statement: no labeled Ollama choice exists, but the Custom Provider choice defaults to the Ollama URL; the fake-key requirement applies to both implicit and explicit config because pi's ModelRegistry requires apiKey (comment at :376). Recommendation: 'treat explicit models.providers.ollama as opt-in' alone will not drop the fake key; it needs placeholder injection for keyless local providers, for which prior art exists in the same file (MINIMAX_OAUTH_PLACEHOLDER :42/:689, QWEN_PORTAL_OAUTH_PLACEHOLDER :101/:725). [...]

#### 3.10-3.11-23

- Verdict: claim **partially-confirmed**; recommendation **needs-change**. Weight: medium. Anchor: `src/commands/auth-choice-options.ts:27-168`
- Original claim: The wizard auth picker in src/commands/auth-choice-options.ts:27-168 has 24 groups / ~45 choices, including a deprecated 'Anthropic setup-token (no longer works)' entry, Z.AI Coding-Plan-Global/CN variants, and Chutes third in the list.
- Original recommendation: Short list (Anthropic, OpenAI, Google, OpenRouter, Local, Custom) plus 'More providers'; delete the deprecated choice.
- What the verifiers found: (reproducer: partially-confirmed / needs-change) "Re-derived counts with node over src/commands/auth-choice-options.ts: AUTH_CHOICE_GROUP_DEFS (lines 19-168) = 24 groups (confirmed: openai, anthropic, chutes, vllm, minimax, moonshot, google, xai, openrouter, qwen, zai, qianfan, copilot, ai-gateway, opencode-zen, xiaomi, synthetic, together, huggingface, venice, nearai, litellm, cloudflare-ai-gateway, custom) containing 36 choices; [...]" (skeptic agrees: partially-confirmed / needs-change) "Recount via node over src/commands/auth-choice-options.ts: 24 group entries (openai, anthropic, chutes, vllm, m [...]"
- Corrected statement / recommendation: Corrected claim: the wizard picker has 24 groups / 36 choices (flat list 38 + skip), and the deprecated 'Anthropic setup-token' entry is already hidden from the interactive wizard (anthropic group = apiKey only); it survives only in the flat BASE list used for the CLI --auth-choice help and legacy validation. Corrected recommendation: the short-list/'More providers' reorganisation stands as a design choice, but 'delete the deprecated choice' is mostly already done for the wizard; [...]

#### 3.10-3.11-25

- Verdict: claim **partially-confirmed**; recommendation **needs-change**. Weight: medium. Anchor: `package.json:172`
- Original claim: package.json line 172 pins WhatsApp's baileys dependency at 7.0.0-rc.9 (a release candidate), and whatsapp is DEFAULT_CHAT_CHANNEL in src/channels/registry.ts:19,46 while docs say Telegram is the fastest to set up and the blurb recommends 'a separate phone + eSIM'.
- Original recommendation: Pin stable baileys 7.x; make Telegram the quickstart default; add a one-line ToS caution. | Pin a stable Baileys release before V1. | Make Telegram the quickstart default per docs; soften the 'separate phone + eSIM' WhatsApp blurb. | Classify WhatsApp NEEDS-POLISH (RC dependency); [...]
- What the verifiers found: (skeptic: partially-confirmed / needs-change) "package.json:172 `"@whiskeysockets/baileys": "7.0.0-rc.9"` (confirmed; unchanged since initial commit per git log -S baileys). src/channels/registry.ts:20 `DEFAULT_CHAT_CHANNEL = "whatsapp"` (claim says :19; it is line 20) and blurb at :46 'works with your own number; recommend a separate phone + eSIM.' docs/channels/index.md:30 'Fastest setup is usually **Telegram**'. [...]" (reproducer: confirmed / needs-change) "`grep -n baileys package.json` -> package.json:172 `"@whiskeysockets/baileys": "7.0.0-rc.9"`; pnpm-lock.yaml:5420 resolves the same rc.9. [...]"
- Corrected statement / recommendation: Corrected statement: baileys is pinned at 7.0.0-rc.9 (five RCs behind `latest`=7.0.0-rc14; no stable 7.x has been published). `DEFAULT_CHAT_CHANNEL="whatsapp"` is the default outbound-delivery channel for `send`/agent delivery, not the onboarding default; the wizard already defaults to Telegram via quickstartScore. Corrected recommendation: 'Pin stable 7.x' is impossible; choose between bumping to 7.0.0-rc14 (latest tag, with a regression test of QR link + send) or falling back to the 6.7.24 legacy line, and document that WhatsApp depends on an RC. [...] (reproducer adds: Claim holds (line numbers are 20 and 47, not 19 and 46). Recommendation 'Pin stable baileys 7.x' is not actionable: there is no stable 7.x on npm or GitHub; [...])

### 4. Peer patterns (single-agent research)

25 item(s) changed in this section (of 26 verified).

#### 4-02

- Verdict: claim **confirmed**; recommendation **needs-change**. Weight: low. Anchor: `src/config/paths.ts:178`
- Original claim: The default gateway port is 19001 (DEFAULT_GATEWAY_PORT in src/config/paths.ts:178), so the installer's final line 'Bitterbot is running at http://localhost:19001' matches the default.
- Original recommendation: Installer ends with 'Bitterbot is running at http://localhost:19001'.
- What the verifiers found: (reproducer: confirmed / needs-change) "src/config/paths.ts:178 `export const DEFAULT_GATEWAY_PORT = 19001;` (grep output). README.md:359 `| **19001** | Gateway (HTTP + WebSocket) | BITTERBOT_GATEWAY_PORT or gateway.port |`. No installer script exists yet (scripts/ has only preinstall-check.mjs, setup-auth-system.sh, setup-deps.sh; [...]" (skeptic agrees: confirmed / needs-change) "src/config/paths.ts:178: `export const DEFAULT_GATEWAY_PORT = 19001;`. [...]"
- Corrected statement / recommendation: The number matches the default gateway port, but the recommended installer line would send users to a URL that 404s unless D5/PLAN-39 phase 1 (gateway serves the renderer on 19001) ships first. Recommendation should be conditional: 'Installer ends with the URL the UI is actually served on: http://localhost:19001 once PLAN-39 phase 1 lands, otherwise http://localhost:5173 (DEFAULT_UI_PORT, src/infra/ui-restart.ts:38).'

#### 4-03

- Verdict: claim **partially-confirmed**; recommendation **needs-change**. Weight: medium. Anchor: `https://raw.githubusercontent.com/ollama/ollama/main/scripts/install.sh; https://raw.githubusercontent.com/n8n-io/n8n/refs/heads/master/docker/get-n8n.sh; [...]`
- Original claim: Ollama's install.sh at https://raw.githubusercontent.com/ollama/ollama/main/scripts/install.sh installs a systemd unit and service user and wraps its body in a main() function; n8n's get-n8n.sh does a port check, health-polls for 180 s and prints stop/upgrade/uninstall commands; the uv installer verifies SHA-256, writes a receipt file and supports --no-modify-path; [...]
- Original recommendation: Pattern 1: one idempotent install script per OS that installs the service, prints the URL and next commands, and is re-run to upgrade.
- What the verifiers found: (skeptic: partially-confirmed / needs-change) "Fetched all four sources today. Ollama install.sh (455 lines, identical at ollama.com/install.sh): `main() {` L7, `main` L455, `useradd -r ... ollama` L200, systemd unit L215-229, `systemctl enable ollama` L236. n8n get-n8n.sh (460 lines): `port_in_use()` L144, used L430-432 ("something is already listening on port"); `wait_for_n8n()` L361-372 polls /healthz `while waited -lt 180`, `sleep 3`; [...]" (reproducer agrees: partially-confirmed / needs-change) "Ollama: curl raw install.sh (455 lines). L7 `main() {`, L455 `main`; [...]"
- Corrected statement / recommendation: Claim: uv's `--no-modify-path` is accepted but deprecated (script tells you to set UV_NO_MODIFY_PATH=1); otherwise the four facts hold. Recommendation: do not make 're-run = upgrade' the mechanism. Two of the four cited peers (n8n, uv/cargo-dist) split install from upgrade (n8n refuses to touch an existing install without --upgrade; uv's receipt is for axoupdater). Bitterbot already has `bitterbot update` with the auto-rollback watchdog and in-UI updates; a re-run-to-upgrade installer would create a second update path that bypasses that safety chain. [...]

#### 4-04

- Verdict: claim **partially-confirmed**; recommendation **needs-change**. Weight: high. Anchor: `src/wizard/; src/cli/program.test-mocks.ts:63`
- Original claim: The Bitterbot wizard/CLI does not probe local LLM runtimes at 127.0.0.1:11434 (Ollama) or :1234 (LM Studio); grep of src/wizard and src/cli for 11434 finds no probe (the only ':1234' hit is a test mock gateway URL in src/cli/program.test-mocks.ts:63).
- Original recommendation: Wizard first choice 'Use a local model (no key)' probing 127.0.0.1:11434 and :1234; embeddings default to the local GGUF (D7) so memory works keyless; 'Detected on this machine' cards in Models & Keys.
- What the verifiers found: (skeptic: partially-confirmed / needs-change) "grep of src/wizard and src/cli for '11434' returns nothing, and the only ':1234' hit under src/cli is a test fixture, as stated. But the wizard logic lives in src/commands, which the grep skipped: src/commands/onboard-custom.ts:11 `const DEFAULT_OLLAMA_BASE_URL = 'http://127.0.0.1:11434/v1'` is the prefilled base URL (:283) of the 'Custom Provider / Any OpenAI or Anthropic compatible endpoint' auth [...]" (reproducer: partially-confirmed / sound) "Reproduced `grep -rn '11434\|:1234\b' src/wizard src/cli`: src/wizard -> zero hits; src/cli -> only src/cli/program.test-mocks.ts:63 `url: "ws://127.0.0.1:1234"` and :65 (test mock gateway URL). [...]"
- Corrected statement / recommendation: Correct statement: there is no automatic localhost runtime detection; the 'Custom Provider' wizard choice defaults to 127.0.0.1:11434/v1 and verifies it on demand, and Ollama model discovery (/api/tags) already exists behind the OLLAMA_API_KEY gate. Recommendation should extend these existing paths (promote Custom Provider's Ollama default into a labeled 'Local model' choice and reuse buildOllamaProvider discovery) rather than add a parallel probe; LM Studio (:1234) support would be net-new. [...] (reproducer adds: Correct statement: src/wizard and src/cli contain no Ollama/LM Studio probe, but src/commands/onboard-custom.ts:11,283 already pre-fills 127.0.0.1:11434/v1 under the generic 'Custom Provider' choice an [...])

#### 4-05

- Verdict: claim **partially-confirmed**; recommendation **needs-change**. Weight: medium. Anchor: `https://docs.anythingllm.com/setup/llm-configuration/overview; https://jan.ai/docs/desktop/quickstart; https://docs.msty.ai/studio/getting-started/onboarding`
- Original claim: AnythingLLM ships a built-in LLM, embedder and LanceDB so it works without an API key; Jan auto-downloads a default model; Msty runs a hardware scan and auto-detects Ollama at onboarding; LM Studio and GPT4All prompt to download one model.
- Original recommendation: Pattern 2: first chat without an API key via local-runtime detection and a keyless default.
- What the verifiers found: (skeptic: partially-confirmed / needs-change) "AnythingLLM: anchored overview page is a nav hub listing 'AnythingLLM Built-in (default)' LLM and 'AnythingLLM Default' embedder but no 'no API key' sentence. The built-in page (docs.anythingllm.com/setup/llm-configuration/local/built-in) says 'This default llm provider feature is only present on Desktop Version of AnythingLLM' and that it 'enables you to download popular and highly-rated LLMs' (a [...]" (reproducer: confirmed / sound) "AnythingLLM: docs.anythingllm.com/setup/llm-configuration/local/built-in: built-in LLM is the default on first boot of AnythingLLM Desktop, no API key, uses "Ollama's MIT-licensed open-source engine un [...]"
- Corrected statement / recommendation: Corrected statement: AnythingLLM defaults to a built-in LLM engine (desktop-only, still requires downloading a model), native embedder and LanceDB so no cloud key is needed; Jan auto-downloads a default model; Msty Studio runs a hardware scan and recommends a local engine/model (the explicit 'auto-detects existing Ollama' wording is from the legacy Msty app docs, not the anchored Studio page); LM Studio's onboarding offers a suggested first-model download per third-party walkthroughs (official docs only say 'download your first LLM' from Discover); [...]

#### 4-06

- Verdict: claim **partially-confirmed**; recommendation **needs-change**. Weight: high. Anchor: `src/gateway/server-methods-list.ts:9; desktop/renderer/src/components/models/KeyEntryModal.tsx:26-71`
- Original claim: Bitterbot already has validate-before-save on channels (channels.validate RPC in src/gateway/server-methods-list.ts:9, used by desktop/renderer/src/components/channels/ChannelSetupDrawer.tsx) and on model keys (KeyEntryModal.tsx calls models.auth.test before models.auth.set), but not on web-search, embeddings, wallet or skill API keys.
- Original recommendation: Run a one-token completion before writing provider keys in the wizard and in models.auth.set; extend validate-before-save to web-search, embeddings, wallet, skill API keys with a Test button beside every secret field.
- What the verifiers found: (skeptic: partially-confirmed / needs-change) "src/gateway/server-methods-list.ts:9 = `"channels.validate"`; desktop/renderer/src/components/channels/ChannelSetupDrawer.tsx:32 ('validate-before-save (channels.validate probes the draft live') and :85 call it - confirmed. KeyEntryModal: the claim that it 'calls models.auth.test before models.auth.set' is only half true. [...]" (reproducer: confirmed / needs-change) "src/gateway/server-methods-list.ts:9 `"channels.validate"`, :40 `"models.auth.test"`, :41 `"models.auth.set"`. desktop/renderer/src/components/channels/ChannelSetupDrawer.tsx:32 comment 'validate-befor [...]"
- Corrected statement / recommendation: Corrected statement: validate-before-save is enforced for channels; for model keys it is available (Test button) but optional - Save does not require a passing probe, and the gateway's models.auth.set never probes; the wizard does format validation only. Web-search/embeddings/wallet/skill keys have no UI entry fields at all. [...] (reproducer adds: Claim stands. Recommendation: (1) the UI already validates before save, but via a GET /models list probe (auth-probe.ts:113), not a completion; [...])

#### 4-07

- Verdict: claim **confirmed**; recommendation **needs-change**. Weight: medium. Anchor: `https://docs.openclaw.ai/start/wizard; https://docs.dify.ai/en/guides/model-configuration/readme; https://code.claude.com/docs/en/quickstart`
- Original claim: OpenClaw's guided onboarding (docs.openclaw.ai/start/wizard) tests a real completion and persists only the verified route; Dify validates provider keys before enabling a provider; Claude Code detects ANTHROPIC_API_KEY and asks the user to approve it.
- Original recommendation: Pattern 3: verify before you persist.
- What the verifiers found: (skeptic: confirmed / needs-change) "OpenClaw docs.openclaw.ai/start/wizard verbatim: 'Test the first detected candidate with a real completion. On failure, show the reason and continue to the next usable candidate.' and 'Persist only the verified model route and any credential/plugin state it requires. [...]" (reproducer: confirmed / sound) "OpenClaw wizard (docs.openclaw.ai/start/wizard): guided onboarding "Test[s] the first detected candidate with a real completion. [...]"
- Corrected statement / recommendation: Recommendation is directionally right but its premise is overstated: validate-before-save exists for channels and for the custom-API wizard path; for model keys the Test is optional in the UI and absent in both models.auth.set and the main CLI auth step (onboard-auth.ts). Corrected recommendation: (1) make models.auth.set call the same probe as models.auth.test and reject on failure (or return a warning the UI must confirm), (2) add the onboard-custom.ts verification routine to onboard-auth.ts for the standard provider choices, and only then (3) extend to [...]

#### 4-08

- Verdict: claim **partially-confirmed**; recommendation **needs-change**. Weight: medium. Anchor: `https://developers.home-assistant.io/docs/config_entries_config_flow_handler`
- Original claim: Home Assistant's ConfigFlow contract (developers.home-assistant.io/docs/config_entries_config_flow_handler) defines reserved steps user/discovery/reauth/reconfigure, async_set_unique_id for deduplication, and a strings.json with entries for every error and abort reason.
- Original recommendation: Pattern 4: a ChannelFlow contract per plugin (steps, uniqueId, strings map), one generic stepper in the Channels page, 'Needs re-authentication' badges, Reconfigure reopens prefilled; reuse in bitterbot onboard and configure --section channels (effort L).
- What the verifiers found: (reproducer: partially-confirmed / needs-change) "Fetched https://developers.home-assistant.io/docs/config_entries_config_flow_handler (page says 'Last updated on Jul 9, 2026'). Reserved steps: 'There are a few step names reserved for system use:' followed by a table of 13 names: bluetooth, discovery (DEPRECATED), dhcp, hassio, homekit, mqtt, ssdp, usb, user, reconfigure, zeroconf, reauth, import. [...]" (skeptic agrees: partially-confirmed / needs-change) "Fetched https://developers.home-assistant.io/docs/config_entries_config_flow_handler. [...]"
- Corrected statement / recommendation: Claim: HA reserves 13 step names (user, reauth, reconfigure, import, plus discovery-source steps bluetooth/dhcp/hassio/homekit/mqtt/ssdp/usb/zeroconf; 'discovery' is reserved but deprecated); async_set_unique_id + \_abort_if_unique_id_configured dedupe; strings.json holds config.step/error/abort maps and the docs say an error key 'needs to be existing in string.json', but the page does not formalize a 'every error and abort reason' rule. [...]

#### 4-10

- Verdict: claim **partially-confirmed**; recommendation **needs-change**. Weight: medium. Anchor: `https://www.home-assistant.io/integrations/labs/; https://developers.home-assistant.io/docs/development/labs/; [...]`
- Original claim: Home Assistant ships a Settings > System > Labs panel backed by a manifest with feedback/learn-more/report-issue URLs, runtime toggle without restart, and documented graduation/removal rules; OpenClaw has Settings > Agents & Tools > Labs with the phrase 'Experimental does not mean hidden'.
- Original recommendation: Pattern 5: Labs panel backed by a feature manifest with a lifecycle.
- What the verifiers found: (skeptic: confirmed / needs-change) "Fetched https://www.home-assistant.io/integrations/labs/: 'Go to Settings > System > Labs', links for feedback ('Share your experience with the community'), learn more, report issue. Fetched https://developers.home-assistant.io/docs/development/labs/: manifest preview_features fields feedback_url, learn_more_url, report_issue_url; [...]" (reproducer: partially-confirmed / sound) "Fetched https://www.home-assistant.io/integrations/labs/: 'Go to Settings > System > Labs.'; 'Optionally they include: Feedback link ... Documentation link ... Report issue link'; [...]"
- Corrected statement / recommendation: Recommendation adjustments: (1) derive requiresRestart from the existing reload rules in src/gateway/config-reload.ts instead of re-declaring it per entry; (2) the Labs manifest must not list circles.p2pDial (or any key absent from the strict zod schema) until finding #2 lands, otherwise `labs enable` writes a key that `doctor` deletes and the gateway refuses; [...] (reproducer adds: Claim holds except that the 'graduation/removal rules' are procedural checklists (remove from preview_features, drop async_is_preview_feature_enabled checks, run hassfest, announce) with no documented [...])

#### 4-12

- Verdict: claim **partially-confirmed**; recommendation **needs-change**. Weight: medium. Anchor: `https://developers.home-assistant.io/blog/2026/05/26/advanced-mode-config-flow-deprecation/; https://docs.openclaw.ai/gateway/configuration`
- Original claim: Home Assistant is deprecating its global show_advanced_options switch (blog post dated 2026-05-26 at developers.home-assistant.io/blog/2026/05/26/advanced-mode-config-flow-deprecation/), describing it as 'a single binary switch that gates unrelated features'; OpenClaw's uiHints distinguish common vs advanced fields.
- Original recommendation: Pattern 6: no global 'Advanced mode' switch; per-field common/advanced hints and collapsible groups.
- What the verifiers found: (reproducer: partially-confirmed / needs-change) "Fetched https://developers.home-assistant.io/blog/2026/05/26/advanced-mode-config-flow-deprecation/: title 'Deprecation of advanced mode in data entry flow', 'May 26, 2026 · One min read Erik Montnemery'. Exact sentence: 'The Advanced mode toggle in the user profile is a single binary switch that gates a collection of unrelated features across Home Assistant, from app (add-on) visibility (Terminal [...]" (skeptic: confirmed / needs-change) "Fetched https://developers.home-assistant.io/blog/2026/05/26/advanced-mode-config-flow-deprecation/: exists, dated May 26 2026, title 'Deprecation of advanced mode in data entry flow'; [...]"
- Corrected statement / recommendation: Claim: HA deprecated FlowHandler.show_advanced_options (removal in Core 2027.6) as part of a year-long effort to remove the profile-level Advanced mode toggle, which the post calls 'a single binary switch that gates a collection of unrelated features across Home Assistant'; OpenClaw uiHints advanced:true/false confirmed. Recommendation: the `advanced` hint slot exists but is unpopulated and unconsumed; [...] (skeptic adds: The 'already-declared advanced hint in schema.hints.ts (ADVANCED_PATHS)' does not exist; only the optional type field exists and no path sets it, and the renderer never renders uiHints at all, so this [...])

#### 4-13

- Verdict: claim **confirmed**; recommendation **needs-change**. Weight: medium. Anchor: `https://openwebui.com/blog/v0-11-0-the-interface-reorganized`
- Original claim: Open WebUI v0.11 merged the user settings modal and the admin panel into one searchable settings surface, with the release post stating 'two surfaces meant two mental models'.
- Original recommendation: Pattern 7: a search input in ConfigView filtering leaf paths from config.schema (title + description + dotted path) and deep-linking to the field; the same box from the sidebar reaches Models & Keys, Channels, P2P, raw config.
- What the verifiers found: (skeptic: confirmed / needs-change) "Fetched https://openwebui.com/blog/v0-11-0-the-interface-reorganized: exists, Open WebUI v0.11.0, published July 27 2026. Quotes: 'Settings used to be two worlds. v0.11.0 brings them together.'; 'Two surfaces meant two mental models, and one surface ends the guessing.'; admin panel 'moved into Settings under its own Admin section'; 'The search box at the top isn't new, but its reach is. [...]" (reproducer: confirmed / sound) "Fetched https://openwebui.com/blog/v0-11-0-the-interface-reorganized: title 'Open WebUI v0.11.0: The Interface, Reorganized', datePublished 2026-07-27T10:02:22Z. [...]"
- Corrected statement / recommendation: Scope the search to ConfigView leaf paths (title + help + dotted path from config.schema, which schema.hints.ts already computes) and make it depend on Pattern 6 (there is no rendered form to deep-link into today). The sidebar-wide box that 'reaches Models & Keys, Channels, P2P' needs a separate static route/keyword index because those views are not config.schema-backed; state that as a second, smaller item rather than folding it into the same M.

#### 4-15

- Verdict: claim **confirmed**; recommendation **needs-change**. Weight: medium. Anchor: `docs/gateway/configuration.md:321,474`
- Original claim: docs/gateway/configuration.md does not contain a one-paragraph precedence rule of the form 'CLI flag > env > bitterbot.json > default'; it only mentions array-of-files deep-merge order (line 321) and defers to /help/environment for precedence (line 474).
- Original recommendation: Add one paragraph to docs/gateway/configuration.md (CLI flag > env > bitterbot.json > default); generalize the Models & Keys 'source' badge to every ConfigView field; add 'bitterbot config explain <path>'; warning chip for unresolved ${VAR}.
- What the verifiers found: (reproducer: confirmed / needs-change) "docs/gateway/configuration.md:321 '- **Array of files**: deep-merged in order (later wins)' (the $include section); :474 'See [Environment](/help/environment) for full precedence and sources.' Full grep `-i -E 'precedence|takes priority|wins'` on the file yields only lines 321, 429 ('Neither file overrides existing env vars' about .env files) and 474. [...]" (skeptic agrees: confirmed / needs-change) "docs/gateway/configuration.md:321 = '- **Array of files**: deep-merged in order (later wins)'; [...]"
- Corrected statement / recommendation: Claim stands. Recommendation: do add the paragraph, but word it as the actual rule ('most settings come only from bitterbot.json; where a BITTERBOT\_\* env var exists it overrides the file; CLI flags override both for that invocation') rather than asserting a uniform four-tier chain that the code does not implement for most keys. 'Generalize the source badge to every ConfigView field' requires a new per-path provenance resolver (none exists outside models-auth.ts) and is materially more than the one-paragraph doc fix; keep them as separate items.

#### 4-16

- Verdict: claim **confirmed**; recommendation **needs-change**. Weight: medium. Anchor: `desktop/renderer/src/components/models/ModelsView.tsx:26`
- Original claim: The Models & Keys page already shows a which-source-wins provenance badge per provider credential (winningSource in desktop/renderer/src/components/models/ModelsView.tsx:26,112-113,253-255), but no other ConfigView field shows its winning source.
- Original recommendation: Generalize the Models & Keys 'source' badge to every ConfigView field.
- What the verifiers found: (reproducer: confirmed / needs-change) "desktop/renderer/src/components/models/ModelsView.tsx:26 '\* credential status with which-source-wins provenance, add/rotate/test/'; :112-113 `configured = authStatus.filter((p) => p.winningSource !== null)` / `unconfigured = ...=== null`; :253 `const hasCredentials = status.winningSource !== null;`; :255 shadow check `status.envPresent && ... !status.winningSource.startsWith("env")`; [...]" (skeptic agrees: confirmed / needs-change) "desktop/renderer/src/components/models/ModelsView.tsx:24-27 doc comment: 'per-provider credential status with w [...]"
- Corrected statement / recommendation: Claim confirmed as stated. Recommendation is sound in direction but understated in cost: there is no generic config-path provenance resolver to 'generalize'; models-auth.ts resolves only provider keys via the auth-profile/env chain. Generalizing requires a new resolver in src/config (file vs $include vs env-substitution vs runtime-override vs default) plus a new ConfigUiHint field; ConfigView's Form tab is a read-only key dump today, so the badge would land on a surface that also needs the form rebuild. [...]

#### 4-17

- Verdict: claim **partially-confirmed**; recommendation **needs-change**. Weight: medium. Anchor: `https://docs.openwebui.com/reference/env-configuration; https://code.claude.com/docs/en/settings; [...]`
- Original claim: Open WebUI's PersistentConfig seeds the DB from env on first launch and thereafter the UI value wins, controllable via ENABLE_PERSISTENT_CONFIG; Claude Code's /status shows 'Setting sources' and its docs publish a precedence table; Vaultwarden's admin-page docs warn that config.json overrides env.
- Original recommendation: Pattern 8: explicit precedence rule and a visible 'which source wins' tag per value.
- What the verifiers found: (skeptic: partially-confirmed / needs-change) "Open WebUI (https://docs.openwebui.com/reference/env-configuration/): 'for environment variables marked as ConfigVar, their values are persisted ... After the initial launch ... will no longer use the external environment variable values'; 'To disable this behavior and force Open WebUI to always use your environment variables (ignoring the database), set ENABLE_PERSISTENT_CONFIG to False'. [...]" (reproducer: confirmed / needs-change) "Open WebUI https://docs.openwebui.com/reference/env-configuration/: 'When launching Open WebUI for the first time, all environment variables are treated equally ... [...]"
- Corrected statement / recommendation: Claim: drop 'Claude Code shows which source wins per value'; its docs say /status lists loaded files only, and env vars sit outside its precedence stack. Recommendation: do not publish 'CLI flag > env > bitterbot.json > default' as one paragraph; it is contradicted by gateway token (config-first), model credentials (profiles-first per PLAN-37), and config.env (env-first). Either document the real per-class orders or land PLAN-37 Phase 2 D1 first and point the paragraph at docs/reference/secrets.md as PLAN-37 already specifies. [...] (reproducer adds: Claim stands. Recommendation needs one correction: Claude Code's /status shows which FILES loaded, not which source won per key (the doc says so explicitly), so cite it as a 'sources loaded' indicator, [...])

#### 4-18

- Verdict: claim **partially-confirmed**; recommendation **needs-change**. Weight: medium. Anchor: `src/gateway/server-methods/config.ts:32-35,283`
- Original claim: Bitterbot's config.patch handler (src/gateway/server-methods/config.ts:283) already computes a reload plan against reload rules (buildGatewayReloadPlan / resolveGatewayReloadSettings imported from src/gateway/config-reload.ts), but the hot-vs-restart classification is not exposed in config.schema nor rendered as a per-setting badge in the UI.
- Original recommendation: Expose the reload classification in config.schema (x-reload: hot|restart), render a 'restarts gateway' chip, show the post-save reload summary as a toast.
- What the verifiers found: (skeptic: partially-confirmed / needs-change) "src/gateway/server-methods/config.ts:31-35 imports buildGatewayReloadPlan, diffConfigPaths, resolveGatewayReloadSettings from ../config-reload.js; :283 opens 'config.patch'; :363-390 computes changedPaths/plan and responds with `reload: { mode: 'hot'|'none', changedPaths, hotReasons, noopPaths }` when no restart is needed -- CONFIRMED. src/gateway/config-reload.ts:52-113 holds prefix rules (e.g. [...]" (reproducer: confirmed / needs-change) "src/gateway/server-methods/config.ts:31-35 imports `buildGatewayReloadPlan, diffConfigPaths, resolveGatewayReloadSettings` from ../config-reload.js; :283 `"config.patch": async ...`; [...]"
- Corrected statement / recommendation: Claim: 'config.patch computes a hot/restart reload plan and returns it, but the Control UI saves via config.apply, which skips the plan and always schedules a SIGUSR1 restart, and ConfigView ignores the response.' Recommendation order should change: step 1 is to route ConfigView saves through config.patch (or make config.apply compute the same plan) and render the returned `reload`/`restart` object -- that alone removes the forced restart on every UI save. [...] (reproducer adds: Claim confirmed. Recommendation should be re-ordered: the 'post-save reload summary toast' is nearly free IF ConfigView switches from config.apply (always restarts, no plan in response) to config.patch [...])

#### 4-19

- Verdict: claim **partially-confirmed**; recommendation **sound**. Weight: low. Anchor: `https://www.librechat.ai/docs/configuration/librechat_yaml`
- Original claim: LibreChat requires 'docker compose down' for every librechat.yaml change (a documented pain point), while Open WebUI applies admin settings live.
- Original recommendation: Pattern 9: restart-required badge per setting; hot-apply everything else.
- What the verifiers found: (reproducer: partially-confirmed / sound) "LibreChat docs (librechat.ai/docs/configuration/librechat_yaml) fetched: "For Docker installs, editing librechat.yaml is not enough. The file must exist in the project root, be mounted into the API container, and LibreChat must be restarted before changes appear in the UI." with the restart given as "docker compose down && docker compose up -d"; local installs restart via npm run backend. [...]" (skeptic: confirmed / sound) "LibreChat docs (https://www.librechat.ai/docs/configuration/librechat_yaml, fetched 2026-08-21): "For Docker installs, editing librechat.yaml is not enough ... [...]"
- Corrected statement / recommendation: Claim should read: LibreChat docs require a full restart (docker compose down && up -d) for any librechat.yaml change; Open WebUI persists ConfigVar (formerly PersistentConfig) settings edited from the Admin UI, which take precedence over env. Recommendation stands and is cheap because the hot/restart classification already exists in config-reload.ts; add that unmatched prefixes currently default to restart, so exposing x-reload will label p2p._, memory._, a2a.\* etc. as restart until rules are added, which is a coverage audit the pattern should include. (skeptic adds: Minor: Open WebUI has renamed the mechanism from 'PersistentConfig' to 'ConfigVar' in current docs. Implementation caveat for Pattern 9: any config prefix not listed in BASE_RELOAD_RULES (e.g. [...])

#### 4-20

- Verdict: claim **confirmed**; recommendation **needs-change**. Weight: high. Anchor: `src/gateway/server-methods-list.ts:62-63`
- Original claim: There is no doctor RPC in the gateway method list (src/gateway/server-methods-list.ts has update.run and update.check but no 'doctor.\*' method), no Repairs cards on the Overview page, and no 'bitterbot doctor --list/--run <check>' or 'bitterbot bugreport' CLI commands.
- Original recommendation: RPC over doctor findings; Repairs cards on Overview next to UpdateCard (severity, why, Fix or Show me how); sidebar badge; bitterbot doctor --list/--run <check>; bitterbot bugreport.
- What the verifiers found: (skeptic: confirmed / needs-change) "src/gateway/server-methods-list.ts: 185 method strings, lines 62-63 are `"update.run"`, `"update.check"`; `grep -n doctor|backup|repair|bugreport` over the whole file returns nothing. The only doctor-adjacent RPC is `agent.runtime.health` (src/gateway/server-methods/agent-runtime.ts:11 'Used by `bitterbot doctor` (when the gateway is up)'), i.e. the gateway serves doctor, not the reverse. [...]" (reproducer agrees: confirmed / needs-change) "Reproduced from scratch. `grep -n "doctor\|update\." src/gateway/server-methods-list.ts` -> only lines 62 `"upd [...]"
- Corrected statement / recommendation: Claim stands. Recommendation should build on existing infrastructure the report omits: (1) `bitterbot doctor --json` already emits a machine-readable findings report (register.maintenance.ts:29-32, doctor-json-emit), and update.run already shells out to `doctor --non-interactive` (src/cli/update-cli/update-command.ts:185-187) - the RPC should spawn `doctor --json --non-interactive` as a subprocess and relay that JSON, not re-implement checks in-process (doctor probes gateway health from outside, runs a model round-trip and agent-turn probe, and writes con [...]

#### 4-21

- Verdict: claim **confirmed**; recommendation **needs-change**. Weight: medium. Anchor: `https://www.home-assistant.io/integrations/repairs/; https://docs.gitea.com/administration/command-line; https://tailscale.com/kb/1080/cli`
- Original claim: Home Assistant has a Settings > System > Repairs surface; Gitea offers 'doctor check --list/--run/--fix'; Vaultwarden's admin Diagnostics page generates a support string; Tailscale's CLI has a 'bugreport' command that emits a marker.
- Original recommendation: Pattern 10: doctor findings as a badge-counted Repairs list with per-item fix buttons.
- What the verifiers found: (skeptic: confirmed / needs-change) "HA Repairs (https://www.home-assistant.io/integrations/repairs/): located at Settings > System > Repairs; "the number of issues pending in the repairs dashboard is shown in the sidebar on the 'Settings' menu item"; each issue offers a fix from the dashboard or instructions. [...]" (reproducer: confirmed / sound) "Home Assistant (home-assistant.io/integrations/repairs/): "You can find the Home Assistant Repairs dashboard in Settings > System > Repairs"; [...]"
- Corrected statement / recommendation: The `--fix` half of the proposed CLI already exists (register.maintenance.ts:21-22, docs/cli/doctor.md:30); only `--list`/`--run <check>` and `bugreport` are new. Also note that several doctor checks (service scanning via --deep, launchctl/systemd repair, keychain prompts) run on the CLI host and cannot be executed from a gateway RPC, so the Repairs RPC should wrap the --json finding set, not the interactive repair flow; per-item Fix buttons will only work for checks whose repair is a config write or gateway-side action.

#### 4-22

- Verdict: claim **partially-confirmed**; recommendation **sound**. Weight: medium. Anchor: `https://docs.letta.com/guides/agents/memory-blocks; https://support.claude.com/en/articles/11817273-using-claude-s-memory-feature; [...]`
- Original claim: Letta memory blocks have label/description/value/limit with a char-count-vs-limit display and a context-window viewer; Claude.ai Settings > Memory shows a categorized summary with Pause, Reset and incognito chats; ChatGPT shows a 'Memory updated' chip and per-chat memory controls.
- Original recommendation: Pattern 11: Memory page presenting the canonical layer as 'About you', 'How you like to work', 'Current projects', 'Standing decisions' with fill bar and 'Last changed by'; Pause memory, Reset with typed confirm, per-session Incognito; 'Memory updated: <block>' chip; [...]
- What the verifiers found: (skeptic: partially-confirmed / sound) "Letta (https://docs.letta.com/guides/agents/memory-blocks): fields label ("a unique identifier for the block"), description, value, limit ("the size limit (in characters) of the block"), plus read_only; the prompt-representation example shows `chars_current=128 chars_limit=5000`. [...]" (reproducer: confirmed / sound) "Letta memory-blocks docs: fields label, description, value, limit ("the size limit (in characters) of the block"), read_only; block metadata rendered as "chars_current=128 chars_limit=5000". [...]"
- Corrected statement / recommendation: Claim text should read: Letta exposes label/description/value/limit and reports chars_current vs chars_limit to the agent; the ADE has a context-window viewer (display of counts in the viewer is not stated in primary docs). ChatGPT's 'Memory updated' chip is documented in OpenAI's announcement, not at the cited learn.chatgpt.com anchor, which only documents `/memories` per-chat control. [...] (reproducer adds: Minor: the four block names (About you / How you like to work / Current projects / Standing decisions) are the audit's own design, not drawn from any of the three sources; [...])

#### 4-23

- Verdict: claim **confirmed**; recommendation **needs-change**. Weight: medium. Anchor: `desktop/renderer/src/components/`
- Original claim: desktop/renderer/src/components contains 26 component directories (agents, channels, chat, circles, config, cowork, cron, debug, dreams, first-run, guards, instances, layout, logs, management, models, nodes, overview, p2p, projects, sessions, skills, ui, usage, wallet, workspace), not the 27 the report states.
- Original recommendation: Collapse the component dirs into Chat; Memory; Agent; Connections; Privacy & Security; System; mirror as 'configure --section <group>' and docs.json tabs.
- What the verifiers found: (skeptic: confirmed / needs-change) "`ls -d desktop/renderer/src/components/*/ | wc -l` = 26; listing: agents channels chat circles config cowork cron debug dreams first-run guards instances layout logs management models nodes overview p2p projects sessions skills ui usage wallet workspace; `find ... -maxdepth 1 -type f` returns no loose files; [...]" (reproducer agrees: confirmed / needs-change) "`ls -d desktop/renderer/src/components/*/ | wc -l` -> 26; names: agents channels chat circles config cowork cro [...]"
- Corrected statement / recommendation: Count is 26, not 27. The recommendation conflates three different things: component source directories (ui, guards, layout, first-run, debug, chat/tool-views are code organisation, not settings pages), the sidebar navigation IA, and CLI/docs grouping. Restate as: regroup the Sidebar nav (components/layout/Sidebar.tsx) into Chat / Memory / Agent / Connections / Privacy & Security / System, leave the component directory tree alone (renaming 26 dirs is churn with no user-visible effect), and align the existing `configure --section` names and the existing doc [...]

#### 4-25

- Verdict: claim **partially-confirmed**; recommendation **needs-change**. Weight: high. Anchor: `src/cli/ (no backup command); ~/.bitterbot/bitterbot.json.bak-pre-*`
- Original claim: Bitterbot has no 'bitterbot backup' CLI command, no Settings > Backup UI, and no scheduled backup; the user's ~/.bitterbot directory holds 4 ad-hoc bitterbot.json.bak-pre-\* files (e.g. bitterbot.json.bak-pre-a2a-payment, bitterbot.json.bak-pre-circles-20260709-122212, bitterbot.json.bak-pre-ingest-policy).
- Original recommendation: Add 'bitterbot backup [--out] [--skip-memory|--skip-keys]' producing one tar.zst (bitterbot.json, agents/, checkpoints, memory DBs via online backup, keys encrypted with printed passphrase); nightly via cron keep-14; Settings > Backup with Restore and pre-restore snapshot; [...]
- What the verifiers found: (skeptic: partially-confirmed / needs-change) "No backup command: src/cli/program/command-registry.ts has no backup entry; `grep -rni backup src/cli` hits only src/cli/browser-cli-extension.ts:57 (renames an old browser extension dir). No Settings > Backup: `grep -rli backup desktop/renderer/src` hits only circles/FrozenCircleBanner.tsx (unrelated). [...]" (reproducer: confirmed / needs-change) "`grep -rn 'command("backup"' src/cli/` and `grep backup src/cli/program/command-registry.ts` -> zero hits; `ls src/cli src/commands | grep -i backup` -> nothing. [...]"
- Corrected statement / recommendation: Corrected statement: there is no user-facing backup/restore command, UI, or schedule, but config already has automatic 5-deep .bak rotation and updates already get a git-level rollback point; the ad-hoc files are manual operator copies, not a product gap in config backup per se. Recommendation changes: (a) 'Create a restore point before updates' is already done for code (auto-rollback watchdog) - scope it to data (memory DBs, agents/, workspace). [...] (reproducer adds: Claim is accurate (4 bitterbot.json.bak-pre-\* files; 5 if you count genesis-trust.txt). Recommendation premise holds, but scope it: config already has a 5-deep rotation (backup-rotation.ts), so the rea [...])

#### 4-26

- Verdict: claim **partially-confirmed**; recommendation **needs-change**. Weight: medium. Anchor: `https://docs.immich.app/administration/backup-and-restore; https://docs.gitea.com/administration/backup-and-restore; [...]`
- Original claim: Immich runs nightly DB dumps keeping 14 with UI restore and an automatic restore point; Gitea has 'gitea dump'; Vaultwarden has a 'vaultwarden backup' command using SQLite's online backup API; Coolify has Settings > Backup with a scope note; Home Assistant Labs takes a one-click backup before enabling a preview feature.
- Original recommendation: Pattern 14: built-in scoped backup with scheduled runs, UI restore, restore points, and a snapshot before risky toggles.
- What the verifiers found: (skeptic: partially-confirmed / needs-change) "Immich (https://docs.immich.app/administration/backup-and-restore): default "keep last 14 backups, create daily at 2:00 AM", restore via Administration > Maintenance, and "a restore point is automatically created before the operation begins, allowing rollback if the restore fails" (restore point is pre-restore, not pre-upgrade). [...]" (reproducer: partially-confirmed / sound) "Immich backup-and-restore docs: default "keep last 14 backups, create daily at 2:00 AM" (claim says nightly; equivalent); UI restore at "Administration > Maintenance" > "Restore database backup"; [...]"
- Corrected statement / recommendation: Vaultwarden's `backup` uses `VACUUM INTO`, not the online backup API; cite it as 'VACUUM INTO' or drop the parenthetical. Immich's automatic restore point is taken before a restore, not before upgrades. Recommendation adjustments: (1) Bitterbot has at least four live WAL-mode SQLite files under ~/.bitterbot (checkpoints.sqlite, event-journal.sqlite, tasks.sqlite, memory/\*) so a consistent snapshot needs better-sqlite3's db.backup() or VACUUM INTO through the open handles in the gateway, not a file copy from a CLI that may run while the gateway is up; [...] (reproducer adds: Claim: Immich default is daily at 02:00 keeping 14 (nightly is fine); Vaultwarden's wiki recommends the SQLite Online Backup API via sqlite3 .backup and separately ships a built-in `vaultwarden backup` [...])

#### 4-27

- Verdict: claim **partially-confirmed**; recommendation **needs-change**. Weight: high. Anchor: `desktop/renderer/src/components/overview/UpdateCard.tsx; src/config/zod-schema.ts:154`
- Original claim: Bitterbot already has in-UI update with drift prompts (desktop/renderer/src/components/overview/UpdateCard.tsx, update.run/update.check RPCs at src/gateway/server-methods-list.ts:62-63) and auto-rollback (update.autoRollback in src/config/zod-schema.ts:154), but no release channel selector (stable/beta), no 'breaking' flag in the release manifest, no backup-before-update toggle, [...]
- Original recommendation: Add channel selector (stable/beta) in Settings > Updates; 'breaking' flag in the release manifest that blocks one-click update until notes are opened; 'Back up before updating' default on once #14 exists; gateway and orchestrator as separately updatable rows; 24 h snooze; [...]
- What the verifiers found: (reproducer: partially-confirmed / needs-change) "Confirmed parts: desktop/renderer/src/components/overview/UpdateCard.tsx exists, calls 'update.check' (:76) and 'update.run' (:97), shows '{behind} commits behind' (:172) and 'Update now' (:242); src/gateway/server-methods-list.ts:62-63 list 'update.run', 'update.check'; src/config/zod-schema.ts:154-159 `autoRollback: z.object({ enabled })`; [...]" (skeptic agrees: partially-confirmed / needs-change) "Present as claimed: desktop/renderer/src/components/overview/UpdateCard.tsx (267 lines) + layout/UpdateBanner.t [...]"
- Corrected statement / recommendation: Corrected statement: Bitterbot already has update.channel (stable/beta/dev) in config + CLI + gateway RPC, an update.checkOnStart=false kill switch, a per-sha banner dismiss, and auto-rollback; what is missing is a UI channel selector, a timed (24 h) snooze, a 'breaking' manifest flag, a backup-before-update toggle, and a separate orchestrator update row. Corrected recommendation: (a) channel selector = thin UI over existing config.update.channel via config.patch, small; [...]

#### 4-28

- Verdict: claim **partially-confirmed**; recommendation **needs-change**. Weight: medium. Anchor: `https://docs.immich.app/administration/system-settings; https://www.home-assistant.io/common-tasks/os/; https://tailscale.com/kb/1067/update; [...]`
- Original claim: Immich's Version Check distinguishes Stable vs RC; Home Assistant's Updates page has a backup toggle and requires reading release notes between versions; Tailscale shows grey vs red update arrows for feature vs security updates; LM Studio (v0.3.6 blog) updates the app and LLM runtimes on separate clocks with release notes.
- Original recommendation: Pattern 15: in-app update with release channel, breaking-change gate, backup-before-update toggle, and security-vs-feature badge.
- What the verifiers found: (skeptic: partially-confirmed / needs-change) "Immich: the cited system-settings page only says Version Check "will periodically make requests to GitHub to check for new releases" with no Stable/RC distinction; the distinction is real but documented in the v3.0.0 release post (https://immich.app/blog/v3.0.0-release): "you can change the release channel from 'Stable' to 'Release candidate' in the Admin settings > Version check options". [...]" (reproducer: confirmed / needs-change) "Immich: the cited system-settings page only says Version Check "will periodically make requests to GitHub to check for new releases" with no RC mention; [...]"
- Corrected statement / recommendation: Claim: attribute the Immich Stable/RC channel to the v3.0.0 release notes, not the system-settings page; drop 'with release notes' from the LM Studio runtime-update sentence. Recommendation: the proposed `update.checkEnabled` kill switch duplicates the existing `update.checkOnStart` (types.bitterbot.ts:68-69) and the channel selector only needs UI over the existing `update.channel`; [...] (reproducer adds: Anchor fix: cite the Immich v3.0.0 blog for Stable vs RC, not system-settings. Recommendation: the channel selector is a UI exposure of the existing update.channel config key and `bitterbot update --ch [...])

#### 4-29

- Verdict: claim **confirmed**; recommendation **needs-change**. Weight: high. Anchor: `.github/workflows/; release-please-config.json (absent)`
- Original claim: The repo has no release-please-config.json or .release-please-manifest.json, and none of the four workflows (.github/workflows/ci.yml, desktop-release.yml, orchestrator-release.yml, skill-review.yml) use actions/attest-build-provenance or cosign.
- Original recommendation: Add release-please-config.json for '.', 'orchestrator' (orchestrator-v) and 'desktop' (desktop-v); actions/attest-build-provenance + cosign bundle in orchestrator/desktop/docker workflows; installer verifies sha256 from checksums.txt.
- What the verifiers found: (skeptic: confirmed / needs-change) "`ls release-please-config.json .release-please-manifest.json` -> both 'No such file'; `git ls-files | grep -i release-please` empty. `grep -rn -i 'attest-build-provenance|cosign|release-please|minisign' .github/` returns hits only in orchestrator-release.yml and only for minisign (6); zero matches for attest-build-provenance or cosign in any of the four workflows. Could not refute. [...]" (reproducer agrees: confirmed / needs-change) "`ls -la release-please-config.json .release-please-manifest.json` -> both 'No such file or directory'; [...]"
- Corrected statement / recommendation: Claim confirmed. Recommendation needs changes: (1) the 'desktop' component with `desktop-v` tags is not ready for release-please, desktop-release.yml derives the version from desktop/src-tauri/tauri.conf.json (0.1.0, `:4-5` comment) while desktop/package.json is 2026.2.15, so release-please's node strategy on `desktop` would bump the wrong file unless `extra-files` targets tauri.conf.json; and the desktop workflow is dormant/half-built (audit line 1223), scope it out of the first config. [...]

#### 4-30

- Verdict: claim **partially-confirmed**; recommendation **needs-change**. Weight: high. Anchor: `package.json:194,235-240`
- Original claim: package.json lists playwright 1.58.2 under 'dependencies' (line 194, not devDependencies), node-llama-cpp 3.15.1 under devDependencies (line 236) and @napi-rs/canvas ^0.1.89 under devDependencies (line 235), with both also declared as peerDependencies, and there is no optionalDependencies block.
- Original recommendation: Move playwright to devDependencies, node-llama-cpp/canvas to optionalDependencies, add 'bitterbot browser install' on demand; doctor lines for 'browser available', 'local LLM available', 'native deps loaded'.
- What the verifiers found: (skeptic: partially-confirmed / needs-change) "package.json:194 `"playwright": "1.58.2"` and :195 `"playwright-core": "1.58.2"` are inside `"dependencies"` (145-209): CONFIRMED. `"devDependencies"` spans 210-233 and ends with vitest; `"peerDependencies"` begins at 234 and contains exactly `"@napi-rs/canvas": "^0.1.89"` (235) and `"node-llama-cpp": "3.15.1"` (236). [...]" (reproducer agrees: partially-confirmed / needs-change) "package.json:194 `"playwright": "1.58.2"` sits inside `dependencies` (section 145-209) alongside `playwright-co [...]"
- Corrected statement / recommendation: Corrected statement: playwright 1.58.2 is in dependencies (line 194); node-llama-cpp (236) and @napi-rs/canvas (235) are in peerDependencies ONLY, not devDependencies; no optionalDependencies. Corrected recommendation: (1) the `playwright` meta-package is unused by runtime code (only playwright-core is imported) and has no postinstall, so simply remove it (or move to devDependencies) and keep playwright-core in dependencies, since src/browser is runtime code; [...]

### 4b. Deep-research corroboration

19 item(s) changed in this section (of 19 verified).

#### 4b-01

- Verdict: claim **confirmed**; recommendation **needs-change**. Weight: low. Anchor: `docs/reviews/v1-release-audit-2026-08-21.md:532`
- Original claim: A separate deep-research workflow ran in parallel with the audit with these statistics: 110 agents, 6 search angles, 27 primary sources fetched, 131 claims extracted, top 25 put through 3-vote adversarial verification yielding 20 confirmed and 5 refuted.
- Original recommendation: Treat section 4b claims as stricter than section 4 because each survived three independent refutation attempts.
- What the verifiers found: (reproducer: confirmed / needs-change) "The workflow's output file exists at /tmp/claude-1000/-mnt-d-Bitterbot-bitterbot-desktop/8c1f3492-28a9-4595-a5af-ac83b5872728/scratchpad/deep-research.json (32,535 bytes, mtime Aug 21 14:49, i.e. 48 min before the audit doc's 15:37 mtime). [...]" (skeptic agrees: confirmed / needs-change) "Run record ~/.claude/projects/-mnt-d-Bitterbot-bitterbot-desktop/8c1f3492-28a9-4595-a5af-ac83b5872728/workflows [...]"
- Corrected statement / recommendation: Statistics stand as written (note: 110 agent calls, not 110 distinct agents). Corrected recommendation: treat section 4b as a second, independent pass with a different failure mode, not as strictly stronger evidence. Two HA sub-claims are 2-1, and the same 3-vote verifier produced at least two false refutations against primary sources, so 4b's confirmations and refutations should both be spot-checked against the cited URL before being used as decision inputs (as done here).

#### 4b-02

- Verdict: claim **partially-confirmed**; recommendation **needs-change**. Weight: medium. Anchor: `docs/reviews/v1-release-audit-2026-08-21.md:532`
- Original claim: The deep-research workflow found no surviving evidence on status/health pages, update flows, activity feeds, versioning, release automation, or artifact signing, and no evidence tying any pattern to adoption metrics; none of Immich, Coolify, n8n, LibreChat, AnythingLLM, LM Studio, Letta, Khoj, or Dify are represented in the verified claims.
- Original recommendation: For those areas, section 4 (single-agent research) is the only input and should be weighted accordingly; treat the 'correlated with adoption' framing as unanswered.
- What the verifiers found: (reproducer: partially-confirmed / needs-change) "From deep-research.json: `caveats` contains verbatim 'Part (4) (status/health page, update flow, activity feed vs logs, docs information architecture) and part (5) (versioning scheme, release automation, artifact signing) have NO surviving claims; [...]" (skeptic: partially-confirmed / sound) "Verified-claims table (docs/reviews/v1-release-audit-2026-08-21.md:536-546): grep for Immich|Coolify|n8n|LibreChat|AnythingLLM|LM Studio|Letta|Khoj|Dify returns only one hit, 'dify' inside 'modify' (ro [...]"
- Corrected statement / recommendation: Corrected statement: section 4b contains no VERIFIED claims on status/health, updates, activity feeds, versioning, release automation, signing, or adoption, and none of the nine named products appear in its 8 findings; however, Immich (4 sources), Coolify (1) and n8n (2) WERE fetched and ~50 claims on those angles were extracted but dropped by the top-25 verification budget, not refuted. Corrected recommendation: for those areas do not simply fall back to section 4; [...] (skeptic adds: Reword 'none of those products are represented at all' to 'none produced a surviving verified claim (Immich's config-file doc was fetched but nothing from it was verified)'. Recommendation is sound; [...])

#### 4b-03

- Verdict: claim **confirmed**; recommendation **needs-change**. Weight: high. Anchor: `https://v2.tauri.app/develop/sidecar/`
- Original claim: Tauri 2 ships sidecar binaries inside the signed desktop installer via `bundle.externalBin` in tauri.conf.json, and every sidecar must be staged as one file per target triple named `name-$TARGET_TRIPLE[.exe]` (e.g. `my-sidecar-x86_64-pc-windows-msvc.exe`, `my-sidecar-aarch64-apple-darwin`), per https://v2.tauri.app/develop/sidecar/ and https://v2.tauri.app/reference/config/.
- Original recommendation: D1/D5 packaging: if Tauri ships post-V1, the orchestrator goes in `bundle.externalBin` with one binary per target triple from the release matrix.
- What the verifiers found: (skeptic: confirmed / needs-change) "External: https://v2.tauri.app/develop/sidecar/ says "To bundle the binaries of your choice, you can add the externalBin property to the bundle object in your tauri.conf.json" and "a binary with the same name and a -$TARGET_TRIPLE suffix must exist on the specified path", with examples my-sidecar-x86_64-unknown-linux-gnu, my-sidecar-aarch64-apple-darwin, my-sidecar-x86_64-pc-windows-msvc.exe. [...]" (reproducer agrees: confirmed / needs-change) "Fetched https://v2.tauri.app/develop/sidecar/: "To bundle the binaries of your choice, you can add the `externa [...]"
- Corrected statement / recommendation: The Tauri mechanics are correct, but the repo already implements the per-triple externalBin pipeline for the gateway SEA (tauri.conf.json:38, build-sea.mjs, desktop-release.yml matrix), so "one binary per target triple from the release matrix" is already done for the existing sidecar. Putting the orchestrator in externalBin is the wrong slot for this architecture: Tauri never spawns the orchestrator (main.rs:10-12); the Node gateway does, via a fixed-name lookup (orchestrator-binary.ts:44-69). [...]

#### 4b-04

- Verdict: claim **partially-confirmed**; recommendation **needs-change**. Weight: medium. Anchor: `https://github.com/tauri-apps/tauri/issues/11992`
- Original claim: tauri-apps/tauri issue #11992 (https://github.com/tauri-apps/tauri/issues/11992) is an open bug about macOS sidecar notarization, current as of 2026-08-21.
- Original recommendation: Budget for tauri#11992 (macOS sidecar notarization) before promising a signed DMG.
- What the verifiers found: (skeptic: partially-confirmed / needs-change) "`gh api repos/tauri-apps/tauri/issues/11992` on 2026-08-21: state=open, title "[bug] MacOS - Codesigning and notarization issue when using ExternalBin", created 2024-12-17, updated_at 2024-12-23, closed_at null, labels ["type: bug","status: needs triage"], comments=1. [...]" (reproducer agrees: partially-confirmed / needs-change) "`gh api repos/tauri-apps/tauri/issues/11992`: title "[bug] MacOS - Codesigning and notarization issue when usin [...]"
- Corrected statement / recommendation: The issue is nominally open but it is a single untriaged, unconfirmed report with zero maintainer engagement since Dec 2024 ("status: needs triage", 1 comment from the reporter himself); calling it "current as of 2026-08-21" overstates it. Jan notarizes a Tauri 2 app with two externalBin sidecars every release, and tauri-bundler explicitly signs sidecars before the app, so sidecar notarization is not a known blocker. [...]

#### 4b-05

- Verdict: claim **confirmed**; recommendation **needs-change**. Weight: medium. Anchor: `desktop/src-tauri/tauri.conf.json:38`
- Original claim: The repo's desktop/src-tauri/tauri.conf.json already declares `bundle.externalBin: ["binaries/bitterbot-gateway"]` (line 38), i.e. the Tauri sidecar mechanism is already used for the gateway binary, not for the Rust orchestrator.
- Original recommendation: If Tauri ships post-V1, the orchestrator goes in `bundle.externalBin` with one binary per target triple.
- What the verifiers found: (reproducer: confirmed / needs-change) "`cat -n desktop/src-tauri/tauri.conf.json` line 38: `"externalBin": ["binaries/bitterbot-gateway"],` (exact line number matches). Introduced by commit d7e95a5 (2026-04-20, VGIL77, 'feat(desktop): externalBin, updater config, capabilities, entitlements'; message: 'bundle.externalBin: ["binaries/bitterbot-gateway"] so the bundler picks up the SEA sidecar produced by scripts/build-sea.mjs'). [...]" (skeptic agrees: confirmed / needs-change) "desktop/src-tauri/tauri.conf.json:38 `"externalBin": ["binaries/bitterbot-gateway"]` (added in commit d7e95a5 ' [...]"
- Corrected statement / recommendation: Claim stands, with the caveat that externalBin is declared and built in CI but main.rs still spawns `node` from PATH (TODO at main.rs:63) rather than calling the sidecar API, so 'already used' means 'already declared and staged', not 'already launched via the sidecar mechanism'. Recommendation adjustment: adding the orchestrator to bundle.externalBin is only half the work; [...]

#### 4b-06

- Verdict: claim **partially-confirmed**; recommendation **sound**. Weight: medium. Anchor: `https://github.com/janhq/jan/issues/4485`
- Original claim: Jan (janhq/jan) migrated from Electron to Tauri in 2025 explicitly because of installer bloat (Electron bundling Chromium/Node, worsened by a macOS universal build) and inability to scale to mobile, per https://github.com/janhq/jan/issues/4485 and https://github.com/janhq/jan/issues/3735; [...]
- Original recommendation: D1: keep Tauri post-V1; Jan is the closest precedent.
- What the verifiers found: (skeptic: partially-confirmed / sound) "`gh api repos/janhq/jan/issues/4485`: title "roadmap: Jan supports Tauri as an alternative build option", created 2025-01-20, closed 2025-05-20. Body Problems: "Electron app size has become really big. Now, Jan has shipped a universal build, which is even bigger." and "Electron embeds Chromium and Node.js, which are not suitable for scaling to mobile platforms. See more in #3735". [...]" (reproducer: confirmed / sound) "`gh api repos/janhq/jan/issues/4485` (title "roadmap: Jan supports Tauri as an alternative build option", created 2025-01-20, closed 2025-05-20) body: "Electron app size has become really big. [...]"
- Corrected statement / recommendation: Migration motive and Mar 31 decision text are accurately quoted, but two corrections: (1) #3735 does not itself say anything about Electron; the Electron/mobile link is only in #4485's body. (2) The size benefit is NOT merely vendor-stated; it is directly measurable from Jan's own release assets (Windows installer 1214 MB -> 55 MB, AppImage 1495 MB -> 150 MB, DMG 231 MB -> 97 MB between the last Electron release v0.5.17 and v0.8.4). Only the memory/CPU and security claims remain unmeasured. [...] (reproducer adds: Minor: the 'inability to scale to mobile' rationale is stated in #4485 only; #3735 is the general mobile/desktop/server architecture goal and does not mention Electron. Otherwise accurate.)

#### 4b-07

- Verdict: claim **partially-confirmed**; recommendation **needs-change** (tiebreak). Weight: high. Anchor: `https://github.com/janhq/jan/issues/4485`
- Original claim: Jan's shipped Tauri builds are still 55-200 MB because the llama.cpp/cortex inference sidecar dominates the installer size.
- Original recommendation: D1: keep Tauri post-V1; Bitterbot would carry Node + Chromium/Playwright + the Rust sidecar, so the size win is not there.
- What the verifiers found: (reproducer: partially-confirmed / needs-change) "Size range re-derived from `gh api repos/janhq/jan/releases/latest` (v0.8.4, 2026-07-23): Jan_0.8.4_x64-setup.exe 55 MB, Jan_0.8.4_amd64.deb 82 MB, Jan_0.8.4_universal.dmg 97 MB, Jan_0.8.4_amd64.AppImage 150 MB. So current builds are 55-150 MB; the 200 MB upper bound is only reached by v0.6.0 (Jan_0.6.0_universal.dmg 208 MB, x64-setup.exe 389 MB, amd64.deb 927 MB, AppImage 1016 MB). [...]" (skeptic: refuted / needs-change) "`gh api 'repos/janhq/jan/releases?per_page=3'` today: v0.8.4 (2026-07-23) x64-setup.exe 55 MB, deb 82 MB, universal dmg 97 MB, AppImage 150 MB; v0.8.3 and v0.8.2 within 1-2 MB of those. [...]" (tiebreak: partially-confirmed / needs-change) "Independently re-derived. (1) Sizes: `gh api repos/janhq/jan/releases?per_page=3` -> v0.8.4 (2026-07-23): x64-setup.exe 55 MB, amd64.deb 82 MB, universal.dmg 97 MB, AppImage 150 MB; v0.8.3 and v0.8.2 within 1-2 MB of those. [...]"
- Corrected statement / recommendation: Tiebreak: the size range is roughly right (55 MB floor exact; current ceiling is 150 MB, not 200 MB), but the load-bearing causal clause is refuted, so label it partially-confirmed and do NOT cite the cause. Corrected statement: Jan's current Tauri builds (v0.8.4) are 55-150 MB (55 MB Windows NSIS, 82 MB deb, 97 MB universal DMG, 150 MB AppImage). The installer is not dominated by a llama.cpp/cortex inference sidecar: cortex was removed after v0.6.0, and llama.cpp backends (and models) are downloaded on first run by the llamacpp extension. [...]

#### 4b-08

- Verdict: claim **partially-confirmed**; recommendation **sound**. Weight: low. Anchor: `https://github.com/tauri-apps/tauri/issues/5889`
- Original claim: Independent measurements show Tauri memory usage on Linux WebKitGTK exceeds Electron (cited via https://github.com/tauri-apps/tauri/issues/5889), partly contradicting Jan's vendor-stated Tauri benefits.
- Original recommendation: Do not cite Jan's Tauri benefits as measured; D1 keep Tauri post-V1.
- What the verifiers found: (reproducer: partially-confirmed / sound) "`gh api repos/tauri-apps/tauri/issues/5889`: title "Memory benchmark might be incorrect: Tauri might consume more RAM than Electron", opened 2022-12-21 by jviotti, closed 2024-05-17 with the author's comment "I'm no longer involved with Electron and this was more of a discussion with no specific action items, so closing this issue!". [...]" (skeptic agrees: partially-confirmed / sound) "`gh api repos/tauri-apps/tauri/issues/5889`: title "Memory benchmark might be incorrect: Tauri might consume mo [...]"
- Corrected statement / recommendation: Corrected statement: a single 2022 measurement by an Electron-affiliated engineer (tauri#5889, closed 2024-05-17 as a discussion with no action items) found Tauri using more RAM than Electron for real web apps on all three desktop OSes (not only Linux/WebKitGTK), with the Linux gap largest; for minimal default apps the Ubuntu PSS figure favored Tauri (185 vs 207 MB). It is anecdotal, not 'independent measurements' plural. The recommendation (do not cite Jan's Tauri memory/size benefits as measured) is sound and is if anything strengthened.

#### 4b-09

- Verdict: claim **partially-confirmed**; recommendation **needs-change**. Weight: high. Anchor: `https://github.com/ollama/ollama/blob/main/scripts/install.sh`
- Original claim: Ollama's install script at https://github.com/ollama/ollama/blob/main/scripts/install.sh (served at https://ollama.com/install.sh) is a single POSIX sh script that wraps all logic in a main() function invoked on the last line, downloads a prebuilt per-arch tarball (ollama-linux-{amd64,arm64}.tar.zst with .tgz fallback) into $PREFIX/lib/ollama and symlinks into PATH on Linux, or [...]
- Original recommendation: P0 WP4 `install.sh`: copy the shape literally: `main()` guard, per-arch tarball or pinned git ref, zero questions.
- What the verifiers found: (skeptic: partially-confirmed / needs-change) "install.sh fetched today: header comment L5-6 "Wrap script in main function so that a truncated partial download doesn't end up executing half a script", `main() {` L7, closing `}` L453, bare `main` on last line L455; `curl -sL https://ollama.com/install.sh | diff - ollama.sh` => IDENTICAL. Arch map L35-39 (x86_64->amd64, aarch64|arm64->arm64). [...]" (reproducer: confirmed / sound) "Fetched raw script and `curl -sI -L https://ollama.com/install.sh`: 307 -> github.com/ollama/ollama/releases/latest/download/install.sh -> 302 -> releases/download/v0.32.15/install.sh; [...]"
- Corrected statement / recommendation: Claim: replace '$PREFIX/lib/ollama and symlinking into PATH' with 'into the prefix of the first PATH bin dir (/usr/local, /usr, /) so bin/ollama is directly on PATH; the symlink branch is effectively dead code'; note Ollama also ships install.ps1 for Windows and current releases are .tar.zst only. Recommendation: keep the `main()` guard (cheap, correct). Drop 'per-arch tarball' (no such artifact exists for a Node+native-addon app; [...]

#### 4b-10

- Verdict: claim **confirmed**; recommendation **needs-change**. Weight: high. Anchor: `https://github.com/ollama/ollama/blob/main/scripts/install.sh`
- Original claim: Ollama's install.sh on Linux creates a dedicated `ollama` system user, writes a systemd unit with Restart=always and RestartSec=3, enables and starts it, prints 'The Ollama API is now available at 127.0.0.1:11434', and on macOS auto-launches the app hidden unless OLLAMA_NO_START is set.
- Original recommendation: P0 WP4 `install.sh`: service user + systemd/launchd unit as an opt-in, print the URL + token location at the end.
- What the verifiers found: (skeptic: confirmed / needs-change) "install.sh fetched today: L199-201 `if ! id ollama ...; $SUDO useradd -r -s /bin/false -U -m -d /usr/share/ollama ollama`; unit heredoc L215-229 with `User=ollama`, `Restart=always` L224, `RestartSec=3` L225; L234-238 `systemctl daemon-reload`, `systemctl enable ollama`, `start_service() { $SUDO systemctl restart ollama; }` via EXIT trap; [...]" (reproducer agrees: confirmed / needs-change) "Same script: L198-200 `if ! id ollama ...; $SUDO useradd -r -s /bin/false -U -m -d /usr/share/ollama ollama`; [...]"
- Corrected statement / recommendation: The service/unit half of the recommendation is already done (and ON by default) via the wizard's daemon-install step on systemd/launchd/schtasks; install.sh should call `bitterbot onboard`/`daemon install`, not re-implement it. Drop the 'dedicated service user': Ollama needs a system user because it is stateless per-user; Bitterbot's config, keys and memory DBs live in $HOME/.bitterbot and the Control UI token handoff is per-user, so an `ollama`-style system user would relocate all state and break the existing daemon code paths. [...]

#### 4b-11 **ALREADY DONE**

- Verdict: claim **partially-confirmed**; recommendation **already-done**. Weight: medium. Anchor: `https://github.com/ollama/ollama/blob/main/scripts/install.sh`
- Original claim: Ollama's install.sh performs no checksum or signature verification of the downloaded tarball, requires root/sudo, and may install CUDA drivers on Linux; the script was last changed 2026-02-19.
- Original recommendation: Add what Ollama lacks: a checksum check on the orchestrator binary in install.sh.
- What the verifiers found: (skeptic: partially-confirmed / already-done) "install.sh fetched today: `grep -n -i 'sha256\|checksum\|gpg\|\.sig'` returns nothing (the only 'sha' hit is `/bin/false` in L200); download L145-156 pipes curl straight into `zstd -d | tar` / `tar -xzf`, so no verification: confirmed. Root: Linux branch L110-118 `if id -u -ne 0 ... SUDO=sudo` else `error 'This script requires superuser permissions'`; [...]" (reproducer: confirmed / already-done) "grep of the 455-line script for sha256|checksum|gpg|minisign|signature: 0 hits; download is `curl ... | zstd -d | $SUDO tar -xf -` (L146-148) with no verification. [...]"
- Corrected statement / recommendation: Claim: 'requires root/sudo' applies to the Linux branch only; macOS runs unprivileged. Add that Ollama does publish sha256sum.txt in releases, the script simply ignores it. Recommendation: a SHA-256 check on the orchestrator binary already exists in scripts/fetch-orchestrator.mjs and runs on `pnpm install`. The useful change is different: verify the minisign signature on checksums.txt with an embedded public key (copy deploy/relay-fleet/scripts/update-orchestrator.sh:86-88), make the mismatch/missing case fatal in the installer path instead of warn-and-co [...] (reproducer adds: The SHA-256 check on the orchestrator binary already exists (fetch-orchestrator.mjs, run on postinstall); install.sh only needs to invoke it. [...])

#### 4b-13

- Verdict: claim **confirmed**; recommendation **needs-change**. Weight: high. Anchor: `https://docs.openwebui.com/getting-started/quick-start/`
- Original claim: Open WebUI's recommended install is a single `docker run` pulling a prebuilt GHCR image (ghcr.io/open-webui/open-webui), mapping host port 3000 to container 8080, persisting all default state (SQLite db, uploads, Chroma vector store) in one named volume, with image variants selected purely by tag: `:main`, `:main-slim`, `:cuda`, `:ollama`, plus immutable pinned `:vX.Y.Z` and `:g [...]
- Original recommendation: D8 Docker: one `docker run` with one named volume for `~/.bitterbot`, image on GHCR, tags `:latest`, `:1.0.0`, `:git-<sha>`; a `:slim` variant without Playwright/Chromium as the analogue of `:main-slim`.
- What the verifiers found: (skeptic: confirmed / needs-change) "docs.openwebui.com quick-start fetched today: `docker run -d -p 3000:8080 -v open-webui:/app/backend/data --name open-webui ghcr.io/open-webui/open-webui:main`, Docker 'Officially supported and recommended for most users' (pip/Kubernetes also listed), tag table :main, :main-slim ('downloads Whisper and embedding models on first use'), :cuda, :ollama, :dev, :vX.Y.Z, :git-<sha>. [...]" (reproducer agrees: confirmed / needs-change) "docs.openwebui.com quick-start page is tab-rendered; fetched its source docs/getting-started/quick-start/tab-do [...]"
- Corrected statement / recommendation: Claim stands. Recommendation: (1) do not introduce a new single `docker run` story; docker-compose.yml + docker-setup.sh already implement the one-volume pattern (bind mount by default, named volume via BITTERBOT_HOME_VOLUME) and token generation; fix Dockerfile COPY ui/package.json and COPY patches first or nothing builds. (2) Drop the `:slim` variant: the full image has no Playwright/Chromium today, so there is nothing to strip; [...]

#### 4b-14

- Verdict: claim **confirmed**; recommendation **needs-change**. Weight: medium. Anchor: `https://docs.openwebui.com/features/authentication-access/rbac/roles/`
- Original claim: In Open WebUI the first account created in the UI automatically becomes Administrator, later sign-ups default to Pending until an admin approves them, all data stays local by default, and admins can pull a model directly from the in-chat Model Selector by typing its name (https://docs.openwebui.com/features/authentication-access/rbac/roles/ and ModelSelector/Selector.svelte).
- Original recommendation: Wizard: first browser visit claims the instance (token handoff), then the model picker offers 'Add a key' or 'Use Ollama' inline; do not ask for a model key before the first screen.
- What the verifiers found: (skeptic: confirmed / needs-change) "docs.openwebui.com/features/authentication-access/rbac/roles/ verbatim: 'The very first account created on a fresh installation is automatically assigned the Admin role.'; pending role is 'The default state for new sign-ups (if configured)' and users 'Must be promoted to user or admin by an existing Administrator'; [...]" (reproducer: confirmed / sound) "Open WebUI quick-start (raw docs/getting-started/quick-start/index.mdx lines 164-168, 'First Login' tip): "The first account created gets Administrator privileges and controls user management and syste [...]"
- Corrected statement / recommendation: Claim stands (cite quick-start for the data-local sentence, and config.py:1699 for the pending default). Recommendation needs reframing: 'first browser visit claims the instance' is not the Open WebUI mechanism (there, signup creates the admin account; Bitterbot has no accounts and FirstRun is a paste-token screen) and is a duplicate of item 19 (token handoff). The browser UI already never asks for a model key; the ordering problem is in the CLI wizard, which collects the provider key (onboarding.ts:404-443) before the user has seen anything. [...]

#### 4b-15 **REFUTED**

- Verdict: claim **refuted**; recommendation **needs-change**. Weight: medium. Anchor: `https://docs.openwebui.com/getting-started/quick-start/connect-a-provider/starting-with-ollama/`
- Original claim: Open WebUI does NOT auto-discover a running Ollama instance with zero configuration; the Ollama connection must be configured first (claim refuted 0-3 against https://docs.openwebui.com/getting-started/quick-start/connect-a-provider/starting-with-ollama/).
- Original recommendation: Do not claim auto-discovery of Ollama unless it is implemented and tested.
- What the verifiers found: (reproducer: refuted / needs-change) "The cited anchor says the opposite of the claim. Raw docs/getting-started/quick-start/connect-a-provider/starting-with-ollama.mdx, Step 1: "Once Open WebUI is installed and running, it will automatically attempt to connect to your Ollama instance. If everything goes smoothly, you'll be ready to manage and use models right away. [...]" (skeptic: refuted / sound) "The anchored page (fetched today via docs.openwebui.com and the raw source docs/getting-started/quick-start/connect-a-provider/starting-with-ollama.mdx) says verbatim under 'Step 1: Setting Up the Olla [...]"
- Corrected statement / recommendation: Open WebUI DOES connect to a running Ollama with zero configuration via a built-in default URL (localhost:11434 / host.docker.internal:11434); the docs state it 'will automatically attempt to connect to your Ollama instance'. It is default-URL probing, not service discovery. Recommendation: keep the rule 'do not claim auto-discovery unless implemented and tested', but drop Open WebUI as the counter-example; it is actually a precedent FOR probing a default local port (127.0.0.1:11434) at first run, which is exactly what Pattern 2 (4-05) proposes. (skeptic adds: Corrected statement: Open WebUI auto-connects to Ollama at its default URL (http://localhost:11434 bare-metal; host.docker.internal:11434 in the stock Docker image) with no user configuration, per the [...])

#### 4b-16

- Verdict: claim **confirmed**; recommendation **needs-change**. Weight: high. Anchor: `https://www.home-assistant.io/getting-started/onboarding/`
- Original claim: Home Assistant's first-run onboarding is a 5-step browser wizard (open address, create new or restore from backup, enter home location, analytics opt-in defaulting off, done) and the official docs at https://www.home-assistant.io/getting-started/onboarding/ state it 'takes only a few minutes... no command-line or coding is required'.
- Original recommendation: Wizard: cap the wizard at ~5 screens (claim instance, model, optional channel, network consent, done).
- What the verifiers found: (skeptic: confirmed / needs-change) "Raw source (raw.githubusercontent.com/home-assistant/home-assistant.io/current/source/getting-started/onboarding.markdown) line 7 verbatim: 'there are 5 steps to complete setting up Home Assistant. The entire onboarding takes only a few minutes and is done in your browser, so no command-line or coding is required.' Steps in the markdown: open the address, (line 20) 'You can either create a new inst [...]" (reproducer: confirmed / sound) "Raw source (raw.githubusercontent.com/home-assistant/home-assistant.io/current/source/getting-started/onboarding.markdown) line 7: "After Home Assistant has been installed on your device, there are 5 s [...]"
- Corrected statement / recommendation: Claim holds for the docs page; note HA's live wizard is 6 screens per its own UX team (#123) and includes an inline device-discovery step, so '5' is the documented not the shipped count. Recommendation needs-change: Bitterbot already has a QuickStart flow that skips some steps (onboarding.ts:332,468,476,545,553); the cap should be implemented by tightening QuickStart (risk ack + model/auth + gateway + optional channel + done) and leaving the Advanced/Manual flow long, rather than capping the wizard globally. [...]

#### 4b-17

- Verdict: claim **partially-confirmed**; recommendation **needs-change**. Weight: medium. Anchor: `https://github.com/home-assistant/roadmap/issues/25`
- Original claim: Home Assistant's 2026 roadmap issue https://github.com/home-assistant/roadmap/issues/25 (written by the HA Product Manager, status 'Considering', closed as duplicate of a narrower issue) frames onboarding as spanning both the one-time wizard and a post-wizard 'what to do next' phase, and argues early sub-optimal decisions 'drastically' hinder the later experience without data be [...]
- Original recommendation: Move everything beyond the ~5 wizard screens to a post-wizard 'Next steps' card on Overview.
- What the verifiers found: (skeptic: partially-confirmed / needs-change) "gh api repos/home-assistant/roadmap/issues/25: title 'Make Home Assistant onboarding a smooth landing', author jlpouffier, created 2026-02-24, state closed, state_reason 'duplicate', closed 2026-04-29 by carlhye. Author role: web search confirms Jean-Loic Pouffier is Product Manager of Home Assistant at Nabu Casa (sessionize.com profile, nabucasa.com/about). [...]" (reproducer: confirmed / sound) "gh api repos/home-assistant/roadmap/issues/25 (redirects to OpenHomeFoundation/roadmap): title "Make Home Assistant onboarding a smooth landing", user jlpouffier, created 2026-02-24, state closed, stat [...]"
- Corrected statement / recommendation: Corrected statement: issue #25 was written by HA's Product Manager (jlpouffier), labelled 'status: proposal' on GitHub and 'Considering' in the OHF Roadmap project, has no plan or data, and was closed as duplicate on 2026-04-29 with no recorded target; the narrower issue is presumably #123 (same day, same closer) but this is inference. [...]

#### 4b-18

- Verdict: claim **partially-confirmed**; recommendation **needs-change**. Weight: high. Anchor: `https://docs.openwebui.com/reference/env-configuration/`
- Original claim: Open WebUI uses a two-tier PersistentConfig scheme in backend/open_webui/models/config.py and env.py where env vars seed settings only on first launch and thereafter the database value wins; a single kill switch ENABLE_PERSISTENT_CONFIG=False flips precedence so env/config is the source of truth and Admin UI edits become session-only; [...]
- Original recommendation: D5/3.3 Configuration model: basic form in the UI + explicit 'Advanced' tier + raw JSON disclosure; file seeds on first launch, UI edits persist; one documented precedence kill switch; [...]
- What the verifiers found: (reproducer: partially-confirmed / needs-change) "Behavior claims confirmed from the docs page (same quotes as 4-17: first-launch seeding, ConfigVar values stored internally, ENABLE_PERSISTENT_CONFIG=False makes env authoritative and UI edits non-persistent: 'CRITICAL WARNING: When ENABLE_PERSISTENT_CONFIG is False, you may still be able to edit settings in the Admin UI. However, these changes are NOT saved'). [...]" (skeptic agrees: partially-confirmed / needs-change) "Docs (curl https://docs.openwebui.com/reference/env-configuration/, 979 KB, parsed to text): ConfigVar seeding [...]"
- Corrected statement / recommendation: Claim: the mechanism is Open WebUI's per-key `Config` model (models/config.py) plus `ENABLE_PERSISTENT_CONFIG` read in config.py (not env.py); there is no `PersistentConfig` class on main or v0.11.0; the 'read once at startup and requires a restart to change' wording appears once, the standard annotation is 'read once at startup; it is not a ConfigVar and cannot be changed from the Admin UI'. [...]

#### 4b-19

- Verdict: claim **confirmed**; recommendation **needs-change**. Weight: high. Anchor: `https://developers.home-assistant.io/docs/development/labs/`
- Original claim: Home Assistant Labs shipped in release 2025.12 (https://www.home-assistant.io/blog/2025/12/03/release-202512/) as a developer-documented feature-flag system (https://developers.home-assistant.io/docs/development/labs/): flags are disabled by default, require explicit user opt-in, are positioned as 'refining user interfaces and design, not about testing for bugs', and every Labs [...]
- Original recommendation: D6 Labs: adopt HA's rule verbatim; a Labs toggle must flip at runtime without a gateway restart, so Circles, P2P dashboard, Dreams dashboard, Wallet, Workspace, Guards qualify only if their UI mounts/unmounts dynamically; [...]
- What the verifiers found: (reproducer: confirmed / needs-change) "HA 2025.12 release blog: "Labs is a brand-new place in Home Assistant that gives you a sneak peek at features we're working on... Preview features are off by default... Simply disable it again. No restart required!" Developer docs (developers.home-assistant.io/docs/development/labs/): "Disabled by default, users must explicitly enable them"; [...]" (skeptic: confirmed / sound) "Developer docs (https://developers.home-assistant.io/docs/development/labs/, fetched 2026-08-21): "Disabled by default, users must explicitly enable them"; [...]"
- Corrected statement / recommendation: Recommendation is right in spirit but the eligibility test should be derived from config-reload.ts rather than from whether UI panels mount dynamically: a Labs flag qualifies when its config path resolves to kind none/hot in the reload rule table. Under today's table circles._ qualifies; p2p._, memory._ (curiosity/rlm/architectEvolution), a2a._, forage.\*, tools.wallet-adjacent paths either have no rule (default restart) or are explicitly restart, so they need a rule added (if they are actually read at runtime) or must live under Advanced with the restart [...]

#### 4b-20 **REFUTED**

- Verdict: claim **refuted**; recommendation **needs-change** (tiebreak). Weight: medium. Anchor: `https://www.jan.ai/docs/desktop/quickstart`
- Original claim: Three Jan claims were refuted against primary sources: Jan does not document shipping cortex-server/llama.cpp as a Tauri sidecar in src-tauri/binaries with a watchdog (0-3, https://github.com/janhq/jan/issues/4485); Jan's install is not a documented zero-terminal three-step flow (1-2, https://www.jan.ai/docs/desktop/quickstart); [...]
- Original recommendation: Do not cite Jan as a documented externalBin/watchdog example or as a zero-question first-run precedent.
- What the verifiers found: (reproducer: refuted / unsound) "The audit accurately reports that the deep-research harness voted these three claims down (scratchpad deep-research.json `refuted[]`: Jan sidecar 0-3, Jan three-step 1-2, Jan auto-download 0-3). But re-checking the primary sources shows the refutations themselves are wrong on all three counts. [...]" (skeptic: partially-confirmed / needs-change) "The audit accurately reports what the harness voted (run record ~/.claude/projects/-mnt-d-Bitterbot-bitterbot-desktop/8c1f3492-.../workflows/wf_1735faf4-7d3.json, result.refuted[0]/[3]/[4]: votes 0-3, [...]" (tiebreak: refuted / needs-change) "Independent re-check of all three primary sources on 2026-08-21. (A) Quickstart: `curl -sL https://www.jan.ai/docs/desktop/quickstart` -> HTTP 200, 88,968 bytes. Tag-stripped text (node) reads verbatim: "Install Jan Download Jan (opens in a new tab) Install the app ( Mac , Windows , Linux ) Launch Jan Getting Ready Jan [...]"
- Corrected statement / recommendation: Corrected statement: All three Jan claims are supported by the cited primary sources. The quickstart (fetched 2026-08-21) documents a literal three-step Download / Install / Launch flow with no terminal step, and states "Jan automatically downloads its default foundation model on first launch ... no setup required." Issue janhq/jan#4485 (Jan 2025 roadmap, closed May 2025) explicitly documents placing cortex-server in src-tauri/binaries as a Tauri v2 sidecar and explicitly flags that it ran WITHOUT a watchdog/self-restart and needed multi-arch bundling. [...]

### 5. Proposed V1 plan, install matrix, versioning, definition of done

4 item(s) changed in this section (of 4 verified).

#### 5-06

- Verdict: claim **confirmed**; recommendation **needs-change**. Weight: high. Anchor: `.github/workflows/ci.yml; docker-compose.yml; https://ghcr.io/bitterbot-ai/bitterbot`
- Original claim: The Docker path (Dockerfile + docker-compose.yml) is broken/unverified: there is no `docker build` job in CI and no published ghcr.io/bitterbot-ai/bitterbot image; Podman files exist in the repo.
- Original recommendation: P0-A.4 / D8: fix Docker with a docker build CI job plus a v\* publish job, or delete it plus docs entries; delete Podman files.
- What the verifiers found: (skeptic: confirmed / needs-change) "CI: `.github/workflows/ci.yml` (83 lines, read in full) has only `build` (tsc/typecheck/pnpm build/test:fast) and `lint` jobs; zero `docker` references; `ls .github/workflows/` = ci.yml, desktop-release.yml, orchestrator-release.yml, skill-review.yml, none of which builds/pushes an image. [...]" (reproducer: confirmed / sound) "Reproduced from scratch at HEAD c5e1f97. (a) Dockerfile is broken: `Dockerfile:20 COPY ui/package.json ./ui/package.json`, `Dockerfile:21 COPY patches ./patches`, `Dockerfile:30 RUN pnpm ui:build` -- ` [...]"
- Corrected statement / recommendation: Claim stands. Recommendation needs adjustment: (a) the fix is smaller than 'M' suggests for the image itself: drop Dockerfile:20 and replace Dockerfile:30 with `pnpm --filter bitterbot-control-ui build` (tsdown already emits dist/index.js, which compose uses; confirmed `ls dist/index.js`); (b) the recommendation ignores prior art that conflicts with 'delete Podman files': docs/plans/PLAN-37-SECRET-CONSOLIDATION.md row 39 explicitly decides to KEEP `bitterbot.podman.env` as a template and gitignore a `.local` variant (line 663, 988), so D8/D1 must override [...] (reproducer adds: Claim stands. Two precision notes for the recommendation: (1) adding a `docker build` CI job alone would fail immediately -- the Dockerfile itself must be repaired first (drop ui/ + patches COPYs, repl [...])

#### 5-32

- Verdict: claim **confirmed**; recommendation **needs-change**. Weight: high. Anchor: `package.json:3; desktop/package.json:3; desktop/src-tauri/tauri.conf.json:4; src/config/version.ts; src/infra/update-check.ts`
- Original claim: The app currently uses CalVer: root package.json and desktop/package.json are at version 2026.2.15 while desktop/src-tauri/tauri.conf.json is at 0.1.0, orchestrator is at SemVer 0.2.3, and src/config/version.ts already parses major.minor.patch; src/infra/update-check.ts has no guard treating a CalVer-shaped installed version (2026.x.y) as older than SemVer 1.x.
- Original recommendation: D2: switch to SemVer 1.0.0 for V1 with one scripts/bump-version.mjs syncing root, desktop, extensions/\*, and tauri.conf.json; git tag v1.0.0 triggers release.yml; add a CalVer-vs-SemVer guard in src/infra/update-check.ts; alternative = stay CalVer and cut 2026.9.0 with release-please Release-As.
- What the verifiers found: (skeptic: confirmed / needs-change) "package.json:3 and desktop/package.json:3 both `"version": "2026.2.15"`; desktop/src-tauri/tauri.conf.json:4 `"version": "0.1.0"`; orchestrator/Cargo.toml:3 `version = "0.2.3"`. src/config/version.ts:8 `VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-(\d+))?/` and compareBitterbotVersions compares major/minor/patch/revision, so yes it parses major.minor.patch. [...]" (reproducer agrees: confirmed / needs-change) "package.json:3 = 2026.2.15; desktop/package.json:3 = 2026.2.15; desktop/src-tauri/tauri.conf.json:4 = 0.1.0; [...]"
- Corrected statement / recommendation: Recommendation: 'git tag v1.0.0 triggers release.yml' is false, no such workflow; the desktop build is triggered by a `desktop-v1.0.0` tag (desktop-release.yml:9-12) and the tag must match tauri.conf.json version. The 'stay CalVer + release-please Release-As' alternative presumes tooling that is not installed. The guard must also cover src/config/version.ts compareBitterbotVersions (src/config/io.ts:437 warnIfConfigFromFuture will warn on every existing node after the switch), not only src/infra/update-check.ts. [...]

#### 5-33

- Verdict: claim **partially-confirmed**; recommendation **needs-change**. Weight: medium. Anchor: `.github/workflows/ (ci.yml, desktop-release.yml, orchestrator-release.yml, skill-review.yml)`
- Original claim: There is no `.github/workflows/release.yml`; the existing workflows are ci.yml, desktop-release.yml, orchestrator-release.yml, and skill-review.yml, and only orchestrator-release.yml is a signed (minisign) release workflow.
- Original recommendation: D2: git tag v1.0.0 triggers release.yml (must be created); release-please manifest mode; attestations + cosign on every artifact. Install matrix: orchestrator prebuilt binaries = Supported via existing signed workflow; add minisign verify in the fetcher.
- What the verifiers found: (skeptic: partially-confirmed / needs-change) "`ls .github/workflows/` = ci.yml, desktop-release.yml, orchestrator-release.yml, skill-review.yml, exactly four; no release.yml (confirmed). `grep -c minisign .github/workflows/*.yml` = 0/0/6/0, only orchestrator-release.yml mentions minisign (confirmed literally). REFUTING NUANCE: desktop-release.yml is ALSO a signing release workflow: :63 '# 2. [...]" (reproducer: confirmed / needs-change) "`git ls-files .github/workflows` and `ls -la .github/workflows/` -> exactly ci.yml, desktop-release.yml, orchestrator-release.yml, skill-review.yml; no release.yml. [...]"
- Corrected statement / recommendation: Corrected statement: four workflows exist; no release.yml; orchestrator-release.yml is the only one that minisign-signs checksums; desktop-release.yml also carries (dormant, unpinned, secret-less) Tauri updater + Apple signing. Recommendation: creating a `v*`-triggered release.yml is sound, but (a) 'orchestrator prebuilt binaries = Supported via existing signed workflow' overstates, no signed artifact has ever been published and the `release` environment does not exist (see 6.9-6.10-09); mark it 'Supported once 0.2.3 ships signed'. [...] (reproducer adds: Claim stands (nuance: desktop-release.yml has optional, secret-gated Tauri/Apple signing that is skipped when blank, so 'only orchestrator is signed' is true in the enforced sense). [...])

#### 5-35

- Verdict: claim **partially-confirmed**; recommendation **needs-change**. Weight: critical. Anchor: `scripts/setup-deps.sh; scripts/fetch-orchestrator.mjs; src/infra/update-check.ts / update command; README.md`
- Original claim: The canonical working install path is source-only: `git clone` + `bash scripts/setup-deps.sh` + `pnpm install` + `pnpm bitterbot onboard`, with `pnpm install` expected to end with `[orchestrator-fetch] installed` (from scripts/fetch-orchestrator.mjs) and updates via `bitterbot update` in git mode with the auto-rollback watchdog; Windows is supported only via WSL2.
- Original recommendation: D1 install matrix: source path = Supported, canonical; README and getting-started must show exactly this. DoD 1: documented install path completes with no prompt beyond risk ack, provider + key (or local model), and go; no cargo/pnpm dev/desktop/.env/JSON-path instructions anywhere in the flow.
- What the verifiers found: (reproducer: partially-confirmed / needs-change) "Source path: README.md:42-50 (git clone, `bash scripts/setup-deps.sh`, `pnpm install`, `pnpm bitterbot onboard`). scripts/setup-deps.sh exists (3087 bytes); its tail prints 'Next steps: 1. pnpm install 2. pnpm bitterbot onboard'; lines 25-30 `elif darwin ... else echo Unsupported OS ... exit 1` (Linux/macOS only). package.json:108 `"postinstall": "node scripts/fetch-orchestrator.mjs"`; [...]" (skeptic agrees: partially-confirmed / needs-change) "Commands: README.md:41-52 matches the stated sequence exactly. [...]"
- Corrected statement / recommendation: Corrected statement: the canonical source path is git clone + setup-deps.sh + pnpm install + pnpm bitterbot onboard, but at HEAD c5e1f97 `pnpm install` ends with `[orchestrator-fetch] could not fetch checksums (HTTP 404 Not Found). The orchestrator-v0.2.3 release may not be published yet...` because Cargo.toml (0.2.3) is ahead of the newest published release (0.2.2). Windows-via-WSL2 is a documentation position; the code has partial native win32 support but setup-deps.sh refuses non-Linux/macOS. [...]

### 6.1-6.2 Appendix: Control UI inventory and polish

4 item(s) changed in this section (of 4 verified).

#### 6.1-6.2-01

- Verdict: claim **partially-confirmed**; recommendation **needs-change**. Weight: high. Anchor: `desktop/renderer/src/components/layout/Sidebar.tsx:57-82`
- Original claim: desktop/renderer/src/components/layout/Sidebar.tsx defines a hand-written NAV_ITEMS list (lines 57-82) of 12 visible entries (13 when the 'management' requireFeature gate passes) split into three groups CONTROL PANEL / AGENT / SETTINGS, and the app has no router (stores/ui-store.ts holds a 22-value TabId union, AppShell.tsx maps every id to a view).
- Original recommendation: Top-level nav count 12 visible (13 with Management) vs. target <= 8; cut/hide research surfaces to reach <= 8. | Reduce top-level nav to <= 8 items: Chat, Channels, Agents (Agents/Skills/Schedules), Overview, Settings, plus an Advanced group; move social links into an About dialog.
- What the verifiers found: (reproducer: partially-confirmed / needs-change) "NAV_ITEMS at Sidebar.tsx:56-83 has 12 entries TOTAL including management (see ids listed under 2.1-2.2-01). Filter at lines 485-489 hides management unless isManagementNode (hook import line 30, call line 182). So visible = 11 normally, 12 with Management -- the claim's '12 visible / 13 with Management' overcounts by one. [...]" (skeptic agrees: partially-confirmed / needs-change) "Count is off by one: NAV_ITEMS (Sidebar.tsx:57-82) has 12 entries INCLUDING management; [...]"
- Corrected statement / recommendation: Correct the count: NAV_ITEMS has 12 entries total; 11 are visible on a normal node and 12 when the management feature gate passes (not 12/13). The rest of the claim (three groups, no router, 22-value TabId, full VIEW_MAP) reproduces exactly. Recommendation: the '<= 8' target is sound but the baseline is 11, and the About-dialog move for social links is fine (the links live at Sidebar.tsx:552-616, see 2.1-2.2-21); see 2.1-2.2-01 for the Circles-badge and unreachable-views caveats.

#### 6.1-6.2-04

- Verdict: claim **partially-confirmed**; recommendation **sound**. Weight: high. Anchor: `desktop/renderer/src/components/projects/ProjectsView.tsx`
- Original claim: Projects is dead end-to-end: activeProjectId in the UI store has no setter caller, so ChatInput never sends projectId, and projects/ProjectSwitcher is never imported anywhere.
- Original recommendation: Delete ProjectsView/ProjectSwitcher or wire activeProjectId before V1. | Delete ProjectsView, ProjectSwitcher, projects-store and the ChatInput projectId spread.
- What the verifiers found: (skeptic: partially-confirmed / sound) "projects-store.ts:31/51 defines setActiveProjectId; it IS called at components/projects/ProjectSwitcher.tsx:33, but ProjectSwitcher is imported nowhere (grep 'ProjectSwitcher' across desktop/renderer/src hits only its own file's export at line 10), so transitively there is no reachable setter. [...]" (reproducer: confirmed / sound) "`grep -rn 'setActiveProjectId' desktop/renderer/src`: defined at stores/projects-store.ts:31,51; the ONLY caller is components/projects/ProjectSwitcher.tsx:13,33. [...]"
- Corrected statement / recommendation: Precise statement: the setter has one caller (ProjectSwitcher.tsx:33) but that component is never mounted, so activeProjectId is always null. 'Dead end-to-end' is true only for the renderer; the gateway path (projects.\* handlers, chat.send projectId, project RAG) is wired. If the delete option is chosen, the orphaned backend (project-rag.ts, server-methods/projects.ts, src/agents/projects.ts) should be in scope too; if the wire option is chosen it is a nav entry plus mounting <ProjectSwitcher/> in ChatInput. (reproducer adds: Recommendation as stated is supported. Note that projects-store.ts (131 lines) is also only consumed by ChatInput, ProjectSwitcher and ProjectsView, so if the two components are deleted the store and t [...])

#### 6.1-6.2-06

- Verdict: claim **confirmed**; recommendation **needs-change**. Weight: critical. Anchor: `src/config/defaults.ts:628`
- Original claim: Circles appears in the primary nav (TabId 'people', circles/CirclesView.tsx) and is enabled by default via src/config/defaults.ts:628; no env/feature flag hides it from the nav (the only in-view gate is server status.enabled -> 'Circles are off on this node' copy at CirclesView.tsx:78-86, and canvas sandbox gated by circles.sandbox.enabled at CircleCanvas.tsx:228).
- Original recommendation: Classify Circles EXPERIMENTAL and hide behind a Labs/Advanced section for V1. | SHIP-ADVANCED: make Circles opt-in; keep the nav item rendering the inert pane; no global badge polling when off.
- What the verifiers found: (skeptic: confirmed / needs-change) "src/config/defaults.ts:623-628 `applyCirclesDefaults` → line 628 `enabled: circles.enabled ?? true` (exact). Sidebar.tsx:63-65 `// PLAN-31 C2 ... stays inert while circles.enabled is off.` `{ id: "people", label: "Circles", icon: Users, group: "control" }` with no `requireFeature`; [...]" (reproducer: confirmed / sound) "Nav: desktop/renderer/src/components/layout/Sidebar.tsx:65 `{ id: "people", label: "Circles", icon: Users, group: "control" }` with no `requireFeature`; [...]"
- Corrected statement / recommendation: Claim fully holds. Recommendation needs reframing: (1) 'keep the nav item rendering the inert pane' is ALREADY the behavior (Sidebar.tsx:63-65 + CirclesView.tsx:78-86), mark that part already-done; (2) 'make Circles opt-in' reverses a recorded product decision, docs/plans/PLAN-31-CIRCLES.md:753-757 'Posture update (2026-07-09): connection surfaces are now ON BY DEFAULT fleet-wide ... live red-teaming at scale is the review', and PLAN-36:125 / PLAN-35:55 build on default-ON. [...] (reproducer adds: Minor: CircleCanvas.tsx:228 is the displayed copy; the gate logic is at lines 204-206. Cheaper existing mechanism for the recommendation: Sidebar already has the `requireFeature` slot (NavItem interfac [...])

#### 6.1-6.2-20

- Verdict: claim **partially-confirmed**; recommendation **needs-change**. Weight: medium. Anchor: `desktop/renderer/src/components/wallet/WalletView.tsx:147`
- Original claim: The Wallet tab (wallet/WalletView.tsx, Coinbase CDP wallet on Base with Stripe onramp / Coinbase Pay funding) is reachable only via the always-mounted WalletSidebarPanel (Sidebar.tsx:306), and is gated by wallet.getConfig().enabled showing 'Wallet Disabled ... set tools.wallet.enabled: true' (WalletView.tsx:147, 271); [...]
- Original recommendation: Classify Wallet SECONDARY/ADVANCED; stop always-mounting the sidebar panel and rewrite subtitle/disabled copy. | "USDC wallet"; chain in tooltip.
- What the verifiers found: (skeptic: partially-confirmed / needs-change) "Reachability: grep '"wallet"' across desktop/renderer/src outside wallet/ hits only stores/ui-store.ts:18 (TabId union) and AppShell.tsx:45 `wallet: () => <WalletView />`; the only `setActiveTab("wallet")` calls are in WalletSidebarPanel.tsx:69 and :85. No nav item, command palette, or settings link targets it, so 'reachable only via WalletSidebarPanel' holds. [...]" (reproducer: partially-confirmed / sound) "Sidebar path/line wrong: the file is desktop/renderer/src/components/layout/Sidebar.tsx (not desktop/renderer/src/layout/Sidebar.tsx) and the panel is mounted at line 301 `<WalletSidebarPanel collapsed [...]"
- Corrected statement / recommendation: Mount is Sidebar.tsx:301, not 306. The disabled copy is only reached when `tools.wallet.enabled: false` is set explicitly (default is enabled); the default fresh-install experience is 'Setup Required ... Configure your CDP API keys'. Recommendation: classifying Wallet as ADVANCED and gating the sidebar panel on `wallet.getAddress` success is reasonable for the renderer (WalletSidebarPanel/WalletView are UI, not money-movement code), but the report's D-level plan also proposes flipping `tools.wallet` default OFF (section 2 line 54) which would change the s [...] (reproducer adds: Cite desktop/renderer/src/components/layout/Sidebar.tsx:301 (not Sidebar.tsx:306). Subtitle appears twice (WalletView.tsx:249 and :333); rewrite both. [...])

### 6.3-6.4 Appendix: install/onboarding and configuration

6 item(s) changed in this section (of 6 verified).

#### 6.3-6.4-07

- Verdict: claim **partially-confirmed**; recommendation **sound**. Weight: medium. Anchor: `README.md; docs/start/getting-started.md; docs/start/wizard.md`
- Original claim: Install documentation is split three ways with inconsistent flows: README uses git-clone + `pnpm bitterbot onboard`; docs/start/getting-started.md uses `curl https://bitterbot.ai/install.sh | bash` + `bitterbot onboard --install-daemon`; docs/start/wizard.md uses `bitterbot dashboard`.
- Original recommendation: Consolidate to one canonical doc for V1.
- What the verifiers found: (skeptic: partially-confirmed / sound) "README.md:41-52: `git clone ... && cd bitterbot-desktop` / `bash scripts/setup-deps.sh` / `pnpm install` then `pnpm bitterbot onboard` (confirmed). docs/start/getting-started.md:35 `curl -fsSL https://bitterbot.ai/install.sh | bash`, :40 `iwr ... [...]" (reproducer: confirmed / sound) "README.md:42-44 `git clone https://github.com/Bitterbot-AI/bitterbot-desktop.git && cd bitterbot-desktop`/`bash scripts/setup-deps.sh`/`pnpm install`; README.md:50 `pnpm bitterbot onboard`. [...]"
- Corrected statement / recommendation: Install docs are split at least FIVE ways (README git-clone; getting-started curl|bash + onboard --install-daemon, plus its own pnpm gateway:watch/Vite section; setup.md and index.md npm -g; windows.md clone of a wrong repo). wizard.md's install command is `bitterbot onboard`, not `bitterbot dashboard`. Of these, only the README flow is executable today (install.sh serves HTML, npm package does not exist). Consolidation recommendation stands; the rewrite must also cover setup.md:71, index.md:100 and windows.md:145. (reproducer adds: Claim stands; severity understated. The getting-started curl|bash path and the bare `bitterbot` global-binary paths (getting-started, wizard, setup.md) are non-functional today, not merely inconsistent [...])

#### 6.3-6.4-09

- Verdict: claim **partially-confirmed**; recommendation **needs-change**. Weight: medium. Anchor: `scripts/setup-deps.sh; scripts/preinstall-check.mjs; README.md`
- Original claim: scripts/setup-deps.sh exits 1 with 'Unsupported OS' on any OS other than Linux/macOS, assumes `brew` exists on macOS (under `set -e`, so `brew: command not found` aborts), and does not install pkg-config/libssl-dev even though scripts/preinstall-check.mjs says it does; Windows support is a README badge only.
- Original recommendation: Windows is not a supported path for V1; fix the preinstall-check message or make setup-deps.sh install the toolchain.
- What the verifiers found: (skeptic: partially-confirmed / needs-change) "scripts/setup-deps.sh:9 `set -e`; lines 25-31: `elif [[ "$OSTYPE" == "darwin"* ]]; then PKG_MANAGER="brew" else echo "⚠️ Unsupported OS: $OSTYPE" ... exit 1`. Line 54 `brew) brew install "$pkg" ;;` with no `command -v brew` check anywhere in the file (`grep -n 'command -v brew' scripts/setup-deps.sh` empty), so a missing brew returns 127 inside install_if_missing and set -e aborts -- but only when [...]" (reproducer: partially-confirmed / sound) "setup-deps.sh:9 `set -e`; lines 16-31 branch on $OSTYPE: linux-gnu* -> apt/dnf/pacman, darwin* -> `PKG_MANAGER="brew"` (line 26) with no `command -v brew` check; [...]"
- Corrected statement / recommendation: Keep the exit-1, unguarded-brew, and pkg-config findings. Replace 'Windows support is a README badge only' with: native Windows is not covered by setup-deps.sh and is documented as WSL2-only, but CI tests on windows-latest, the daemon has schtasks support, and a Windows desktop release workflow exists. Recommendation: 'Windows is not a supported path for V1' should be phrased as 'native Windows is not a supported install path; WSL2 is (already documented)'. Also guard brew: `command -v brew` check with a pointer to brew.sh before the install loop. (reproducer adds: Corrected claim: the setup-deps.sh facts hold (Unsupported-OS exit 1, unchecked brew under set -e, no pkg-config/libssl-dev), but Windows is more than a badge: CI exercises native Windows for install/t [...])

#### 6.3-6.4-13

- Verdict: claim **partially-confirmed**; recommendation **sound**. Weight: medium. Anchor: `src/config/zod-schema.ts; src/config/zod-schema.*.ts; src/config/types.*.ts; src/config/defaults.ts`
- Original claim: The config zod schema (src/config/zod-schema.ts BitterbotSchema at 925 lines plus 14 zod-schema._.ts files, ~3,100 lines total) defines 38 top-level sections, roughly 1,412 `.optional()` keys, 87 `enabled: z.boolean()` flags and 30 `.register(sensitive)` fields, with a parallel hand-written type tree in 34 types._.ts files and runtime defaults in src/config/defaults.ts (641 line [...]
- Original recommendation: Config surface must be tiered core/advanced/hidden for V1. | Inventory baseline for the section-level SHIP/SHIP-ADVANCED/HIDE/REMOVE verdicts in 2.4.
- What the verifiers found: (reproducer: partially-confirmed / sound) "Reproduced every number from scratch. Exact matches: `wc -l src/config/zod-schema.ts` = 925; `ls src/config/zod-schema.*.ts | grep -v test | wc -l` = 14 (no test files among them); `grep -cE 'enabled: z\.boolean\(\)'` over the 15 files = 87; `grep -c 'register(sensitive'` = 30; `wc -l src/config/defaults.ts` = 641. [...]" (skeptic agrees: partially-confirmed / sound) "Recounted: `wc -l` -> src/config/zod-schema.ts = 925 (correct); [...]"
- Corrected statement / recommendation: Corrected figures: 37 top-level sections (not 38); ~1,432 `.optional()` (not 1,412); zod schema total 3,699 lines across zod-schema.ts + 14 sub-files (not ~3,100); 33 dotted types.\*.ts files plus types.ts (34 only with the base file); `?? true`/`!== false` sites are ~106-110 config-scoped out of 279 raw non-test lines (not 114). 925 / 14 files / 87 enabled flags / 30 sensitive / 641-line defaults.ts are exact. The tiering recommendation is unaffected by the small count drifts.

#### 6.3-6.4-16

- Verdict: claim **partially-confirmed**; recommendation **needs-change**. Weight: high. Anchor: `desktop/renderer/src/components/config/ConfigView.tsx; src/config/schema.ts`
- Original claim: The Control UI Config page (desktop/renderer/src/components/config/ConfigView.tsx) is a raw JSON textarea whose 'Form' tab is a read-only key dump truncated at 80 chars; the gateway's `config.schema` RPC (src/config/schema.ts) emits a JSON schema plus ~650 lines of label/help uiHints that the renderer stores but never renders.
- Original recommendation: Render the uiHints-driven form for core settings in V1.
- What the verifiers found: (reproducer: partially-confirmed / needs-change) "ConfigView.tsx reproduced in full. Raw tab: :104-115 `<textarea ... value={draft}>`, save via :159 `request("config.apply", {raw, baseHash})`. Form tab: :6-64 ConfigFormView declares onSave/saving props (:8-9) but never uses them; renders Object.keys(config) sections (:16,:23) and Object.entries (:37) as `{key}: {val}` text; [...]" (skeptic agrees: partially-confirmed / needs-change) "Renderer side confirmed and slightly understated: ConfigView.tsx:104-105 is the raw `<textarea>`; [...]"
- Corrected statement / recommendation: Corrected statement: the renderer never calls `config.schema`; config-store.ts:13-16,28 only declares an unused `schema`/`uiHints` slot and `setSchema`, with no caller. The 80-char truncation applies only to nested-object values (ConfigView.tsx:44); scalars render in full. On the recommendation: the premise (rich uiHints + restart-aware config.patch already exist server-side, renderer has a ready store slot) supports building a form, but 'render the uiHints-driven form for core settings in V1' is broad for a P0/V1 item. [...]

#### 6.3-6.4-17

- Verdict: claim **partially-confirmed**; recommendation **sound**. Weight: medium. Anchor: `src/commands/configure.shared.ts:10-19; src/wizard/onboarding.p2p.ts`
- Original claim: `bitterbot configure --section` accepts exactly workspace|model|web|gateway|daemon|channels|skills|health (src/commands/configure.shared.ts:10-19); neither it nor the onboarding wizard exposes memory, circles, economy (forage/a2a/commerce) settings, and the wizard's p2p module (onboarding.p2p.ts) asks 0 questions in QuickStart with P2P on by default.
- Original recommendation: CLI exposure of config is thin; core settings need a first-class surface.
- What the verifiers found: (skeptic: partially-confirmed / sound) "src/commands/configure.shared.ts:10-19 `CONFIGURE_WIZARD_SECTIONS = ["workspace","model","web","gateway","daemon","channels","skills","health"]` -- exact. No 'memory' in src/commands/configure*.ts (grep = 0). grep of src/wizard/*.ts for forage|commerce|a2a = 0 hits, so those economy sections are not exposed; [...]" (reproducer: confirmed / sound) "src/commands/configure.shared.ts:10-19 `CONFIGURE_WIZARD_SECTIONS = ["workspace","model","web","gateway","daemon","channels","skills","health"] as const` (exactly 8); [...]"
- Corrected statement / recommendation: Claim should read: configure sections are exactly the 8 listed; memory subsystems, circles, forage/a2a/commerce are not in the wizard, but memory embeddings (agents.defaults.memorySearch) and the wallet (tools.wallet + CDP creds) are; `bitterbot config set <path>` can reach any key. Add: the wizard advertises two nonexistent sections (`--section memory` at onboarding.embeddings.ts:158, `--section wallet` at onboarding.wallet.ts:309) -- either add those sections or fix the hints as part of the 'first-class surface' work. (reproducer adds: Claim fully holds. Add to the recommendation: the onboarding wizard already advertises a nonexistent `--section memory` (src/wizard/onboarding.embeddings.ts:158), so either add a `memory` section to CO [...])

#### 6.3-6.4-19

- Verdict: claim **partially-confirmed**; recommendation **needs-change**. Weight: critical. Anchor: `src/config/defaults.ts; src/config/zod-schema*.ts defaults; src/agents/sandbox/config.ts:166; src/update/* (autoRollback)`
- Original claim: The following are ON by default in a fresh install: p2p.enabled (relayMode auto, bootstrapDns p2p.bitterbot.ai + 4 hardcoded peers), a2a.enabled + a2a marketplace (+ payment when earning-capable), circles.enabled with mailbox -> mailbox.bitterbot.ai, briefing, practicePartner, agentDrafts and sandbox, forage.nightShift + audit, agents.defaults.harnessEvolve, memory dream engine [...]
- Original recommendation: For V1: forage and a2a marketplace/payment default OFF, circles opt-in behind advanced, harnessEvolve OFF, curiosity OFF until wired-but-dead F8/F9 are fixed, p2p a single core on/off toggle. [...]
- What the verifiers found: (reproducer: partially-confirmed / needs-change) "Confirmed ON by default: p2p (defaults.ts:501-509, relayMode auto, bootstrapDns p2p.bitterbot.ai, 4 FALLBACK_BOOTSTRAP_PEERS lines 478-494); a2a.enabled (:547) + marketplace (:573); payment = isEarningCapable (:560, OFF without CDP creds); [...]" (skeptic agrees: partially-confirmed / needs-change) "Confirmed ON-by-default (all `!== false`/`?? true`/`=== false`-only gates, my grep at HEAD): p2p.enabled/relayM [...]"
- Corrected statement / recommendation: Corrected statement: dream engine has 7 (not 4) LLM-requiring modes enabled by default on gpt-4o-mini; a2a.payment only auto-enables when CDP wallet credentials exist; harnessEvolve is effectively dormant because the harness_evolve dream mode is disabled by default (flipping agents.defaults.harnessEvolve is redundant unless the mode is re-enabled); sandbox 'off' at config.ts:166 is correct. Recommendation adjustments: drop 'harnessEvolve OFF' and 'a2a.payment OFF' as already-done-in-effect; [...]

### 6.5-6.6 Appendix: CLI and experimental feature triage

7 item(s) changed in this section (of 9 verified).

#### 6.5-6.6-09 **REFUTED**

- Verdict: claim **refuted**; recommendation **needs-change**. Weight: high. Anchor: `src/cli/ skills command; docs/reviews/wired-but-dead-audit-2026-08-09.md (F6/F15/F16)`
- Original claim: The `skills incoming list/accept/reject` quarantine-review flow is structurally dead per the 2026-08-09 wired-but-dead audit findings F6/F15/F16, while `skills list/info/check` work.
- Original recommendation: Do not ship the incoming-skills CLI flow as working; note that section 6.6 separately claims F6 and F16 were fixed on 08-09, so the two statements must be reconciled.
- What the verifiers found: (skeptic: refuted / needs-change) "F6 FIXED: `git show fd59b1a` 2026-08-09 22:51 "fix(skills,curiosity): peer trust credit + stable curiosity regions (audit F6/F8)" touches ingest.ts and server-methods/skills.ts; ingest.ts:340-345 `acceptIncomingSkill` now takes `reputationManager?: { recordIngestionResult(...) }` ('so a manual accept credits the peer (F6)') and line 241 calls `recordIngestionResult(envelope.author_pubkey, true)`; [...]" (reproducer agrees: refuted / needs-change) "CLI surface exists and is wired: src/cli/skills-cli.ts:138-215 defines `skills incoming list|accept|reject`, ca [...]"
- Corrected statement / recommendation: Corrected statement: F6 and F16 were fixed 2026-08-09 (fd59b1a, 34f78cd); only F15 remains open, and its effect is noise (a node's own re-broadcast skills land in quarantine), not a dead flow. `skills incoming list/accept/reject` works. Reconcile in favor of section 6.6 (SHIP). Two residual caveats to note instead: (1) the CLI accept/reject path does not pass reputationManager, so peer-trust credit (F6) only accrues via the gateway RPC / Control UI IncomingPanel, not the CLI; [...]

#### 6.5-6.6-12

- Verdict: claim **confirmed**; recommendation **needs-change**. Weight: high. Anchor: `docs/plans/PLAN-25:6; src/memory/dream-types.ts:64; src/memory/manager.ts:2788`
- Original claim: docs/plans/PLAN-25 line 6 says harness evolution is 'LANDED, on by default', but the code has `harness_evolve: { enabled: false }` in src/memory/dream-types.ts:64 (while manager.ts:2788 reads `harnessEvolve.enabled ?? true`), and the mode needs >=5 held-out executions and has 0, so it never runs.
- Original recommendation: HIDE harness evolution and fix the PLAN-25 doc's overclaim. | HIDE PLAN-25 and fix the doc to say the mode is disabled by default.
- What the verifiers found: (skeptic: confirmed / needs-change) "docs/plans/PLAN-25-SELF-OPTIMIZING-HARNESS.md:6 = '**Status:** **LANDED, on by default.** ... Kill switch: `agents.defaults.harnessEvolve.enabled` (default `true`).' src/memory/dream-types.ts:64 `harness_evolve: { enabled: false, weight: 0.05, ... }` (PLAN-40 HOLD comment :56-61, introduced in 6d80b77). [...]" (reproducer: confirmed / sound) "docs/plans/PLAN-25-SELF-OPTIMIZING-HARNESS.md:6 `**Status:** **LANDED, on by default.** The full self-evolving loop runs as the harness_evolve dream mode ... [...]"
- Corrected statement / recommendation: Claim stands. Recommendation should be re-targeted: (1) 'fix the PLAN-25 doc' has zero release impact because docs/plans is untracked; the public overclaims are README.md:133 ('Harness Evolution' row) and the comment at src/config/types.agent-defaults.ts:298 ('Default: true'). (2) 'HIDE' must not mean removing the mode or flipping the kill switch: the mode is already scheduler-held by PLAN-40 E5 with a doctor-visible wake counter (dream-utility.ts:196-199, wakeAt 25 completed executions, currently 13). [...]

#### 6.5-6.6-14

- Verdict: claim **partially-confirmed**; recommendation **needs-change**. Weight: critical. Anchor: `src/config/defaults.ts:628-634; src/config/types.circles.ts; desktop/renderer/src/layout/Sidebar.tsx:68`
- Original claim: Circles is ON by default: `circles.enabled ?? true`, `practicePartner.enabled: true`, and mailbox default `https://mailbox.bitterbot.ai` at src/config/defaults.ts:628-634; p2pDial and meshTopic default OFF in src/config/types.circles.ts; Circles has 71 commits with the latest on 2026-08-17 and a 'Circles' nav entry at Sidebar.tsx:68 with 34 components.
- Original recommendation: SHIP-ADVANCED: make Circles an opt-in toggle, default off for fresh installs until B5 closes (note: project memory records p2pDial as default-ON, which contradicts this row's 'p2pDial OFF').
- What the verifiers found: (reproducer: partially-confirmed / needs-change) "Defaults reproduced exactly at src/config/defaults.ts:628 (`enabled ?? true`), :634 (`practicePartner: { enabled: true`), :621/:632 (mailbox url https://mailbox.bitterbot.ai). p2pDial/meshTopic default OFF: the defaults live in src/circles/service.ts:302-303 (`=== true`) and :312 (`!== true`), NOT in src/config/types.circles.ts, which only declares the optional shapes at :62 and :78 with no default [...]" (skeptic agrees: partially-confirmed / needs-change) "CONFIRMED: defaults.ts:628 `circles.enabled ?? true`, :632 mailbox default https://mailbox.bitterbot.ai (:621), [...]"
- Corrected statement / recommendation: Corrected statement: Circles ON by default (defaults.ts:628/633/634, mailbox :621/:632); p2pDial/meshTopic default OFF in src/circles/service.ts:302-312 (types.circles.ts:62/78 only declare the shapes) and are currently rejected by the strict zod schema; 71 src/circles commits, latest 2026-08-17; 'Circles' nav at desktop/renderer/src/components/layout/Sidebar.tsx:65; 33 files / 24 non-test .tsx components in components/circles. The memory note claiming p2pDial ON is stale (flipped OFF in c150141 on 2026-08-14). [...]

#### 6.5-6.6-15

- Verdict: claim **partially-confirmed**; recommendation **needs-change**. Weight: critical. Anchor: `docs/reviews/circles-p2p-security-remediation-2026-08-14.md (untracked)`
- Original claim: The Circles P2P security remediation document docs/reviews/circles-p2p-security-remediation-2026-08-14.md is untracked in git (marked do-not-commit) and still lists the B5 supply-chain finding as an open critical.
- Original recommendation: Close B5 before Circles ships enabled by default.
- What the verifiers found: (reproducer: partially-confirmed / needs-change) "Untracked + do-not-commit reproduced (git status `??`; doc lines 3-5). 'Still lists B5 as an open critical' reproduced as a statement about the doc text: line 26 '### B5, Supply chain (do FIRST; only live-fleet-exploitable critical)' and lines 19-21 'The supply-chain item is the only finding exploitable against the deployed fleet today.' But the doc is stale: 6633401 (2026-08-15) shipped the B5 cod [...]" (skeptic: confirmed / needs-change) "Untracked + do-not-commit: git status `??`, not gitignored, header lines 3-5 quoted above. Lists B5 as open critical: doc lines 26-50 '### B5, Supply chain (do FIRST; [...]"
- Corrected statement / recommendation: The doc is untracked and its text still frames B5 as the open critical, but that reflects its 08-14 snapshot; the B5 code landed in 6633401 and the updater now fails closed on the placeholder key, pending human activation (SIGNING.md). Corrected recommendation: do not gate the Circles default on B5, B5 concerns the relay fleet's updater, not the user-facing mesh, which is already default-OFF. Gate instead on the product decision (opt-in for V1) plus the zod-schema fix; [...] (skeptic adds: Corrected recommendation: close B5 (run SIGNING.md: keypair, embed pubkey, repo secrets, protected `release` environment, cut signed 0.2.3, update the 3 relays) before the V1 release regardless of the [...])

#### 6.5-6.6-16

- Verdict: claim **partially-confirmed**; recommendation **needs-change**. Weight: high. Anchor: `benchmarks/arc-agi-3/; vitest.config.ts:40; src/memory/knowledge-graph.ts:56-63; package.json:67-73`
- Original claim: ARC-AGI-3 research material is in the shipped tree: benchmarks/arc-agi-3/ has 75 git-tracked files (464 MB locally), vitest.config.ts:40 includes its tests in the default test run, src/memory/knowledge-graph.ts:56-63 adds arc_state/arc_object/arc_action/arc_rule entity kinds, and docs/agents/arc-agi-3.md is a docs page; [...]
- Original recommendation: REMOVE arc-agi-3 and dream-ablation from the V1 tree; keep longmemeval/biomemeval as SHIP-ADVANCED. | REMOVE ARC-AGI-3 from the tree. | Move to a sibling repo; at minimum exclude from the tarball, pnpm install, and the default vitest include.
- What the verifiers found: (skeptic: partially-confirmed / needs-change) "`git ls-files benchmarks/arc-agi-3 | wc -l` = 75 (confirmed). Size is misattributed: `du -sh benchmarks/arc-agi-3` = 129M (121M apparent), of which benchmarks/arc-agi-3/kaggle = 129M (dominated by the gitignored .venv/**pycache**/egg-info per `git status --ignored`); tracked arc content = 456K. The 464M figure is `du -sh benchmarks` as a whole (longmemeval = 335M of ignored data). [...]" (reproducer agrees: partially-confirmed / needs-change) "`git ls-files benchmarks/arc-agi-3 | wc -l` = 75 (CONFIRMED). `du -sh benchmarks/arc-agi-3` = 129M, NOT 464M; [...]"
- Corrected statement / recommendation: Corrected claim: benchmarks/arc-agi-3 is 75 tracked files / ~456 KB tracked and ~129 MB on disk (almost all gitignored Python venv under kaggle/); 464 MB is the whole benchmarks/ directory. The KG kinds span lines 61-64. docs/agents/arc-agi-3.md is an orphan page not linked from docs.json. Its tests run not only via vitest.config.ts:40 but also in the default `pnpm test`/CI `test:fast` path through vitest.unit.config.ts:6-8. Corrected recommendation: 'exclude from the tarball' is already done (benchmarks/ is not in `files`); [...]

#### 6.5-6.6-17

- Verdict: claim **partially-confirmed**; recommendation **needs-change** (tiebreak). Weight: high. Anchor: `src/config/types.bitterbot.ts:114,120; src/memory/manager.ts:2523; src/gateway/a2a/forage.ts`
- Original claim: Forage is partially on by default: `forage.nightShift.enabled` documented 'Default: true (monitoring-only)' at src/config/types.bitterbot.ts:114 with the sweep at src/memory/manager.ts:2523, while `pools.enabled` defaults false 'until payments counsel review' (types.bitterbot.ts:120); [...]
- Original recommendation: HIDE Forage: set nightShift default off and drop the Forage/Earnings tabs.
- What the verifiers found: (skeptic: partially-confirmed / needs-change) "types.bitterbot.ts:114 is the 'Default: true (monitoring-only...)' comment (field at :115); `pools?: {` is at :126-128 and its 'Default: FALSE ... until payments counsel review' comment is :121-125, not :120 (:120 is a closing brace). Sweep at manager.ts:2523 confirmed (`return forage.nightShiftSweep({`). [...]" (tiebreak: partially-confirmed / needs-change) "Tiebreak: I side with the skeptic on every point of substance. (1) Line anchors are off by one or more: src/config/types.bitterbot.ts:114 is the comment `/** Default: true (monitoring-only, receive-only money flow). */`, the `enabled?: boolean` field is :115; [...]"
- Corrected statement / recommendation: Corrected statement: Forage Night Shift defaults ON (`forage.nightShift.enabled`, types.bitterbot.ts:115; kill-switch check forage-client.ts:111) but only runs when a local wallet address exists (manager.ts:2522), so it is a no-op on credential-less nodes; `pools.enabled` defaults false (types.bitterbot.ts:126-127); src/gateway/a2a/forage.ts exposes 5 `forage/*` A2A methods (claim, deliver, checkin, verdict, fund), with forage/fund legal-gated off by default; [...]

#### 6.5-6.6-18

- Verdict: claim **partially-confirmed**; recommendation **needs-change** (tiebreak). Weight: high. Anchor: `desktop/renderer/src/layout/Sidebar.tsx:301; src/config/defaults.ts:520-526`
- Original claim: The WalletSidebarPanel is rendered unconditionally at desktop/renderer/src/layout/Sidebar.tsx:301 and the Wallet tab (WalletView.tsx) has no nav entry; `isEarningCapable` requires CDP credentials (src/config/defaults.ts:520-526), so earning is OFF unless CDP creds are configured while the wallet tool is ON.
- Original recommendation: SHIP-ADVANCED: hide the wallet sidebar panel until a wallet is configured. | SHIP-ADVANCED.
- What the verifiers found: (skeptic: confirmed / needs-change) "Sidebar path is desktop/renderer/src/components/layout/Sidebar.tsx (there is no desktop/renderer/src/layout/Sidebar.tsx); lines 300-301 are `{/* Wallet Panel */}` / `<WalletSidebarPanel collapsed={isCollapsed} />` with no conditional wrapper. Nav ids at Sidebar.tsx:61-82 are overview, channels, people, p2p, management, agents, skills, guards, cron, dreams, models, config: no `wallet` entry; [...]" (tiebreak: partially-confirmed / needs-change) "Independently checked. (1) Path: `ls desktop/renderer/src/layout/Sidebar.tsx` -> No such file; the file is desktop/renderer/src/components/layout/Sidebar.tsx. Lines 300-301 there: `{/* Wallet Panel */}` / `<WalletSidebarPanel collapsed={isCollapsed} />` with no conditional wrapper. [...]"
- Corrected statement / recommendation: Claim text: the anchor path is desktop/renderer/src/components/layout/Sidebar.tsx:301 (desktop/renderer/src/layout/Sidebar.tsx does not exist); everything else in the claim is accurate. Recommendation: agree with the skeptic. Hiding WalletSidebarPanel until a wallet is configured would orphan WalletView, because the panel's two setActiveTab('wallet') calls are the only routes to the wallet tab, and WalletView is where the 'unconfigured' state and the CDP_API_KEY_ID / CDP_API_KEY_SECRET / CDP_WALLET_SECRET setup instructions are rendered. [...]

### 6.7-6.8 Appendix: code health and security posture

6 item(s) changed in this section (of 7 verified).

#### 6.7-6.8-10

- Verdict: claim **partially-confirmed**; recommendation **needs-change**. Weight: medium. Anchor: `skills/clawhub; skills/moltbook; package.json files`
- Original claim: Bundled skills skills/clawhub (clawhub.com CLI) and skills/moltbook (social network for AI agents) are heritage-ecosystem skills shipped in the npm package via package.json `files: skills/`; heritage name hits (openclaw/clawdbot/moltbot) in non-test code are otherwise zero (4 textual hits: AGENTS.md:149, README.md:443, 2 test fixtures).
- Original recommendation: prune heritage-ecosystem skills | Remove clawhub/moltbook skills; review Mac-only/personal skills (apple-notes, bear-notes, things-mac, imsg, bluebubbles, sonoscli, openhue) as optional.
- What the verifiers found: (skeptic: partially-confirmed / needs-change) "skills/clawhub/SKILL.md (clawhub.com CLI, requires bin `clawhub`, npm package `clawhub`) and skills/moltbook/SKILL.md ('the social network for AI agents', requires config `moltbook.apiKey`) exist and are covered by package.json:44 `skills/`. moltbook is dead: `git grep -i moltbook -- src/config` -> zero hits (no moltbook.apiKey schema key); no src/extensions/docs references at all. [...]" (reproducer: confirmed / sound) "skills/clawhub/SKILL.md exists (name: clawhub; 'Use the ClawHub CLI to search, install, update, and publish agent skills from clawhub.com'; requires bin `clawhub`, npm install of package `clawhub`). [...]"
- Corrected statement / recommendation: Corrected claim: heritage-name hits total 10 (6 textual + 4 binary fixtures); non-test textual hits are AGENTS.md:149, README.md:443, LICENSE:27 (attribution, must stay) and skills/nano-banana-pro/scripts/generate_image.py:172 (a shipped skill comment). Corrected recommendation: remove skills/moltbook (references a config key that does not exist) and skills/clawhub (no code path depends on it); also fix the stray OpenClaw comment in skills/nano-banana-pro/scripts/generate_image.py:172 and rename appendClawHubHint in src/cli/skills-cli.format.ts:21. [...]

#### 6.7-6.8-11

- Verdict: claim **confirmed**; recommendation **needs-change**. Weight: high. Anchor: `src/gateway/server-runtime-config.ts:40`
- Original claim: Gateway bind defaults to loopback at src/gateway/server-runtime-config.ts:40 and startup refuses a non-loopback bind without auth at line 91; the wizard always generates a 24-byte random token (src/wizard/onboarding.gateway-config.ts:204-211, randomBytes(24).hex at src/commands/onboard-helpers.ts:69).
- Original recommendation: core gateway posture is acceptable for local-first V1; none of the edge findings is a remote-unauthenticated compromise on the default loopback install
- What the verifiers found: (skeptic: confirmed / needs-change) "src/gateway/server-runtime-config.ts:40 `const bindMode = params.bind ?? params.cfg.gateway?.bind ?? "loopback";`; :89-93 `if (!isLoopbackHost(bindHost) && !hasSharedSecret && authMode !== "trusted-proxy") { throw new Error(\`refusing to bind gateway to ${bindHost}:${params.port} without auth ...\`) }`(message text on :91). [...]" (reproducer: confirmed / sound) "src/gateway/server-runtime-config.ts:40`const bindMode = params.bind ?? params.cfg.gateway?.bind ?? 'loopback'`; [...]"
- Corrected statement / recommendation: The baseline facts are confirmed. The conclusion 'none of the edge findings is a remote-unauthenticated compromise on the default loopback install' should be narrowed: the A2A loopback waiver combined with missing Origin/Host checks is reachable from the default install through the user's browser (CSRF/DNS rebinding), which is remote-originated and unauthenticated even though the TCP peer is loopback. State it as 'no direct network-unauthenticated compromise; [...] (reproducer adds: Claim text precision: the wizard always generates a 24-byte token when auth mode is 'token' (the default); password mode generates none. [...])

#### 6.7-6.8-12

- Verdict: claim **partially-confirmed**; recommendation **needs-change**. Weight: critical. Anchor: `src/gateway/a2a/a2a-http.ts:700-740`
- Original claim: The A2A HTTP surface (src/gateway/a2a/a2a-http.ts:700-740) waives bearer auth for any RFC1918/CGNAT source address, not just loopback (via net.ts:70-95), and uses a non-constant-time token compare; skills.expose defaults to `all` (agent-card.ts:143).
- Original recommendation: becomes a real exposure when user picks bind=lan; restrict bypass to loopback before public V1
- What the verifiers found: (skeptic: partially-confirmed / needs-change) "authorizeA2aRequest spans a2a-http.ts:692-740; waiver at :713 via isPrivateOrLoopbackAddress (net.ts:70-103, IPv4 private/CGNAT at :88-92, and also IPv6 ULA/link-local at :98-101 which the claim omits; the IPv4 part does end ~:95). Non-constant-time compare at :724. [...]" (reproducer: confirmed / needs-change) "Waiver: a2a-http.ts:700-716 (authorizeA2aRequest starts :692; type 'none' short-circuit :701-704; waiver :713). net.ts:70-107 is the range check (doc anchor 70-95 slightly short; [...]"
- Corrected statement / recommendation: The waiver and `===` facts are right; 'critical' should be stated as conditional (bind=lan, tailnet, or any network where the gateway is reachable from RFC1918/CGNAT/ULA peers), and skills.expose=all is a separate low-severity disclosure item. The fix must cover tailscale serve (loopback-with-forwarded-headers, see 3.1-06) and browser CSRF/DNS-rebinding from loopback (no Origin/Host/Content-Type check on POST /a2a; see 3.1-05), otherwise 'restrict bypass to loopback' leaves both paths open. (reproducer adds: Severity 'critical' is defensible only for non-loopback binds or tailscale serve/funnel; on the default loopback install with tailscale off it is not reachable. [...])

#### 6.7-6.8-13

- Verdict: claim **confirmed**; recommendation **needs-change**. Weight: high. Anchor: `desktop/vite.config.ts:17-35`
- Original claim: The Control UI build bakes the gateway token into the JS bundle via Vite `define` (desktop/vite.config.ts:17-35,116-120, reading desktop/.env and ~/.bitterbot/bitterbot.json), FirstRun stores the token in localStorage (desktop/renderer/src/stores/gateway-store.ts:77-120), the token leaks into an iframe URL, and `local-dev-token` fallback strings remain.
- Original recommendation: fix token handoff design before public V1 | P0-C.19: FirstRun rewrite + one-time token handoff from `bitterbot dashboard`; remove VITE_GATEWAY_TOKEN define and local-dev-token fallbacks; GatewayControls reads stored token; stop wizard writing desktop/.env. [...]
- What the verifiers found: (skeptic: confirmed / needs-change) "desktop/vite.config.ts:17-35 resolveGatewayToken (env VITE_GATEWAY_TOKEN, else ~/.bitterbot/bitterbot.json gateway.auth.token, else ''); :88 `envDir: __dirname` loads desktop/.env; :114-118 define inlines the token. desktop/renderer/src/stores/gateway-store.ts:80 LS_TOKEN_KEY, :90-103 readStoredGatewayToken (localStorage first, then build-time env), :113-121 persistGatewayCredentials writes localSt [...]" (reproducer: confirmed / sound) "Reproduced: desktop/vite.config.ts:17-35 `resolveGatewayToken()` precedence: process.env.VITE_GATEWAY_TOKEN (:18) then `path.join(os.homedir(), ".bitterbot", "bitterbot.json")` -> `config.gateway?.auth [...]"
- Corrected statement / recommendation: Claim confirmed. Recommendation mostly sound but the 'one-time token handoff from `bitterbot dashboard`' part is unbuildable as stated for V1: src/commands/dashboard.ts:24-37 builds `http://127.0.0.1:19001/#token=...` (resolveControlUiLinks, onboard-helpers.ts:456-485 always uses the gateway port) which 404s because the gateway serves nothing at GET / (PLAN-39 §0), and the Vite renderer reads neither `location.hash` nor `searchParams` (grep returns nothing; [...]

#### 6.7-6.8-14

- Verdict: claim **confirmed**; recommendation **needs-change**. Weight: high. Anchor: `src/gateway/server-http.ts:537-596`
- Original claim: Unauthenticated loopback GETs to /management (src/gateway/server-http.ts:537-557) and /m (src/gateway/server-http.ts:575-596) are accepted via a local-direct bypass and the served HTML embeds the raw gateway token; /m also accepts the token via `?t=` query.
- Original recommendation: stop handing back the raw token to unauthenticated requests | Require bearer or ?t= on /management, or mint a short-lived page token.
- What the verifiers found: (skeptic: confirmed / needs-change) "src/gateway/server-http.ts:537-557 `/management` GET: :538 bearer only, :539-545 authorizeGatewayConnect, :546 `if (!authResult.ok && !isLocalDirectRequest(req, trustedProxies))` -> fail, else :552 `const gatewayToken = resolvedAuth?.token ?? ""`, :557 `res.end(renderManagementDashboardPage(wsUrl, gatewayToken))`; [...]" (reproducer: confirmed / sound) "Reproduced src/gateway/server-http.ts:537-557: `/management` GET -> `getBearerToken(req)` -> `authorizeGatewayConnect` -> `if (!authResult.ok && !isLocalDirectRequest(req, trustedProxies)) { sendGatewa [...]"
- Corrected statement / recommendation: Claim confirmed (anchor for /m is :574-597). Recommendation 'require bearer or ?t= on /management' would break the Control UI's Management tab as built: ManagementView.tsx sets an iframe `src`, which cannot send an Authorization header, and ?token= is ignored, so the only reason the tab works today is the loopback waiver; removing it without a replacement handoff leaves the iframe showing a 401. Also the same waiver+embed exists on /dreams (:514-534) and /wallet/fund (:598-620) and the mobile UI; fixing /management alone is inconsistent. [...]

#### 6.7-6.8-20

- Verdict: claim **confirmed**; recommendation **needs-change**. Weight: medium. Anchor: `src/circles/service.ts:295-304`
- Original claim: circles.p2pDial defaults to OFF at src/circles/service.ts:295-304 (the memory note saying default-ON is stale), while the Circles canvas sandbox defaults to ON at src/circles/service.ts:2092 (`!== false`) even though the comment at src/circles/sandbox-agent.ts:26 says default OFF; circles.enabled is ON with mailbox https://mailbox.bitterbot.ai (src/config/defaults.ts:621,628).
- Original recommendation: treat p2pDial as not live-exposed by default; fix the stale sandbox-agent.ts comment | Pick one; recommend explicit opt-in.
- What the verifiers found: (skeptic: confirmed / needs-change) "p2pDial: src/circles/service.ts:295-303 comment 'Stage 4 kill switch ... Default OFF (2026-08-14)' and `return this.config.circles?.p2pDial?.enabled === true;` at :303; introduced by c150141 (2026-08-14). Memory file project_circles_p2p_security_pass.md:16 still says 'p2pDial defaults ON (service.ts:298)' and project_circles_p2p_transport_plan.md:86 says 'default ON', both stale vs HEAD. [...]" (reproducer: confirmed / sound) "p2pDial: src/circles/service.ts:295-303 `Stage 4 kill switch: circles.p2pDial.enabled === true. Default OFF (2026-08-14)` / `return this.config.circles?.p2pDial?.enabled === true;` (flipped from `!== f [...]"
- Corrected statement / recommendation: Claim fully confirmed. Recommendation: 'treat p2pDial as not live-exposed by default' and 'fix the stale sandbox-agent.ts:26 comment' are sound (and the two memory files should be corrected too). 'Pick one; recommend explicit opt-in' for the sandbox is not a neutral tidy-up: it would reverse the documented R19 amendment of 2026-07-28 (8af2abc; rationale in types.circles.ts:99-110 and service.ts:2080-2090: generation only runs inside human-created enrollments with human-refillable budgets and every move waits for a tap). [...] (reproducer adds: Statement is accurate. Recommendation split: fixing the sandbox-agent.ts:26 comment is a trivial, clearly supported action; [...])

### 6.9-6.10 Appendix: packaging/versioning and documentation

2 item(s) changed in this section (of 2 verified).

#### 6.9-6.10-08

- Verdict: claim **partially-confirmed**; recommendation **needs-change**. Weight: high. Anchor: `package.json; desktop/src-tauri/tauri.conf.json; orchestrator/Cargo.toml; git tag`
- Original claim: Versioning is incoherent: package.json, desktop/package.json and extensions/\* are all at the upstream-inherited CalVer 2026.2.15 (package.json's version line has only ever changed in commit 33f9833, the Initial commit, per `git log -G'"version": "' -- package.json`), desktop/src-tauri/tauri.conf.json says 0.1.0, orchestrator/Cargo.toml says 0.2.3, and the repo has never had an a [...]
- Original recommendation: Adopt SemVer 1.0.0 with a single version-sync script and tag the app release. | D2; one scripts/bump-version.mjs syncing root/desktop/extensions/tauri.conf; tag v1.0.0; guard in update-check. | D2: move to SemVer 1.0.0 synced by one script, tag v1.0.0; orchestrator stays on orchestrator-v0.x.
- What the verifiers found: (skeptic: partially-confirmed / needs-change) "Confirmed facts: package.json:3 `"version": "2026.2.15"`; desktop/package.json:3 same; desktop/src-tauri/tauri.conf.json:4 `"version": "0.1.0"`; orchestrator/Cargo.toml:3 `version = "0.2.3"`. `git log --oneline -G'"version": "' -- package.json` => only `33f9833 Initial commit`. `git tag` => 4 tags, all orchestrator-v0.1.0/0.2.0/0.2.1/0.2.2 (remote identical via git ls-remote); [...]" (reproducer: confirmed / needs-change) "Reproduced from scratch: `grep -n '"version"' package.json` -> line 3 `"version": "2026.2.15"`; desktop/package.json:3 `"version": "2026.2.15"`; [...]"
- Corrected statement / recommendation: Statement: root/desktop and the 8 extensions that have a package.json are at 2026.2.15 (4 extensions have no package.json); tauri.conf 0.1.0 is an intentionally separate desktop-shell version (desktop-v* tag convention), and orchestrator Cargo 0.2.3 is itself unreleased (latest tag 0.2.2). Recommendation: moving to SemVer 1.0.0 is defensible, but (1) a bare `v1.0.0` tag triggers NO workflow, there is no release.yml; desktop-release.yml fires on `desktop-v*`, orchestrator-release.yml on `orchestrator-v\*`; [...] (reproducer adds: Premise is fully correct, but the recommendation's tagging step is wrong as written: a `v1.0.0` tag triggers nothing. [...])

#### 6.9-6.10-09

- Verdict: claim **partially-confirmed**; recommendation **needs-change**. Weight: medium. Anchor: `.github/workflows/orchestrator-release.yml; gh release list / gh release view orchestrator-v0.2.2`
- Original claim: .github/workflows/orchestrator-release.yml is SHA-pinned, uses `environment: release` (approval-gated) and minisign-signed checksums; published orchestrator releases are 0.1.0, 0.2.0, 0.2.1 and 0.2.2, and the 0.2.2 release has 6 assets with no .minisig file.
- Original recommendation: Keep orchestrator-release.yml as the model release pipeline; ensure the next release carries the .minisig.
- What the verifiers found: (skeptic: partially-confirmed / needs-change) "SHA-pinned: every `uses:` in orchestrator-release.yml carries a 40-hex SHA (:64,:69,:79,:98,:118,:123,:173), confirmed. `environment: release` declared at :115, confirmed as text. Minisign: :147-158 installs minisign and signs checksums.txt; :180 uploads `.minisig`, confirmed. Releases: `gh release list` today = 0.2.2 (Latest, 2026-08-14T19:23Z), 0.2.1, 0.2.0, 0.1.0, exactly four, confirmed. [...]" (reproducer agrees: partially-confirmed / needs-change) "SHA-pinned: confirmed, every `uses:` in orchestrator-release.yml carries a 40-hex SHA (lines 64, 69, 79, 98, 11 [...]"
- Corrected statement / recommendation: Corrected statement: orchestrator-release.yml is SHA-pinned and, as of 6633401, signs checksums.txt with minisign and DECLARES `environment: release`; however the `release` environment has not been created in repo settings, so there is currently no approval gate (a tag push today would auto-create an unprotected environment and publish after the secret check). [...]

### 6.11-6.12 Appendix: first-run runtime and channels/providers

6 item(s) changed in this section (of 7 verified).

#### 6.11-6.12-04

- Verdict: claim **confirmed**; recommendation **needs-change**. Weight: high. Anchor: `orchestrator/src/main.rs:24; src/infra/orchestrator-bridge.ts:1109-1111; .gitignore:209`
- Original claim: The libp2p P2P identity keypair (node.key/node.pub) is written to `<cwd>/keys/` because orchestrator/src/main.rs:24 declares `#[arg(long, default_value = "./keys")]` and src/infra/orchestrator-bridge.ts:1109-1111 only passes `--key-dir` when `p2p.keyDir` is set in config; [...]
- Original recommendation: Always pass --key-dir pointing under ~/.bitterbot (e.g. identity/) so the P2P identity is stable and covered by reset/uninstall. | Default keyDir to <stateDir>/identity/p2p, always pass --key-dir, add one-time migration from <packageRoot>/keys and ~/keys, include in reset/uninstall. [...]
- What the verifiers found: (skeptic: confirmed / needs-change) "orchestrator/src/main.rs:23-25 `#[arg(long, default_value = "./keys")] key_dir: PathBuf`; orchestrator/src/crypto.rs:18-20 `fs::create_dir_all(key_dir)?` then `key_dir.join("node.key")`/`node.pub`. src/infra/orchestrator-bridge.ts:1109-1111 `if (this.config.keyDir) { args.push("--key-dir", this.config.keyDir); [...]" (reproducer: confirmed / sound) "Reproduced from scratch. orchestrator/src/main.rs:24-25 `#[arg(long, default_value = "./keys")] key_dir: PathBuf`; main.rs:100 `crypto::load_or_generate_keypair(&args.key_dir)`; [...]"
- Corrected statement / recommendation: Claim stands. Recommendation should be reconciled with PLAN-37 D5 rather than re-invented: (1) the proposed target `<stateDir>/identity/p2p` conflicts with D5's `~/.bitterbot/keys` (which is also what docs/gateway/configuration-reference.md:2128 already shows), pick one; (2) the migration list `<packageRoot>/keys` and `~/keys` is incomplete: add `<packageRoot>/desktop/keys` (exists on this machine) and the co-located `genesis_trust_list.txt` / `bootnode-peers.json` files (main.rs:105,175); [...] (reproducer adds: Cheaper interim already exists: set `p2p.keyDir` in config (bridge honors it, doctor already recommends it). The recommended default-under-stateDir + always-pass + migration is the right durable fix; [...])

#### 6.11-6.12-05

- Verdict: claim **confirmed**; recommendation **needs-change**. Weight: medium. Anchor: `src/commands/reset.ts; src/infra/orchestrator-bridge.ts:17-20`
- Original claim: `bitterbot reset --scope full` (src/commands/reset.ts) removes the state dir, config, oauth and workspace dirs but does not remove `<cwd>/keys/` or the fixed IPC socket `/tmp/bitterbot-orchestrator.sock` (src/infra/orchestrator-bridge.ts:17-20).
- Original recommendation: Extend reset/uninstall to cover the P2P key dir and the socket (or move the key dir into the state dir).
- What the verifiers found: (reproducer: confirmed / needs-change) "src/commands/reset.ts:139-150 (`scope === "full"`): removePath(stateDir), configPath if !configInsideState, oauthDir if !oauthInsideState, each workspace in workspaceDirs -- nothing else; `grep -n 'keys\|sock' src/commands/reset.ts` returns nothing. [...]" (skeptic agrees: confirmed / needs-change) "src/commands/reset.ts:139-150 (`scope === "full"`): removePath(stateDir), configPath, oauthDir, each workspaceD [...]"
- Corrected statement / recommendation: Keys part stands (best fixed by moving keyDir under the state dir per 6.11-6.12-04, which makes reset cover it for free). The socket part is low value: the orchestrator unlinks a stale /tmp/bitterbot-orchestrator.sock on every start (main.rs:223), so a leftover socket after reset is harmless; do not spend effort on it beyond an optional unlink.

#### 6.11-6.12-08

- Verdict: claim **partially-confirmed**; recommendation **needs-change**. Weight: medium. Anchor: `src/infra/update-startup.ts:16-24; src/gateway/server.impl.ts:621-655`
- Original claim: The gateway performs an update check including a `git fetch` at boot (src/infra/update-startup.ts:16-24, invoked from src/gateway/server.impl.ts:621-655) with a 30-minute floor and 6-hour recheck, on every first boot.
- Original recommendation: Part of 'first boot is noisy and outward-facing by default'; gate network-reaching boot activity for V1 first run.
- What the verifiers found: (skeptic: partially-confirmed / needs-change) "src/infra/update-startup.ts:18-28: UPDATE_CHECK_FILENAME, UPDATE_RECHECK_INTERVAL_MS = 6h (:20), UPDATE_CHECK_TIMEOUT_MS = 10s (:22), UPDATE_CHECK_FLOOR_MS = 30 min (:28 - outside the cited 16-24 range). runGatewayUpdateCheck calls checkUpdateStatus with fetchGit: true (:108-115); [...]" (reproducer agrees: partially-confirmed / needs-change) "src/infra/update-startup.ts: :20 `UPDATE_RECHECK_INTERVAL_MS = 6 * 60 * 60 * 1000`, :28 `UPDATE_CHECK_FLOOR_MS [...]"
- Corrected statement / recommendation: Corrected statement: at boot (including first boot) the gateway runs an update check - `git fetch` on git checkouts, an npm dist-tag lookup on package installs - unless update.checkOnStart is false or Nix mode; floor 30 min, recheck 6h. Recommendation is partially already done: the kill switch exists and is documented, and the report's own row at line 253 proposes a 'Local only' wizard choice that flips checkOnStart. [...]

#### 6.11-6.12-09

- Verdict: claim **partially-confirmed**; recommendation **needs-change**. Weight: high. Anchor: `src/config/defaults.ts:480-511,547; src/gateway/server-startup.ts:165-515`
- Original claim: P2P orchestrator spawn (DNS bootstrap + 4 fleet bootstrap peers, relay reservations, census poll every 30s), circles P2P transport, and the A2A HTTP server are all enabled by default per src/config/defaults.ts:480-511 and :547, and all start during `startGatewaySidecars` (src/gateway/server-startup.ts:165-515) on first boot.
- Original recommendation: First boot is outward-facing by default; decide which of p2p/circles/a2a should be opt-in for V1.
- What the verifiers found: (reproducer: partially-confirmed / needs-change) "defaults.ts:478-509 confirmed (4 fallback peers, p2p enabled true, bootstrapDns, relayMode auto); :547 a2a.enabled ?? true. src/gateway/server-startup.ts: `export async function startGatewaySidecars` at line 30, function body ends line 518 (file is 518 lines, so the cited 165-515 is inside it). Orchestrator spawn: line 175 `if (params.cfg.p2p?.enabled) { ... orchestratorBridge.start()` (line 180). [...]" (skeptic agrees: partially-confirmed / needs-change) "src/gateway/server-startup.ts: startGatewaySidecars spans lines 30-518 (claim's 165-515 is the sidecar body; [...]"
- Corrected statement / recommendation: Corrected: the A2A HTTP handler is created in src/gateway/server-runtime-state.ts:122 (mounted on the gateway HTTP server), not in startGatewaySidecars; the 30s census poll is a local IPC call to the spawned orchestrator, not outbound traffic; circles P2P transport starts inbound-only by default (p2pDial default OFF since c150141 2026-08-14, meshTopic default OFF), so 'circles P2P transport enabled by default' overstates outbound exposure. [...]

#### 6.11-6.12-10

- Verdict: claim **partially-confirmed**; recommendation **needs-change**. Weight: medium. Anchor: `src/cli/update-cli/update-command.ts; src/memory/migrations.ts:2274-2318; src/infra/boot-verify.ts:40`
- Original claim: `bitterbot update` (src/cli/update-cli/update-command.ts) takes no database backup before updating, and memory schema migrations (src/memory/migrations.ts, v1..v62) are forward-only with an N-1 compatibility policy, while the boot-watchdog auto-rollback does `git reset --hard` (kill switch `update.autoRollback.enabled=false`).
- Original recommendation: Add a DB backup step before update so auto-rollback cannot leave code at N-1 against a v-N schema.
- What the verifiers found: (reproducer: partially-confirmed / needs-change) "No backup: `grep -rn -i 'backup|VACUUM INTO|snapshot' src/cli/update-cli/update-command.ts src/infra/update-runner.ts` hits only readConfigFileSnapshot (config, not DB); `grep -n -i 'memory|sqlite' src/infra/update-runner.ts` -> empty; repo-wide `VACUUM INTO|.backup(` in src/ -> empty. The only backup on this machine is a manual ~/.bitterbot/workspace-memory-backup-20260812-2246.tgz. [...]" (skeptic: confirmed / needs-change) "No backup: grep -i 'backup|vacuum|sqlite' in src/cli/update-cli/update-command.ts hits only config readConfigFileSnapshot (lines 8,291,516); [...]"
- Corrected statement / recommendation: Corrected anchor: the `git reset --hard` is in src/infra/boot-watchdog.ts:136, not boot-verify.ts:40. Corrected recommendation rationale: a pre-update DB backup does NOT prevent 'code at N-1 against a v-N schema' -- the watchdog rolls back code only and the N-1 policy (migrations.ts:8-22) is the mechanism that makes that state safe by design. The backup is still worthwhile as a recovery net for a migration that violates the policy or corrupts data; [...] (skeptic adds: Corrected recommendation: keep the N-1 policy as the rollback safety mechanism (it already covers the stated scenario). [...])

#### 6.11-6.12-11

- Verdict: claim **partially-confirmed**; recommendation **needs-change**. Weight: low. Anchor: `src/checkpoints/agent-event-writer.ts:45; src/infra/orchestrator-binary.ts:68`
- Original claim: checkpoints.sqlite path in src/checkpoints/agent-event-writer.ts:45 is built from os.homedir() and ignores BITTERBOT_STATE_DIR; likewise the orchestrator binary path in src/infra/orchestrator-binary.ts:68 uses os.homedir().
- Original recommendation: Route all state paths through the STATE_DIR resolver.
- What the verifiers found: (reproducer: partially-confirmed / needs-change) "src/checkpoints/agent-event-writer.ts:42-47: `defaultCheckpointDbPath()` returns `process.env.BITTERBOT_CHECKPOINT_DB ?? path.join(os.homedir(), ".bitterbot", "checkpoints.sqlite")` -- homedir default confirmed and BITTERBOT_STATE_DIR is not consulted, but an explicit env override (BITTERBOT_CHECKPOINT_DB) exists, which the claim omits. [...]" (skeptic: confirmed / needs-change) "src/checkpoints/agent-event-writer.ts:42-47 `defaultCheckpointDbPath()` returns `process.env.BITTERBOT_CHECKPOINT_DB ?? path.join(os.homedir(), ".bitterbot", "checkpoints.sqlite")` (line 45 confirmed); [...]"
- Corrected statement / recommendation: Corrected claim: checkpoints path ignores BITTERBOT_STATE_DIR but honors BITTERBOT_CHECKPOINT_DB; the homedir default is duplicated in checkpoints-cli.ts:17/26 as well. Corrected recommendation: route the checkpoint default through resolveStateDir (paths.ts:45) in both agent-event-writer.ts and checkpoints-cli.ts. For the orchestrator binary, changing only orchestrator-binary.ts:68 would break lookup because scripts/fetch-orchestrator.mjs:33 installs to ~/.bitterbot/bin; [...] (skeptic adds: Claim holds for both lines, but the recommendation is wrong as stated for the orchestrator binary: routing the prebuilt lookup through STATE_DIR would break every `--profile` / BITTERBOT_STATE_DIR user [...])

## 3. Impact on the decisions and the plan

Short answer: no decision flips. Eight of ten decisions keep their recommendation with corrected mechanics; D3 and D4 lose items from their flip lists because some flips are already in effect or are no-ops. The P0 list keeps all 29 items but 24 of them have amended action text (see the corrections list); two P0 sub-items are already done and one turns out to be a different, cheaper first step. Effort totals move by about a day in each direction and net out.

### D1 Install matrix (source via `install.sh`/`install.ps1` + Docker on GHCR; defer npm and Tauri; delete Swift/Sparkle/Podman)

Changes the recommendation: **no**, with three corrections. (1) The "size win is not there" argument against Tauri (4b, Jan) was wrong: Jan's own release assets show a measured 1 GB to 82-150 MB drop and the current builds bundle bun/uv, not an inference engine. Tauri stays post-V1 on schedule grounds only (build-sea is broken, no signing identity, `main.rs` still spawns `node`). (2) A hosted `install.sh` needs text/plain hosting at bitterbot.ai, which is an out-of-repo change (the site is an SPA catch-all today), and re-running it should delegate to the existing `bitterbot update` with its auto-rollback watchdog rather than implement a second update path. (3) The orchestrator prebuilt-binary row is not "supported (existing signed workflow)": the signing job has never executed, there are 0 repository secrets and no `release` environment. It becomes supported only after SIGNING.md steps 1-5 run. Deleting Podman overrides PLAN-37 row 39, which decided to keep `bitterbot.podman.env`; D1 must say so explicitly.

### D2 Versioning (SemVer 1.0.0, tag `v1.0.0`, orchestrator stays `orchestrator-v0.x`)

Changes the recommendation: **yes, in mechanics, not in the choice**. No workflow listens for a bare `v*` tag and there is no `release.yml`; the only app-release pipeline is `desktop-release.yml` on `desktop-v*`. Either tag `desktop-v1.0.0` or add a `v*` trigger. The "one-line guard in `compareSemverStrings`" is not enough: `compareBitterbotVersions` in `src/config/version.ts` fires on every existing git install via `warnIfConfigFromFuture`, so both comparators need the CalVer-is-older rule. The desktop version is split (0.1.0 in `tauri.conf.json`/`src-tauri` vs 2026.2.15 in `desktop/package.json`), so the sync script must cover `extra-files` if release-please is adopted, and release-please itself is net-new (nothing is installed). Decision stands.

### D3 Circles default (opt-in; `practicePartner` off; mailbox poll only when enabled)

Changes the recommendation: **yes, narrower**. `circles.enabled=false` stands. The mailbox already polls only when circles is enabled and the node has a non-practice circle, so that clause is already true. `practicePartner` should stay ON inside opted-in circles because it is what makes a solo circle usable. Also note the strict circles zod schema does not declare `p2pDial`/`meshTopic`/`dial`, so doctor deletes those keys; that is a separate finding (#2 in 3.1) that must land before any Labs toggle writes `circles.*`.

### D4 Network defaults (flip marketplace/payment/forage/skillSeekers/marketability OFF; wizard consent step; `network.localOnly`)

Changes the recommendation: **yes, narrower and partly already done**. `a2a.payment` is already derived OFF without CDP credentials and `harnessEvolve` is already mode-held, so both flips are no-ops. `tools.wallet` currently defaults ON on base-sepolia (the claim that it is default-OFF was refuted), so it belongs on the flip list. `curiosity` can be flipped or the open F9 fix shipped instead; `rlm` OFF removes the deep_recall tool, so prefer keeping it capped. The wizard consent step already exists in the advanced flow (`onboarding.p2p.ts:77-90`) and should be promoted to QuickStart rather than written again. A `network.localOnly` key is unnecessary: a Local-only wizard preset over the existing flags (`p2p.enabled`, `circles.enabled`, `a2a.enabled`, `update.checkOnStart`, `models.liveDiscovery.enabled`) does the same without a new schema key. `p2p.enabled` stays a Victor call.

### D5 Who serves the Control UI (PLAN-39 phase 1)

Changes the recommendation: **no, with corrected scope**. Gateway serving is PLAN-39 Phase 2, gated on the Phase 0 restart-blackout measurement, and Phase 1 is the build pipeline; effort is M-L, not M. `src/infra/ui-restart.ts:337` also spawns `pnpm dev` and must change with `start:all` and onboarding. The `bitterbot dashboard` token handoff is half-built (CLI emits `#token=`, renderer never reads `location.hash`, 19001 serves no UI), so P0 item 19's handoff lands after this, and FirstRun keeps a paste-token screen until then. Port 5173 appears in 11+ docs pages.

### D6 Labs vs removal

Changes the recommendation: **no, one item reopened**. Debug and Instances are safe to delete. Projects should be decided as a whole feature (its backend is wired into `chat.send`), not "remove UI, keep backend". Sessions duplicates Conversations and should be dropped or justified rather than re-homed. Logs/Usage/Nodes/Workspace have never been reachable, so "re-home" means exposing them for the first time under Advanced. The nav baseline is 11 visible items, not 12-13. The Labs manifest (pattern 5) should derive `requiresRestart` from `config-reload.ts`; today `circles.*` is hot and `p2p.*`, `memory.*`, `a2a.*`, `forage.*` fall through to restart-required.

### D7 Keyless memory path (auto-download the local GGUF)

Changes the recommendation: **no, with corrected mechanics**. The download code already exists behind `provider: "local"`; the gap is that `auto` never selects it. The local provider must come last in the chain (after remote keys) and only after node-llama-cpp and sqlite-vec load, so DoD 3 ("memory works without a key") needs a platform qualifier. The model is ~329 MB. The health RPC must expose the manager error to the `/dreams` page too, and `status.scan.ts` currently discards it. The dream model should use the key-aware cheap-sibling chooser already in `manager.ts:1568-1577`, not "the primary model" (8 Opus calls per cycle), and the empty-DB skip already exists.

### D8 Docker (fix)

Changes the recommendation: **no, cheaper**. The image fix is two Dockerfile lines plus dropping the UI build step and fetching the orchestrator outside the mounted tree (S); the `docker build` CI job and GHCR publish are the M part. It is the same call as PLAN-39 D4. No `:slim` variant is needed because the image bakes no Chromium today. `docker-compose.yml` and `docker-setup.sh` exist but have never run against a buildable image; deletion (the alternative) must also remove `src/docker-setup.test.ts` and `.dockerignore`.

### D9 Docs hosting (deploy Mintlify to docs.bitterbot.ai after the nav prune)

Changes the recommendation: **partly; half of it is already done**. `formatDocsLink` already points at the GitHub `docs/` tree (`src/terminal/links.ts:3`, commit 007db0a). 62 source files (not 81) still mention the host, mostly as link labels; the raw literals are in `docs.ts:8,164`, `system-prompt.ts:648` and three troubleshooting prints. The remaining decision is only the DNS record plus Mintlify deploy, after the nav prune; the code-side fix is a constant plus a local fallback for `bitterbot docs`. The docs link audit already runs in CI via `check:docs` (the claim that it does not was refuted); its glob skips `docs/*.md`.

### D10 Windows ("via WSL2" for V1)

Changes the recommendation: **no**. Docs already say this in three places and CI already runs install/typecheck/unit tests on windows-latest; the remaining edits are the README badge, the getting-started PowerShell tab (dead `install.ps1`) and the setup-deps exit message.

### P0 (29 items)

All 29 items survive. The corrections list amends 24 of them. The material changes:

- Item 1 (orchestrator release): the tag push fails at the sign step today; SIGNING.md steps 1-5 (keypair, embed pubkey in `update-orchestrator.sh:40`, `MINISIGN_SECRET_KEY`, `release` environment) come first; no fetcher fallback; doctor stays at warn.
- Item 3 (docs Step 1): 14 `github.com/bitterbot/bitterbot` URLs, the dangling `/install` link and the docs.json install pages join the scope; the grep step goes inside the existing `check:docs`.
- Item 5 (`bitterbot dashboard`): the fix is in `resolveControlUiLinks`, which has six callers, and the unread `#token=` fragment should be dropped.
- Item 6 (keyless memory): see D7.
- Item 8 (boot stall): the first step is `NODE_ENV=production` or preferring `dist/plugin-sdk/index.js` in the alias order, because the `bitterbot/plugin-sdk` alias drags ~1,900 source modules through jiti; "precompile extensions" is dropped (the transpile cache was warm during the 27-minute stall); the hormonal accessor's first refresh moves past listen; the FTS backfill is measured before it is touched.
- Item 9 (A2A bypass): loopback-only is not enough under tailscale serve (the waiver fires on the proxied loopback branch) and POST /a2a has no Origin/Host check.
- Item 10 (default flips): see D3/D4; two flips are no-ops, `tools.wallet` joins, consent step is promoted not added.
- Item 13 (nav regroup): baseline is 11, Projects/Sessions are decisions, four views are exposed for the first time.
- Item 15 (Settings form): switch saves from `config.apply` to `config.patch` so the reload plan comes back and the forced restart on every save goes away; `config.schema` already has an empty slot in the config store.
- Item 16 (native dialogs): the lint rule is oxlint `eslint/no-alert` after removing `desktop/` from `.oxlintrc.json` ignorePatterns; there is no eslint.
- Item 19 (FirstRun): token handoff lands after PLAN-39; `vite.config.ts` also reads the token from `bitterbot.json`; the stale on-disk `dist-renderer` already contains the live token and must be deleted.
- Item 21 (fonts): the Geist CDN URLs have 404'd since the day they were added; vendor woff2 with hand-written `@font-face`.
- Item 22 (dream model): cheap-sibling chooser, not the primary model; empty-DB skip exists.
- Item 24 (dead scripts): 30 dead scripts not 32; ~57 MB of benchmark artifacts not 56; the `.gitignore` rewrite must keep the load-bearing Python/Rust rules; LINE removal needs `stripMarkdown` relocated first.
- Item 26 (docs.json): ~70 real orphans, wallet is already in nav, the link audit is already in CI and needs `docs/*.md` added to its glob.
- Item 28 (CLI): `-v` has three sites; hide dev commands in both placeholders and real registrars; `doctor` should suppress posture lines for unconfigured subsystems rather than overload `--deep`.
- Item 29 (identity/tagging): ~20 files incl. `update-cli/shared.ts:40` and `system-prompt.ts:649`; `desktop-v1.0.0` or a new `v*` trigger; `docs/reference/RELEASING.md` already exists and is stale.

Already done before the audit (drop from P0 scope): the `formatDocsLink` repoint (item 27 / D9), the quarantine 30-day TTL sweeper (P1 runtime line), the hidden deprecated setup-token picker choice (P1), Telegram as the quickstart default (P1), the SHA-256 check in `fetch-orchestrator.mjs` (4b installer row). The one unsound recommendation (`2.5-2.6-25`) is amended in place in section 2.6.

### P1

Unchanged in shape. Corrections: the Ollama item builds on the existing Custom Provider path (which already pre-fills `127.0.0.1:11434/v1` and probes it) instead of a new wizard group; "Telegram as quickstart default" and "deprecated choice hidden" are already true; "Baileys stable pin" is impossible because no stable 7.x exists (choose rc14 or fall back to 6.7.24); the sidecar `info` channel is a parameter-type widening, not a new channel; quarantine retention exists; the `ADVANCED_PATHS` item must note that nothing in the renderer reads uiHints today, so it is two halves; the Help & Docs sidebar link waits for a docs destination.

### P2

Unchanged in shape. Corrections: the backup item needs `VACUUM INTO`/`db.backup()` through the gateway's open handles (four WAL-mode databases) and gzip or a Node >= 22.15 bump for zstd; the release-automation item drops cosign (duplicate trust root next to minisign) and treats attestations as optional; the ChannelFlow item should extend the existing `onboarding-types.ts` contract and move `CHANNEL_SETUP_DESCRIPTORS` out of the renderer instead of adding a new contract; the update-channel selector is a UI over the existing `update.channel`, and `update.checkOnStart` is the existing kill switch; the memory-blocks UI is PLAN-33 Phase 4 and needs a `memory` rule in `config-reload.ts` before a Pause toggle ships.

### Effort and definition of done

P0 totals stay at roughly 24 engineer-days: item 8 likely shrinks (a one-line alias change may resolve the stall), item 1 grows by the signing runbook, item 20 grows to M-L, item 4's image fix shrinks to S. DoD 1 is a wizard change (QuickStart asks 15-19 prompts today and hard-wires `desktop/.env`); DoD 2 should not reuse `--deep`; DoD 3 gains a platform qualifier and names the cheap dream model; DoD 9 replaces "attested artifacts" with minisign-signed GitHub release assets (npm is unpublished) and names the real tag form.

## 4. Confirmed claims

133 claims were confirmed as written. Recommendation verdicts are listed because a confirmed fact can still carry a recommendation that was changed in section 2.

| id           | claim                                                                                                                                                                              | verdict   | rec          | strongest evidence                                                                                                                                                                                         |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| 1-02         | orchestrator/Cargo.toml line 3 declares package version 0.2.3.                                                                                                                     | confirmed | needs-change | `sed -n 1,12p orchestrator/Cargo.toml` -> line 3: `version = "0.2.3"`. `git log -1 -- orchestrator/Cargo.toml` -> 017761f 2026-08-15 "fix(circles): B3 mesh rate limiting + B4 relay hardening [...]       |
| 1-04         | The checksums URL for orchestrator-v0.2.3 (the URL built by scripts/fetch-orchestrator.mjs from the Cargo.toml version) returns HTTP 404.                                          | confirmed | needs-change | Re-derived the URL from scripts/fetch-orchestrator.mjs:32 (REPO = "Bitterbot-AI/bitterbot-desktop"), :172 (releaseBase = https://github.com/${REPO}/releases/download/orchestrator-v${version}) [...]      |
| 1-05         | The postinstall orchestrator fetch (scripts/fetch-orchestrator.mjs) only warns and exits 0 when the release download fails, so `pnpm install` succeeds without the orchestr [...]  | confirmed | needs-change | package.json:108 `"postinstall": "node scripts/fetch-orchestrator.mjs"`. scripts/fetch-orchestrator.mjs:6-12 header: "Non-fatal by design: any failure ... [...]                                           |
| 1-10         | docs/index.md line 100 says `npm install -g bitterbot@latest`, and the npm registry returns Not found for the package name `bitterbot`.                                            | confirmed | needs-change | docs/index.md:100 reads exactly ` npm install -g bitterbot@latest` inside the Quick start `<Step title="Install Bitterbot">`. [...]                                                                        |
| 1-42         | docker-compose.yml and docker-setup.sh exist in the repo root alongside the broken Dockerfile.                                                                                     | confirmed | needs-change | `ls -la Dockerfile docker-compose.yml docker-setup.sh` at repo root: Dockerfile (1553 B, Feb 19 2026), docker-compose.yml (1060 B, Mar 28), docker-setup.sh (6307 B, Mar 28); [...]                        |
| 2.1-2.2-01   | The Control UI top-level navigation is defined by a NAV_ITEMS array at desktop/renderer/src/components/layout/Sidebar.tsx lines 57-82 containing exactly 12 entries: overvi [...]  | confirmed | needs-change | Reproduced from scratch: `git ls-files \| grep Sidebar.tsx` -> desktop/renderer/src/components/layout/Sidebar.tsx (661 lines). [...]                                                                       |
| 2.1-2.2-25   | desktop/renderer/src/components/instances/InstancesView.tsx (81 lines) depends on a `hello.instances` field that the gateway never sends; [...]                                    | confirmed | sound        | `wc -l` InstancesView.tsx = 81. Lines 19-21 read `Array.isArray(hello?.instances) ? hello.instances : []`. [...]                                                                                           |
| 2.1-2.2-27   | desktop/renderer/src/components/logs/LogsView.tsx is 184 lines and is backed by the `logs.tail` gateway RPC.                                                                       | confirmed | sound        | `wc -l desktop/renderer/src/components/logs/LogsView.tsx` = 184. Only gateway call in the file: line 63 `(await request("logs.tail", params))`. [...]                                                      |
| 2.1-2.2-28   | desktop/renderer/src/components/sessions/SessionsView.tsx is 255 lines and is backed by sessions.list/patch/delete/reset RPCs; [...]                                               | confirmed | needs-change | Line counts reproduced: SessionsView.tsx 255, UsageView.tsx 250, NodesView.tsx 241. RPCs reproduced by grep: SessionsView calls sessions.list (140), sessions.patch (161), sessions.delete (173 [...]      |
| 2.3-2.4-09   | The commands acp, checkpoints, heartbeat, system, hooks, webhooks, dns, daemon are currently visible in root help (not registered with hidden: true), and no BITTERBOT_SHOW [...]  | confirmed | needs-change | All eight names are SubCliEntry records in src/cli/program/register.subclis.ts with no hidden field and none possible (type at :9-13 has only name/description/register): acp :36, daemon :52, [...]       |
| 2.5-2.6-12   | The bundled OAuth provider extensions google-antigravity-auth, google-gemini-cli-auth and qwen-portal-auth exist in extensions/ and are disabled by default (not in BUNDLED [...]  | confirmed | sound        | `ls extensions` includes google-antigravity-auth, google-gemini-cli-auth, qwen-portal-auth; e.g. extensions/google-gemini-cli-auth/bitterbot.plugin.json `{"id":"google-gemini-cli-auth","provi [...]      |
| 2.5-2.6-13   | PLAN-13 skill ingestion security (quarantine, trust) is shipped and ON by default, with findings F6/F16 fixed on 2026-08-09.                                                       | confirmed | sound        | docs/plans/PLAN-13-skill-ingestion-security.md:3 'Status: Phases A, A.5, B, B.5, B.6, B.7, and Phase C (TTL sweeper, bulk-reject, peer decay) shipped 2026-04-26. [...]                                    |
| 2.5-2.6-16   | PLAN-18/27/28 (SAGE graph memory, graph-anchored recall, graph population) are landed and ON by default.                                                                           | confirmed | sound        | PLAN-18: src/memory/knowledge-graph.ts exists; src/memory/migrations.ts:563 `version: 13`; manager.ts:269 'PLAN-18 Phase 1, small fast LLM call for query decomposition'. [...]                            |
| 2.5-2.6-19   | PLAN-23 SABM reconsolidation exists as a dream mode that is disabled (OFF) by default.                                                                                             | confirmed | sound        | Reproduced from scratch. src/memory/dream-types.ts:21 `\| "relationship_reconsolidation" // PLAN-23 SABM: adjudicate flagged belief contradictions...`; [...]                                              |
| 3.1-01       | In src/config/zod-schema.ts at about line 539 the `circles` zod object is declared `.strict()` and does not include the sub-keys `dial`, `meshTopic`, or `p2pDial`.                | confirmed | needs-change | Reproduced from scratch. `grep -n circles src/config/zod-schema.ts` -> single hit at line 539 (`circles: z`). [...]                                                                                        |
| 3.1-02       | src/config/types.circles.ts declares `dial`, `meshTopic`, and `p2pDial` at about lines 48/62/78, and the keys are read at src/circles/service.ts:302-312, src/gateway/serve [...]  | confirmed | sound        | src/config/types.circles.ts: `dial?: {` at line 48, `meshTopic?: {` at line 62, `p2pDial?: {` at line 78 (grep output). [...]                                                                              |
| 3.1-03       | Running the config zod `safeParse({circles:{p2pDial:{enabled:true}}})` returns an `unrecognized_keys` error, server.impl.ts:241-250 then throws "Invalid config", and the ` [...]  | confirmed | sound        | safeParse reproduced (see 3.1-01): `unrecognized_keys` at path ["circles"] for p2pDial/meshTopic/dial. Chain to the crash: src/config/validation.ts:103 `BitterbotSchema.safeParse(raw)` -> ok: [...]      |
| 3.1-04       | docs/network/circles.md line 33 states that the circles p2pDial/mesh transport is "default ON", which is stale relative to the code.                                               | confirmed | sound        | docs/network/circles.md:32-33: `Point-to-point circle RPC over the mesh (orchestrator v0.2.2, \`circles.p2pDial\`, default ON) dials members by their signed PeerId`. [...]                                |
| 3.1-05       | In src/gateway/a2a/a2a-http.ts:706-716 the comment says the auth waiver applies to loopback only, but the code calls `isPrivateOrLoopbackAddress`, which also matches 10/8, [...]  | confirmed | needs-change | Reproduced from scratch. src/gateway/a2a/a2a-http.ts:706 `// Allow local loopback without token.`; :713 `if (clientIp && isPrivateOrLoopbackAddress(clientIp)) { return { ok: true }; [...]                |
| 3.1-07       | The A2A bearer-token comparison at src/gateway/a2a/a2a-http.ts:724 is a plain `===` (not constant-time), the A2A tests only exercise the remote address 8.8.8.8, and src/co [...]  | confirmed | sound        | src/gateway/a2a/a2a-http.ts:724 `if (a2aToken && token === a2aToken) {` - plain ===. a2a-http.ts has no import of safeEqualSecret (grep -l safeEqualSecret lists auth.ts, server-http.ts, secre [...]      |
| 3.1-11       | In src/memory/embeddings.ts:67 `canAutoSelectLocal` returns false unless an on-disk local model path is configured, so the `auto` embedding provider only tries openai/gemi [...]  | confirmed | needs-change | Reproduced from scratch: `grep -rn canAutoSelectLocal src/` -> src/memory/embeddings.ts:68 (declaration; the cited :67 is off by one, line 67 is blank). [...]                                             |
| 3.1-12       | When MemoryIndexManager.get fails, the gateway emits a single log.warn at src/gateway/server-startup-memory.ts:31, the `dream.*` RPCs throw, and the Control UI shows nothi [...]  | confirmed | sound        | src/gateway/server-startup-memory.ts:29-34: `const { manager, error } = await getMemorySearchManager(...); [...]                                                                                           |
| 3.1-17       | desktop/vite.config.ts:114-118 bakes VITE_GATEWAY_TOKEN into 1 of 337 renderer chunks via `define`; [...]                                                                          | confirmed | sound        | Reproduced: desktop/vite.config.ts:113-118 `define: { "import.meta.env.VITE_GATEWAY_URL": JSON.stringify(url), "import.meta.env.VITE_GATEWAY_TOKEN": JSON.stringify(token), ... }`. [...]                  |
| 3.1-18       | Circles is ON by default (src/config/defaults.ts:628,634), the practice-partner bot auto-seats in solo circles (src/circles/service.ts:2184-2200), there is no Settings tog [...]  | confirmed | needs-change | src/config/defaults.ts:628 `enabled: circles.enabled ?? true,`; :634 `practicePartner: { enabled: true, ...circles.practicePartner },`; [...]                                                              |
| 3.1-24       | scripts/fetch-orchestrator.mjs:174-199 verifies downloaded orchestrator binaries only against a same-origin checksums.txt (no signature); [...]                                    | confirmed | needs-change | scripts/fetch-orchestrator.mjs:172 `const releaseBase = \`https://github.com/${REPO}/releases/download/orchestrator-v${version}\``; [...]                                                                  |
| 3.1-30       | desktop/resources/demo-config.json:5-27 contains `dangerouslyDisableDeviceAuth`, `security: full`, `ask: off`, `token: local-dev-token` and elevated webchat `*`, has zero [...]   | confirmed | sound        | Reproduced from scratch. `cat -n desktop/resources/demo-config.json` shows line 6 `"dangerouslyDisableDeviceAuth": true`, line 7 `"allowInsecureAuth": true`, line 10 `"token": "local-dev-toke [...]      |
| 3.2-02       | scripts/fetch-orchestrator.mjs line 172 builds the GitHub release download URL from the Cargo.toml version with no fallback to an older published release.                         | confirmed | needs-change | `cat -n scripts/fetch-orchestrator.mjs` line 172: `const releaseBase = \`https://github.com/${REPO}/releases/download/orchestrator-v${version}\`;` where `version` comes solely from readOrches [...]      |
| 3.2-06       | The release workflow in .github/workflows refuses to publish an unsigned orchestrator release until the MINISIGN_SECRET_KEY secret is set.                                         | confirmed | needs-change | cat -n .github/workflows/orchestrator-release.yml -> lines 141-146 in the `release` job: `MINISIGN_SECRET_KEY: ${{ secrets.MINISIGN_SECRET_KEY }}` then `if [ -z "$MINISIGN_SECRET_KEY" ]; [...]           |
| 3.2-09       | https://bitterbot.ai/install.sh returns HTTP 200 with Content-Type text/html (the SPA catch-all page), not a shell script; [...]                                                   | confirmed | sound        | `curl -sI https://bitterbot.ai/install.sh` -> `HTTP/2 200`, `content-type: text/html; charset=utf-8`, `content-length: 1293`, `etag: W/"50d-19fb42d4ad8"`, `server: Google Frontend`. [...]                |
| 3.2-11       | No file named install.sh or install.ps1 exists anywhere in the repository's git history.                                                                                           | confirmed | needs-change | `git log --all --oneline --name-only --diff-filter=A -- '*install.sh' '*install.ps1'` returns nothing (no file matching either name was ever added in any branch). [...]                                   |
| 3.2-13       | docs/platforms/windows.md line 145 tells users to clone github.com/bitterbot/bitterbot.git, which is not this project's repository.                                                | confirmed | needs-change | docs/platforms/windows.md:145 reads `git clone https://github.com/bitterbot/bitterbot.git` (followed by `cd bitterbot`, and a duplicated `pnpm build` at lines 148-149). [...]                             |
| 3.2-15       | Dockerfile lines 20-21 run `COPY ui/package.json` and `COPY patches`, and neither a `ui/` directory nor a `patches/` directory exists in the repo, so `docker build` fails. [...]  | confirmed | needs-change | Reproduced from scratch. `cat -n Dockerfile` -> line 20 `COPY ui/package.json ./ui/package.json`, line 21 `COPY patches ./patches`. `ls -d ui patches` -> both 'No such file or directory'; [...]          |
| 3.2-16       | Dockerfile line 30 runs `pnpm ui:build`, but no `ui:build` script is defined in package.json.                                                                                      | confirmed | needs-change | Dockerfile:30 `RUN pnpm ui:build`. Dumped root package.json scripts via `node -e` (full list of ~95 keys): no `ui:build` key; the only `ui`-prefixed entries do not exist at all. [...]                    |
| 3.2-17       | Dockerfile lines 3-5 install Bun, which is never used elsewhere in the Dockerfile or build.                                                                                        | confirmed | sound        | Dockerfile:3-5: `# Install Bun (required for build scripts)`, `RUN curl -fsSL https://bun.sh/install \| bash`, `ENV PATH="/root/.bun/bin:${PATH}"`. No later Dockerfile line invokes `bun`; [...]          |
| 3.2-19       | docker-compose.yml lines 18 and 39 run `dist/index.js` while the Dockerfile CMD runs `bitterbot.mjs`; the two entrypoints disagree.                                                | confirmed | sound        | docker-compose.yml:15-24 gateway `command: ["node", "dist/index.js", "gateway", "--bind", ...]` (dist/index.js at line 18); :39 cli `entrypoint: ["node", "dist/index.js"]`. [...]                         |
| 3.2-21       | No workflow in .github/workflows runs `docker build`, and the Dockerfile has not been modified since the repository's initial commit.                                              | confirmed | needs-change | `ls .github/workflows` -> ci.yml, desktop-release.yml, orchestrator-release.yml, skill-review.yml. `grep -rn -iE 'docker (build\|buildx)\|docker/build-push\|docker/setup-buildx\|ghcr\|Dockerfile' [...]  |
| 3.2-24       | scripts/start-all.mjs line 171 launches the 'production' Control UI via `pnpm dev` (a Vite dev server, desktop/package.json:9, with strictPort 5173), the gateway token is [...]   | confirmed | needs-change | Reproduced: scripts/start-all.mjs:171 `startChild("ui", colors.ui, "pnpm", ["dev"], { cwd: path.join(repoRoot, "desktop") })` (and again at :227 for respawn); [...]                                       |
| 3.2-26       | scripts/preinstall-check.mjs line 105 says setup-deps installs pkg-config/libssl-dev, but scripts/setup-deps.sh lines 64-69 install only ripgrep, trash-cli, htop, ffmpeg, [...]   | confirmed | sound        | scripts/preinstall-check.mjs:102-107 (Linux branch, process.platform === 'linux') warns: `run: bash scripts/setup-deps.sh which installs the full dep set (pkg-config, libssl-dev, ffmpeg, chro [...]      |
| 3.2-28       | src/wizard/onboarding.finalize.ts line 201 runs a gateway health check 2 seconds after service install with a 10 second timeout, while the same file states cold start is ~ [...]  | confirmed | needs-change | src/wizard/onboarding.finalize.ts:197-202: `if (!opts.skipHealth && installDaemon) { ... await new Promise((resolve) => setTimeout(resolve, 2000)); [...]                                                  |
| 3.3-01       | The CONFIGURE_WIZARD_SECTIONS list in src/commands/configure.shared.ts (around line 10) contains no `wallet` entry and no `memory` entry.                                          | confirmed | needs-change | Reproduced from scratch: `grep -rn CONFIGURE_WIZARD_SECTIONS src/` -> definition at src/commands/configure.shared.ts:10. [...]                                                                             |
| 3.3-03       | Eleven call sites tell users to run `bitterbot configure --section wallet`: doctor-wallet.ts:131 and :137, onboarding.wallet.ts:120, 288, 309, 342, 443, docs/gateway/confi [...]  | confirmed | sound        | `git grep -n -- "--section wallet"` returns exactly 11 hits: .env.example:77, docs/gateway/configuration-reference.md:1567, docs/help/environment.md:64, docs/reference/wizard.md:113, src/comm [...]      |
| 3.3-05       | docs/cli/configure.md line 32 uses `--section models` while the valid section name is `model`.                                                                                     | confirmed | sound        | docs/cli/configure.md:32 reads `bitterbot configure --section models --section channels` (verified via sed -n 25,40p). `git grep -n -- "--section models"` returns only this one hit. [...]                |
| 3.3-06       | No test guards the CONFIGURE_WIZARD_SECTIONS list against `--section` strings used in src, docs, or .env.example.                                                                  | confirmed | sound        | `git grep -ln "parseConfigureWizardSections\|CONFIGURE_WIZARD_SECTIONS\|WizardSection\|--section" -- '*.test.ts' '*.spec.ts' 'test/**' 'scripts/**'` returns no files. [...]                               |
| 3.3-08       | Because MemorySchema uses passthrough, `bitterbot doctor` cannot repair memory-key typos (no `unrecognized_keys` issue is produced) and the generated JSON schema emits `ad [...]  | confirmed | sound        | Reproduced both halves. (a) Doctor: src/commands/doctor-config-flow.ts:74-107 `stripUnknownConfigKeys` does `BitterbotSchema.safeParse(config)` and only acts on issues where `issue.code === " [...]      |
| 3.3-11       | In desktop/renderer/src/components/config/ConfigView.tsx (lines 6-64 and 99-118), ConfigFormView ignores its `onSave`/`saving` props and renders `Object.entries` as plain [...]   | confirmed | needs-change | Reproduced from scratch with `cat -n desktop/renderer/src/components/config/ConfigView.tsx` (254 lines). `ConfigFormView` spans lines 6-64 exactly; [...]                                                  |
| 3.3-12       | The renderer never calls the `config.schema` or `config.patch` gateway RPC methods, even though both exist in src/gateway/server-methods/config.ts at lines 254 and 283.           | confirmed | sound        | `grep -n '"config\.' src/gateway/server-methods/config.ts` shows handlers at line 246 (`config.get`), 254 (`config.schema`), 260 (`config.set`), 283 (`config.patch`), 426 (`config.apply`) -- [...]       |
| 3.3-13       | ConfigFormView has never been editable at any point in git history (no prior commit had a working form editor).                                                                    | confirmed | sound        | `git log --oneline --follow -- desktop/renderer/src/components/config/ConfigView.tsx` returns exactly two commits: 35b3a0f (2026-03-28, "Electron App", file added) and 8b13436 ("style: bulk f [...]      |
| 3.3-15       | docs/web/control-ui.md lines 11 and 84 describe a "Vite + Lit" Control UI with schema-driven form rendering that does not exist (the UI is React and has no form rendering) [...]  | confirmed | sound        | docs/web/control-ui.md:11 'The Control UI is a small **Vite + Lit** single-page app served by the Gateway:'; [...]                                                                                         |
| 3.3-16       | The Control UI already has proper dedicated editors for models and channels (unlike the generic config view).                                                                      | confirmed | sound        | Sidebar nav (desktop/renderer/src/components/layout/Sidebar.tsx:62 `channels`, :81 `models` "Models & Keys", :82 `config`). [...]                                                                          |
| 3.3-17       | docs/gateway/configuration-reference.md is 2,553 lines long and contains zero occurrences of circles, `a2a.`, `memory.`, forage, commerce, harnessEvolve, curiosity, dream, [...]  | confirmed | needs-change | Reproduced: `wc -l docs/gateway/configuration-reference.md` = 2553. Case-insensitive grep -c per term: circles 0, `a2a\.` 0, forage 0, commerce 0, harnessEvolve 0, curiosity 0, dream 0, autoR [...]      |
| 3.3-18       | GROUP_LABELS in src/config/schema.hints.ts (around line 22) lacks entries for memory, circles, p2p, and a2a but includes entries for `presence` and `voicewake`, which are [...]   | confirmed | needs-change | src/config/schema.hints.ts:22-48 GROUP_LABELS contains: wizard, update, diagnostics, logging, gateway, nodeHost, agents, tools, bindings, audio, models, messages, commands, session, cron, hoo [...]      |
| 3.4-01       | desktop/renderer/src/components/dreams/DreamsView.tsx lines 27-36 render the "Dreams (beta)" view as an iframe that loads the gateway dream dashboard page (src/gateway/dre [...]  | confirmed | needs-change | Reproduced at HEAD c5e1f97. `cat -n desktop/renderer/src/components/dreams/DreamsView.tsx` lines 26-39: `export function DreamsView() { const src = useMemo(() => `${resolveGatewayHttpUrl()}/d [...]      |
| 3.4-02       | src/gateway/dream-dashboard-page.ts lines 99-108 define ten tabs: Status, Utility, History, Analytics, Emotional, Curiosity, Retrieval, Earnings, Forage, Live.                    | confirmed | needs-change | `sed -n 98,109p src/gateway/dream-dashboard-page.ts` shows `<div class="tabs">` at line 98 followed by exactly ten `<button class="tab" data-tab=...>` elements at lines 99-108 in this order: [...]       |
| 3.4-04       | src/gateway/server-http.ts lines 514-533 waive authentication for the dream dashboard page only for loopback requests, so a user loading the Control UI from a LAN (non-loo [...]  | confirmed | needs-change | src/gateway/server-http.ts:514-533 reproduced: the `/dreams` GET handler calls `authorizeGatewayConnect` with `connectAuth: token ? {token, password: token} : null` where `token = getBearerTo [...]      |
| 3.4-07       | ActiveGuardsView.tsx (lines 97,133,158,162,239-246,270,330,392) exposes the internal path `src/agents/skills/builtin-interceptors/`, the labels "Registered Interceptors", [...]   | confirmed | needs-change | Re-read desktop/renderer/src/components/guards/ActiveGuardsView.tsx with cat -n. Line 97: "Gateway needs a restart to expose guards.status (PLAN-20)."; [...]                                              |
| 3.4-08       | Sidebar.tsx has no 'advanced' gating mechanism for nav items; the existing `requireFeature` NavItem flag handles only the management-node case.                                    | confirmed | needs-change | `grep -nE 'advanced\|Advanced' desktop/renderer/src/components/layout/Sidebar.tsx` -> zero hits. NavItem interface (lines 47-54) has only id/label/icon/group/requireFeature. [...]                        |
| 3.4-09       | The Guards/interceptor feature is functional: finding F4 was fixed in commit 34f78cd and the feature was live-verified on 2026-08-10.                                              | confirmed | sound        | `git show --stat 34f78cd`: commit 34f78cd16f7531f464f26d5e0433506e78bb5bf0, Sun Aug 9 2026, subject "fix(skills): revive skill bootstrap, interceptor activation, quarantine hint (audit F3/F4/ [...]      |
| 3.4-12       | The 8 unreachable TabIds (instances, sessions, usage, nodes, projects, workspace, debug, logs) have never appeared as Sidebar nav entries at any point in the git history o [...]  | confirmed | sound        | Sidebar.tsx actually lives at desktop/renderer/src/components/layout/Sidebar.tsx (the cited path desktop/renderer/src/layout/Sidebar.tsx has 0 commits). [...]                                             |
| 3.4-15       | desktop/renderer/src/components/debug/DebugView.tsx (line 155) is a free-text RPC console that also dumps the hello payload; [...]                                                 | confirmed | sound        | Reproduced from scratch. `export function DebugView()` is at desktop/renderer/src/components/debug/DebugView.tsx:155 (file is 168 lines). [...]                                                            |
| 3.4-18       | desktop/renderer/src/components/management/ManagementView.tsx (lines 14, 22, 41) passes the auth token in the iframe URL query string, offers an "Open in new tab" link tha [...]  | confirmed | sound        | Reproduced from full file read (cat -n desktop/renderer/src/components/management/ManagementView.tsx, 57 lines): :14 `const gatewayToken = (import.meta.env.VITE_GATEWAY_TOKEN ?? "local-dev-to [...]      |
| 3.4-19       | desktop/renderer/src/components/overview/GatewayControls.tsx (lines 8, 76) implements the Start Gateway button by calling `/__gateway/start`, an endpoint that exists only [...]   | confirmed | needs-change | GatewayControls.tsx:6-11 comment: 'Start posts to the Vite dev server's /\_\_gateway/start endpoint ... In builds without that endpoint (packaged Tauri app), Start surfaces terminal guidance'; [...]     |
| 3.4-24       | Circles UI copy leaks config keys: desktop/renderer/src/components/circles/CircleCanvas.tsx line 226 shows "Agent generation is off (circles.sandbox.enabled)", InvitePanel [...]  | confirmed | needs-change | CircleCanvas.tsx:227-228 renders `Agent generation is off on this node <span className="font-mono">(circles.sandbox.enabled)</span>, ` (claim's line 226 is one line early; [...]                          |
| 3.5-01       | There are exactly 28 native alert()/confirm()/prompt() calls across 9 feature files in desktop/renderer/src/components: cron/CronView.tsx (lines 58,177,189,201,213), agent [...]  | confirmed | needs-change | Reproduced from scratch with `grep -rnE '(^\|[^A-Za-z0-9_.])(alert\|confirm\|prompt)\s*\(' desktop/renderer/src --include=*.tsx --include=*.ts`. 29 hits; [...]                                            |
| 3.5-02       | Sonner toaster is mounted in desktop/renderer/src/App.tsx at lines 45 and 53, and desktop/renderer/src/components/ui/alert-dialog.tsx is imported by zero feature component [...]  | confirmed | sound        | desktop/renderer/src/App.tsx:4 `import { Toaster } from "./components/ui/sonner";`, :45 `<Toaster richColors position="top-right" />`, :53 `<Toaster richColors position="top-right" />` (two m [...]      |
| 3.5-04       | desktop/renderer/src/components/chat/MessageList.tsx:35 renders the welcome heading with gradient classes `from-white via-purple-200`, and desktop/renderer/index.html:2 se [...]  | confirmed | needs-change | desktop/renderer/src/components/chat/MessageList.tsx:35: `<h2 className="text-4xl font-bold bg-gradient-to-r from-white via-purple-200 to-purple-400 bg-clip-text text-transparent">` (inside t [...]      |
| 3.5-08       | desktop/renderer/src/components/first-run/FirstRun.tsx (lines 95-107,147,193-204) shows end-user copy containing "If you already ran `pnpm bitterbot onboard`, the wizard s [...]  | confirmed | needs-change | FirstRun.tsx:95-99: 'The Control UI needs a running Bitterbot gateway and an auth token to connect. If you already ran `pnpm bitterbot onboard`, the wizard should have saved your token to `de [...]      |
| 3.5-11       | desktop/renderer/src/components/layout/Sidebar.tsx lines 640 and 644 hardcode the string "Bitterbot Desktop v2026.2.15" while OverviewView.tsx:83 already reads a live `hel [...]  | confirmed | sound        | desktop/renderer/src/components/layout/Sidebar.tsx:640 `<span title="Bitterbot Desktop v2026.2.15">v2</span>` and :644 `<span>Bitterbot Desktop v2026.2.15</span>` (hard-coded; [...]                      |
| 3.5-18       | channels/ChannelsView.tsx has a button labeled "Probe All" (line 300), prints raw accountId "default" in mono (line 130), uses text glyphs ▲▼ (line 107), and an empty stat [...]  | confirmed | sound        | All four reproduced at the cited lines in desktop/renderer/src/components/channels/ChannelsView.tsx: :300 `{loading ? "Probing…" : "Probe All"}`; [...]                                                    |
| 3.5-19       | desktop/renderer/src/components/models/KeyEntryModal.tsx:121 accepts a free-text provider id, so a typo creates an auth profile for a nonexistent provider.                        | confirmed | sound        | KeyEntryModal.tsx:114-124: when no `provider` prop is passed, it renders `<Input id="key-provider" value={providerDraft} onChange=... [...]                                                                |
| 3.5-20       | src/channels/registry.ts lines 77 and 87 contain channel blurbs rendered in the wizard primer that read `signal-cli linked device; [...]                                           | confirmed | sound        | Reproduced via `grep -n 'Hop on Discord\\                                                                                                                                                                  | work in progress' src/channels/registry.ts`: line 77 `blurb: 'signal-cli linked device; [...]            |
| 3.5-22       | desktop/renderer/src/components/skills/TrustSettings.tsx:137-165 renders native <option> elements with labels such as "deny, drop everything (default)" and "off (transport [...]  | confirmed | needs-change | TrustSettings.tsx:137-139: `<option value="deny">deny, drop everything (default)</option>`, `review, quarantine, manual accept`, `auto, accept signed skills from trusted peers`; [...]                    |
| 3.6-01       | Root package.json contains 16 scripts that point at files which do not exist in the repo: census:dump, plugins:sync, release:check, test:force, eight test:docker:\* scripts [...] | confirmed | needs-change | Reproduced from scratch with `node -e` over package.json scripts (82 total) + fs.existsSync on every scripts/\|benchmarks/\|desktop/\|apps/ path: exactly 16 non-apps scripts point at missing fil [...]   |
| 3.6-03       | The chain scripts format:all, lint:all, test:all, and test:docker:all in package.json fail when run because they invoke the missing-file scripts.                                  | confirmed | needs-change | package.json:88 format:all = `pnpm format && pnpm format:swift` (format:swift -> swiftformat binary absent + apps/macos\|ios\|shared dirs absent); [...]                                                   |
| 3.6-06       | .gitignore ignores _.db but has no rule for _.sqlite, which is why the benchmark SQLite databases are tracked.                                                                     | confirmed | sound        | `grep -n sqlite .gitignore` returns only line 68 `db.sqlite3` and line 69 `db.sqlite3-journal` (inside the Django boilerplate block); line 179 is `*.db` under a `# SQLite` comment. [...]                 |
| 3.6-08       | The renderer test suite (desktop/renderer, 20 vitest files run via `vitest run`) is never invoked by any CI workflow.                                                              | confirmed | sound        | `find desktop/renderer -name '*.test.ts' -o -name '*.test.tsx'` (excluding node_modules) = 20 files (e.g. desktop/renderer/src/components/circles/CirclesView.test.tsx, desktop/renderer/src/li [...]      |
| 3.6-17       | Root-level how-the-memory-works.md is a divergent duplicate of docs/memory/how-the-memory-works.md, and root-level self_harness_integration_study.md is an AI-authored RFC [...]   | confirmed | sound        | `git ls-files how-the-memory-works.md self_harness_integration_study.md` -> both tracked at repo root. Sizes: root how-the-memory-works.md 29,933 bytes vs docs/memory/how-the-memory-works.md [...]       |
| 3.6-20       | Test coverage by file count on the install path is: src/wizard 4 test files for 15 source files, src/sessions 1 for 7, and desktop/renderer/src 20 for 185 (and the rendere [...]  | confirmed | needs-change | Re-derived with `git ls-files <dir> \| grep -E '\.(ts\|tsx\|js\|mjs)$'` minus `\.(test\|spec)\.`: src/wizard 19 tracked TS files, 4 tests (onboarding.completion.test.ts, onboarding.gateway-config. [...] |
| 3.6-25       | .github/workflows/desktop-release.yml line 7 has a comment pointing at research/TAURI-PRODUCTION-PLAN.md, which is gitignored; [...]                                               | confirmed | needs-change | .github/workflows/desktop-release.yml:7 = `# See research/TAURI-PRODUCTION-PLAN.md for the full design rationale.` `git check-ignore -v research/TAURI-PRODUCTION-PLAN.md` -> `.gitignore:212:r [...]      |
| 3.7-3.8-04   | desktop/src-tauri/src/main.rs:93 spawns `node scripts/run-node.mjs`, which requires the repo source tree and therefore cannot work in a packaged Tauri app.                        | confirmed | needs-change | Reproduced from scratch. `grep -n Command::new desktop/src-tauri/src/main.rs` -> line 93 `Command::new("node")`, line 94 `.args(["scripts/run-node.mjs", "gateway"])`, line 95 `.current_dir(&g [...]      |
| 3.7-3.8-06   | scripts/build-sea.mjs:196 handles only better-sqlite3 as a native addon, while the repo now uses node:sqlite plus the sqlite-vec extension, and it bundles ESM into a Node [...]   | confirmed | needs-change | scripts/build-sea.mjs: line 114 `"--format=esm"`, line 115 `"--target=node22"`, line 119 `"--external:better-sqlite3"`, lines 188-210 copy `node_modules/better-sqlite3/build/Release/better_sq [...]      |
| 3.7-3.8-07   | .github/workflows/desktop-release.yml:119 pins pnpm 9 while package.json:241 declares packageManager "pnpm@10.23.0".                                                               | confirmed | sound        | Line numbering is off by one: .github/workflows/desktop-release.yml:118 `- uses: pnpm/action-setup@v4`, :119 `with:`, :120 `version: 9` (claim cites 119). [...]                                           |
| 3.7-3.8-08   | The URL github.com/Bitterbot-AI/bitterbot-desktop/releases/latest/download/latest.json (used by the Tauri updater config) redirects to the orchestrator release, because th [...]  | confirmed | needs-change | `gh release list --limit 50` -> exactly four releases: orchestrator-v0.2.2 (Latest, 2026-08-14), orchestrator-v0.2.1, orchestrator-v0.2.0, orchestrator-v0.1.0; no desktop-v\* release. [...]              |
| 3.7-3.8-24   | src/cli/program/register.subclis.ts:53 registers a `daemon` legacy alias duplicating the `gateway` service commands, and the build step scripts/write-cli-compat.ts:58-70 w [...]  | confirmed | needs-change | src/cli/program/register.subclis.ts:51-58 `{ name: "daemon", description: "Gateway service (legacy alias)", register: ... import("../daemon-cli.js") ... [...]                                             |
| 3.7-3.8-27   | src/cli/browser-cli.ts:21 registers roughly 60 browser-automation leaf commands at the `browser` level (e.g. [...]                                                                 | confirmed | needs-change | src/cli/browser-cli.ts:19-21 `export function registerBrowserCli(program: Command) { const browser = program.command("browser")` then :51-57 calls seven register\* helpers. [...]                         |
| 3.7-3.8-29   | src/cli/completion-cli.ts:419,433 emits the hidden `boot-watchdog` and `ui-restart` commands in generated shell completions because it does not filter on commander's hidde [...]  | confirmed | sound        | Hidden commands: src/cli/program/register.maintenance.ts:51 `.command("boot-watchdog", { hidden: true })` and :69 `.command("ui-restart", { hidden: true })`; [...]                                        |
| 3.9-05       | Nine files under docs/reviews/\* are tracked in git (plus docs/debug/skill-forge.md, docs/diagnostics/flags.md, docs/agents/arc-agi-3.md, docs/memory/plan9-memory-supremacy [...] | confirmed | sound        | `git ls-files docs/reviews` -> 9 tracked files: dream-engine-utility-2026-08-10, economy-audit-2026-06-09, horma-memory-mapping-2026-06-12, horma-phase2-contrastive-2026-06-13, horma-phase2-s [...]      |
| 3.9-11       | Google Chat, MS Teams, IRC, Matrix and Mattermost are advertised as channels (docs/channels/index.md:19,21,23; README.md:304,314-315; [...]                                        | confirmed | sound        | docs/channels/index.md:19 `[IRC](/channels/irc)`, :21 `[Google Chat](/channels/googlechat)`, :23 `[Microsoft Teams](/channels/msteams)`. [...]                                                             |
| 3.9-12       | Config residue for the non-existent channels remains at src/config/schema.labels.ts:210,214,261-265, src/config/zod-schema.core.ts:359-364, plugin-auto-enable.ts:108-120,2 [...]  | confirmed | needs-change | Reproduced each location. src/config/schema.labels.ts:210 `"channels.mattermost": "Mattermost"`, :214 `"channels.msteams": "MS Teams"`, :261-265 five `channels.mattermost.*` labels. [...]                |
| 3.9-13       | docs/providers/index.md:14-22 says 'Highlight: Venice ... Best overall: venice/claude-opus-45' while the README default model is Anthropic Claude Opus 4.8; [...]                  | confirmed | needs-change | docs/providers/index.md:14 `Looking for chat channel docs (WhatsApp/Telegram/Discord/Slack/Mattermost (plugin)/etc.)`; :16-22 `## Highlight: Venice (Venice AI) ... [...]                                  |
| 3.9-14       | 119 on-disk docs pages are absent from the docs.json nav, including all 16 docs/memory/\* pages, network/circles, circle-gossip, mailbox-host, management-nodes, core-system [...] | confirmed | needs-change | Same node walker: 313 .md/.mdx files on disk under docs/; 120 not referenced by any nav entry today -- the 120th is docs/reviews/v1-release-audit-2026-08-21.md (the audit document itself, cre [...]      |
| 3.9-23       | `grep -l "Control UI" docs/channels/*.md` returns nothing; every channel page (docs/channels/telegram.md:27 and 4 others) goes from BotFather to hand-editing json5; [...]         | confirmed | sound        | Re-ran `grep -l "Control UI" docs/channels/*.md` -> no output, exit 1; case-insensitive `control ui\|control-ui` also empty. [...]                                                                         |
| 3.10-3.11-01 | Gateway structured logs on 2026-08-21 record {"label":"load-plugins","ms":1646406} (~27.4 min) and the 'listening' line only follows afterwards, reproduced on every restar [...]  | confirmed | needs-change | Reproduced from /tmp/bitterbot/bitterbot-2026-08-21.log (structured file log, DEFAULT_LOG_DIR per src/logging/logger.ts:12-13,218): `{"label":"load-plugins","ms":1646406,"totalMs":1646673}` a [...]      |
| 3.10-3.11-04 | The only measured environment for the ~27 min boot is WSL2 on /mnt/d (DrvFS); native-FS boot time is unmeasured; [...]                                                             | confirmed | needs-change | `mount \| grep ' /mnt/d '` -> `D:\ on /mnt/d type 9p (rw,noatime,aname=drvfs;...)`; repo is /mnt/d/Bitterbot/bitterbot-desktop and every boot log (structured `fullFilePath` file:///mnt/d/Bitte [...]     |
| 3.10-3.11-05 | A synchronous FTS-drift repair runs before the gateway calls listen().                                                                                                             | confirmed | needs-change | src/memory/memory-schema.ts:80-112: inside ensureMemoryIndexSchema, a synchronous better-sqlite3 `params.db.exec(INSERT INTO chunks_fts ... SELECT ... [...]                                               |
| 3.10-3.11-09 | MAX_LOG_AGE_MS in src/logging/logger.ts:17 is 24 hours, so logs older than one day are deleted.                                                                                    | confirmed | sound        | src/logging/logger.ts:17 `const MAX_LOG_AGE_MS = 24 * 60 * 60 * 1000; // 24h`. Used only at :233 inside pruneOldRollingLogs (:230-250), which `fs.rmSync`s any `bitterbot-*.log` in the log dir [...]      |
| 3.10-3.11-11 | A failed memory migration is logged but its result is discarded; boot continues on a partial schema and clears the post-update beacon (src/memory/migrations.ts:2309, memor [...]  | confirmed | sound        | src/memory/migrations.ts:2274-2318 runMigrations: each migration runs in BEGIN/COMMIT with ROLLBACK on failure, then the outer catch does `log.error(\`migration v${migration.version} failed a [...]      |
| 3.10-3.11-14 | src/commands/uninstall.ts:89 implements an --app flag that removes /Applications/Bitterbot.app although no native app has been released.                                           | confirmed | needs-change | src/commands/uninstall.ts:85-93 `removeMacApp` returns early unless `process.platform === "darwin"`, then `removePath("/Applications/Bitterbot.app", ...)` (line 89); [...]                                |
| 3.10-3.11-17 | 'imessage' is listed in CHAT_CHANNEL_ORDER in src/channels/registry.ts:7-14 with the blurb 'this is still a work in progress', but no plugin registers it and extensions/im [...]  | confirmed | needs-change | Reproduced from scratch at HEAD c5e1f97. `sed -n 7,14p src/channels/registry.ts` shows CHAT_CHANNEL_ORDER = [telegram, whatsapp, discord, slack, signal, "imessage"] (imessage at line 13); [...]          |
| 3.10-3.11-20 | Twitch is in BUNDLED_ENABLED_BY_DEFAULT (src/plugins/config-state.ts:33, asserted by config-state.test.ts:28) while docs/channels/twitch.md:12-14 says it is 'not bundled, [...]   | confirmed | sound        | src/plugins/config-state.ts:33 `"twitch",` inside BUNDLED_ENABLED_BY_DEFAULT (set starts line 16). src/plugins/config-state.test.ts:28 `for (const id of ["telegram", "whatsapp", "discord", "s [...]      |
| 3.10-3.11-21 | extensions/twitch/src/plugin.ts has no setup adapter and there is no Twitch descriptor in channel-setup-fields.ts:22-93, so channels.configure rejects Twitch and it is the [...]  | confirmed | sound        | `grep -c setup extensions/twitch/src/plugin.ts extensions/twitch/index.ts` -> 0 and 0; plugin.ts:51-75 defines id, meta, `onboarding: twitchOnboardingAdapter` (CLI wizard adapter, a different [...]      |
| 3.10-3.11-24 | device-pair, phone-control and talk-voice are enabled by default (src/plugins/config-state.ts:17) and register /pair, /phone and /voice commands (extensions/talk-voice/ind [...]  | confirmed | sound        | Reproduced from scratch. src/plugins/config-state.ts:16-19 `export const BUNDLED_ENABLED_BY_DEFAULT = new Set<string>(["device-pair","phone-control","talk-voice", ...` and :201 `if (origin == [...]      |
| 4-02         | The default gateway port is 19001 (DEFAULT_GATEWAY_PORT in src/config/paths.ts:178), so the installer's final line 'Bitterbot is running at http://localhost:19001' matches [...]  | confirmed | needs-change | src/config/paths.ts:178 `export const DEFAULT_GATEWAY_PORT = 19001;` (grep output). README.md:359 `\| **19001** \| Gateway (HTTP + WebSocket) \| BITTERBOT_GATEWAY_PORT or gateway.port \|`. [...]         |
| 4-07         | OpenClaw's guided onboarding (docs.openclaw.ai/start/wizard) tests a real completion and persists only the verified route; [...]                                                   | confirmed | needs-change | OpenClaw wizard (docs.openclaw.ai/start/wizard): guided onboarding "Test[s] the first detected candidate with a real completion. [...]                                                                     |
| 4-09         | Bitterbot has no src/config/labs.ts feature manifest; its kill-switched experiments (circles, p2pDial, sandbox, harnessEvolve, curiosity, rlm, liveDiscovery, autoRollback, [...]  | confirmed | sound        | `ls src/config/labs.ts` -> No such file; `git ls-files \| grep -i labs` -> empty. `grep -rn 'Labs\\                                                                                                        | Experimental' desktop/renderer/src --include=\*.tsx` -> empty (no Labs UI). [...]                        |
| 4-13         | Open WebUI v0.11 merged the user settings modal and the admin panel into one searchable settings surface, with the release post stating 'two surfaces meant two mental mode [...]  | confirmed | needs-change | Fetched https://openwebui.com/blog/v0-11-0-the-interface-reorganized: title 'Open WebUI v0.11.0: The Interface, Reorganized', datePublished 2026-07-27T10:02:22Z. [...]                                    |
| 4-15         | docs/gateway/configuration.md does not contain a one-paragraph precedence rule of the form 'CLI flag > env > bitterbot.json > default'; [...]                                      | confirmed | needs-change | docs/gateway/configuration.md:321 '- **Array of files**: deep-merged in order (later wins)' (the $include section); [...]                                                                                  |
| 4-16         | The Models & Keys page already shows a which-source-wins provenance badge per provider credential (winningSource in desktop/renderer/src/components/models/ModelsView.tsx:2 [...]  | confirmed | needs-change | desktop/renderer/src/components/models/ModelsView.tsx:26 '\* credential status with which-source-wins provenance, add/rotate/test/'; [...]                                                                 |
| 4-20         | There is no doctor RPC in the gateway method list (src/gateway/server-methods-list.ts has update.run and update.check but no 'doctor.\*' method), no Repairs cards on the Ov [...] | confirmed | needs-change | Reproduced from scratch. `grep -n "doctor\\                                                                                                                                                                | update\." src/gateway/server-methods-list.ts`-> only lines 62`"update.run"`and 63`"update.check"`; [...] |
| 4-21         | Home Assistant has a Settings > System > Repairs surface; Gitea offers 'doctor check --list/--run/--fix'; Vaultwarden's admin Diagnostics page generates a support string; [...]   | confirmed | needs-change | Home Assistant (home-assistant.io/integrations/repairs/): "You can find the Home Assistant Repairs dashboard in Settings > System > Repairs"; [...]                                                        |
| 4-23         | desktop/renderer/src/components contains 26 component directories (agents, channels, chat, circles, config, cowork, cron, debug, dreams, first-run, guards, instances, layo [...]  | confirmed | needs-change | `ls -d desktop/renderer/src/components/*/ \| wc -l` -> 26; names: agents channels chat circles config cowork cron debug dreams first-run guards instances layout logs management models nodes ov [...]     |
| 4-29         | The repo has no release-please-config.json or .release-please-manifest.json, and none of the four workflows (.github/workflows/ci.yml, desktop-release.yml, orchestrator-re [...]  | confirmed | needs-change | `ls -la release-please-config.json .release-please-manifest.json` -> both 'No such file or directory'; `git ls-files \| grep -i release-please` -> empty. [...]                                            |
| 4b-01        | A separate deep-research workflow ran in parallel with the audit with these statistics: 110 agents, 6 search angles, 27 primary sources fetched, 131 claims extracted, top [...]   | confirmed | needs-change | The workflow's output file exists at /tmp/claude-1000/-mnt-d-Bitterbot-bitterbot-desktop/8c1f3492-28a9-4595-a5af-ac83b5872728/scratchpad/deep-research.json (32,535 bytes, mtime Aug 21 14:49, [...]       |
| 4b-03        | Tauri 2 ships sidecar binaries inside the signed desktop installer via `bundle.externalBin` in tauri.conf.json, and every sidecar must be staged as one file per target tri [...]  | confirmed | needs-change | Fetched https://v2.tauri.app/develop/sidecar/: "To bundle the binaries of your choice, you can add the `externalBin` property to the `bundle` object in your `tauri.conf.json`" and "a binary w [...]      |
| 4b-05        | The repo's desktop/src-tauri/tauri.conf.json already declares `bundle.externalBin: ["binaries/bitterbot-gateway"]` (line 38), i.e. [...]                                           | confirmed | needs-change | `cat -n desktop/src-tauri/tauri.conf.json` line 38: `"externalBin": ["binaries/bitterbot-gateway"],` (exact line number matches). [...]                                                                    |
| 4b-10        | Ollama's install.sh on Linux creates a dedicated `ollama` system user, writes a systemd unit with Restart=always and RestartSec=3, enables and starts it, prints 'The Ollam [...]  | confirmed | needs-change | Same script: L198-200 `if ! id ollama ...; $SUDO useradd -r -s /bin/false -U -m -d /usr/share/ollama ollama`; [...]                                                                                        |
| 4b-13        | Open WebUI's recommended install is a single `docker run` pulling a prebuilt GHCR image (ghcr.io/open-webui/open-webui), mapping host port 3000 to container 8080, persisti [...]  | confirmed | needs-change | docs.openwebui.com quick-start page is tab-rendered; fetched its source docs/getting-started/quick-start/tab-docker/ManualDocker.md (imported by index.mdx L15/L42): "docker run -d -p 3000:808 [...]      |
| 4b-14        | In Open WebUI the first account created in the UI automatically becomes Administrator, later sign-ups default to Pending until an admin approves them, all data stays local [...]  | confirmed | needs-change | Open WebUI quick-start (raw docs/getting-started/quick-start/index.mdx lines 164-168, 'First Login' tip): "The first account created gets Administrator privileges and controls user management [...]      |
| 4b-16        | Home Assistant's first-run onboarding is a 5-step browser wizard (open address, create new or restore from backup, enter home location, analytics opt-in defaulting off, do [...]  | confirmed | needs-change | Raw source (raw.githubusercontent.com/home-assistant/home-assistant.io/current/source/getting-started/onboarding.markdown) line 7: "After Home Assistant has been installed on your device, the [...]      |
| 4b-19        | Home Assistant Labs shipped in release 2025.12 (https://www.home-assistant.io/blog/2025/12/03/release-202512/) as a developer-documented feature-flag system (https://devel [...]  | confirmed | needs-change | HA 2025.12 release blog: "Labs is a brand-new place in Home Assistant that gives you a sneak peek at features we're working on... Preview features are off by default... [...]                             |
| 5-06         | The Docker path (Dockerfile + docker-compose.yml) is broken/unverified: there is no `docker build` job in CI and no published ghcr.io/bitterbot-ai/bitterbot image; [...]          | confirmed | needs-change | Reproduced from scratch at HEAD c5e1f97. (a) Dockerfile is broken: `Dockerfile:20 COPY ui/package.json ./ui/package.json`, `Dockerfile:21 COPY patches ./patches`, `Dockerfile:30 RUN pnpm ui:b [...]      |
| 5-32         | The app currently uses CalVer: root package.json and desktop/package.json are at version 2026.2.15 while desktop/src-tauri/tauri.conf.json is at 0.1.0, orchestrator is at [...]   | confirmed | needs-change | package.json:3 = 2026.2.15; desktop/package.json:3 = 2026.2.15; desktop/src-tauri/tauri.conf.json:4 = 0.1.0; orchestrator/Cargo.toml:3 = 0.2.3. [...]                                                      |
| 6.1-6.2-06   | Circles appears in the primary nav (TabId 'people', circles/CirclesView.tsx) and is enabled by default via src/config/defaults.ts:628; [...]                                       | confirmed | needs-change | Nav: desktop/renderer/src/components/layout/Sidebar.tsx:65 `{ id: "people", label: "Circles", icon: Users, group: "control" }` with no `requireFeature`; [...]                                             |
| 6.5-6.6-12   | docs/plans/PLAN-25 line 6 says harness evolution is 'LANDED, on by default', but the code has `harness_evolve: { enabled: false }` in src/memory/dream-types.ts:64 (while m [...]  | confirmed | needs-change | docs/plans/PLAN-25-SELF-OPTIMIZING-HARNESS.md:6 `**Status:** **LANDED, on by default.** The full self-evolving loop runs as the harness_evolve dream mode ... [...]                                        |
| 6.5-6.6-13   | DEFAULT_MODE_CONFIGS defines 15 dream modes, and the README dream-mode table (README.md lines 116-133) lists Mutation, Research, Reconsolidation, Interceptor Harvest, and [...]   | confirmed | sound        | src/memory/dream-types.ts:36-77 DEFAULT_MODE_CONFIGS: counted 15 keys (replay :37, compression :38, mutation :46, simulation :47, extrapolation :48, exploration :49, research :55, interceptor [...]      |
| 6.5-6.6-19   | The P2P skills marketplace is ON by default (`p2p.enabled: true` at src/config/defaults.ts:504; [...]                                                                              | confirmed | sound        | src/config/defaults.ts:504 `enabled: true,` inside applyP2pDefaults; :573 `marketplace: { enabled: true,` inside applyA2aDefaults. [...]                                                                   |
| 6.7-6.8-11   | Gateway bind defaults to loopback at src/gateway/server-runtime-config.ts:40 and startup refuses a non-loopback bind without auth at line 91; [...]                                | confirmed | needs-change | src/gateway/server-runtime-config.ts:40 `const bindMode = params.bind ?? params.cfg.gateway?.bind ?? 'loopback'`; [...]                                                                                    |
| 6.7-6.8-13   | The Control UI build bakes the gateway token into the JS bundle via Vite `define` (desktop/vite.config.ts:17-35,116-120, reading desktop/.env and ~/.bitterbot/bitterbot.js [...]  | confirmed | needs-change | Reproduced: desktop/vite.config.ts:17-35 `resolveGatewayToken()` precedence: process.env.VITE_GATEWAY_TOKEN (:18) then `path.join(os.homedir(), ".bitterbot", "bitterbot.json")` -> `config.gat [...]      |
| 6.7-6.8-14   | Unauthenticated loopback GETs to /management (src/gateway/server-http.ts:537-557) and /m (src/gateway/server-http.ts:575-596) are accepted via a local-direct bypass and th [...]  | confirmed | needs-change | Reproduced src/gateway/server-http.ts:537-557: `/management` GET -> `getBearerToken(req)` -> `authorizeGatewayConnect` -> `if (!authResult.ok && !isLocalDirectRequest(req, trustedProxies)) { [...]       |
| 6.7-6.8-17   | SECURITY.md points to a docs/security/ path that does not exist (the real page is docs/gateway/security/index.md) and claims detect-secrets runs in CI, but detect-secrets [...]   | confirmed | sound        | SECURITY.md 'Operational Guidance' section: 'see: - `docs/security/` in this repository'. `ls docs/security` -> 'No such file or directory'; [...]                                                         |
| 6.7-6.8-20   | circles.p2pDial defaults to OFF at src/circles/service.ts:295-304 (the memory note saying default-ON is stale), while the Circles canvas sandbox defaults to ON at src/circ [...]  | confirmed | needs-change | p2pDial: src/circles/service.ts:295-303 `Stage 4 kill switch: circles.p2pDial.enabled === true. Default OFF (2026-08-14)` / `return this.config.circles?.p2pDial?.enabled === true;` (flipped f [...]      |
| 6.11-6.12-04 | The libp2p P2P identity keypair (node.key/node.pub) is written to `<cwd>/keys/` because orchestrator/src/main.rs:24 declares `#[arg(long, default_value = "./keys")]` and s [...]  | confirmed | needs-change | Reproduced from scratch. orchestrator/src/main.rs:24-25 `#[arg(long, default_value = "./keys")] key_dir: PathBuf`; main.rs:100 `crypto::load_or_generate_keypair(&args.key_dir)`; [...]                    |
| 6.11-6.12-05 | `bitterbot reset --scope full` (src/commands/reset.ts) removes the state dir, config, oauth and workspace dirs but does not remove `<cwd>/keys/` or the fixed IPC socket `/ [...]  | confirmed | needs-change | src/commands/reset.ts:139-150 (`scope === "full"`): removePath(stateDir), configPath if !configInsideState, oauthDir if !oauthInsideState, each workspace in workspaceDirs -- nothing else; [...]          |
| 6.11-6.12-12 | Telegram, Discord, Slack, WhatsApp and Signal ship as bundled extensions (extensions/telegram, discord, slack, whatsapp, signal) listed in BUNDLED_ENABLED_BY_DEFAULT in sr [...]  | confirmed | sound        | Reproduced from scratch. `grep -n BUNDLED_ENABLED_BY_DEFAULT -r src` -> src/plugins/config-state.ts:16 (set definition) and :201 (`if (origin === "bundled" && BUNDLED_ENABLED_BY_DEFAULT.has(i [...]      |

## 5. External sources consulted

191 distinct URLs were fetched or queried by the verifiers (deduped; GitHub API calls against the repo are listed once per endpoint form). Non-URL sources (local commands and GitHub CLI queries) are summarized after the list.

- https://about.bitterbot.ai/
- https://api.github.com/repos/Bitterbot-AI/bitterbot-desktop
- https://api.github.com/repos/Bitterbot-AI/bitterbot-desktop/environments
- https://api.github.com/repos/WhiskeySockets/Baileys/releases
- https://api.github.com/repos/bitterbot/bitterbot
- https://api.github.com/repos/ollama/ollama/commits?path=scripts/install.sh
- https://api.github.com/repos/ollama/ollama/contents/scripts
- https://api.github.com/repos/ollama/ollama/releases/latest
- https://bitterbot.ai/definitely-not-a-real-path-xyz
- https://bitterbot.ai/install.ps1
- https://bitterbot.ai/install.sh
- https://bitterbot.ai/this-path-does-not-exist-xyz
- https://cdn.coollabs.io/coolify/install.sh
- https://cdn.jsdelivr.net/npm/geist@1/dist/fonts/geist-mono/style.css
- https://cdn.jsdelivr.net/npm/geist@1/dist/fonts/geist-sans/style.css
- https://cdn.jsdelivr.net/npm/geist@1/package.json
- https://cloudflare-dns.com/dns-query?name=docs.bitterbot.ai&type=A
- https://cloudflare-dns.com/dns-query?name=docs.bitterbot.ai&type=CNAME
- https://code.claude.com/docs/en/quickstart
- https://code.claude.com/docs/en/settings
- https://coolify.io/docs/get-started/installation
- https://coolify.io/docs/get-started/upgrade
- https://coolify.io/docs/knowledge-base/how-to/backup-restore-coolify
- https://data.jsdelivr.com/v1/package/npm/geist@1.5.1/flat
- https://data.jsdelivr.com/v1/package/resolve/npm/geist@1
- https://data.jsdelivr.com/v1/packages/npm/geist/resolved?specifier=1
- https://data.jsdelivr.com/v1/packages/npm/geist@1.2.2
- https://data.jsdelivr.com/v1/packages/npm/geist@1.7.2
- https://developers.home-assistant.io/blog/2026/05/26/advanced-mode-config-flow-deprecation/
- https://developers.home-assistant.io/docs/config_entries_config_flow_handler
- https://developers.home-assistant.io/docs/development/labs/
- https://dns.google/resolve?name=docs.bitterbot.ai&type=A
- https://docs.anythingllm.com/setup/embedder-configuration/local/built-in
- https://docs.anythingllm.com/setup/llm-configuration/local/built-in
- https://docs.anythingllm.com/setup/llm-configuration/overview
- https://docs.anythingllm.com/setup/vector-database-configuration/local/lancedb
- https://docs.bitterbot.ai/
- https://docs.bitterbot.ai/reviews/economy-audit-2026-06-09
- https://docs.bitterbot.ai/start/faq
- https://docs.bitterbot.ai/troubleshooting
- https://docs.dify.ai/en/guides/model-configuration/readme
- https://docs.gitea.com/administration/backup-and-restore
- https://docs.gitea.com/administration/command-line
- https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions
- https://docs.gpt4all.io/gpt4all_desktop/quickstart.html
- https://docs.immich.app/administration/backup-and-restore
- https://docs.immich.app/administration/server-stats/
- https://docs.immich.app/administration/system-settings
- https://docs.immich.app/install/upgrading/
- https://docs.letta.com/guides/ade/context-window-viewer/
- https://docs.letta.com/guides/ade/core-memory/
- https://docs.letta.com/guides/agents/memory-blocks
- https://docs.msty.ai/studio/getting-started/onboarding
- https://docs.msty.ai/studio/managing-models/local-models
- https://docs.msty.app/getting-started/onboarding
- https://docs.msty.app/how-to-guides/use-existing-ollama-models
- https://docs.n8n.io/release-notes
- https://docs.npmjs.com/cli/v10/commands/npm-exec
- https://docs.npmjs.com/cli/v10/commands/npx
- https://docs.openclaw.ai/concepts/experimental-features
- https://docs.openclaw.ai/gateway/configuration
- https://docs.openclaw.ai/start/wizard
- https://docs.openwebui.com/features/authentication-access/rbac/roles/
- https://docs.openwebui.com/getting-started/quick-start/
- https://docs.openwebui.com/getting-started/quick-start/connect-a-provider/starting-with-ollama/
- https://docs.openwebui.com/reference/env-configuration/
- https://ghcr.io/bitterbot-ai/bitterbot
- https://ghcr.io/token?scope=repository:bitterbot-ai/bitterbot:pull
- https://ghcr.io/token?scope=repository:bitterbot-ai/bitterbot:pull&service=ghcr.io
- https://ghcr.io/v2/open-webui/open-webui/tags/list
- https://github.com/
- https://github.com/Bitterbot-AI/bitterbot-desktop.git
- https://github.com/Bitterbot-AI/bitterbot-desktop/blob/main/docs/reviews/economy-audit-2026-06-09.md
- https://github.com/Bitterbot-AI/bitterbot-desktop/releases
- https://github.com/Bitterbot-AI/bitterbot-desktop/releases/download/orchestrator-v0.2.2/checksums.txt
- https://github.com/Bitterbot-AI/bitterbot-desktop/releases/download/orchestrator-v0.2.2/checksums.txt.minisig
- https://github.com/Bitterbot-AI/bitterbot-desktop/releases/download/orchestrator-v0.2.3/checksums.txt
- https://github.com/Bitterbot-AI/bitterbot-desktop/releases/latest/download/latest.json
- https://github.com/Bitterbot-AI/bitterbot-desktop/releases/tag/orchestrator-v0.2.2
- https://github.com/Mintplex-Labs/anything-llm
- https://github.com/OpenHomeFoundation/roadmap/issues/123
- https://github.com/bitterbot/bitterbot
- https://github.com/dani-garcia/vaultwarden/blob/main/src/db/mod.rs
- https://github.com/dani-garcia/vaultwarden/wiki/Backing-up-your-vault
- https://github.com/dani-garcia/vaultwarden/wiki/Enabling-admin-page
- https://github.com/danny-avila/LibreChat/issues/11175
- https://github.com/go-gitea/gitea/blob/main/cmd/doctor.go
- https://github.com/home-assistant/roadmap/issues/123
- https://github.com/home-assistant/roadmap/issues/25
- https://github.com/janhq/jan/blob/dev/.github/workflows/template-tauri-build-macos.yml
- https://github.com/janhq/jan/blob/dev/extensions/llamacpp-extension/src/backend.ts
- https://github.com/janhq/jan/blob/dev/package.json
- https://github.com/janhq/jan/blob/dev/src-tauri/tauri.macos.conf.json
- https://github.com/janhq/jan/blob/dev/src-tauri/tauri.windows.conf.json
- https://github.com/janhq/jan/blob/main/.github/workflows/template-tauri-build-macos.yml
- https://github.com/janhq/jan/blob/main/extensions/llamacpp-extension/src/index.ts
- https://github.com/janhq/jan/blob/main/src-tauri/tauri.linux.conf.json
- https://github.com/janhq/jan/blob/main/src-tauri/tauri.macos.conf.json
- https://github.com/janhq/jan/blob/main/src-tauri/tauri.windows.conf.json
- https://github.com/janhq/jan/blob/v0.6.0/src-tauri/tauri.conf.json
- https://github.com/janhq/jan/blob/v0.8.4/extensions/llamacpp-extension/src/backend.ts
- https://github.com/janhq/jan/blob/v0.8.4/src-tauri/tauri.linux.conf.json
- https://github.com/janhq/jan/blob/v0.8.4/src-tauri/tauri.macos.conf.json
- https://github.com/janhq/jan/blob/v0.8.4/src-tauri/tauri.windows.conf.json
- https://github.com/janhq/jan/issues/3735
- https://github.com/janhq/jan/issues/4485
- https://github.com/janhq/jan/releases/tag/v0.5.17
- https://github.com/janhq/jan/releases/tag/v0.6.0
- https://github.com/janhq/jan/releases/tag/v0.8.4
- https://github.com/janhq/jan/tree/main/src-tauri/plugins
- https://github.com/lmstudio-ai/lms/issues/160
- https://github.com/nodejs/corepack/issues/722
- https://github.com/nodejs/nodejs.org/issues/7555
- https://github.com/open-webui/open-webui/blob/main/backend/open_webui/config.py
- https://github.com/open-webui/open-webui/blob/main/src/lib/components/chat/ModelSelector/Selector.svelte
- https://github.com/orgs/Bitterbot-AI/packages
- https://github.com/orgs/mintlify/discussions/1516
- https://github.com/pnpm/action-setup/blob/master/README.md
- https://github.com/tauri-apps/tauri/blob/dev/crates/tauri-bundler/src/bundle/macos/app.rs
- https://github.com/tauri-apps/tauri/issues/11992
- https://github.com/tauri-apps/tauri/issues/5889
- https://huggingface.co/api/models/ggml-org/embeddinggemma-300m-qat-q8_0-GGUF/tree/main
- https://huggingface.co/ggml-org/embeddinggemma-300m-qat-q8_0-GGUF/resolve/main/embeddinggemma-300m-qat-Q8_0.gguf
- https://immich.app/blog/v3.0.0-release
- https://jan.ai/docs/desktop/quickstart
- https://jobs.ashbyhq.com/nabucasa/cb061b70-df9a-4a77-bdc6-753843769a16
- https://keith.github.io/xcode-man-pages/launchd.plist.5.html
- https://learn.chatgpt.com/docs/customization/memories
- https://lmstudio.ai/blog/lmstudio-v0.3.6
- https://lmstudio.ai/docs/app/basics
- https://man7.org/linux/man-pages/man5/systemd.exec.5.html
- https://next.coolify.io/docs/core/observability/monitoring/overview
- https://nodejs.org/api/single-executable-applications.html
- https://nodejs.org/docs/latest-v22.x/api/single-executable-applications.html
- https://nodejs.org/docs/latest-v24.x/api/single-executable-applications.html
- https://ollama.com/install.sh
- https://openai.com/index/memory-and-new-controls-for-chatgpt/
- https://openwebui.com/blog/v0-11-0-the-interface-reorganized
- https://raw.githubusercontent.com/home-assistant/home-assistant.io/current/source/getting-started/onboarding.markdown
- https://raw.githubusercontent.com/mintlify/docs/main/skill.md
- https://raw.githubusercontent.com/n8n-io/n8n/refs/heads/master/docker/get-n8n.sh
- https://raw.githubusercontent.com/ollama/ollama/main/scripts/install.sh
- https://raw.githubusercontent.com/open-webui/docs/main/docs/getting-started/quick-start/connect-a-provider/starting-with-ollama.mdx
- https://raw.githubusercontent.com/open-webui/docs/main/docs/getting-started/quick-start/index.mdx
- https://raw.githubusercontent.com/open-webui/docs/main/docs/getting-started/quick-start/tab-docker/ManualDocker.md
- https://raw.githubusercontent.com/open-webui/open-webui/main/.github/workflows/docker.yaml
- https://raw.githubusercontent.com/open-webui/open-webui/main/Dockerfile
- https://raw.githubusercontent.com/open-webui/open-webui/main/backend/open_webui/config.py
- https://raw.githubusercontent.com/open-webui/open-webui/main/backend/open_webui/env.py
- https://raw.githubusercontent.com/open-webui/open-webui/main/backend/open_webui/models/config.py
- https://raw.githubusercontent.com/open-webui/open-webui/main/src/lib/components/chat/ModelSelector/Selector.svelte
- https://raw.githubusercontent.com/open-webui/open-webui/v0.11.0/backend/open_webui/models/config.py
- https://raw.githubusercontent.com/pnpm/action-setup/master/src/install-pnpm/run.ts
- https://raw.githubusercontent.com/tauri-apps/tauri/dev/crates/tauri-codegen/src/context.rs
- https://registry.npmjs.org/@bitterbot%2fmatrix
- https://registry.npmjs.org/@bitterbot%2fmsteams
- https://registry.npmjs.org/@whiskeysockets%2Fbaileys
- https://registry.npmjs.org/@whiskeysockets/baileys
- https://registry.npmjs.org/bitterbot
- https://registry.npmjs.org/bitterbot-ai
- https://registry.npmjs.org/geist/latest
- https://registry.npmjs.org/playwright/1.58.2
- https://releases.astral.sh/installers/uv/latest/uv-installer.sh
- https://sessionize.com/jean-loic-pouffier/
- https://socket.dev/blog/node-js-tsc-votes-to-stop-distributing-corepack
- https://support.claude.com/en/articles/11817273-using-claude-s-memory-feature
- https://tailscale.com/kb/1067/update
- https://tailscale.com/kb/1080/cli
- https://tailscale.com/kb/1312/serve
- https://v2.tauri.app/develop/resources/
- https://v2.tauri.app/develop/sidecar/
- https://v2.tauri.app/plugin/updater/
- https://v2.tauri.app/reference/config/
- https://www.home-assistant.io/blog/2025/12/03/release-202512/
- https://www.home-assistant.io/common-tasks/os/
- https://www.home-assistant.io/getting-started/onboarding/
- https://www.home-assistant.io/integrations/labs/
- https://www.home-assistant.io/integrations/repairs/
- https://www.jan.ai/docs/desktop/quickstart
- https://www.letta.com/blog/introducing-the-agent-development-environment/
- https://www.librechat.ai/docs/configuration/librechat_yaml
- https://www.mintlify.com/docs/cli/commands
- https://www.mintlify.com/docs/deploy/preview-deployments
- https://www.mintlify.com/docs/guides/hidden-pages
- https://www.mintlify.com/docs/guides/internationalization
- https://www.mintlify.com/docs/organize/hidden-pages
- https://www.mintlify.com/docs/organize/navigation
- https://www.mintlify.com/docs/organize/redirects
- https://www.mintlify.com/docs/organize/settings
- https://www.nabucasa.com/about/
- https://www.npmjs.com/package/@mintlify/validation

Non-URL evidence sources (170 distinct, trimmed):

- /tmp/claude-1000/-mnt-d-Bitterbot-bitterbot-desktop/8c1f3492-28a9-4595-a5af-ac83b5872728/scratchpad/deep-research.json
- curl -sIL https://bitterbot.ai/install.sh -> HTTP/2 200, content-type: text/html (homepage)
- gh api /orgs/Bitterbot-AI/packages?package_type=container
- gh api /orgs/bitterbot-ai/packages?package_type=container => []
- gh api repos/Bitterbot-AI/bitterbot-desktop
- gh api repos/Bitterbot-AI/bitterbot-desktop -> private=false default=main
- gh api repos/Bitterbot-AI/bitterbot-desktop/actions/secrets -> total_count 0
- gh api repos/Bitterbot-AI/bitterbot-desktop/automated-security-fixes -> {"enabled":false,"paused":false}
- gh api repos/Bitterbot-AI/bitterbot-desktop/dependabot/alerts -> 403 'Dependabot alerts are disabled for this repository.'
- gh api repos/Bitterbot-AI/bitterbot-desktop/environments/release -> 404
- gh api repos/Bitterbot-AI/bitterbot-desktop/vulnerability-alerts -> 404
- gh api repos/bitterbot/bitterbot
- gh api repos/bitterbot/bitterbot -> 404 Not Found
- gh release list
- gh release list (2026-08-21): latest = orchestrator-v0.2.2 2026-08-14T19:23:14Z
- gh release list (2026-08-21): orchestrator-v0.2.2 Latest, 0.2.1, 0.2.0, 0.1.0 only
- gh release list (2026-08-21): orchestrator-v0.2.2 Latest, 0.2.1, 0.2.0, 0.1.0; no desktop-v* or v* releases
- gh release list (4 orchestrator releases only)
- gh release list (Bitterbot-AI/bitterbot-desktop)
- gh release list (Bitterbot-AI/bitterbot-desktop): orchestrator-v0.2.2 Latest 2026-08-14
- gh release list (VGIL77/bitterbot-desktop), run 2026-08-21: orchestrator-v0.2.2 Latest 2026-08-14; no orchestrator-v0.2.3
- gh release list (repo origin) 2026-08-21: orchestrator-v0.2.2 Latest 2026-08-14T19:23:14Z; [...]
- gh release list (repo): orchestrator-v0.2.2, 0.2.1, 0.2.0, 0.1.0 only
- gh release list (run 2026-08-21)
- gh release list --repo Bitterbot-AI/bitterbot-desktop (2026-08-21): orchestrator-v0.2.2 Latest 2026-08-14, 0.2.1, 0.2.0, 0.1.0
- gh release list / gh api repos/Bitterbot-AI/bitterbot-desktop/releases/latest
- gh release list / gh api repos/Bitterbot-AI/bitterbot-desktop/tags -> only orchestrator-v0.1.0..0.2.2
- gh release list / gh release view orchestrator-v0.2.2 (2026-08-21): no signed release exists
- gh release list 2026-08-21: latest orchestrator-v0.2.2
- gh release list 2026-08-21: orchestrator-v0.2.2 Latest; assets lack checksums.txt.minisig
- gh release view orchestrator-v0.2.2 --json assets
- gh release view orchestrator-v0.2.3
- gh run list --workflow=desktop-release.yml (no runs)
- gh run list --workflow=orchestrator-release.yml
- gh run view 32203544474 --json jobs
- git ls-remote --tags origin: only orchestrator-v\* tags
- https://about.bitterbot.ai/ (HTTP 200)
- https://api.github.com/repos/Bitterbot-AI/bitterbot-desktop (via gh api, 200)
- https://api.github.com/repos/ollama/ollama/commits?path=scripts/install.sh
- https://api.github.com/repos/ollama/ollama/releases/latest
- https://bitterbot.ai/definitely-not-a-real-path-xyz
- https://bitterbot.ai/install.ps1
- https://bitterbot.ai/install.sh
- https://cdn.coollabs.io/coolify/install.sh
- https://cdn.jsdelivr.net/npm/geist@1/dist/fonts/geist-mono/style.css (HTTP 404)
- https://cloudflare-dns.com/dns-query?name=docs.bitterbot.ai&type=A -> Status 3 (NXDOMAIN), SOA logan.ns.cloudflare.com
- https://cloudflare-dns.com/dns-query?name=docs.bitterbot.ai&type=CNAME (Status 3)
- https://code.claude.com/docs/en/quickstart
- https://code.claude.com/docs/en/settings
- https://coolify.io/docs/get-started/installation
- https://coolify.io/docs/knowledge-base/how-to/backup-restore-coolify
- https://data.jsdelivr.com/v1/package/npm/geist@1.5.1/flat (58 files; no style.css)
- https://data.jsdelivr.com/v1/packages/npm/geist@1.7.2 (dist/fonts/geist-sans contains only .woff2/.ttf; no .css anywhere in package)
- https://developers.home-assistant.io/docs/config_entries_config_flow_handler
- https://developers.home-assistant.io/docs/development/labs/
- https://dns.google/resolve?name=docs.bitterbot.ai&type=A (Status 3 NXDOMAIN)
- https://docs.anythingllm.com/setup/llm-configuration/local/built-in
- https://docs.anythingllm.com/setup/vector-database-configuration/local/lancedb
- https://docs.bitterbot.ai/ (curl -sI: no response)
- https://docs.bitterbot.ai/start/faq (curl -sI: no response, host NXDOMAIN)
- https://docs.dify.ai/en/guides/model-configuration/readme
- https://docs.gitea.com/administration/backup-and-restore
- https://docs.gitea.com/administration/command-line
- https://docs.gpt4all.io/gpt4all_desktop/quickstart.html
- https://docs.immich.app/administration/backup-and-restore
- https://docs.immich.app/administration/server-stats/
- https://docs.immich.app/administration/system-settings
- https://docs.letta.com/guides/ade/core-memory/
- https://docs.letta.com/guides/agents/memory-blocks
- https://docs.msty.ai/studio/getting-started/onboarding
- https://docs.msty.ai/studio/managing-models/local-models
- https://docs.n8n.io/release-notes
- https://docs.npmjs.com/cli/v10/commands/npm-exec
- https://docs.openclaw.ai/concepts/experimental-features
- https://docs.openclaw.ai/gateway/configuration
- https://docs.openclaw.ai/start/wizard
- https://docs.openwebui.com/features/authentication-access/rbac/roles/
- https://docs.openwebui.com/getting-started/quick-start/
- https://docs.openwebui.com/getting-started/quick-start/connect-a-provider/starting-with-ollama/
- https://docs.openwebui.com/reference/env-configuration/
- https://ghcr.io/token?scope=repository:bitterbot-ai/bitterbot:pull
- https://ghcr.io/v2/open-webui/open-webui/tags/list
- https://github.com/Bitterbot-AI/bitterbot-desktop/blob/main/docs/reviews/economy-audit-2026-06-09.md
- https://github.com/Bitterbot-AI/bitterbot-desktop/releases (gh release list / gh release view orchestrator-v0.2.2)
- https://github.com/Bitterbot-AI/bitterbot-desktop/releases/download/orchestrator-v0.2.2/checksums.txt (200)
- https://github.com/Bitterbot-AI/bitterbot-desktop/releases/download/orchestrator-v0.2.2/checksums.txt -> HTTP 302
- https://github.com/Bitterbot-AI/bitterbot-desktop/releases/tag/orchestrator-v0.2.2
- https://github.com/OpenHomeFoundation/roadmap/issues/123
- https://github.com/bitterbot/bitterbot
- https://github.com/dani-garcia/vaultwarden/wiki/Backing-up-your-vault
- https://github.com/dani-garcia/vaultwarden/wiki/Enabling-admin-page
- https://github.com/home-assistant/roadmap/issues/123
- https://github.com/janhq/jan/blob/dev/extensions/llamacpp-extension/src/backend.ts
- https://github.com/janhq/jan/blob/dev/src-tauri/tauri.macos.conf.json
- https://github.com/janhq/jan/blob/dev/src-tauri/tauri.windows.conf.json
- https://github.com/janhq/jan/blob/main/extensions/llamacpp-extension/src/index.ts
- https://github.com/janhq/jan/blob/main/src-tauri/tauri.linux.conf.json
- https://github.com/janhq/jan/blob/main/src-tauri/tauri.macos.conf.json
- https://github.com/janhq/jan/blob/main/src-tauri/tauri.windows.conf.json
- https://github.com/janhq/jan/blob/v0.8.4/extensions/llamacpp-extension/src/backend.ts
- https://github.com/janhq/jan/blob/v0.8.4/src-tauri/tauri.linux.conf.json
- https://github.com/janhq/jan/blob/v0.8.4/src-tauri/tauri.windows.conf.json
- https://github.com/janhq/jan/issues/4485
- https://github.com/janhq/jan/releases/tag/v0.5.17
- https://github.com/janhq/jan/releases/tag/v0.6.0
- https://github.com/janhq/jan/releases/tag/v0.8.4
- https://github.com/janhq/jan/tree/main/src-tauri/plugins
- https://github.com/lmstudio-ai/lms/issues/160
- https://github.com/nodejs/nodejs.org/issues/7555
- https://github.com/open-webui/open-webui/blob/main/src/lib/components/chat/ModelSelector/Selector.svelte
- https://github.com/orgs/Bitterbot-AI/packages (no packages)
- https://github.com/orgs/mintlify/discussions/1516
- https://github.com/pnpm/action-setup/blob/master/README.md
- https://github.com/tauri-apps/tauri/blob/dev/crates/tauri-bundler/src/bundle/macos/app.rs
- https://github.com/tauri-apps/tauri/issues/5889
- https://huggingface.co/ggml-org/embeddinggemma-300m-qat-q8_0-GGUF/resolve/main/embeddinggemma-300m-qat-Q8_0.gguf
- https://immich.app/blog/v3.0.0-release
- https://jan.ai/docs/desktop/quickstart
- https://jobs.ashbyhq.com/nabucasa/cb061b70-df9a-4a77-bdc6-753843769a16
- https://learn.chatgpt.com/docs/customization/memories
- https://lmstudio.ai/blog/lmstudio-v0.3.6
- https://lmstudio.ai/docs/app/basics
- https://man7.org/linux/man-pages/man5/systemd.exec.5.html
- https://nodejs.org/api/single-executable-applications.html
- https://nodejs.org/docs/latest-v22.x/api/single-executable-applications.html
- https://ollama.com/install.sh
- https://openwebui.com/blog/v0-11-0-the-interface-reorganized
- https://raw.githubusercontent.com/home-assistant/home-assistant.io/current/source/getting-started/onboarding.markdown
- https://raw.githubusercontent.com/mintlify/docs/main/skill.md
- https://raw.githubusercontent.com/n8n-io/n8n/refs/heads/master/docker/get-n8n.sh
- https://raw.githubusercontent.com/ollama/ollama/main/scripts/install.sh
- https://raw.githubusercontent.com/open-webui/docs/main/docs/getting-started/quick-start/connect-a-provider/starting-with-ollama.mdx
- https://raw.githubusercontent.com/open-webui/docs/main/docs/getting-started/quick-start/index.mdx
- https://raw.githubusercontent.com/open-webui/open-webui/main/.github/workflows/docker.yaml
- https://raw.githubusercontent.com/open-webui/open-webui/main/backend/open_webui/config.py
- https://raw.githubusercontent.com/open-webui/open-webui/main/backend/open_webui/env.py
- https://raw.githubusercontent.com/open-webui/open-webui/main/backend/open_webui/models/config.py
- https://raw.githubusercontent.com/tauri-apps/tauri/dev/crates/tauri-codegen/src/context.rs
- https://registry.npmjs.org/@bitterbot%2fmatrix (npm view -> E404 Not Found)
- https://registry.npmjs.org/@whiskeysockets/baileys (dist-tags latest=7.0.0-rc14, legacy=6.7.24)
- https://registry.npmjs.org/bitterbot (404 {"error":"Not found"})
- https://registry.npmjs.org/bitterbot (HTTP 404, body {"error":"Not found"})
- https://registry.npmjs.org/bitterbot (HTTP 404, {"error":"Not found"})
- https://registry.npmjs.org/bitterbot -> {"error":"Not found"}
- https://registry.npmjs.org/bitterbot-ai
- https://registry.npmjs.org/geist/latest (version 1.7.2)
- https://socket.dev/blog/node-js-tsc-votes-to-stop-distributing-corepack
- https://tailscale.com/kb/1067/update
- https://tailscale.com/kb/1312/serve - 'When you use Serve to proxy traffic to a local service running on your device, it adds a few Tailscale identity headers to [...]
- https://v2.tauri.app/develop/resources/
- https://v2.tauri.app/develop/sidecar/
- https://v2.tauri.app/reference/config/
- https://www.home-assistant.io/blog/2025/12/03/release-202512/
- https://www.home-assistant.io/common-tasks/os/
- https://www.home-assistant.io/getting-started/onboarding/
- https://www.home-assistant.io/integrations/labs/
- https://www.home-assistant.io/integrations/repairs/
- https://www.jan.ai/docs/desktop/quickstart
- https://www.letta.com/blog/introducing-the-agent-development-environment/
- https://www.librechat.ai/docs/configuration/librechat_yaml
- https://www.mintlify.com/docs/cli/commands
- https://www.mintlify.com/docs/guides/internationalization
- https://www.mintlify.com/docs/organize/hidden-pages
- https://www.mintlify.com/docs/organize/navigation
- https://www.mintlify.com/docs/organize/settings (no redirects section)
- https://www.nabucasa.com/about/
- npm registry: `npm view bitterbot version` -> 404
- npm registry: `npm view playwright version` -> 1.62.1
- npm view bitterbot version -> 404
- npm view bitterbot version -> npm error 404 (2026-08-21)

## 6. Appendix: corrections applied to the main report

The 301 in-place edits derived from section 2, as exact find/replace pairs against `docs/reviews/v1-release-audit-2026-08-21.md` at HEAD c5e1f97 (each `find` string occurs exactly once in that file). The structured result returned to the orchestrator carries the highest-priority subset; this appendix is the complete list.

```json
[
  {
    "section": "1 Executive summary",
    "find": "3 TODOs, zero heritage names in non-test code",
    "replace_with": "3 TODO markers in src/ + desktop/renderer/src (2 genuine; 5 more in scripts/, orchestrator/src, desktop/src-tauri), zero heritage names in non-test code",
    "reason": "1-01 partial: count scope and one false positive (heartbeat.ts:39 is prose)"
  },
  {
    "section": "1 Executive summary",
    "find": "are dead on every install since 2026-08-15. (confirmed critical, effort S)",
    "replace_with": "are dead on every fresh install that depends on the prebuilt fetch (no local cargo build, no `p2p.orchestratorBinary`) since 2026-08-15. Publishing needs `MINISIGN_SECRET_KEY` (0 repo secrets today) and the `release` GitHub environment (404 today), so the tag push would fail at the sign step. (confirmed critical, effort S plus the SIGNING.md runbook)",
    "reason": "1-03 partial; 1-02/3.2-06 recommendation needs-change"
  },
  {
    "section": "1 Executive summary",
    "find": "several feeding loops the 2026-08-09 wired-but-dead audit found structurally dead.",
    "replace_with": "several feeding loops the 2026-08-09 wired-but-dead audit found structurally dead (9 of its 17 findings, incl. F5/F6/F8/F16, were fixed on 2026-08-09/10; F7/F9/F10/F15 remain open).",
    "reason": "1-21 partial: most of that audit is fixed"
  },
  {
    "section": "1 Executive summary",
    "find": "A fresh node phones home to `p2p.bitterbot.ai`, 4 hardcoded relays, `mailbox.bitterbot.ai`, and GitHub on first boot.",
    "replace_with": "A fresh node phones home to `p2p.bitterbot.ai`, 4 hardcoded bootstrap peers (3 relays + 1 bootnode), GitHub (git fetch) and registry.npmjs.org on first boot; `mailbox.bitterbot.ai` is contacted once the node has a non-practice circle.",
    "reason": "1-22 partial: mailbox poll is gated on hasActiveCircles; update check also hits npm"
  },
  {
    "section": "1 Executive summary",
    "find": "exec deny-by-default, $50/day wallet cap)",
    "replace_with": "exec approvals deny by default, $50 per-session wallet cap; the configured daily limit is reported, not enforced)",
    "reason": "1-35 partial: dailySpendLimitUsd has no enforcement site"
  },
  {
    "section": "1 Executive summary",
    "find": "so `bind=lan` or Tailscale serve gives any LAN/tailnet host token-free agent runs (confirmed high, S).",
    "replace_with": "so `bind=lan` or Tailscale serve gives any LAN/tailnet host token-free agent runs; under tailscale serve the waiver fires on the loopback branch (proxied via 127.0.0.1 with `trustedProxies=[]`), so a loopback-only fix is not enough, and POST /a2a has no Origin/Host check (confirmed high, S).",
    "reason": "3.1-05/3.1-06: loopback-only fix leaves tailscale serve and browser CSRF open"
  },
  {
    "section": "1 Decisions",
    "find": "only `compareSemverStrings` in update-check needs a one-line guard.",
    "replace_with": "both comparators need a guard: `compareSemverStrings` (`src/infra/update-check.ts:344`, package installs only) and `compareBitterbotVersions` (`src/config/version.ts`, which runs on every git install via `warnIfConfigFromFuture`). No workflow listens for a bare `v*` tag today.",
    "reason": "3.7-3.8-03 partial, 5-32/6.9-6.10-08 recommendation needs-change"
  },
  {
    "section": "1 Decisions",
    "find": "Opt-in for V1 (`circles.enabled=false`, `practicePartner.enabled=false`, mailbox poll only when enabled) with a real toggle in Settings.",
    "replace_with": "Opt-in for V1 (`circles.enabled=false`; keep `practicePartner` ON inside opted-in circles, it is what makes a solo circle usable; the mailbox already polls only when circles is enabled) with a real toggle in Settings (none exists today).",
    "reason": "3.1-18 recommendation needs-change"
  },
  {
    "section": "1 Decisions",
    "find": "add one wizard consent step (\"Connect to the Bitterbot network?\") and a `network.localOnly` switch.",
    "replace_with": "promote the existing advanced-flow consent (`onboarding.p2p.ts:77-90`) to QuickStart and add a Local-only wizard preset over the existing flags (`p2p.enabled`, `circles.enabled`, `a2a.enabled`, `update.checkOnStart`, `models.liveDiscovery.enabled`) rather than a new `network.localOnly` key. `a2a.payment` is already derived OFF without CDP credentials.",
    "reason": "1-22/3.1-23/3.3-25 recommendation needs-change; consent step exists"
  },
  {
    "section": "1 Decisions",
    "find": "PLAN-39 phase 1 (M). Removes port 5173",
    "replace_with": "PLAN-39 Phases 0-2 (Phase 0 measures the restart blackout, Phase 1 is the build pipeline, Phase 2 is gateway serving; M-L). Removes port 5173",
    "reason": "3.2-24/3.7-3.8-09: gateway serving is PLAN-39 Phase 2, gated on Phase 0"
  },
  {
    "section": "1 Decisions",
    "find": "Auto-download the ~300 MB default local embedding GGUF when no remote key exists",
    "replace_with": "Auto-select the ~329 MB default local embedding GGUF when no remote key exists (download code already exists behind `provider: \"local\"`; `auto` never reaches it)",
    "reason": "1-41 partial: download exists, selection is the gap"
  },
  {
    "section": "1 Decisions",
    "find": "Fix (M): it is the cheapest self-contained server artifact and `docker-compose.yml`, `docker-setup.sh` already exist.",
    "replace_with": "Fix (image fix is S: two Dockerfile lines; CI + GHCR publish is M; same call as PLAN-39 D4): `docker-compose.yml`, `docker-setup.sh` already exist but have never been run against a buildable image. PLAN-37 row 39 decided to keep `bitterbot.podman.env`; D1 must override it.",
    "reason": "1-42/5-06/3.2-22 recommendation needs-change"
  },
  {
    "section": "1 Decisions",
    "find": "Deploy, because 81 source files and the system prompt already link there; but only after the 270 dead nav entries are removed.",
    "replace_with": "The `formatDocsLink` repoint is already done (`src/terminal/links.ts:3`, commit 007db0a); 62 src files still mention the host, mostly as link labels. Fix the raw literals (`docs.ts:8,164`, `system-prompt.ts:648`, three troubleshooting prints) via one constant, give `bitterbot docs` a local fallback, and decide the DNS record + Mintlify deploy separately, after the nav prune.",
    "reason": "3.9-07 partial: half of D9 is already done"
  },
  {
    "section": "1 Decisions",
    "find": "\"Windows via WSL2\" everywhere for V1; native Windows post-V1. | Affects README badge, docs/platforms, install matrix, and CI matrix.",
    "replace_with": "\"Windows via WSL2\" everywhere for V1; native Windows post-V1. Docs already say this (platforms/windows.md, wizard.md, onboarding-overview.md) and CI runs install/typecheck/unit tests on windows-latest; the remaining edits are the README badge, the getting-started PowerShell tab (dead install.ps1) and the setup-deps exit message. | Affects README badge, docs/platforms, install matrix, and CI matrix.",
    "reason": "3.2-29/6.3-6.4-09 partial: Windows is more than a badge"
  },
  {
    "section": "1 Decisions",
    "find": "wallet default-on in QuickStart (recommend off; configure from the Wallet page)",
    "replace_with": "wallet default-on in QuickStart (recommend skipping the CDP walkthrough in QuickStart; a global `tools.wallet.enabled=false` is a separate schema decision, the key currently defaults ON)",
    "reason": "3.2-27 wallet recommendation needs-change; 2.3-2.4-24 refuted"
  },
  {
    "section": "1 Decisions",
    "find": "(recommend foreground `start:all` default, service opt-in)",
    "replace_with": "(recommend `requireConfirm: true` on the existing linger helper and giving QuickStart the advanced flow's \"Install as a service?\" confirm; the service is the documented reboot-surviving path)",
    "reason": "3.2-28 recommendation needs-change"
  },
  {
    "section": "2.1 nav",
    "find": "| **SHIP-ADVANCED** | Opt-in toggle; keep nav item rendering the inert pane; no global badge polling when off |",
    "replace_with": "| **SHIP-ADVANCED** | Opt-in toggle; keep nav item rendering the inert pane (already the behaviour); stop the 45 s `circles.status` probe once it reports enabled=false (no `circles.list` or badge polling happens today when off) |",
    "reason": "2.1-2.2-06 partial, 6.1-6.2-06 recommendation already partly done"
  },
  {
    "section": "2.1 nav",
    "find": "Reduce to connection state, peer ID, peer count, NAT; drop Contribution Score / Skills Verified until F7/F11/F14 land |",
    "replace_with": "Reduce to connection state, peer ID, peer count, NAT; drop \"Skills Verified\" outright (no producer anywhere, always 0) and drop or relabel \"Contribution Score\" (`skills_published*10 + uptime*0.1`, unrelated to EigenTrust/F7) |",
    "reason": "3.4-16 partial"
  },
  {
    "section": "2.1 nav",
    "find": "| **SHIP** | Provider picker instead of free-text; add \"Use a local model\" |",
    "replace_with": "| **SHIP** | Provider picker in KeyEntryModal instead of free-text (ModelsView already prefills the provider per row); add \"Use a local model\" (needs a `models.providers.<id>.baseUrl` config write, not only models.auth.*) |",
    "reason": "2.1-2.2-17 partial"
  },
  {
    "section": "2.1 nav",
    "find": "| (sidebar) Social links | n/a | Sidebar.tsx:524-585 |",
    "replace_with": "| (sidebar) Social links | n/a | Sidebar.tsx:552-616 |",
    "reason": "2.1-2.2-21 partial: wrong line anchor"
  },
  {
    "section": "2.1 nav",
    "find": "Into an About dialog; add Help & Docs link |",
    "replace_with": "Into an About dialog; add Help & Docs link once a docs destination exists (`docs.bitterbot.ai` does not resolve; use about.bitterbot.ai or the GitHub docs tree meanwhile) |",
    "reason": "2.1-2.2-21 recommendation needs-change"
  },
  {
    "section": "2.1 nav",
    "find": "Target nav (8 items):",
    "replace_with": "Target nav (8 items; baseline today is 11 visible, 12 on management nodes; Chat is a separate affordance and the Wallet panel sits outside NAV_ITEMS):",
    "reason": "2.1-2.2-01/6.1-6.2-01: baseline count and Chat/Wallet status"
  },
  {
    "section": "2.2 orphans",
    "find": "### 2.2 Control UI: views compiled in with no nav entry and no `setActiveTab` caller",
    "replace_with": "### 2.2 Control UI: views compiled in with no nav entry (chat and wallet do have `setActiveTab` callers; the other eight have none)",
    "reason": "2.1-2.2-23 partial"
  },
  {
    "section": "2.2 orphans",
    "find": "| **SHIP** (reached via Conversations / New Conversation) |",
    "replace_with": "| **SHIP** (default tab on launch; also reached via Conversations / New Conversation) |",
    "reason": "2.1-2.2-30 partial"
  },
  {
    "section": "2.2 orphans",
    "find": "| projects.* (backend works) |",
    "replace_with": "| projects.* (backend registered and wired into chat.send; not runtime-tested; deleting the UI alone recreates the wired-but-dead pattern) |",
    "reason": "2.1-2.2-26 partial, 6.1-6.2-04 partial"
  },
  {
    "section": "2.2 orphans",
    "find": "(or fold thinking/verbose controls into chat header)",
    "replace_with": "(or fold the thinking-level control into the chat header; no verbose control exists)",
    "reason": "2.1-2.2-28 recommendation needs-change"
  },
  {
    "section": "2.2 orphans",
    "find": "| workspace.tree/read/stat/search/write |",
    "replace_with": "| workspace.tree/read/search/write + fileChanged event (`workspace.stat` has no UI caller; WorkspaceFilesPanel is already live as the chat Files tab) |",
    "reason": "2.1-2.2-29 partial"
  },
  {
    "section": "2.3 CLI",
    "find": "(`hidden: true`, `BITTERBOT_SHOW_DEV_COMMANDS=1`)",
    "replace_with": "(`hidden: true` on both the lazy placeholder and the real registrar, since `BITTERBOT_DISABLE_LAZY_SUBCOMMANDS` and completion bypass placeholders; `BITTERBOT_SHOW_DEV_COMMANDS=1`; update docs/cli/index.md)",
    "reason": "2.3-2.4-09 recommendation needs-change"
  },
  {
    "section": "2.4 config",
    "find": "autoRollback/uiRestart advanced, git installs only |",
    "replace_with": "autoRollback/uiRestart advanced (autoRollback is git-only by construction; uiRestart only acts on a running Vite dev server, not a git check) |",
    "reason": "2.3-2.4-23 partial"
  },
  {
    "section": "2.4 config",
    "find": "`tools.wallet.enabled` default false |",
    "replace_with": "`tools.wallet.enabled` defaults ON (refuted, 2nd pass: `wallet-tool.ts:73-78` registers the tool unless explicitly false, on base-sepolia); making wallet advanced needs a real default flip |",
    "reason": "2.3-2.4-24 refuted"
  },
  {
    "section": "2.4 config",
    "find": "| skills (skillSeekers, marketability, agentskills, p2p ingest) | ON |",
    "replace_with": "| skills (skillSeekers, marketability, agentskills, p2p ingest) | skillSeekers + predictor ON; agentskills OFF (opt-in); p2p ingest has no flag, `ingestPolicy` defaults to review |",
    "reason": "2.3-2.4-28 partial"
  },
  {
    "section": "2.4 config",
    "find": "| Legacy migrations (`src/config/legacy.*`, ~1,300 lines) | runs on every load |",
    "replace_with": "| Legacy migrations (`src/config/legacy.*`, ~1,160 lines; ~1,360 with helpers) | only detection runs on load (and rejects the config); migrations run from `doctor` and the config-restore RPC |",
    "reason": "3.3-23 partial"
  },
  {
    "section": "2.5 channels",
    "find": "| Document ffmpeg as optional for Discord voice |",
    "replace_with": "| ffmpeg is already documented (discord.md:599, setup.md:32) and installed by setup-deps; make the duration/convert path in voice-message.ts fail soft |",
    "reason": "3.9-25 partial: ffmpeg is declared"
  },
  {
    "section": "2.5 channels",
    "find": "Pin stable Baileys; soften \"separate phone + eSIM\" blurb; make Telegram the quickstart default per docs |",
    "replace_with": "No stable Baileys 7.x exists (latest 7.0.0-rc14, legacy 6.7.24): bump to rc14 with a regression test or fall back to 6.7.24; soften the eSIM blurb; Telegram is already the quickstart default (`DEFAULT_CHAT_CHANNEL` is the delivery default, not the wizard default) |",
    "reason": "3.10-3.11-25 partial"
  },
  {
    "section": "2.5 channels",
    "find": "| Actionable install hint from greyed card |",
    "replace_with": "| The greyed card already says \"Install it or set channels.signal.cliPath\"; extend it with the install command and add macOS/Windows sections to signal.md (CLI onboarding auto-installs from GitHub releases, Homebrew is only the arm fallback) |",
    "reason": "3.9-24 partial"
  },
  {
    "section": "2.5 channels",
    "find": "| Appears in wizard on Linux/Windows as dead end |",
    "replace_with": "| Appears in wizard on every platform and dead-ends at \"imessage plugin not available\" (onboard-channels.ts:480) |",
    "reason": "3.10-3.11-18 partial"
  },
  {
    "section": "2.5 channels",
    "find": "| LINE | src/line (46 files) + `@line/bot-sdk` | never registered | **REMOVE** | |",
    "replace_with": "| LINE | src/line (46 files) + `@line/bot-sdk` | never registered as a channel, but `stripMarkdown` feeds TTS, the plugin runtime exposes a `line` namespace and normalize-reply strips LINE directives on every reply | **REMOVE** | Relocate `stripMarkdown`, remove the runtime namespace and the normalize-reply hook first |",
    "reason": "3.6-21 partial"
  },
  {
    "section": "2.6 plans",
    "find": "| PLAN-15 memory curator / scrubber | module shipped, unwired | OFF | **HIDE** |",
    "replace_with": "| PLAN-15 memory curator / scrubber | scrubber shipped and unwired; the A-MAC skill curator IS wired into the dream cycle (`dream-engine.ts:975`, every 24 h) | scrubber OFF / curator ON | **HIDE** scrubber (already hidden); decide the curator explicitly |",
    "reason": "2.5-2.6-14 partial"
  },
  {
    "section": "2.6 plans",
    "find": "| PLAN-24 HORMA | phases 0/1/3/5 landed | ON |",
    "replace_with": "| PLAN-24 HORMA | phases 0/1/2 (gate passed)/3/4/5 landed | ON |",
    "reason": "2.5-2.6-20 partial"
  },
  {
    "section": "2.6 plans",
    "find": "| 71 commits; B3/B4/B5 landed 08-15; key-rotation gap open | ON |",
    "replace_with": "| 71 src/circles commits; B3/B4/B5 code merged 08-15 but none is live (placeholder minisign key, relays on 0.2.2); sender-key rotation on removal is implemented, per-node by design; B7 batch open | ON |",
    "reason": "2.5-2.6-24 partial"
  },
  {
    "section": "2.6 plans",
    "find": "| PLAN-32 fleet sync, PLAN-14, PLAN-39 | docs only | n/a | docs: mark backlog |",
    "replace_with": "| PLAN-32 fleet sync, PLAN-39 (PLAN-14 has landed code: OTel tool spans, network-state prompt block) | local gitignored drafts, not in the repo | n/a | nothing public to mark; annotate the local files only |",
    "reason": "2.5-2.6-25 partial, recommendation unsound"
  },
  {
    "section": "2.6 plans",
    "find": "| PLAN-33 canonical ledger | landed; 0 auto-pins in 26 cycles | ON | **SHIP** (fix calibration) |",
    "replace_with": "| PLAN-33 canonical ledger | landed; extraction auto-pins work (219 pins, 40 active); only the `canonical_promotion` dream mode is near-dead (1 pin in 40 cycles) | ON | **SHIP** (run the PLAN-40 calibrate-or-retire pilot on that mode only) |",
    "reason": "2.5-2.6-26 partial"
  },
  {
    "section": "2.6 plans",
    "find": "| Skill Seekers trending sweep | 268-item unreviewed quarantine | ON |",
    "replace_with": "| Skill Seekers trending sweep | 08-10 figure was 268 quarantined; 20 today under the 30-day TTL sweeper; default-on lives in `manager.ts:3135` and contradicts the type doc | ON |",
    "reason": "3.4-22 partial"
  },
  {
    "section": "3.1 Security",
    "find": "derive `CirclesConfig` via `z.infer`;",
    "replace_with": "add a schema-vs-type drift test (no `z.infer` is used anywhere in src/config; all 38 sections are hand-typed);",
    "reason": "3.1-01 recommendation needs-change"
  },
  {
    "section": "3.1 Security",
    "find": "`security audit` recommends tailscale serve (CGNAT range).",
    "replace_with": "`security audit` recommends tailscale serve only as the funnel downgrade; under serve the waiver fires on the loopback branch (tailscaled proxies via 127.0.0.1 and `trustedProxies` defaults to `[]`), not the CGNAT range.",
    "reason": "3.1-06 partial: mechanism corrected"
  },
  {
    "section": "3.1 Security",
    "find": "Replace with `isLoopbackAddress`; optional",
    "replace_with": "Replace with `isLocalDirectRequest` (auth.ts:88; loopback alone still waives every tailscale-serve caller) and add an Origin/Host check on POST /a2a (`readJsonBody` enforces no Content-Type, so a cross-site simple POST from the user's browser reaches it); optional",
    "reason": "3.1-05 recommendation needs-change"
  },
  {
    "section": "3.1 Security",
    "find": "`src/config/defaults.ts:547,573,504,628`",
    "replace_with": "`src/config/defaults.ts:547,573,560,628`",
    "reason": "3.1-08 partial: payment default is at line 560"
  },
  {
    "section": "3.1 Security",
    "find": "`payment.enabled: isEarningCapable`, `p2p.enabled: true`",
    "replace_with": "`payment.enabled: isEarningCapable` (derived: OFF without CDP credentials), `p2p.enabled: true`",
    "reason": "3.1-08 partial"
  },
  {
    "section": "3.1 Security",
    "find": "`forage.nightShift !== false`. `types.circles.ts:6`: ON \"for live red-teaming at scale\". | Flip marketplace/payment/forage/circles OFF; keep p2p only if in V1 story; one wizard consent step. | S |",
    "replace_with": "`forage.nightShift !== false` (in `forage-client.ts:111`, inert without a wallet address; agentDrafts/sandbox defaults live in `service.ts:1930/2092`). `types.circles.ts:6-8`: ON \"for live red-teaming at scale\" (a recorded PLAN-31 §8 decision the flip must explicitly reverse). | Flip marketplace/forage/circles OFF (payment is already derived OFF); keep p2p only if in V1 story; promote the existing advanced-flow P2P consent to QuickStart; a Circles Settings toggle does not exist yet. | S |",
    "reason": "3.1-08 partial and recommendation needs-change"
  },
  {
    "section": "3.1 Security",
    "find": "(audit F8/F9: regions get fresh UUIDs every 30 min, zero targets resolved)",
    "replace_with": "(audit F8 fixed in fd59b1a: region ids are now stable and learning_progress accumulates; F9 still open: knowledge_gap targets never resolve because region_id is NULL at creation)",
    "reason": "3.1-10 partial"
  },
  {
    "section": "3.1 Security",
    "find": "dream 4 LLM modes every 120 min with 8 calls. None labeled experimental. | Defaults: harnessEvolve/curiosity/rlm/architectEvolution OFF; keep dream+consolidation+extraction; mark rest `advanced`. | S |",
    "replace_with": "dream engine: 7 LLM modes enabled, 1-3 run per cycle under an 8-call cap, adaptive 30-240 min interval; `harnessEvolve` is effectively OFF because the `harness_evolve` dream mode is held OFF by PLAN-40 (`dream-types.ts:64`). None labeled experimental. | Defaults: curiosity (or ship the F9 fix instead; curiosity OFF also removes GCCRF scoring and dream weighting), rlm (this removes the user-facing deep_recall tool; prefer keeping it with its budget caps), architectEvolution OFF; harnessEvolve is already mode-held; keep dream+consolidation+extraction; mark rest `advanced`. | S |",
    "reason": "3.1-09 partial and recommendation needs-change"
  },
  {
    "section": "3.1 Security",
    "find": "Wizard does warn, but pins `provider: \"openai\"` with no key on blank input. | (1) `auto` falls back to `DEFAULT_LOCAL_MODEL` with auto-download + kill switch;",
    "replace_with": "Wizard does warn, but pins the selected provider (openai by default) with no key on blank input and its skip message points at `configure --section memory`, which does not exist. | (1) `auto` reaches the existing local download (`createLocalEmbeddingProvider` already calls `resolveModelFile`) last in the chain, after remote keys (so adding a key later does not flip embedding dimensions) and only after `importNodeLlamaCpp()`/`getLlama()` and sqlite-vec load succeed, with a kill switch;",
    "reason": "3.1-13 partial; 3.1-11/1-41 recommendation needs-change"
  },
  {
    "section": "3.1 Security",
    "find": "(3) wizard \"Local (no API key)\" option, default for Anthropic; leave `auto` on blank key. | M |",
    "replace_with": "(3) wizard \"Local (no API key)\" option offered after a node-llama-cpp probe (with the ~329 MB warning), default for Anthropic; omit `provider` on blank key (today it is always written). | M |",
    "reason": "3.1-13 recommendation needs-change"
  },
  {
    "section": "3.1 Security",
    "find": "Worse: `daemon/program-args.ts:205-210` sets no workingDirectory, so launchd cwd is `/`",
    "replace_with": "Worse: `daemon/program-args.ts:199-210` (the non-dev branches; dev-mode installs do set `workingDirectory: repoRoot`) sets no workingDirectory, so launchd cwd is `/` (inferred from launchd behaviour)",
    "reason": "3.1-15 partial"
  },
  {
    "section": "3.1 Security",
    "find": "Default `keyDir` to `<stateDir>/identity/p2p`, always pass `--key-dir`, one-time migration from `<packageRoot>/keys` and `~/keys`, include in reset/uninstall, fix doc and `doctor-identity.ts:39-52`. | S-M |",
    "replace_with": "Default `keyDir` per PLAN-37 D5 (`~/.bitterbot/keys`, which the doc already shows; pick one target, not `<stateDir>/identity/p2p`), always pass `--key-dir`, one-time migration from `<packageRoot>/keys`, `<packageRoot>/desktop/keys` (exists on this machine) and `~/keys` plus the co-located `genesis_trust_list.txt`/`bootnode-peers.json`, fail hard for management-tier nodes instead of minting a fresh key, include in reset/uninstall, fix the doc (`doctor-identity.ts:39-52` is already correct since 5365a26). | S-M |",
    "reason": "6.11-6.12-04 recommendation needs-change; 3.1-16 partial"
  },
  {
    "section": "3.1 Security",
    "find": "Security framing stale: B3/B4/B5 landed in 017761f/6633401; mesh transport already default-OFF; remaining gap is sender-key rotation on removal (`sender-keys.ts:24-29`). | Default `circles.enabled=false`, `practicePartner.enabled=false`; real toggle; mailbox opt-in with circles; gate re-enable on rotation fix, not B5. | M |",
    "replace_with": "Security framing: B3/B4/B5 code landed in 017761f/6633401 but none is live (placeholder minisign key, no signed release, relays on 0.2.2); mesh transport already default-OFF; sender-key rotation on removal is implemented (`service.ts:1619-1623`) and per-node by design (`sender-keys.ts:24-29`); the open work is the B7 batch. Partner auto-seat fires on sandbox \"propose\" enrollment, not circle creation. | Default `circles.enabled=false`; real toggle (none exists); keep `practicePartner` ON inside opted-in circles; the mailbox already polls only when circles is enabled (`server-startup.ts:399`); gate mesh re-enable on B5 activation + signed 0.2.3 on all relays, not on a rotation fix. | M |",
    "reason": "3.1-19 partial; 3.1-18/6.5-6.6-15 recommendation needs-change"
  },
  {
    "section": "3.1 Security",
    "find": "`src/config/types.bitterbot.ts:114`, `src/memory/manager.ts:2515-2533`",
    "replace_with": "`src/config/types.bitterbot.ts:115`, `src/memory/manager.ts:2515-2533`",
    "reason": "3.1-20 partial: anchor"
  },
  {
    "section": "3.1 Security",
    "find": "no-ops without CDP wallet creds (`manager.ts:2525`) and requires marketplace + funded bounties.",
    "replace_with": "no-ops without CDP wallet creds (`manager.ts:2522`); the marketplace gate is trivially met (on by default) and bounties must be funded/open.",
    "reason": "3.1-20 partial"
  },
  {
    "section": "3.1 Security",
    "find": "Hide Forage/Earnings tabs (`dream-dashboard-page.ts:106-107`); flip to explicit opt-in; private-IP guard before `forage-client.ts:140`. | S |",
    "replace_with": "Hide the Forage tab (`dream-dashboard-page.ts:107`; Earnings at :106 is the marketplace panel and follows the marketplace decision); the opt-in flip is cosmetic on wallet-less nodes and reverses PLAN-29's active-by-default rule, so state it as a D4 choice; the required fix is routing the `monitor_url` and `poster_a2a_url` fetches in `src/memory/forage-client.ts` (not `src/forage/`) through the existing `src/infra/net/fetch-guard.ts` / `assertPublicHostname` (SSRF is gated on a funded bounty). | S |",
    "reason": "3.1-20/3.1-21/6.5-6.6-17 recommendation needs-change"
  },
  {
    "section": "3.1 Security",
    "find": "`src/gateway/server-http.ts:546-556, 585-596` |",
    "replace_with": "`src/gateway/server-http.ts:537-557, 574-597` (same pattern on `/dreams` :514-534 and `/wallet/fund` :598-620) |",
    "reason": "6.7-6.8-14: anchors and scope"
  },
  {
    "section": "3.1 Security",
    "find": "Require bearer/`?t=` or mint a short-lived page token. | S |",
    "replace_with": "Mint a short-lived, read-scoped page token for all four embedded pages and pass it via fragment (requiring bearer/`?t=` on `/management` would break the iframe-based Management tab, which works only via the loopback waiver; `/m` needs `?t=` for QR pairing by design); the replacement is already noted at `server-http.ts:507-513` (PLAN-40 Phase 2). | S |",
    "reason": "6.7-6.8-14 recommendation needs-change"
  },
  {
    "section": "3.1 Security",
    "find": "Quickstart silently joins mesh, mailbox, A2A with `skills.expose: \"all\"`; opt-out only in advanced flow (`onboarding.p2p.ts:77`); orchestrator binds `0.0.0.0:9100`. | One consent step; `network.localOnly` switch; document outbound hosts in `docs/gateway/security`. | S |",
    "replace_with": "Quickstart joins the mesh with a note that names the opt-out key but no prompt (`onboarding.p2p.ts:68-77`), and A2A (`skills.expose: \"all\"`) and Circles/mailbox with no wizard mention at all; orchestrator binds `0.0.0.0:9100` (overridable via `p2p.listenAddrs`). | Promote the existing confirm to QuickStart; a Local-only wizard preset over the existing flags (`p2p.enabled`, `circles.enabled`, `circles.mailbox.enabled`, `a2a.enabled`, `update.checkOnStart`, `models.liveDiscovery.enabled`, `p2p.listenAddrs`) rather than a fifth `network.localOnly` key; document outbound hosts and exposed listeners separately in `docs/gateway/security/index.md`. | S |",
    "reason": "3.1-23 partial and recommendation needs-change"
  },
  {
    "section": "3.1 Security",
    "find": "Complete SIGNING.md; verify `.minisig` in the fetcher; add `actions/attest-build-provenance` + cosign bundle. | M |",
    "replace_with": "Execute the SIGNING.md runbook (it is written; the one-time setup has not been performed: 0 repo secrets, placeholder pubkey, no `release` environment); then verify `.minisig` in the fetcher via node:crypto Ed25519 with the embedded pubkey (or port `update-orchestrator.sh:83-99` for a shell installer); defer attest-build-provenance/cosign (duplicate trust root, needs `id-token: write`; the remediation doc chose minisign). | M |",
    "reason": "3.1-24 recommendation needs-change"
  },
  {
    "section": "3.1 Security",
    "find": "No dependabot/renovate, no `pnpm audit`, no overrides; `.secrets.baseline` from 2026-03-28. | Add `dependabot.yml` (npm+cargo+actions), non-blocking audit job. | S |",
    "replace_with": "No dependabot/renovate (alerts are also disabled at the GitHub repo level), no `pnpm audit`; six security overrides plus `minimumReleaseAge: 2880` do exist in `pnpm-workspace.yaml`; `.secrets.baseline` generated 2026-01-25 (git-dated 03-28). | Enable Dependabot alerts in repo settings; add `dependabot.yml` (npm + two cargo dirs: `orchestrator/`, `desktop/src-tauri/` + actions); non-blocking `pnpm audit` plus `cargo audit`. | S |",
    "reason": "3.1-26 partial and recommendation needs-change"
  },
  {
    "section": "3.1 Security",
    "find": "one `git add -A` from disclosure; status predates 017761f/6633401. | Update status and commit as closed post-mortem, or move out of tree; gitignore the pattern. | S |",
    "replace_with": "one `git add -A` from disclosure; status predates 017761f/6633401, but its \"CRITICAL items open\" condition still holds (B5 unactivated, relays unsigned, B7 items such as unauthenticated Windows IPC 19002 live). | Do not commit it as a closed post-mortem (that publishes live findings); move it into `docs/plans/` (already gitignored) or gitignore `docs/reviews/*-security-remediation-*.md`; revisit after B5 activation + signed 0.2.3 fleet convergence. | S |",
    "reason": "3.1-27 partial and recommendation needs-change"
  },
  {
    "section": "3.1 Security",
    "find": "| Pick one; recommend explicit opt-in. | S |",
    "replace_with": "| Fix the stale comment at `sandbox-agent.ts:26` (code and `types.circles.ts:99-110` agree on ON per the R19 amendment of 2026-07-28); explicit opt-in is a product decision for Victor, not a tidy-up. | S |",
    "reason": "6.7-6.8-20 recommendation needs-change"
  },
  {
    "section": "3.1 Security",
    "find": "`desktop/src-tauri/tauri.conf.json:24,61-65`",
    "replace_with": "`desktop/src-tauri/tauri.conf.json:24,60-65`",
    "reason": "3.1-29 partial: active flag is line 60"
  },
  {
    "section": "3.2 Install",
    "find": "`doctor-p2p.ts:152` only warns; dev box hides it",
    "replace_with": "`doctor-p2p.ts:157-161` only warns (by design: an error-level finding blocks the update gate whose `pnpm install` re-runs the fetcher); dev box hides it",
    "reason": "3.2-05 partial"
  },
  {
    "section": "3.2 Install",
    "find": "Set minisign secrets; push `orchestrator-v0.2.3`; verify 302; CI guard that Cargo version has a published release; fetcher fallback to newest published with loud warning (0.2.2 lacks B3 rate limiter, stopgap only); doctor error not warn; fix README:431 and `onboarding.p2p.ts:122` advice. | S |",
    "replace_with": "Run SIGNING.md steps 1-5 (minisign keypair; embed the pubkey in `update-orchestrator.sh:40`; `MINISIGN_SECRET_KEY` repo secret, none exist today; create the protected `release` environment, 404 today); push `orchestrator-v0.2.3`; verify 302 on checksums.txt and `.minisig`; a tag-equals-Cargo check inside orchestrator-release.yml plus a post-merge/scheduled check (a PR-time guard is red by construction between bump and tag); no fetcher fallback (`/releases/latest` resolves to whatever release is newest, incl. future app releases, and would ship a daemon without B3/C7); keep doctor at warn (error blocks the update gate); fix README:431, `onboarding.p2p.ts:118-123`, `doctor-p2p.ts:160` and `orchestrator-binary.ts:105` to name the version/URL that 404'd and offer `node scripts/fetch-orchestrator.mjs`. | S |",
    "reason": "1-02/1-03/1-04/1-05/3.2-02/3.2-05/3.2-06/3.2-07 recommendation needs-change"
  },
  {
    "section": "3.2 Install",
    "find": "`docs/start/getting-started.md:35,40`, `docs/index.md:100`, `docs/start/setup.md:71`, `docs/platforms/linux.md:19` |",
    "replace_with": "`docs/start/getting-started.md:35,40` (+ `docs/reference/RELEASING.md:50`) for the curl/iwr lines; `docs/index.md:100`, `docs/start/setup.md:71`, `docs/platforms/linux.md:19` are the npm-global lines |",
    "reason": "3.2-08 partial: two distinct dead install stories were merged"
  },
  {
    "section": "3.2 Install",
    "find": "`docs/platforms/windows.md:145` clones `github.com/bitterbot/bitterbot.git` (wrong repo). `package.json:134-137` `test:install:*` and `RELEASING.md:50` keep the myth alive.",
    "replace_with": "`docs/platforms/windows.md:145` clones `github.com/bitterbot/bitterbot.git` (wrong repo; the same URL appears in 13 more places incl. `package.json:24,30`, `docs/docs.json:39,44`, and `cd bitterbot` / duplicated `pnpm build` at :146-149). `package.json:134-137` `test:install:*` (targets never existed in git) and `docs/reference/RELEASING.md:47-53` (smoke test listed as \"required\") keep the myth alive; `getting-started.md:46` links `/install` and docs.json lists 20 nonexistent `install/*` pages.",
    "reason": "3.2-13/3.2-14 partial"
  },
  {
    "section": "3.2 Install",
    "find": "fix windows.md clone URL; delete `test:install:*`; docs lint that greps for `bitterbot.ai/install.` and `npm i -g bitterbot`. | S (docs) / M (real installer) |",
    "replace_with": "fix all 14 `github.com/bitterbot/bitterbot` occurrences and the windows.md block; delete `test:install:*` (and the six dead `test:docker:*`); rewrite RELEASING.md:47-53; fix the `/install` link and docs.json install/* pages; add the grep to the existing `check:docs` step (already in CI) matching `bitterbot.ai/install` and `npm (i|install) -g bitterbot`. A real installer also requires hosting text/plain on bitterbot.ai (an SPA catch-all today, outside this repo). | S (docs) / M (real installer) |",
    "reason": "3.2-08/3.2-11/3.2-13/3.2-14/1-10 recommendation needs-change"
  },
  {
    "section": "3.2 Install",
    "find": "orchestrator postinstall lands in `/root/.bitterbot/bin` before `USER node` switches HOME;",
    "replace_with": "orchestrator postinstall would land in `/root/.bitterbot/bin` before `USER node` (line 40, not 48) switches HOME (latent: today nothing is downloaded because 0.2.3 is unreleased, and compose mounts the host dir over `/home/node/.bitterbot` anyway);",
    "reason": "3.2-18 partial"
  },
  {
    "section": "3.2 Install",
    "find": "Fix (drop ui/patches/Bun; copy `desktop/package.json` + `extensions/*/package.json`; `pnpm --filter bitterbot-control-ui build`; `ENV HOME=/home/node` before install; align CMD; `docker build` CI job; GHCR publish on tag) or delete everything incl. docs entries. | M (fix) / S (delete) |",
    "replace_with": "Fix (drop ui/patches/Bun and the dead `BITTERBOT_PREFER_PNPM`; copy `desktop/package.json` + each `extensions/*/package.json` separately; drop the UI build step rather than rename it, the gateway serves no UI assets until PLAN-39; fetch the orchestrator into a path outside the compose-mounted tree such as `/app/orchestrator/target/release` or set `p2p.orchestratorBinary`, `ENV HOME` alone is shadowed by the volume; align CMD in compose:17-18,39 and docker-setup.sh:218 keeping the literal `\"gateway\"` token for `src/docker-setup.test.ts`; `docker build` CI job only after the fix; GHCR publish needs a tag scheme that does not exist yet) or delete everything incl. `src/docker-setup.test.ts`, `.dockerignore` and the three docs.json entries. This is PLAN-39 D4 restated. | S (image) + M (CI/GHCR) / S (delete) |",
    "reason": "3.2-15/16/18/19/21 and 5-06/1-42 recommendation needs-change"
  },
  {
    "section": "3.2 Install",
    "find": "which never existed in any commit; hard-exits at line 82;",
    "replace_with": "which never existed in any commit; guard at line 82, `exit 1` at 84 (on a host without podman it exits at line 26 first);",
    "reason": "3.2-22 partial"
  },
  {
    "section": "3.2 Install",
    "find": "| Delete both files and the docs entries. | S |",
    "replace_with": "| Delete both files and the docs entries (this supersedes PLAN-37 row 39, which kept `bitterbot.podman.env` as a template); prune the whole dead `install/*` nav group at the same time and re-run the link audit. | S |",
    "reason": "3.2-22 recommendation needs-change"
  },
  {
    "section": "3.2 Install",
    "find": "`src/commands/dashboard.ts:37`, `onboard-helpers.ts:482`, `docs/start/getting-started.md:14`, `docs/start/wizard.md:22` | `bitterbot dashboard` opens `http://127.0.0.1:19001/#token=...`; gateway serves no UI; docs repeat it; README says 5173. | Point at the UI port until D5 lands; then both collapse to 19001. | S |",
    "replace_with": "`src/commands/dashboard.ts:37`, `src/commands/onboard-helpers.ts:482`, `docs/start/getting-started.md:14`, `docs/index.md:122`, `docs/start/hubs.md:24`, `docs/platforms/linux.md:22` | `bitterbot dashboard` opens `http://127.0.0.1:19001/#token=...` (a fragment the renderer never reads); the gateway answers 404 at `/` (it does serve `/m`, `/dreams`, `/management`); the same URL is emitted by `status`, `status --all`, `configure`, daemon status and non-interactive onboard; docs repeat it (`wizard.md:22` has no literal URL); README and getting-started.md:90 say 5173; the interactive wizard itself opens 5173. | Fix in `resolveControlUiLinks` (covers all six callers) using `DEFAULT_UI_PORT` (`ui-restart.ts:38`) and handle the no-repo case; drop the unread `#token=` fragment (PLAN-39 §8 already says so); collapse to 19001 after PLAN-39 Phase 2 (serving), not Phase 1. | S |",
    "reason": "3.2-23 partial and recommendation needs-change"
  },
  {
    "section": "3.2 Install",
    "find": "D5: gateway serves `dist-renderer` (PLAN-39 phase 1); minimum: `vite preview` of built output. | M-L |",
    "replace_with": "D5: gateway serves `dist-renderer` (PLAN-39 Phases 0-2: Phase 0 measures the restart blackout the separate Vite process currently masks, Phase 1 is the build pipeline, Phase 2 is serving; the c5e1f97 Start-gateway middleware must move); minimum: `vite preview` (script exists) after the `define` removal, noting it loses `/__gateway/start`. The token also comes from `~/.bitterbot/bitterbot.json` via vite.config.ts:21-31, not only `desktop/.env`. | M-L |",
    "reason": "3.2-24 recommendation needs-change"
  },
  {
    "section": "3.2 Install",
    "find": "`scripts/setup-deps.sh:77` | Unpinned interactive `npx playwright install --with-deps chromium` runs before `pnpm install` while package pins `playwright 1.58.2`; `--with-deps` needs sudo. | Remove from setup-deps; lazy `bitterbot browser install`; move `playwright` to devDependencies (keep `playwright-core`). | S |",
    "replace_with": "`scripts/setup-deps.sh:77-81` | Line 77 probes `npx playwright --version` with output suppressed (so the npx install prompt is invisible and the script appears to hang; if answered yes the version check passes and the Chromium install at line 81 never runs); line 81 is the unpinned `npx playwright install --with-deps chromium`, before `pnpm install`, so npx pulls `playwright@latest` (1.62.1 today) not the pinned 1.58.2; `--with-deps` needs sudo. The downloaded Chromium is not even found by Bitterbot's resolver, which attaches over CDP to a system Chrome/Brave/Edge unless `browser.executablePath` is set. | Remove from setup-deps; drop the unused `playwright` meta-package (nothing imports it; `playwright-core` is the runtime dep and ships the same `install` CLI); no `bitterbot browser install` command exists and a lazy install must also set `browser.executablePath`; keep the existing `chrome.ts:238` remediation hint. | S |",
    "reason": "3.2-25 partial and recommendation needs-change; 4-30 partial"
  },
  {
    "section": "3.2 Install",
    "find": "`scripts/preinstall-check.mjs:105` vs",
    "replace_with": "`scripts/preinstall-check.mjs:107` vs",
    "reason": "3.2-26: anchor"
  },
  {
    "section": "3.2 Install",
    "find": "QuickStart = ~14 prompts + ~20 wall-of-text notes: risk, flow, provider/method/key, model, embeddings (forced), web search (forced), channel, skills confirm+multiselect, wallet CDP, hooks multiselect, GitHub star. | 3 prompts: risk, provider+key, go. Reuse OpenAI key for embeddings; defer web search, channels, skills, hooks, wallet, star to the UI. | M |",
    "replace_with": "QuickStart = 15-19 prompts + ~20 wall-of-text notes: risk, flow, provider/method/key, model, embeddings (forced unless an OpenAI/Gemini/Voyage key is already in env; the OpenAI auth path exports the key, so reuse already works for OpenAI users), web search (forced), channel, skills confirm+multiselect (not flow-gated), wallet CDP, hooks multiselect (not flow-gated), GitHub star. | 4-5 prompts: risk, provider, method, key, go (provider+key alone is 2-3 prompts). Gate skills/hooks on non-quickstart (cheapest win); defer web search, channels, wallet, star to the UI. | M |",
    "reason": "3.2-27 partial and recommendation needs-change"
  },
  {
    "section": "3.2 Install",
    "find": "| Use the existing 90 s `waitForGatewayReachable` poll. | S |",
    "replace_with": "| Use the existing 90 s `waitForGatewayReachable` poll (already imported in finalize.ts, used only on the spawn path) but keep the soft \"still starting\" note: cold boots exceed 90 s on WSL2. | S |",
    "reason": "3.2-28 recommendation needs-change"
  },
  {
    "section": "3.2 Install",
    "find": "README badge \"macOS · Linux · Windows\"; setup-deps exits 1 on Windows; nothing documents or tests native Windows. | \"Windows via WSL2\" (D10). | S |",
    "replace_with": "README badge \"macOS · Linux · Windows\"; setup-deps exits 1 on Windows; CI does run install/typecheck/unit tests on windows-latest and docs already say WSL2 (platforms/windows.md, wizard.md:13, onboarding-overview.md:17); the contradiction is the badge and the getting-started \"Windows (PowerShell)\" tab pointing at a dead install.ps1. | \"Windows via WSL2\" (D10): fix the badge, the PowerShell tab and the setup-deps exit message. | S |",
    "reason": "3.2-29/6.3-6.4-09 partial"
  },
  {
    "section": "3.2 Install",
    "find": "| Default `tools.wallet.enabled=false`; enable from Wallet page. | S |",
    "replace_with": "| Skip the CDP walkthrough in QuickStart (`onboarding.wallet.ts:127` already offers \"skip\"); a global `tools.wallet.enabled=false` is a separate schema/product decision (the key currently defaults ON). | S |",
    "reason": "3.2-27 wallet recommendation needs-change"
  },
  {
    "section": "3.2 Install",
    "find": "| Foreground `start:all` default; service opt-in; never sudo without confirm. | S |",
    "replace_with": "| Pass `requireConfirm: true` to `ensureSystemdUserLingerInteractive` (already supported at `systemd-linger.ts:56`); give QuickStart the advanced flow's \"Install as a service?\" confirm (`finalize.ts:92-96`) defaulting to yes rather than making foreground the default (the service is the documented reboot-surviving path; on WSL2 without systemd the foreground path is already used). | S |",
    "reason": "3.2-28 recommendation needs-change"
  },
  {
    "section": "3.2 Install",
    "find": "`node-llama-cpp 3.15.1`, `@lydell/node-pty` beta, `sharp`, `@napi-rs/canvas`, matrix crypto, `sqlite-vec` alpha all hard deps; 0 optionalDependencies. | Move node-llama-cpp, canvas, matrix crypto to optionalDependencies with runtime detection; `NODE_LLAMA_CPP_SKIP_DOWNLOAD=1` in installer. | M |",
    "replace_with": "`@lydell/node-pty` beta, `sharp` and `sqlite-vec` alpha are hard deps; `node-llama-cpp 3.15.1` and `@napi-rs/canvas` are peerDependencies only (`package.json:234-237`) and are already lazy-imported with runtime detection (`node-llama.ts:2`, `input-files.ts:16-19`); matrix crypto is not a dependency at all (stale `onlyBuiltDependencies` entry); 0 optionalDependencies. | Move node-llama-cpp and canvas from peerDependencies to optionalDependencies (detection already exists); delete the stale matrix entry; `NODE_LLAMA_CPP_SKIP_DOWNLOAD` is referenced nowhere in the repo. | S |",
    "reason": "3.2-30/4-30 partial and recommendation needs-change"
  },
  {
    "section": "3.2 Install",
    "find": "| `corepack enable && corepack prepare pnpm@10.23.0 --activate` in setup-deps and README. | S |",
    "replace_with": "| `corepack enable && corepack prepare pnpm@10.23.0 --activate || npm i -g pnpm@10.23.0` in setup-deps and README (corepack is no longer distributed with Node >= 25, which the `>= 22` floor permits; `desktop/setup-local-env.sh:192-196` already has this pattern). | S |",
    "reason": "3.2-29 recommendation needs-change"
  },
  {
    "section": "3.2 Install",
    "find": "| `doctor --fix` re-runs the fetcher; end-user wording; consider bundling the binary in the release artifact. | S |",
    "replace_with": "| End-user wording naming the version and URL that 404'd; doctor must stay at warn (error blocks the update gate); bundling presupposes an app release artifact that does not exist yet. | S |",
    "reason": "1-05 recommendation needs-change"
  },
  {
    "section": "3.2 Install",
    "find": "| `<stateDir>/run/orchestrator.sock`. | S |",
    "replace_with": "| `<stateDir>/run/orchestrator.sock` (the orchestrator already accepts `--ipc-path`; only `orchestrator-bridge.ts:196` and `docs/tools/computer-use.md:118,147` change; post-bind access is already limited by the C7 0600 chmod, so rate low; the bigger gap is Windows falling back to unauthenticated TCP 19002, `ipc.rs:254-259`). | S |",
    "reason": "3.2-30 recommendation needs-change"
  },
  {
    "section": "3.2 Install",
    "find": "`src/wizard/onboarding.p2p.ts:119` |",
    "replace_with": "`src/wizard/onboarding.p2p.ts:118-123` (+ `README.md:431`, `doctor-p2p.ts:160`, `orchestrator-binary.ts:105`) |",
    "reason": "3.2-07 partial"
  },
  {
    "section": "3.2 Install",
    "find": "| Tell the truth: the prebuilt for v<X> could not be downloaded; offer to re-run the fetcher. | S |",
    "replace_with": "| Tell the truth at all four sites: the prebuilt for v<Cargo version> could not be downloaded from <URL>; offer `node scripts/fetch-orchestrator.mjs` (cheaper than a full `pnpm install`) or a cargo build. The advice becomes correct again once 0.2.3 is published. | S |",
    "reason": "3.2-07 recommendation needs-change"
  },
  {
    "section": "3.2 Install",
    "find": "| Embeddings and web-search key prompts forced in QuickStart even when the LLM key covers them. | Auto-reuse OpenAI/Gemini key; web search as a post-install UI nudge. | S |",
    "replace_with": "| Embeddings prompt forced in QuickStart only for providers other than OpenAI/Gemini (`detectExistingKey` already auto-configures from env and the OpenAI auth path exports the key); web search has no LLM key to reuse and is always forced. | Key reuse is already done for OpenAI/Gemini; web search as a post-install UI nudge. | S |",
    "reason": "3.2-27 partial: reuse exists"
  },
  {
    "section": "3.2 Install",
    "find": "| `os.homedir()` instead of `resolveStateDir()` for checkpoints DB and orchestrator binary. | Route through `resolveStateDir()`. | S |",
    "replace_with": "| `os.homedir()` instead of `resolveStateDir()` for the checkpoints DB (honors `BITTERBOT_CHECKPOINT_DB`; duplicated in `checkpoints-cli.ts:26`; writer is opt-in) and the orchestrator binary (mirrors the postinstall fetcher's install dir, which has no profile context). | Route the checkpoints default through `resolveStateDir()` in both files; leave the orchestrator binary cache on homedir (or move writer and reader together), else `--profile` users lose the binary. | S |",
    "reason": "6.11-6.12-11 partial and recommendation needs-change"
  },
  {
    "section": "3.3 Configuration",
    "find": "`configure.commands.ts:27-33` exits 1 with \"Invalid --section\";",
    "replace_with": "`configure.commands.ts:27-33` exits 1 with \"Invalid --section\" only when an invalid name is mixed with a valid one; `--section wallet` alone hits the `sections.length === 0` early-return at :23-26 and silently opens the full configure wizard (which has no wallet step);",
    "reason": "3.3-02 partial"
  },
  {
    "section": "3.3 Configuration",
    "find": "Also `onboarding.embeddings.ts:158` says `--section memory` (invalid)",
    "replace_with": "Also `src/wizard/onboarding.embeddings.ts:158` says `--section memory` (invalid; same silent fall-through)",
    "reason": "3.3-04 partial: path"
  },
  {
    "section": "3.3 Configuration",
    "find": "Add `wallet` and `memory` sections wired to `setupWalletForOnboarding` / embeddings step, or rewrite all 12 strings; fix `configure.md:32`;",
    "replace_with": "Add `wallet` and `memory` sections (both step functions take an onboarding `flow` argument; add them to `opts.sections` and `CONFIGURE_SECTION_OPTIONS` too) or repoint all 12 strings at `bitterbot onboard`; move the invalid-section check above the empty early-return; fix `configure.md:32`;",
    "reason": "3.3-01/3.3-02 recommendation needs-change"
  },
  {
    "section": "3.3 Configuration",
    "find": "16 sub-objects in `types.memory.ts:33-141` never validated;",
    "replace_with": "15 sub-objects (17 keys) in `types.memory.ts:33-141` never validated;",
    "reason": "3.3-07 partial: count"
  },
  {
    "section": "3.3 Configuration",
    "find": "read sites disagree (`curiosity-tool.ts:27` `!enabled` vs `doctor-memory-system.ts:525` `!== false`).",
    "replace_with": "read sites disagree (`src/agents/tools/curiosity-tool.ts:27` `!enabled`, so the curiosity_state/curiosity_resolve tools are default-OFF and wired-but-dead, vs `doctor-memory-system.ts:525` and `manager.ts:6179` `!== false`, default ON; same bug PLAN-40 F18 fixed for the dream tool).",
    "reason": "3.3-09 partial"
  },
  {
    "section": "3.3 Configuration",
    "find": "grep live configs first (comment mentions `requestFrequency`, not in types); tests for rejection. | M |",
    "replace_with": "grep live configs first (the operator config sets only `memory.dream.modes`; `requestFrequency` is real, `memory.curiosity.requestFrequency` in `curiosity-types.ts:135`, read at `manager.ts:3190`, the zod comment only misplaces its nesting); fix `curiosity-tool.ts:27` to `=== false` independently of the schema work; the strict mirror must cover the five imported sub-types (CuriosityConfig, EmotionalConfig, DreamEngineConfig, GCCRFConfig, RLMConfig); tests for rejection. | M |",
    "reason": "3.3-07/3.3-09/3.3-10 recommendation needs-change"
  },
  {
    "section": "3.3 Configuration",
    "find": "`desktop/renderer/src/components/config/ConfigView.tsx:6-64,99-118`",
    "replace_with": "`desktop/renderer/src/components/config/ConfigView.tsx:6-64,66-118` (write at :159)",
    "reason": "3.3-11 partial anchors"
  },
  {
    "section": "3.3 Configuration",
    "find": "Four views tell users to hand-edit keys (`CirclesView.tsx:84`, `WalletView.tsx:271`, `CircleCanvas.tsx:228`, `P2pDashboard.tsx:91`).",
    "replace_with": "Three views instruct hand-edits (`circles/CirclesView.tsx:84`, `wallet/WalletView.tsx:271` plus :421 \"enable in config\", `p2p/P2pDashboard.tsx:91`); `circles/CircleCanvas.tsx:228` only names the key in a status note. The renderer never even requests `config.schema` (the config-store slot is declared but never populated).",
    "reason": "3.3-14 partial; 6.3-6.4-16 partial"
  },
  {
    "section": "3.3 Configuration",
    "find": "update policy via `config.patch` (restart-aware); raw JSON under \"Advanced\"; replace the 4 hand-edit strings with toggles; fix or delete `control-ui.md`. | M |",
    "replace_with": "update policy via `config.patch` only for keys without a typed RPC (wallet already has `wallet.setConfig`; trust/agentDrafts/models/channels have their own); surface the restart consequence per toggle (`p2p.*`/`gateway.*` restart, `circles.*`/`tools.*` hot per `config-reload.ts`); raw JSON under \"Advanced\" (already exists with the baseHash guard); replace the 3 hand-edit strings (+WalletView:421) with toggles; fix rather than delete `control-ui.md` (its Tailscale/basePath sections are the only docs for those knobs) and `docs/web/index.md:11`. | M |",
    "reason": "3.3-11/3.3-14/3.3-15/6.3-6.4-16 recommendation needs-change"
  },
  {
    "section": "3.3 Configuration",
    "find": "| Add \"Memory & biology\" and \"Network\" sections; fix GROUP_LABELS; generate a keys appendix from the schema. | M |",
    "replace_with": "| Extend the existing `## P2P Network` section (line 2115) with a2a/circles/forage/commerce; add a Memory section cross-linking docs/memory/*; fix GROUP_LABELS (also missing forage, commerce, auth, web, media, approvals, broadcast, canvasHost; note nothing in the renderer reads hints today, so this is a no-op until ConfigFormView consumes them); generate the keys appendix via the existing `config.schema` builder (the label/help tables are empty for these groups, so output is key names only until filled). Do not \"hide\" default-ON subsystems from the reference. | M |",
    "reason": "3.3-17/3.3-18 recommendation needs-change"
  },
  {
    "section": "3.3 Configuration",
    "find": "`docs/plans/PLAN-37-SECRET-CONSOLIDATION.md:38` | 37 on-disk secret locations, 263 distinct `process.env.*` keys (113 `BITTERBOT_*`), 35 `writeConfigFile` sites, wizard still writes `.env` files; only one PLAN-37 commit landed. | Land Phase 0-1 only: read-only auth loader, stop wizard writing `.env`, `bitterbot doctor auth` as the \"which key wins\" tool. | L |",
    "replace_with": "`docs/plans/PLAN-37-SECRET-CONSOLIDATION.md:34-40` (gitignored, local only) | PLAN-37 counts 37 on-disk locations and ~41 env vars + ~26 secret config fields; the audit's own counts are 263 distinct `process.env.*` keys in src incl. tests (112 `BITTERBOT_*`; 184/80 excluding tests), 63 `writeConfigFile` sites in 35 files; the wizard writes `desktop/.env` at two sites (`control-ui-env.ts:99`, `p2p.ts:257`); no PLAN-37 phase has landed (dd57ae8 references PLAN-37 H2 and ships the `winningSource` resolver the plan's Phase 0 calls for). | Land Phase 0 only: read-only loader + `bitterbot doctor auth` wrapping the existing `models.auth.list` winningSource resolver; \"stop wizard writing .env\" is Phase 2 and must ship with the `VITE_GATEWAY_TOKEN` define removal; commit the plan doc. | M |",
    "reason": "3.3-19/3.3-20 partial and recommendation needs-change"
  },
  {
    "section": "3.3 Configuration",
    "find": "`src/memory/dream-types.ts:278`, `manager.ts:2613,3104` | Dream model hard-coded `openai/gpt-4o-mini` regardless of provider; first cycle at +5 min (`manager.ts:2800`); Anthropic-only installs log `dream cycle failed` forever; OpenAI-keyed installs start spending within 5 minutes. | Default to the resolved primary model (or cheap sibling via alias table); skip first cycle on an empty DB; log once which model dreams use; expose in Models view. | S |",
    "replace_with": "`src/memory/dream-types.ts:278-279`, `manager.ts:2613,3104,3331,6169` | Dream/predictor/discovery model hard-coded `openai/gpt-4o-mini` in 5 sites unless `memory.dream.model` is set (documented, accepted); first cycle at +5 min (`manager.ts:2800`); Anthropic-only installs do NOT log `dream cycle failed`: the LLM modes fail silently at debug level and the cycle completes with `llmCalls:0` (observed 2026-08-21 17:39Z), i.e. silent loss of dream synthesis; OpenAI-keyed installs start spending within 5 minutes. | Reuse the key-aware chooser already in `manager.ts:1568-1577` (Haiku with an Anthropic key, 4o-mini with OpenAI, else disable LLM modes with one info log) rather than the primary model (Opus at up to 8 calls per cycle); centralize the 5 fallback sites; the empty-DB skip already exists (`minChunksForDream`, `dream-engine.ts:798`); surface LLM-mode failures at warn; Models-view exposure is P1. | S |",
    "reason": "3.3-21 partial and recommendation needs-change"
  },
  {
    "section": "3.3 Configuration",
    "find": "| `ADVANCED_PATHS` prefix list covering those plus all `memory.*` except enabled/dream.model/dream.intervalMinutes. | S |",
    "replace_with": "| `ADVANCED_PATHS` prefix list covering those plus all `memory.*` except enabled/dream.model/dream.intervalMinutes; only useful once ConfigFormView consumes uiHints (it ignores them and renders whatever keys are in the file). | S |",
    "reason": "3.3-22 recommendation needs-change"
  },
  {
    "section": "3.3 Configuration",
    "find": "~1,300 lines migrating top-level whatsapp/telegram/routing/agent/identity/msteams keys from the initial commit; runs on every load; two e2e tests exist only to exercise it. | Delete (keep a one-line `gateway.token -> gateway.auth.token` rule if fleet nodes need it). | M |",
    "replace_with": "~1,160 lines (~1,360 with helpers) migrating top-level whatsapp/telegram/routing/agent/identity/msteams keys from the initial commit; only detection runs on load (`io.ts:753`) and `validation.ts:93` rejects the config; migrations run from `doctor` (`doctor-config-flow.ts:431`) and the config-restore RPC (`config.ts:344`); at least five test files exercise it. | Delete together with the rules/`validation.ts:93` check, the two detection e2e tests, `doctor-legacy-config.e2e.test.ts`, the two `doctor.migrates-*` tests and the doctor harness mock, or the gateway keeps hard-rejecting legacy keys with no repair path; the `gateway.token` rule is a warning today, not a rewrite. Low V1 value, non-trivial blast radius: defer. | M |",
    "reason": "3.3-23 partial and recommendation needs-change"
  },
  {
    "section": "3.3 Configuration",
    "find": "in-memory overrides; 114 scattered `?? true`/`!== false` defaults. | Single `DEFAULTS` table with a test that every zod `enabled` flag has an entry; `bitterbot config explain <path>`. | L |",
    "replace_with": "in-memory overrides; ~279 scattered `?? true`/`!== false` defaults (106 of them on `enabled` keys). | `DEFAULTS` table scoped to the ~106 `enabled` flags with a test that every zod `enabled` flag has an entry; model `bitterbot config explain <path>` on the existing `sandbox explain`; the secret-store half is PLAN-37. | L |",
    "reason": "3.3-24 partial and recommendation needs-change"
  },
  {
    "section": "3.3 Configuration",
    "find": "| Four bitterbot.ai services contacted by default (mailbox, p2p DNS + relays, onramp, update check + live model discovery). | Document outbound endpoints; `network.offline`/\"Local only\" wizard choice that flips p2p/circles/checkOnStart/liveDiscovery together. | M |",
    "replace_with": "| Two bitterbot.ai services contacted by default (mailbox.bitterbot.ai once a real circle exists, p2p.bitterbot.ai DNS + 3 hardcoded relay IPs); onramp.bitterbot.ai only on a user-triggered `wallet.stripeOnramp` RPC; the update check hits registry.npmjs.org and live model discovery hits each provider's own API. | Document the real outbound list; a \"Local only\" wizard preset over the existing flags (no new `network.offline` key). | M |",
    "reason": "3.3-25 partial and recommendation needs-change"
  },
  {
    "section": "3.3 Configuration",
    "find": "lists 7 `BITTERBOT_*` vars while src reads 113.",
    "replace_with": "lists 9 `BITTERBOT_*` vars (1 active, 8 commented) while non-test src reads 113.",
    "reason": "3.3-25 partial"
  },
  {
    "section": "3.3 Configuration",
    "find": "| 40+ skills-economy keys (skillSeekers trending, marketability predictor, agentskills royaltyBps, marketplace pricing, gatewayFeePercent) first-class for a loop the audit found dead. | Defaults OFF; mark advanced; out of docs until Tier 2 fixes land. | S |",
    "replace_with": "| ~48-58 economy keys when a2a.mesh/marketplace are counted (8 of the `skills.p2p` keys are PLAN-13 security keys); skillSeekers and `enableMarketplaceDemand` are a working, documented external-ingestion path, not the dead reputation/revenue chain (F7/F10/F11/F14 open; F5 fixed). | OFF/advanced only for the genuinely dead keys (`royaltyBps`, already documented inert; marketplace pricing; `gatewayFeePercent`); decide skillSeekers separately. | S |",
    "reason": "3.3-25 partial and recommendation needs-change"
  },
  {
    "section": "3.4 UI cleanup",
    "find": "headings \"Review queue, rate lane outputs (D1 pilot)\", \"Closed-loop cognition (PLAN-34)\", \"Canonical memory ledger (PLAN-33)\", cortisol x9, dopamine x9, GCCRF x7; `server-http.ts:514-533` waives auth only on loopback so LAN users get an auth error inside the iframe.",
    "replace_with": "headings \"Review queue, rate lane outputs (D1 pilot)\" (:123, a dead PLAN-40 Lane 2 card), \"Closed-loop cognition (PLAN-34)\" (:167), \"Canonical memory ledger (PLAN-33)\" (:170), plus visible \"lanes land with PLAN-40 Phases 1-3\" (:574) and \"GCCRF Components\"/\"GCCRF not initialized yet\" (:155,:709); cortisol/dopamine x9 are case-insensitive counts, mostly JS property reads, rendered only as \"Energy (Dopamine)\"/\"Focus (Cortisol)\"; `server-http.ts:514-533` waives auth only on loopback, so the iframe gets a 401 only when `gateway.bind` is non-loopback AND auth is configured AND the UI is opened off-loopback (the default install is unaffected).",
    "reason": "3.4-03 partial; 3.4-04 scope"
  },
  {
    "section": "3.4 UI cleanup",
    "find": "Native React summary (last dream, next scheduled, utility KPI) + Status/Utility/History; Analytics/Emotional/Curiosity/Retrieval/Live behind Advanced; remove Earnings/Forage; drop \"(beta)\"; strip PLAN/D1 labels from any customer-facing page. | M |",
    "replace_with": "Cheapest V1-safe move: relabel/gate the nav entry and strip the PLAN/D1 strings incl. :574 (PLAN-39 plans to keep the iframe same-origin, which also fixes the off-loopback auth; a native rewrite re-implements ~15 RPCs); if rewritten: Status/Utility/History native, Analytics/Emotional/Curiosity/Retrieval/Live behind Advanced; gate Earnings/Forage on their backend flags rather than deleting (the renderer has no other Forage surface and PLAN-29 is live; `forage.test.ts` covers the tab); drop \"(beta)\". | M |",
    "reason": "3.4-01/3.4-02/3.4-03/3.4-04 recommendation needs-change"
  },
  {
    "section": "3.4 UI cleanup",
    "find": "`Sidebar.tsx:57-82,306,524-585` | 12 visible nav items (13 on management nodes) + wallet panel + conversations + 4 social links + version footer; target <= 8. | Chat, Channels, Agents (Agents/Skills/Schedules), Overview, Settings, Advanced group; About dialog for social links. | M |",
    "replace_with": "`Sidebar.tsx:56-83,301,552-616` | 11 visible nav items (12 on management nodes; NAV_ITEMS has 12 entries incl. the gated one) + wallet panel + conversations + 4 social links + version footer; target <= 8. `react-router-dom` is declared unused in `desktop/package.json:52`. | Chat (new item; today it is the default tab via the session list), Channels, Agents (Agents/Skills/Schedules), Overview, Settings, Advanced group (keep the Circles attention badge visible if Circles moves there); About dialog for social links. | M |",
    "reason": "6.1-6.2-01 partial; 2.1-2.2-01 recommendation needs-change"
  },
  {
    "section": "3.4 UI cleanup",
    "find": "\"Restart the gateway to load PLAN-20\" (only user-facing PLAN reference in the renderer),",
    "replace_with": "\"Restart the gateway to load PLAN-20\" (lines 91 and 97: the only two user-facing PLAN strings in the renderer),",
    "reason": "3.4-06 partial"
  },
  {
    "section": "3.4 UI cleanup",
    "find": "| Rewrite copy; map raw errors; add an `advanced` NavItem flag and move under it or fold into Skills as a tab. | S |",
    "replace_with": "| Rewrite copy (keep the fact that \"Promote\" does not make a rule live until a TS implementation exists); map raw errors at :98, :258 and :311; generalize the hardcoded `requireFeature === \"management\"` check into a feature lookup rather than adding a second ad-hoc `advanced` boolean, and move under it or fold into Skills as a tab. | S |",
    "reason": "3.4-07/3.4-08 recommendation needs-change"
  },
  {
    "section": "3.4 UI cleanup",
    "find": "8 of 22 TabIds (instances, sessions, usage, nodes, projects, workspace, debug, logs; 2,835 LOC) unreachable: no nav entry, no caller, no hash routing, not persisted; never in nav in git history.",
    "replace_with": "10 of 22 TabIds have no nav entry; chat and wallet have `setActiveTab` callers (session list, wallet panel), the other 8 (instances, sessions, usage, nodes, projects, workspace, debug, logs; 2,835 LOC = all .tsx under their dirs, 1,920 for the 8 View files) are unreachable: no caller, no hash routing, not persisted; never in nav in git history.",
    "reason": "2.1-2.2-23/3.4-11/3.4-25 partial"
  },
  {
    "section": "3.4 UI cleanup",
    "find": "Projects backend works, only the UI is unmounted;",
    "replace_with": "Projects backend is registered and wired into chat.send -> project RAG (not runtime-tested); `setActiveProjectId` has exactly one caller, inside the never-imported ProjectSwitcher;",
    "reason": "6.1-6.2-04 partial"
  },
  {
    "section": "3.4 UI cleanup",
    "find": "Delete Debug, Instances, Projects UI (ProjectsView, ProjectSwitcher, projects-store, ChatInput projectId spread); re-home Logs/Sessions/Usage/Nodes/Workspace under Advanced; derive VIEW_MAP and NAV_ITEMS from one list. | S + M |",
    "replace_with": "Delete Debug (or gate it behind the same Advanced toggle; it is a working RPC console) and Instances; decide Projects as a whole feature (deleting the UI while keeping `projects.*`, `project-rag.ts` and `src/agents/projects.ts` recreates the wired-but-dead pattern; wiring is a nav entry + mounting ProjectSwitcher in ChatInput); drop or justify Sessions (it duplicates the Conversations list's `sessions.*` calls); re-home Logs/Usage/Nodes/Workspace under Advanced (note these are being exposed for the first time, not re-homed); make one nav list the source of `TabId` (VIEW_MAP is already `Record<TabId,...>`, so only the TabId -> nav direction is unguarded). | S + M |",
    "reason": "2.1-2.2-23/2.1-2.2-26/3.4-25 recommendation needs-change"
  },
  {
    "section": "3.4 UI cleanup",
    "find": "| Cards \"Skills Published\", \"Skills Received\", \"Contribution Score\", \"Skills Verified\" for an economy the audit found structurally dead (F7 EigenTrust write-only, F10, F11, F14 deferred). | Advanced; reduce to connection/peers/peer ID/NAT. | S |",
    "replace_with": "| Cards \"Connected Peers\", \"Skills Published\", \"Skills Received\", \"Contribution Score\" (:103-118) plus a \"Skills Verified\" detail row (:190); Contribution Score is `skills_published*10 + uptime_hours*0.1` from `orchestrator/src/swarm/http.rs:239`, unrelated to EigenTrust/F7; \"Skills Verified\" has no producer in TS or Rust and always reads 0. | No Advanced nav group exists (use the \"(beta)\" label convention or add one); drop \"Skills Verified\" outright; drop or relabel \"Contribution Score\" as an activity score; keep Connected Peers/uptime (real orchestrator stats); reduce the rest to connection/peers/peer ID/NAT. | S |",
    "reason": "3.4-16 partial and recommendation needs-change"
  },
  {
    "section": "3.4 UI cleanup",
    "find": "| Trust settings, Incoming quarantine, \"Sign and broadcast over P2P\", \"POST to agentskills.io\" exposed to every user. | Behind an Advanced disclosure or only when `p2p.enabled` and peers > 0. | S |",
    "replace_with": "| Trust settings, Incoming quarantine, \"Sign and broadcast over P2P\", \"POST to agentskills.io\" exposed to every user; but Incoming and Trust settings also serve the agentskills.io registry path, only \"Publish to P2P\" and the p2p trust rows are P2P-specific, and the server already rejects publish when p2p is off (`skills.ts:848`). | Gate only \"Publish to P2P\" (and the p2p trust rows) on p2p-store `enabled` + `connected_peers > 0`; keep Incoming and agentskills import/upload visible (gate upload on `skills.agentskills.enabled`); put Trust settings under an Advanced disclosure. | S |",
    "reason": "3.4-17 partial and recommendation needs-change"
  },
  {
    "section": "3.4 UI cleanup",
    "find": "| Hide when endpoint probe fails, or implement via packaged launcher. Moot after D5. | M |",
    "replace_with": "| Gate the button on `import.meta.env.DEV` (one line) rather than a probe; the fallback message is deliberate and tested, and the Vite dev UI is the only shipped surface today so impact is nil. Moot after D5. | S |",
    "reason": "3.4-19 recommendation needs-change"
  },
  {
    "section": "3.4 UI cleanup",
    "find": "`wallet/WalletSidebarPanel.tsx:137,178-183`, `Sidebar.tsx:306` | Fabricated green `USDC $0.00` + MAINNET/TESTNET pill on error or empty balances; mounted for every user. | Hide unless `wallet.getAddress` succeeds; muted \"Set up wallet\" link otherwise. | S |",
    "replace_with": "`wallet/WalletSidebarPanel.tsx:137,178-183`, `Sidebar.tsx:301` | Fabricated green `USDC $0.00` on error or empty balances (the MAINNET/TESTNET pill only appears after a prior successful `wallet.getAddress`); mounted for every user; the panel is the only route to WalletView, which holds the CDP setup instructions. | Hide unless `wallet.getConfig().enabled` (cheaper; WalletView already calls it) / `wallet.getAddress` succeeds, and pair the hide with a nav entry or \"Set up wallet\" link so WalletView stays reachable. | S |",
    "reason": "3.4-20 partial; 6.5-6.6-18 recommendation needs-change"
  },
  {
    "section": "3.4 UI cleanup",
    "find": "| Aubaine group-buy (default OFF, never run) published in the docs tree next to user guides. | \"Experimental protocols\" group or out of docs.json. | S |",
    "replace_with": "| Aubaine group-buy (default OFF, no runtime state on this node) docs are tracked but NOT in docs.json nav: orphan pages, URL-reachable only on Mintlify; the page itself says \"off by default\". | Already out of nav; either leave orphaned, move out of `docs/`, or add an Experiments group (which increases exposure). | S |",
    "reason": "3.4-21 partial, recommendation already-done"
  },
  {
    "section": "3.4 UI cleanup",
    "find": "`src/config/types.skill-seekers.ts:10`, `dream-engine.ts:252` | Skill Seekers trending sweep ON; produced 268-item unreviewed quarantine backlog; 183 egress-log rows. | Default OFF; opt-in under Skills settings. | S |",
    "replace_with": "`src/memory/manager.ts:3131-3137` (a 24 h memory-manager timer, not the dream engine; `types.skill-seekers.ts:40` and the function's own docblock still say opt-in) | Skill Seekers trending sweep ON by code; the 268-item backlog and 183 egress rows are the 2026-08-10 review's figures; today 20 quarantine entries (the 30-day TTL sweeper prunes them) and 240 `research_egress_log` rows (GitHub fetches, attribution to the sweep unproven). | Default OFF via `enabled !== true` at `manager.ts:3135` plus fixing the stale comments; the argument is unsolicited GitHub egress on a fresh install, not disk growth. | S |",
    "reason": "3.4-22 partial and recommendation needs-change"
  },
  {
    "section": "3.4 UI cleanup",
    "find": "| PLAN-16/17/22 task spine runs unconditionally; no `tasks.enabled`; plan docs say \"Draft\"; audit coverage gap #9. | Add `agents.defaults.tasks.enabled`; update plan status; schedule audit. | S |",
    "replace_with": "| PLAN-16/17/22 task spine is registered unconditionally (`server.impl.ts:281`); no config key, but documented and tested env kill switches exist (`BITTERBOT_TASKS_AUTO_INITIATE=0`, `BITTERBOT_TASKS_COMPLEXITY_GATE=0`, plus HORMONAL_GATE/NUDGE/COMPLETION_NOTIFY, `docs/automation/long-horizon-tasks.md:288-289`); plan docs say \"Draft\"; audit coverage gap #9. | Document the env flags; if `agents.defaults.tasks.enabled` is added, feed the existing `isAutoInitiateEnabled`/`isComplexityGateEnabled` seams; update plan status; schedule audit. | S |",
    "reason": "3.4-23 partial and recommendation needs-change"
  },
  {
    "section": "3.4 UI cleanup",
    "find": "| Toggles/links to Settings; friendlier invite-code label. | S |",
    "replace_with": "| A link for the sandbox note (no `circles.sandbox.set` RPC exists; a toggle is new gateway work); soften the agentDrafts fallback string (a toggle already exists via `circles.agentDrafts.set`, the string only shows on version skew); keep the accurate `bbc1.` placeholder and add a visible label. | S |",
    "reason": "3.4-24 recommendation needs-change"
  },
  {
    "section": "3.5 UI polish",
    "find": "CircleChat already replaced them; no eslint `no-alert`. | Replace all 28 (toast.error on errors; AlertDialog or CircleChat local-state pattern for confirms; Select for the thinking-level prompt); add `no-restricted-globals` rule. | M |",
    "replace_with": "CircleChat already replaced them; no linter reaches the renderer at all (the repo has no eslint; oxlint, the only linter, lists `desktop/` in `ignorePatterns`). | Replace all 28 (toast.error on errors; pick one house pattern: AlertDialog or the CircleChat inline-state confirm; Select for the thinking-level prompt); add oxlint `eslint/no-alert` after un-ignoring desktop/renderer, or a grep check in `desktop/scripts/` which already runs under `pnpm lint`. | M |",
    "reason": "3.5-01/3.5-03 recommendation needs-change"
  },
  {
    "section": "3.5 UI polish",
    "find": "131 `text-green/red/yellow-400` without `dark:` pairs; 50 `text-purple-300`; 216 `zinc-*`/`text-white` literals; 43 `dark:` variants app-wide; theme toggle prominent. | Ship dark-only for V1 and hide the toggle, or do a light-mode pass. Recommend dark-only. | M |",
    "replace_with": "79 `text-green/red/yellow-400` without `dark:` pairs; 50 `text-purple-300`; ~340 `zinc-*`/`text-white` literals (88 in the unreachable workspace/ views); 66 `dark:` variants on 44 lines in 20 files; the theme toggle is a small footer icon; a complete light token set exists in globals.css:114-176, so light mode is broken by literals, not unsupported. | Ship dark-only for V1: hide the toggle AND force the store default (`ui-store.ts:49-55` restores a persisted `light`, leaving users who once toggled stuck); tokenization is the P1 follow-up. | S |",
    "reason": "3.5-05 partial; 3.5-04 recommendation needs-change"
  },
  {
    "section": "3.5 UI polish",
    "find": "`overview/OverviewView.tsx:166-172,137-152,94,115` | Channel status ternary collapses every truthy value to `\"configured\"`; `ChannelCard` colors green only for `connected`/`running`, so the green pill never shows; card prints Config/State Dir paths in mono; subtitle \"Gateway dashboard\". | Pass the real status (mirror `ChannelsView.tsx:99-105`); paths under Details; rename subtitle. | S |",
    "replace_with": "`overview/OverviewView.tsx:166-172,35-50,137-152,94` | Channel status ternary collapses every truthy value to `\"configured\"`; `ChannelCard` (:35-50) colors green only for `connected`/`running`, so the green pill never shows; Overview reads `health.channels` (`ChannelHealthSummary`: configured/linked/running), not the `channels.status` accounts payload ChannelsView uses, so the `.status` branch is dead; card prints Config/State Dir paths in mono (:137-152); subtitle \"Gateway dashboard\" (:94). | Derive status from the health keys that exist (`running || connected || linked` -> connected, `configured` -> configured) or switch Overview to `channels.status`; ChannelsView's mapping cannot be copied literally; paths under a collapsible Details; rename subtitle. | S |",
    "reason": "3.5-06/3.5-07 partial and recommendation needs-change"
  },
  {
    "section": "3.5 UI polish",
    "find": "| 3-step card; `bitterbot dashboard` one-time token handoff so FirstRun is rarely seen; drop `desktop/.env`/pnpm mentions. | M |",
    "replace_with": "| 3-step card; drop `desktop/.env`/pnpm mentions; the `bitterbot dashboard` handoff is half-built: the CLI already emits `#token=` in the URL (`dashboard.ts:36-39`) but the renderer never reads `location.hash` and 19001 serves no UI, so the missing piece is renderer-side intake after PLAN-39 (PLAN-37 D4 already records: token paste now, fragment handoff later). | M |",
    "reason": "3.5-08/6.7-6.8-13 recommendation needs-change"
  },
  {
    "section": "3.5 UI polish",
    "find": "144 `purple-NNN` literals, 32 hex literals, cyan `#00D4E6` in 13 headings, refresh-button recipe copy-pasted in 6 views; `ui/button` used in 7 files vs 68 hand-rolled `<button>`. | Section-heading token; `ui/button` variant; lint regex rejecting `#[0-9a-f]{6}` and `purple-\\d{3}` outside `components/ui`. | M |",
    "replace_with": "247 `purple-NNN` literals on 144 lines (38 files), 36 hex literals on 32 lines, cyan `#00D4E6` in 13 headings (no token exists for it), refresh/spin recipe in 4-6 files; `ui/button` imported by 7 files (only 3 app views) vs 248 raw `<button>` in 68 files. | Section-heading token (add a cyan token; map purples onto the existing 13 `--bb-purple-*` tokens); `ui/button` variant; implement the `#[0-9a-f]{6}` / `purple-\\d{3}` check as an extension of `desktop/scripts/check-px-text.mjs` (oxlint ignores `desktop/`, so it cannot be a lint rule as written). | M |",
    "reason": "3.5-09 partial and recommendation needs-change"
  },
  {
    "section": "3.5 UI polish",
    "find": "`layout/UpdateBanner.tsx:114-125`, `UpdateCard.tsx:41,132,144` | \"This node is N commits behind the latest code. Out-of-date nodes drift from the fleet.\" \"Node Version\". | \"A new version of Bitterbot is available\" + \"Update now\"; commit count in a detail line. | S |",
    "replace_with": "`layout/UpdateBanner.tsx:111-121`, `UpdateCard.tsx:132,144,172,176` | The banner is already branched: \"A newer release is available (vX)\" for package installs, \"This node is N commits behind the latest code.\" for git installs, with an unconditional \"Out-of-date nodes drift from the fleet.\" suffix; \"Node Version\" at :132/:144 (`UpdateCard.tsx:41` is an unrelated reason string). | \"A new version of Bitterbot is available\" + \"Update now\" is honest only once D2 tags exist (git installs keep a constant version string); until then an honest git-mode variant (\"An update is available\") with the commit count in a detail line; drop the fleet-drift suffix. | S |",
    "reason": "3.5-10 partial and recommendation needs-change"
  },
  {
    "section": "3.5 UI polish",
    "find": "| \"your AI development assistant\"; \"BitterBot\" vs \"Bitterbot\". | One tagline consistent with README; one casing. | S |",
    "replace_with": "| \"your AI development assistant\" (README's tagline is \"A local-first personal AI with biological memory, a dream engine, and a P2P skills economy\"); both cited lines say \"BitterBot\"; the casing split is renderer-wide (18 `BitterBot` vs 16 `Bitterbot`) against README's consistent `Bitterbot`. | One tagline consistent with README; one casing (`Bitterbot`). | S |",
    "reason": "3.5-12 partial"
  },
  {
    "section": "3.5 UI polish",
    "find": "`Sidebar.tsx:66,76-79,85`, `CronView.tsx:106,116`, `ManagementView.tsx:37` | Labels \"Cron\", \"Active Guards\", \"P2P Network\", \"Dreams (beta)\", group \"CONTROL PANEL\"; cron placeholders assume cron syntax;",
    "replace_with": "`Sidebar.tsx:66,77-79,86`, `CronView.tsx:72,92,106`, `ManagementView.tsx:37` | Labels \"Cron\", \"Active Guards\", \"P2P Network\", \"Dreams (beta)\", group \"CONTROL PANEL\"; the cron default (`\"0 9 * * *\"`), heading and placeholder assume cron syntax (`CronView.tsx:116` is the message-text placeholder) although `src/cron/types.ts` already has `every`/`at` schedule kinds the UI ignores;",
    "reason": "3.5-13 partial"
  },
  {
    "section": "3.5 UI polish",
    "find": "`AppShell.tsx:72`, `ToolCallPanel.tsx:214`, `Sidebar.tsx:242` | Fixed 256 px sidebar + fixed 550 px tool panel; one `@media` rule in all CSS (reduced motion); 36 responsive utilities across 156 files. | Declare min width 1024 with a friendly overlay; auto-collapse sidebar < 1280; tool panel as sheet < 1400. | M |",
    "replace_with": "`AppShell.tsx:72` (the 550 px tool-panel margin), `chat/ToolCallPanel.tsx:214`, `Sidebar.tsx:242` | 256 px sidebar when expanded (it already collapses to 48 px via `setSidebarCollapsed` and can be hidden) + fixed 550 px tool panel; one `@media` rule in all CSS (reduced motion); ~38-40 responsive utilities in 17 of 156 files (no breakpoint-driven layout, not \"no responsive layout\"). | No hard min-width overlay (PLAN-39 serves this UI to phones/tablets over tailnet; Tauri already sets `minWidth: 800`); auto-collapse the sidebar via a `matchMedia` listener on the existing `sidebarCollapsed` state; tool panel as sheet < 1400. | M |",
    "reason": "3.5-14 partial and recommendation needs-change"
  },
  {
    "section": "3.5 UI polish",
    "find": "`Sidebar.tsx:266,458`, `CronView.tsx:97-116` | 0 `focus-visible` outside `ui/`; 41 `aria-label` for 259 buttons; 7 `htmlFor` for 40 inputs; `focus:outline-none` without ring. | Adopt `ui/button`/`ui/input`/`ui/label`; aria-labels on icon buttons; jsx-a11y rules. | M |",
    "replace_with": "`AgentsView.tsx:73`, `ChatInput.tsx:116` (outline removed, no replacement); `Sidebar.tsx:266,458` (no focus styling at all); `CronView.tsx:97-120` (`focus:outline-none` with a `focus:border-purple-500` substitute) | 0 `focus-visible` outside `ui/`; 41 `aria-label` for 259 buttons; 7 `htmlFor` for ~39 inputs; 21 `focus:outline-none` sites, 2 without any replacement. | Adopt `ui/button`/`ui/input`/`ui/label`; aria-labels on icon buttons; enable oxlint's jsx-a11y plugin after removing `desktop/` from `.oxlintrc.json` ignorePatterns (there is no eslint). | M |",
    "reason": "3.5-15 partial and recommendation needs-change"
  },
  {
    "section": "3.5 UI polish",
    "find": "`ActiveGuardsView.tsx:98` + 25 `setError(err.message)` sites | Raw RPC/transport strings shown to users (\"unknown method\"); `DebugView.tsx:46` falls back to `JSON.stringify(err)`. | `describeError()` helper in `lib/`; raw text in a collapsible. | S |",
    "replace_with": "`ActiveGuardsView.tsx:98` + ~21 `set*Error(err instanceof Error ? err.message : ...)` sites (+8 store-level `error:` assignments; no literal `setError(err.message)` exists) | Raw RPC/transport strings shown to users (\"unknown method\"); `DebugView.tsx:46` falls back to `JSON.stringify(err, null, 2)`. | `describeError()` helper in `lib/` (none exists); raw text in a collapsible; exclude DebugView (verbatim output is its purpose). | S |",
    "reason": "3.5-16 partial"
  },
  {
    "section": "3.5 UI polish",
    "find": "`index.html:21,25-33` | Geist fonts from `cdn.jsdelivr.net`; CSP allows it; offline renders differently. | Vendor via the pinned `geist` npm package; CSP `'self'`. | S |",
    "replace_with": "`index.html:21,23-31` | Geist stylesheet URLs on `cdn.jsdelivr.net` (`geist@1/dist/fonts/geist-sans/style.css`) have returned 404 since they were added on 2026-03-28: the `geist` npm package ships only .woff2/.ttf and no CSS in any 1.x release, so the UI has always rendered in the `ui-sans-serif, system-ui` fallback, online or offline; the CSP allows a dead third-party host and `preconnect` beacons it on every load. | Vendor the two variable woff2 files (from `geist/dist/fonts` or `@fontsource/geist-sans`/`geist-mono`) with hand-written `@font-face` in globals.css; remove the preconnect and the two jsdelivr CSP entries; PLAN-39 §385-389 already lists this. Raise from inventory fact: the brand font is not shipping at all. | S |",
    "reason": "3.5-17 partial and recommendation needs-change"
  },
  {
    "section": "3.5 UI polish",
    "find": "Real issue: jargon-stacked intros with no gloss, hardcoded hex literals repo-wide.",
    "replace_with": "Real issue: jargon-stacked intros (Phenotype/Bond/Niche are glossed inline at :134-136; \"hormonal homeostasis\" and \"Crystal Pointers\" are not), hardcoded hex literals repo-wide (no cyan token exists; #00D4E6 is used by six components, so tokenize it, do not remove it).",
    "reason": "3.5-21 partial"
  },
  {
    "section": "3.5 UI polish",
    "find": "| Radio group with title + description. | S |",
    "replace_with": "| Plain-word option labels (the `Row` wrapper already renders a hint/description under each select); a radio group (`ui/radio-group.tsx` exists, unused) is optional. | S |",
    "reason": "3.5-22 recommendation needs-change"
  },
  {
    "section": "3.5 UI polish",
    "find": "| `wallet/WalletView.tsx:249` | \"Coinbase AgentKit wallet on Base L2\". | \"USDC wallet\"; chain in tooltip. | S |",
    "replace_with": "| `wallet/WalletView.tsx:249,333` | \"Coinbase AgentKit wallet on Base L2\" (twice). | \"Agent wallet (USDC on Base)\" (the panel also shows ETH); chain in tooltip. | S |",
    "reason": "6.1-6.2-20 partial"
  },
  {
    "section": "3.5 UI polish",
    "find": "| `p2p/P2pDashboard.tsx:89`, `CirclesView.tsx:81` | Disabled states give instructions with no action. | \"Enable and restart\" button or `setActiveTab(\"config\")`. | S |",
    "replace_with": "| `p2p/P2pDashboard.tsx:89`, `CirclesView.tsx:81` | Disabled states give instructions with no action; P2pDashboard:89 is a \"not connected\" state shown whether P2P is disabled OR the orchestrator crashed (so its advice can be wrong); CirclesView:81 is a true disabled state. | Circles: an Enable button must write config (`config.apply`/`config.patch`) AND call `system.restart` (the `circles` reload rule is kind none while startup is boot-gated); P2P: read `p2p.enabled` first and branch the copy (an enable write already triggers a restart via the hybrid reload plan, do not add a second). | S |",
    "reason": "3.5-23 partial and recommendation needs-change"
  },
  {
    "section": "3.5 UI polish",
    "find": "| Only per-session thinking/verbose controls live in an unreachable view. | Fold into chat header next to ModelPicker. | S |",
    "replace_with": "| Only the per-session thinking control (a `prompt()` at :84-95; line 161 is the patch RPC) lives in an unreachable view; no verbose control exists (`verboseLevel` is a dead type field). | Fold a thinking-level Select into the chat header next to ModelPicker, reusing its `sessions.patch` pattern. | S |",
    "reason": "3.5-23 partial"
  },
  {
    "section": "3.5 UI polish",
    "find": "`src/cli/cli-name.ts:5-6`, `hooks-cli.ts:441,452`, `banner.ts:48` | `(bitterbot|bitterbot)` duplicated regex token; emoji in hooks output; em-dash banner separator. | Collapse; drop emoji; `·`. | S |",
    "replace_with": "`src/cli/cli-name.ts:5-6`, `hooks-cli.ts:441,452`, `banner.ts:45,51` | `(bitterbot|bitterbot)` duplicated regex token (and the same duplicate in the Set at :5); `hook.emoji` is a documented hook metadata field rendered across hooks-cli (lines 115-348), not stray emoji; em-dash banner separator at :45 and :51. | Collapse regex and Set; decide the emoji field product-wide rather than per line; `·`. | S |",
    "reason": "3.5-24 partial and recommendation needs-change"
  },
  {
    "section": "3.6 Hygiene",
    "find": "4 `test:install:*`; `scripts/e2e/` does not exist); 12 target deleted `apps/` (`android:*`, `ios:*`, `format:swift`, `lint:swift`, `protocol:check`, `protocol:gen:swift`, `mac:package` via `package-mac-app.sh:9,126,143,204,208`); chain scripts `format:all`, `lint:all`, `test:all`, `test:docker:all` fail; `RELEASING.md:46-53`, `docs/reference/test.md`, `ci.md` list `release:check`/`test:install:smoke` as required; CI never runs any of them. | Delete ~32 scripts; trim chains; remove `.swiftformat`/`.swiftlint.yml`; update RELEASING/test/ci docs; CI one-liner asserting every `scripts/`/`apps/` path in package.json exists. | S |",
    "replace_with": "4 `test:install:*`; `scripts/e2e/` is the target of 5 of the `test:docker:*` scripts; all 16 were dangling in the initial commit, never functional here); 14 target `apps/`, which never existed in this repo (`android:*`, `ios:*`, `format:swift`, `lint:swift`, `protocol:check`, `protocol:gen:swift` via `protocol-gen-swift.ts:18`, `mac:package` via `package-mac-app.sh:9,126,143,204,208`, `mac:restart` via `restart-mac.sh:9-11,160-161`); chain scripts `format:all`, `lint:all`, `test:all` (fails only at its last link), `test:docker:all` fail; `docs/reference/RELEASING.md:46-53` lists `release:check`/`test:install:smoke` (smoke \"required\"), `ci.md:47` only as a local equivalent, `test.md:40,50` references the dead `scripts/e2e/onboard-docker.sh` and `test:docker:qr`; CI never runs any of them. | Delete 16 + 14 scripts (plus `mac:open`); delete `format:all`/`lint:all`/`test:docker:all` outright (trimmed they collapse to aliases or nothing), trim only `test:all`; remove `.swiftformat`/`.swiftlint.yml` and the swiftlint/swiftformat hooks plus the `scripts/e2e`/`Swabble/` excludes in `.pre-commit-config.yaml`; keep `scripts/bundle-a2ui.sh` (guarded, part of `pnpm build`); update RELEASING/test/ci docs and docs.json:1174,1654; CI one-liner asserting every `scripts/`/`apps/` path in package.json exists (also cover `.pre-commit-config.yaml`). | S |",
    "reason": "3.6-02/3.6-04 partial; 3.6-01/3.6-03 recommendation needs-change"
  },
  {
    "section": "3.6 Hygiene",
    "find": "| `benchmarks/longmemeval/.bench-runs-bio/adb4873b/store/benchmark.sqlite` | 56 MB tracked run artifacts: two SQLite DBs (32 + 22 MB) + 53 generated `.work-bio/*.md`; `.gitignore` has `*.db` but not `*.sqlite`. | `git rm --cached`; ignore `*.sqlite*`, `.bench-runs-*/`, `.work-*/`; consider history rewrite or moving benchmarks to its own repo. | S |",
    "replace_with": "| `benchmarks/longmemeval/.bench-runs-bio/{adb4873b,25e5f2fe}/store/benchmark.sqlite` | ~57 MB tracked run artifacts: two SQLite DBs (33 + 23 MB, in two run dirs) + 91 `.bench-runs-bio/*/workspace/memory/*.md` + 53 `.work-bio/*.md` (0.56 MB), swept in by the 7e0b58f lint commit; `.gitignore` has `*.db` (and `db.sqlite3`) but not `*.sqlite`. | `git rm -r --cached` both dirs; ignore `*.sqlite*`, `benchmarks/longmemeval/.bench-runs-*/`, `.work-*/` next to the existing `.work-contrastive/` rule at `.gitignore:234`; untracking does not shrink clones, a history rewrite is optional at 57 MB. | S |",
    "reason": "3.6-05 partial"
  },
  {
    "section": "3.6 Hygiene",
    "find": "| Only `pnpm test:fast` runs; it excludes `src/gateway/**` (95 test files) and `extensions/**` (12); renderer `vitest run` (20 files) never invoked. | Add gateway, extensions, and `--filter bitterbot-control-ui test` steps. | S |",
    "replace_with": "| Only `pnpm test:fast` runs; it excludes `src/gateway/**` (95 test files, 65 of them unit tests; 30 are live/e2e and excluded everywhere) and `extensions/**` (12); renderer `vitest run` (21 files incl. `desktop/gateway-launcher.test.ts`) never invoked. | Switch ci.yml:56 to `pnpm test` (`scripts/test-parallel.mjs` already orchestrates unit + extensions + gateway with Windows-CI sharding) and add `pnpm --filter bitterbot-control-ui test`; budget a first run against the 30-minute job timeout on three OSes. | S |",
    "reason": "3.6-07 partial and recommendation needs-change"
  },
  {
    "section": "3.6 Hygiene",
    "find": "| `.oxlintrc.json:24` | `ignorePatterns` excludes `desktop/`, `extensions/`, `skills/`, nonexistent `Swabble/`; the Control UI has no linter beyond three bespoke scripts. | Un-ignore desktop/extensions; add React/JSX plugin; drop `Swabble/`. | M |",
    "replace_with": "| `.oxlintrc.json:23-38` (`desktop/` :26, `extensions/` :29, `skills/` :33, `Swabble/` :36) | `ignorePatterns` excludes `desktop/`, `extensions/`, `skills/`, nonexistent `Swabble/` (since the initial commit); the Control UI has no linter beyond three bespoke scripts (CI does run its `tsc` typecheck). | Un-ignore desktop/extensions (type-aware lint needs `desktop/tsconfig.json` resolution; expect a large first-run error wave, phase categories in via `overrides`); add the `react` plugin (oxlint 1.47.0 ships it); drop `Swabble/`. | M |",
    "reason": "3.6-09 partial and recommendation needs-change"
  },
  {
    "section": "3.6 Hygiene",
    "find": "| `vendor/a2ui` (173 files, 3 vendored lockfiles) is dead: bundler needs `apps/shared/.../CanvasA2UI` so it always falls back to the committed 592 KB bundle; `.dockerignore:45-57` whitelists the missing path. | Restore sources or drop vendor/a2ui and freeze the bundle with a README note. | M |",
    "replace_with": "| `vendor/a2ui` (173 files, 4 vendored lockfiles, 2.7 MB, zero runtime consumers) is dead: bundler needs `apps/shared/.../CanvasA2UI`, which never existed in this repo, so it always falls back to the committed 604 KB bundle (last built 2026-04-12); `.dockerignore:48-56` whitelists the missing path; the bundle itself is live (`canvas-tool.ts` a2ui_push, `canvas-a2ui-copy.ts`). | \"Restore sources\" is impossible; drop vendor/a2ui, `bundle-a2ui.sh`, the `canvas:a2ui:bundle` prefix in `build`, `.bundle.hash` and `.dockerignore:48-56`; keep `a2ui.bundle.js` with a README stating how it was produced; fix `RELEASING.md:30`. | M |",
    "reason": "3.6-10 partial and recommendation needs-change"
  },
  {
    "section": "3.6 Hygiene",
    "find": "| 500-line cap exists, never run; 194 offenders, 26 > 1000 lines (`manager.ts` 6472, `dream-engine.ts` 4293). | Adopt desktop's 1000-cap + grandfather allowlist; wire into `pnpm lint`. | S |",
    "replace_with": "| 500-line cap exists (`pnpm check:loc`), never run by lint/CI/hooks; 195 non-test offenders (293 incl. tests and vendor, which the script does not skip), 26 > 1000 (46 incl. tests) (`manager.ts` 6472, `dream-engine.ts` 4293). | Run `check-ts-max-loc.ts --max 1000` with a grandfather allowlist seeded from the 26 files (copy the ALLOWLIST + slack pattern from `desktop/scripts/check-file-sizes.mjs`), skipping `*.test.ts` and vendor/, appended to `lint`; running the existing 500 cap unchanged fails on 293 files. | S |",
    "reason": "3.6-11 partial and recommendation needs-change"
  },
  {
    "section": "3.6 Hygiene",
    "find": "| No import outside benchmarks for `@anthropic-ai/claude-agent-sdk`, `@modelcontextprotocol/sdk`, `@larksuiteoapi/node-sdk`, `@mariozechner/pi-tui`, `signal-utils`; renderer `@radix-ui/react-navigation-menu`, `react-router-dom`. | Confirm with knip; remove / move to benchmarks package. | S |",
    "replace_with": "| No import outside benchmarks for `@anthropic-ai/claude-agent-sdk`, `@modelcontextprotocol/sdk`, `@larksuiteoapi/node-sdk`, `@mariozechner/pi-tui` (transitive via pi-coding-agent anyway); `signal-utils` IS imported by the vendored A2UI lit renderer compiled from root by `bundle-a2ui.sh`; renderer `@radix-ui/react-navigation-menu`, `react-router-dom` unused. | knip is not installed; remove `@larksuiteoapi/node-sdk` outright; drop `pi-tui` after fixing `docs/reference/pi.md:503-507`; move claude-agent-sdk + MCP SDK with the arc-agi-3 tree (benchmarks/ has no package.json and is not a workspace member); keep `signal-utils` (or move it to devDependencies beside `lit`). | S |",
    "reason": "3.6-12 partial and recommendation needs-change"
  },
  {
    "section": "3.6 Hygiene",
    "find": "| Lists nonexistent `README-header.png`, `assets/`; ships 15 MB `docs/` (incl. reviews, 6 MB gif) and all 58 skills. | Prune `files`; `.npmignore` for reviews/gifs; `npm pack --dry-run` in release check. | S |",
    "replace_with": "| Lists nonexistent `README-header.png`, `assets/` (harmless); would ship 14-15 MB `docs/` (incl. reviews, 6.5 MB gif) and all 59 skills; latent, the package has never been published. | Prune `files` (narrow `docs/`; keep `skills/`, the runtime resolves bundled skills from the package root); restore the missing `scripts/release-check.ts` behind `release:check` (RELEASING.md:46 already depends on it) or delete both. | S |",
    "reason": "3.6-13 partial and recommendation needs-change"
  },
  {
    "section": "3.6 Hygiene",
    "find": "| Python pre-commit with swiftlint/swiftformat for no Swift code; duplicates `git-hooks/pre-commit`; 69 KB baseline from Jan 2026 not run in CI. | Keep one hook; delete or trim pre-commit; run detect-secrets in CI if kept. | S |",
    "replace_with": "| Python pre-commit with swiftlint/swiftformat hooks that never fire (`types: [swift]`, zero .swift files); only its oxlint/oxfmt hooks duplicate `git-hooks/pre-commit`, while shellcheck/actionlint/zizmor/detect-secrets have no equivalent anywhere; 69 KB baseline generated 2026-01-25 not run in CI; the `(same as CI)` comments and `SECURITY.md:92` are false. | Do not delete pre-commit wholesale (it is the only shellcheck/actionlint/zizmor coverage): either move those checks into CI and keep git-hooks, or keep pre-commit and drop git-hooks; remove the Swift hooks; fix SECURITY.md:92-93; regenerate or delete the baseline. | S |",
    "reason": "3.6-14 partial and recommendation needs-change"
  },
  {
    "section": "3.6 Hygiene",
    "find": "| `scripts/package-mac-app.sh:9` + 9 siblings | 10 mac/iOS packaging scripts target `apps/macos`; `make_appcast.sh` needs missing `changelog-to-html.sh` and a Sparkle feed at `github.com/bitterbot/bitterbot`; hard-coded `SPARKLE_PUBLIC_ED_KEY` default. | Delete all; Tauri is the only native path. | S |",
    "replace_with": "| `scripts/package-mac-app.sh:9` + 6 siblings + `protocol-gen-swift.ts:18` | 7 shell scripts (incl. `build_icon.sh`) plus `protocol-gen-swift.ts` hard-code the never-existent `apps/macos`; `codesign-mac-app.sh`, `notarize-mac-artifact.sh`, `ios-team-id.sh` are dead only transitively; `make_appcast.sh` needs missing `changelog-to-html.sh` and a 404 feed at `github.com/bitterbot/bitterbot`; the hard-coded `SPARKLE_PUBLIC_ED_KEY` default lives in `package-mac-app.sh:25`. | Delete all 10 plus `protocol-gen-swift.ts`, `.swiftlint.yml`/`.swiftformat`, the `mac:*`/`ios:*`/`android:*`/`*:swift`/`protocol:*` scripts, the pre-commit Swift hooks, `MACOS_APP_SOURCES_DIR` in `src/compat/legacy-names.ts`, the apps/ lines in `vitest.config.ts`/`.dockerignore`, and fix `docs/reference/device-models.md` + `RELEASING.md:73`; Tauri is the only native path. | S |",
    "reason": "3.6-15 partial and recommendation needs-change"
  },
  {
    "section": "3.6 Hygiene",
    "find": "| `scripts/setup-auth-system.sh:94`, `auth-monitor.sh:6`, `aubaine-demo.ts`, `seed-forage-tranche.mts` | Personal homelab tooling (`/home/admin/bitterbot`, Termux widgets that reference missing scripts). | Move to an ignored `ops/` or out of repo. | S |",
    "replace_with": "| `scripts/setup-auth-system.sh:94`, `auth-monitor.sh:6,81` | Personal homelab tooling (`/home/admin/bitterbot`, `ssh l36`, Termux widgets and systemd units referencing five files that do not exist); `aubaine-demo.ts` (PLAN-26 harness, `pnpm aubaine:demo`) and `seed-forage-tranche.mts` (PLAN-29 operator script) are product scripts with no personal paths and do not belong in this finding. | Delete `setup-auth-system.sh` or strip its Termux step; `auth-monitor.sh` is documented at `docs/automation/auth-monitoring.md:36`, so either fix its paths and restore the promised systemd units or delete it with that doc page and the `docs/gateway/authentication.md:95` link. | S |",
    "reason": "3.6-16 partial and recommendation needs-change"
  },
  {
    "section": "3.6 Hygiene",
    "find": "| Full Python package + MCP server + Kaggle doc in the product repo; arc-agi-3 and longmemeval tests in default vitest include; `docs/agents/arc-agi-3.md` in docs. | Sibling repo; at minimum exclude from tarball, `pnpm install`, and default vitest include. | M |",
    "replace_with": "| Full Python package + MCP server + Kaggle doc in the product repo (456 KB tracked; the 129 MB on disk is a gitignored venv; 464 MB is all of benchmarks/); arc-agi-3 and longmemeval tests in the default vitest include and therefore in CI `test:fast` via `vitest.unit.config.ts` inheritance; `docs/agents/arc-agi-3.md` is an orphan page, not in docs.json nav; two root deps (`@anthropic-ai/claude-agent-sdk`, `@modelcontextprotocol/sdk`) exist only for it. | Sibling repo; the tarball exclusion is already done (`files` omits benchmarks/); the real costs are the two root deps and `vitest.config.ts:40`; leave the additive `arc_*` entity kinds in `knowledge-graph.ts:61-64` or handle them as a migration; delete `.gitignore:225-230` and the docs page with the tree; check the PLAN-19b Kaggle track before deleting. | M |",
    "reason": "6.5-6.6-16 partial and recommendation needs-change"
  },
  {
    "section": "3.6 Hygiene",
    "find": "| Heritage-ecosystem skills (clawhub.com CLI, \"Moltbook — the social network for AI agents\") shipped via `files: skills/`; `skills-cli.format.ts` references clawhub. | Remove; review Mac-only/personal skills (apple-notes, bear-notes, things-mac, imsg, bluebubbles, sonoscli, openhue) as optional. | S |",
    "replace_with": "| Heritage-ecosystem skills (clawhub.com CLI, \"Moltbook: the social network for AI agents\") shipped via `files: skills/`; moltbook's `moltbook.apiKey` config key exists nowhere; `skills-cli.format.ts:21` keeps the function name `appendClawHubHint` (text already rebranded); a stray OpenClaw comment survives in `skills/nano-banana-pro/scripts/generate_image.py:172`. | Remove both skills, rename the helper, fix the comment; apple-notes/bear-notes/things-mac/imsg already carry `os: [\"darwin\"]` gating, imsg/bluebubbles are channel integrations (keep), only sonoscli/openhue/bluebubbles lack an os gate. | S |",
    "reason": "6.7-6.8-10 partial and recommendation needs-change"
  },
  {
    "section": "3.6 Hygiene",
    "find": "| Least-tested parts of the install path. | Smoke tests for non-interactive onboard and FirstRun/Models/Channels screens; wire into CI. | M |",
    "replace_with": "| Least-tested parts of the install path (the src/wizard ratio understates it: most onboarding logic and tests live in src/commands/). | Non-interactive onboard e2e tests already exist (`src/commands/onboard-non-interactive.*.e2e.test.ts`, excluded from `test:fast` and never run in CI) and Models/Channels screens have tests; add a FirstRun test, then wire `pnpm test:e2e` (or the onboard subset) and `pnpm --filter bitterbot-control-ui test` into ci.yml. | M |",
    "reason": "3.6-20 recommendation needs-change"
  },
  {
    "section": "3.6 Hygiene",
    "find": "| 46-file LINE channel never registered; `@line/bot-sdk ^10.6.0` pulled into every install. | Delete src/line, `line-directives.ts`, plugin-sdk re-exports, dependency. | M |",
    "replace_with": "| 46-file LINE channel never registered as a channel, but it is live code: `stripMarkdown` feeds TTS (`tts.ts:25,883`, dragging `@line/bot-sdk` into the TTS path), the plugin runtime exposes a `line` namespace (`runtime/index.ts:88-105,415-430`, a plugin-API surface), `normalize-reply.ts:74-75` strips LINE directives on every reply, and plugin-sdk re-exports its types; `@line/bot-sdk ^10.6.0` pulled into every install. | First relocate `stripMarkdown`, remove the `line` runtime namespace (plugin-API break) and the normalize-reply hook deliberately (output text changes), then delete src/line, `line-directives.ts`, the re-exports and the dependency; a plain `rm -rf src/line` breaks typecheck in four places. | M |",
    "reason": "3.6-21 partial and recommendation needs-change"
  },
  {
    "section": "3.6 Hygiene",
    "find": "| `.gitignore:60` | Unedited Python/Django template (~150 lines of Django/Flask/Scrapy/Celery/SageMath) before the real rules. | Rewrite as ~40-line Node/Tauri/Rust ignore. | S |",
    "replace_with": "| `.gitignore:9-167` | Near-verbatim ~159-line Python template (Django/Flask/Scrapy/Celery/SageMath) after 8 lines of project rules; it is load-bearing: `target/` (orchestrator/target has no own .gitignore), `.venv`, `*.egg-info/`, `__pycache__/`, `.pytest_cache/`, `*.log`, `.env` all come from it. | Rewrite as a ~40-line Node/Tauri/Rust ignore only after the arc-agi-3 Python tree decision, retaining those rules and everything at lines 169-238 (keys/, wallet-data.json, .claude/, benchmark data). | S |",
    "reason": "3.6-22 partial and recommendation needs-change"
  },
  {
    "section": "3.6 Hygiene",
    "find": "| Two dev scripts under `src/` carry most of the 112 `console.log` hits. | Move to `scripts/diagnostics/`; oxlint `no-console` warn for src. | S |",
    "replace_with": "| Two dev scripts under `src/memory/scripts/` (`pipeline-diagnostic.ts` 56, `skill-forge-test.ts` 32) carry 88 of the ~115-129 non-test `console.log` hits (112 is not reproducible by any one filter). | Move to `scripts/` (no `scripts/diagnostics/` exists) and update `docs/debug/skill-forge.md:14-26`; oxlint `eslint/no-console` warn for src with allowances for intentional stdout (completion-cli, web/login, acp/client, runtime.ts). | S |",
    "reason": "3.6-23 partial and recommendation needs-change"
  },
  {
    "section": "3.6 Hygiene",
    "find": "| Nine `truncate()`, five `clamp()` (one exported from `src/utils.ts:37`), five `formatDuration()`. | Consolidate into `src/utils.ts`. | S |",
    "replace_with": "| Nine `truncate()` (8 src + 1 renderer, four distinct output formats), six `clamp()` (5 duplicates + the `src/utils.ts:37` alias; the memory copies default to 0..1), five `formatDuration()` (2 src, 2 renderer, 1 extension; `src/infra/format-time/format-duration.ts` already exists). | Switch the src clamp duplicates to `src/utils.ts` and fold src formatDuration copies into `format-time/format-duration.ts`; renderer and extension copies cannot import src/utils; leave truncate (output formats differ). Low V1 value. | S |",
    "reason": "3.6-24 partial and recommendation needs-change"
  },
  {
    "section": "3.6 Hygiene",
    "find": "| Comment points at gitignored `research/TAURI-PRODUCTION-PLAN.md`. | Point at PLAN-39 or a docs page. | S |",
    "replace_with": "| Comment points at gitignored `research/TAURI-PRODUCTION-PLAN.md`; more stale refs in `.oxfmtrc.jsonc` (Swabble), `.pre-commit-config.yaml:70,102`, `.swiftlint.yml`, `.swiftformat`, `vitest.config.ts:50`. | Point at `desktop/TAURI.md` (PLAN-39 covers Control UI serving, not the Tauri release design) or commit the research doc; sweep all of the above. | S |",
    "reason": "3.6-25 recommendation needs-change"
  },
  {
    "section": "3.7 Packaging",
    "find": "`RELEASING.md:21` says bump to CalVer and run missing `plugins:sync`; `compareSemverStrings` would treat `1.0.0` as older than `2026.2.15`. | D2; one `scripts/bump-version.mjs` syncing root/desktop/extensions/tauri.conf; tag `v1.0.0`; guard in update-check. | S |",
    "replace_with": "`docs/reference/RELEASING.md:22-23` says bump to CalVer and run `plugins:sync` (the script name exists; its target `scripts/sync-plugin-versions.ts` never did); 8 of 12 extensions have a package.json (all 2026.2.15); tauri.conf 0.1.0 is a deliberate separate `desktop-v*` scheme; Cargo 0.2.3 is itself unreleased; `compareSemverStrings` (`src/infra/update-check.ts:344`, package installs only, npm unpublished) would rank `1.0.0` below `2026.2.15` (bypassable downgrade prompt), and `compareBitterbotVersions` (`src/config/version.ts`) would warn on every git install via `warnIfConfigFromFuture`. | D2; one bump script replacing the dangling `plugins:sync`/`release:check` entries, syncing root/desktop/the 8 extension manifests/tauri.conf; tag `desktop-v1.0.0` or extend a workflow trigger (no workflow listens for `v*`); guard both comparators (treat major >= 2000 as older than any SemVer) or migrate `meta.lastTouchedVersion`. | S |",
    "reason": "6.9-6.10-08/3.7-3.8-02/3.7-3.8-03 partial; 5-32 recommendation needs-change"
  },
  {
    "section": "3.7 Packaging",
    "find": "`desktop/src-tauri/src/main.rs:93`, `tauri.conf.json:30-36,66`, `scripts/build-sea.mjs:196`, `desktop-release.yml:119`",
    "replace_with": "`desktop/src-tauri/src/main.rs:93`, `tauri.conf.json:31-37,65`, `scripts/build-sea.mjs:33,116-119,188-213`, `desktop-release.yml:120`",
    "reason": "3.7-3.8-05/06/07 anchors"
  },
  {
    "section": "3.7 Packaging",
    "find": "SEA handles only better-sqlite3 (repo now uses `node:sqlite` + sqlite-vec extension; build-sea still bundles ESM into a Node 22 SEA which is CJS-only); workflow pins pnpm 9 vs `pnpm@10.23.0`; `releases/latest/download/latest.json` redirects to the orchestrator release. | Scope out of V1 in README/TAURI.md; fix pnpm pin and add SHA-pinning + `environment: release` before it ever runs; fix build-sea (CJS entry, sqlite-vec file, Node 24 for sidecar) post-V1. | S (scope) / M (fix) |",
    "replace_with": "SEA handles only better-sqlite3, which is no longer a dependency (repo uses `node:sqlite` + sqlite-vec); build-sea bundles ESM into a Node 22 SEA (CJS-only) and its entry is the dev runner `scripts/run-node.mjs`, not `dist/entry.js`; workflow pins pnpm 9 vs `pnpm@10.23.0` (the exact ERR_PNPM_BAD_PM_VERSION failure 6cbdaca removed from ci.yml); `releases/latest/download/latest.json` redirects to the orchestrator release and will keep doing so whenever an orchestrator release is newer. | Scope out of V1 in `desktop/TAURI.md` only (README has zero Tauri mentions; adding one contradicts the install matrix row); delete the pnpm `version:` block (as in 6cbdaca) and add SHA-pinning + `environment: release` (create it with reviewers first) before it ever runs; post-V1: bundle `src/entry.ts` as CJS (Node 24 SEA is still CJS-only; ESM needs Node 26), ship the sqlite-vec .so/.dylib as a resource via the existing `extensionPath` override, and point the updater at a fixed tag/asset instead of `/releases/latest`. | S (scope) / M (fix) |",
    "reason": "3.7-3.8-04/05/06/08 recommendation needs-change"
  },
  {
    "section": "3.7 Packaging",
    "find": "| Gateway never serves `dist-renderer`; CI builds it (`ci.yml:50-52`) and nothing consumes it. | D5 / PLAN-39 phase 1. | M |",
    "replace_with": "| Gateway never serves `dist-renderer`; CI builds it (`ci.yml:51-53`) as a bundler smoke check; the only consumer is the unreleased Tauri shell (`tauri.conf.json:8 frontendDist`). | D5 / PLAN-39 Phases 0-2 (serving is Phase 2, gated on the Phase 0 blackout measurement); also `src/infra/ui-restart.ts:337` respawns `pnpm dev` on update and `Dockerfile:21,29` assume the `ui:build` script Phase 1 creates; 11+ docs mention port 5173. | M |",
    "reason": "3.7-3.8-09 partial and recommendation needs-change"
  },
  {
    "section": "3.7 Packaging",
    "find": "| `package.json:22`, `docs/docs.json:38-45`, `SECURITY.md`, `CONTRIBUTING.md` | Repo identity split: `github.com/bitterbot/bitterbot` vs `Bitterbot-AI/bitterbot-desktop` (the real remote and `fetch-orchestrator.mjs:33`). | Canonical URL everywhere; lint grep. | S |",
    "replace_with": "| `package.json:24,30`, `docs/docs.json:39,44`, `src/cli/update-cli/shared.ts:40`, `src/agents/system-prompt.ts:649,651`, `scripts/make_appcast.sh:6,52`, `docs/reference/RELEASING.md:24,25,30` + ~12 more (30 hits in 20 files) | Repo identity split: `github.com/bitterbot/bitterbot` (404) vs `Bitterbot-AI/bitterbot-desktop` (the real remote and `fetch-orchestrator.mjs:32`); SECURITY.md and CONTRIBUTING.md are already correct; `update-cli/shared.ts:40` is functional (the `bitterbot update` fresh-clone URL) and `system-prompt.ts:649` is injected into every agent prompt. | Canonical URL everywhere (sed over 20 files, not 4); lint grep; fix the existing `docs/reference/RELEASING.md` rather than write a new runbook. | S |",
    "reason": "3.7-3.8-10 partial and recommendation needs-change"
  },
  {
    "section": "3.7 Packaging",
    "find": "| If npm is post-V1, drop the RELEASING npm checklist; otherwise precompile extensions and add `npm pack --dry-run` check. | M |",
    "replace_with": "| If npm is post-V1, mark the RELEASING npm items \"post-V1\" and restore or delete the dangling `release:check`; do not precompile extensions (the plugin loader jiti-loads TS source by design, `loader.ts:231-233`); the `npm pack --dry-run` step already exists in RELEASING.md:34/46/65 in name only. | M |",
    "reason": "3.6-13 recommendation needs-change"
  },
  {
    "section": "3.7 Packaging",
    "find": "| `pnpm build` and renderer build skipped on Windows; no `v*`-tag workflow; no artifact. | `release.yml` on `v*`: full build, tarball + built UI, Docker push, GitHub Release; make Windows leg real or drop Windows from matrix. | M |",
    "replace_with": "| Only the two build steps are skipped on Windows (typecheck + unit tests run and pass; deliberate per 0e39738 because `bundle-a2ui.sh` needs bash); no `v*`-tag workflow, but `desktop-v*` (never run) and `orchestrator-v*` (4 releases) workflows exist; ci.yml produces no artifact. | Decide one tag scheme and extend `desktop-release.yml` (or add a gateway release workflow) rather than a third pipeline; Docker push depends on D8; a \"real\" Windows leg means porting `bundle-a2ui.sh` to Node or `shell: bash` on that step, not dropping Windows. | M |",
    "reason": "3.7-3.8-12 partial and recommendation needs-change"
  },
  {
    "section": "3.7 Packaging",
    "find": "| `scripts/setup-deps.sh:26-30`, `preinstall-check.mjs`, `engines` | Node floor 22 vs `>=22.12.0`; pnpm never installed; Windows unsupported. |",
    "replace_with": "| `scripts/setup-deps.sh:102-110`, `preinstall-check.mjs:50-53`, `engines` | Both scripts check major >= 22 only (setup-deps warns, preinstall hard-fails), while `engines` and `onboarding.node-version.ts:36` require >= 22.12.0 (a Node 22.0-22.11 user is stopped only at wizard entry); pnpm never installed; Windows unsupported by the script. |",
    "reason": "3.7-3.8-13 partial"
  },
  {
    "section": "3.7 Packaging",
    "find": "| `docs/reference/RELEASING.md:47,60`, `desktop-release.yml:56`, `research/TAURI-PHASE-1-STATUS.md:3` | Missing `release:check`/`test:install:smoke`; \"2.0.0-beta2\" troubleshooting; `--notes \"See CHANGELOG\"` with no CHANGELOG.md; \"local only, not pushed\" though files are on main. | One-page V1 runbook; add CHANGELOG.md (Keep a Changelog); move TAURI-* under docs/plans with a post-V1 banner. | S |",
    "replace_with": "| `docs/reference/RELEASING.md:46-47,63`, `desktop-release.yml:58`, `research/TAURI-PHASE-1-STATUS.md:3` (gitignored, local only) | `release:check`/`test:install:smoke` exist as script names but their files never did; \"2.0.0-beta2\" troubleshooting at :63; `--notes \"Automated release. See CHANGELOG.\"` with no root CHANGELOG.md (RELEASING.md:38 itself says \"create the file if missing\"); the stale \"local only, not pushed\" line is invisible to anyone but the local checkout; the real defect is three tracked files (`desktop/TAURI.md:108,182,203`, `scripts/build-sea.mjs:20`, `desktop-release.yml:7`) pointing at ignored docs. | Fix the existing RELEASING.md; decide CHANGELOG vs `--generate-notes` (the one live pipeline uses inline notes, `generate_release_notes: false`); do not commit the stale research status doc (it describes a branch that no longer exists); put the post-V1 banner in `desktop/TAURI.md` and repoint the three references. | S |",
    "reason": "3.7-3.8-14/15 partial and recommendation needs-change"
  },
  {
    "section": "3.7 Packaging",
    "find": "| `/install` -> getting-started which links back to `/install` (loop); `/docker`, `/install/podman|nix|railway|northflank|updating` -> nonexistent pages. | Delete the block; one real install page. | S |",
    "replace_with": "| `/install` -> getting-started which links back to `/install` (loop); the whole Install tab (20 en pages + zh-CN) and 17 `/install/*` redirect destinations are dead, masked from `check:docs` by the `/install/:slug*` catch-all at :71 (double hops into getting-started if the host chains redirects). | Delete the Install tab and the `/install/*` redirects (or keep only the catch-all); fix `setup.md:27` and `getting-started.md:46`; make `docs-link-audit.mjs` validate nav pages and redirect destinations. | S |",
    "reason": "3.7-3.8-16 partial and recommendation needs-change"
  },
  {
    "section": "3.8 CLI",
    "find": "`skills-cli.ts:34`, `hooks-cli.ts:471`, `acp/server.ts:137` declare `-v, --verbose`;",
    "replace_with": "`skills-cli.ts:34`, `hooks-cli.ts:471`, `acp-cli.ts:19` declare `-v, --verbose` (`acp/server.ts:137` is a standalone-entry parser and is unaffected); only `help.ts:69-76` prints and exits, `argv.ts` and `banner.ts` gate routing/banner; reproduced live: `skills list -v` prints `2026.2.15`;",
    "reason": "3.7-3.8-17 partial"
  },
  {
    "section": "3.8 CLI",
    "find": "`src/cli/program/register.subclis.ts:273`, `command-registry.ts:151-155`, `help.ts:36`",
    "replace_with": "`src/cli/program/register.subclis.ts:278`, `command-registry.ts:151-155`, `help.ts:36`",
    "reason": "3.7-3.8-18 partial anchor"
  },
  {
    "section": "3.8 CLI",
    "find": "| Single source of truth for descriptions; real root description; fixed `DEFAULT_TAGLINE` in help banner. | S |",
    "replace_with": "| Single source of truth for descriptions (the registry string stays the source and each registrar imports it, or the lazy-load win of `register.subclis.ts:15-27` is lost; add a parity test); real root description; fixed `DEFAULT_TAGLINE` in help banner. | S |",
    "reason": "3.7-3.8-18 recommendation note"
  },
  {
    "section": "3.8 CLI",
    "find": "| `src/cli/program/register.subclis.ts:34-250` | 42 visible top-level commands, flat alphabetical, only 2 hidden;",
    "replace_with": "| `src/cli/program/register.subclis.ts:34-250` (26 sub-CLIs) + `command-registry.ts:30-122` (18 core, 2 hidden) | 42 visible top-level commands (44 registered), flat alphabetical, only 2 hidden;",
    "reason": "3.7-3.8-19 partial"
  },
  {
    "section": "3.8 CLI",
    "find": "| Add `hidden` to SubCliEntry; hide acp, checkpoints, heartbeat, system, hooks, webhooks, dns, daemon, `gateway call`; `BITTERBOT_SHOW_DEV_COMMANDS=1`; drop `--dev gateway` example; grouped help text. | S |",
    "replace_with": "| Add `hidden` to SubCliEntry AND apply it inside each real registrar (the eager path under `BITTERBOT_DISABLE_LAZY_SUBCOMMANDS` and `completion-cli.ts:246-257` bypass the placeholders); `gateway call`/`usage-cost` are nested commands needing `{ hidden: true }` in `gateway-cli/register.ts`; hide acp, heartbeat, system, hooks, webhooks, dns; delete `daemon` rather than hide; hiding `checkpoints` (PLAN-14 feature) is a product call; `BITTERBOT_SHOW_DEV_COMMANDS=1`; drop `--dev gateway` example; grouped help text; pair with a docs/cli pass (index.md lists these as first-class pages). | S |",
    "reason": "3.7-3.8-19/2.3-2.4-09 recommendation needs-change"
  },
  {
    "section": "3.8 CLI",
    "find": "| 17 sections unconditionally incl. \"Forage Night Shift is enabled (default) but the node has no wallet credentials\", \"A2A payment gate off\", P2P Identity, Canvas, Liveness, Task spine. README says run `doctor` first. | Gate Economy/Wallet/P2P Identity/Canvas/Liveness/Task-spine behind `--deep` or their `enabled` flag. | S |",
    "replace_with": "| ~23 top-level sections (16 in lines 334-400; README itself says ~30 checks) incl. info-level \"Forage Night Shift is enabled (default) but the node has no wallet credentials\", \"A2A payment gate off\", P2P Identity, Canvas, Liveness, Task spine; Identity/Canvas/Wallet already early-return on their `enabled` flags (which default ON), Economy/Liveness/Task-spine are ungated; the economy lines do not affect the exit code. README's first command is `onboard`; `doctor` is the first troubleshooting step. | Do not overload `--deep` (it already means \"scan system services for extra gateway installs\", `register.maintenance.ts:27`, and the update flow runs doctor): suppress info-level posture lines for unconfigured subsystems on non-JSON runs, extend the `enabled` early-returns to Economy/Liveness/Task-spine, or add a new flag. | S |",
    "reason": "3.7-3.8-20 partial and recommendation needs-change"
  },
  {
    "section": "3.8 CLI",
    "find": "| `src/cli/tagline.ts:27`, `banner.ts:121` | ~90 taglines on every TTY invocation incl.",
    "replace_with": "| `src/cli/tagline.ts:27`, `banner.ts:110-111` | 90 taglines (10 holiday-gated; \"claw-sistant\" is Dec-25-only) on TTY invocations except `--json`/`--version`/`update`/`completion`/`BITTERBOT_HIDE_BANNER`, and on every `--help` regardless of TTY, incl.",
    "reason": "3.7-3.8-21 partial"
  },
  {
    "section": "3.8 CLI",
    "find": "| Fixed `DEFAULT_TAGLINE`; commit hash behind `--verbose`. | S |",
    "replace_with": "| `DEFAULT_TAGLINE` already exists (`tagline.ts:1`): make `pickTagline` return it and delete the TAGLINES/HOLIDAY/`BITTERBOT_TAGLINE_INDEX` machinery; keep the commit hash in the banner (`--version` prints only the semver, so the banner is the only place a bug report shows the build). | S |",
    "reason": "3.7-3.8-21 recommendation needs-change"
  },
  {
    "section": "3.8 CLI",
    "find": "| Four entry points into the same wizard (onboard / configure / config / setup --wizard). | Keep onboard + configure; `config` prints help; hide `setup`. | S |",
    "replace_with": "| Four entry points into TWO wizards: `onboard` and `setup --wizard` run the onboarding wizard (`src/wizard/onboarding.ts`); `configure` and bare `config` run the section-based configure wizard (`src/commands/configure.wizard.ts`); docs/cli/config.md:11 documents the bare-`config` behaviour as intentional. | Keep onboard + configure; `config` prints help (also remove its `--section` option at `config-cli.ts:289-295` and update docs/cli/config.md:11, configure.md:15); hide `setup` (its `--wizard` flags all exist on `onboard`); do not merge the two wizards. | S |",
    "reason": "3.7-3.8-22 partial and recommendation needs-change"
  },
  {
    "section": "3.8 CLI",
    "find": "omits `checkpoints`, `completion`, `gateway usage-cost`, `skills import/incoming`, `cron runs`; `--skip-ui` help mentions TUI. | Delete/fix pages; generate index.md tree from `program.commands` in CI. | M |",
    "replace_with": "omits `completion` and `gateway usage-cost` (`checkpoints` is documented under docs/tools/checkpoints.md; `skills import/incoming` and `cron runs` ARE in docs/cli/index.md:445-448,919); `cron remove` exists with no `rm`/`delete` aliases and enable/disable are `cron edit` flags; `--skip-ui` help mentions TUI; the `tui`/`tui:dev` package.json scripts and the `@mariozechner/pi-tui` dependency are equally dead. | Delete/fix pages incl. `docs/web/tui.md` and the docs.json tui/voicecall nav entries (:624,1091,1133,1136,1613,1616); drop the dead scripts and dependency; generate index.md tree from `program.commands` in CI with `BITTERBOT_DISABLE_LAZY_SUBCOMMANDS=1` and hidden commands filtered. | M |",
    "reason": "3.7-3.8-23 partial and recommendation needs-change"
  },
  {
    "section": "3.8 CLI",
    "find": "| Remove alias, shim, and build step. | S |",
    "replace_with": "| Remove the shim (plus `src/cli/daemon-cli-compat.ts` and its test; no Bitterbot install was ever pre-tsdown) and the build step; if the `daemon` alias goes, update `scripts/restart-mac.sh:220-221` in the same commit or hide it with `{ hidden: true }` instead. | S |",
    "reason": "3.7-3.8-24 recommendation needs-change"
  },
  {
    "section": "3.8 CLI",
    "find": "| `help.ts:45-48,21`, `gateway-cli/run.ts:339-355` | `--dev` flag and `--dev gateway` example in help (banned per project rule);",
    "replace_with": "| `help.ts:38-41,20`, `gateway-cli/run.ts:333-356` | `--dev` flag and `--dev gateway` example in help (discouraged in Victor's local-dev notes because `~/.bitterbot-dev` holds a stale token, but still a documented flag: docs/cli/index.md:47, docs/gateway/index.md:188, used by `tui:dev` and tested in profile.test.ts);",
    "reason": "3.7-3.8-25 partial"
  },
  {
    "section": "3.8 CLI",
    "find": "| `hideHelp()`; happy-path examples (onboard, dashboard, doctor, channels add, update). | S |",
    "replace_with": "| `hideHelp()` on `--reset` (coupled to `--dev`), `--claude-cli-logs`, `--ws-log`, `--raw-stream*` is safe; hiding `--dev`, `--allow-unconfigured` (6 docs) and `gateway call` (16 docs) without a docs pass creates help/docs drift, so either deprecate `--dev` fully or keep it visible; happy-path examples (onboard, dashboard, doctor, channels add, update). | S |",
    "reason": "3.7-3.8-25 recommendation needs-change"
  },
  {
    "section": "3.8 CLI",
    "find": "| `skills incoming` exposes a quarantine flow with audit F6/F15/F16 open; `memory backfill-embeddings` is an internal migration with jargon description (\"fact_*, notes, briefs\"). | Dev namespace; run backfill from `doctor --repair`. | S |",
    "replace_with": "| `skills incoming` is a live flow (F6 and F16 were fixed 2026-08-09 in fd59b1a/34f78cd; only F15 remains, and the CLI accept path skips the F6 peer-trust credit); `memory backfill-embeddings` is a documented on-demand drainer (docs/cli/memory.md:47) of a bounded backfill the hygiene cycle already runs every sync, with a jargon description (\"fact_*, notes, briefs\"). | Document `skills incoming` in docs/cli/skills.md (the F16 fix tells operators to run it) and pass a reputationManager on the CLI accept path; reword the backfill description; drop the `doctor --repair` idea (auto-backfill already exists). | S |",
    "reason": "3.7-3.8-26 partial and recommendation needs-change"
  },
  {
    "section": "3.8 CLI",
    "find": "| Hide from root help; kebab-case. | S |",
    "replace_with": "| Hide from root help (`program.command(\"browser\", { hidden: true })`); kebab-case the 3 non-kebab leaves (`scrollintoview`, `waitfordownload`, `responsebody`; 57 leaves total, 5 group parents) with `.alias()` for the old spellings, which docs/tools/browser.md:398-413 documents. | S |",
    "reason": "3.7-3.8-27 recommendation needs-change"
  },
  {
    "section": "3.8 CLI",
    "find": "| `bitterbot.mjs:50`, `README.md:43-44` | `bin` requires a prior build; README never shows `npm i -g` or `pnpm link`, so `bitterbot` is \"command not found\" unless prefixed with `pnpm`. | Pick one story (D1); `bitterbot.mjs` prints a one-line \"run pnpm build\" hint. | M |",
    "replace_with": "| `bitterbot.mjs:53`, `README.md:43-44,379,384,435` | `bin` requires a prior build and already throws `bitterbot: missing dist/entry.(m)js (build output).`; README's documented `pnpm bitterbot ...` path auto-builds via `run-node.mjs`, but README also uses bare `bitterbot` at :379,:384,:435 and docs/index.md:100, setup.md:71, linux.md:19 instruct `npm install -g bitterbot@latest` for a package that is not on npm (404). | Pick one story (D1): stop using bare `bitterbot` in README or add `pnpm link --global`; remove the three npm-global doc lines; the hint already exists, at most mention `pnpm build` / `pnpm bitterbot`. | S |",
    "reason": "3.7-3.8-28 partial and recommendation needs-change"
  },
  {
    "section": "3.8 CLI",
    "find": "| `completion-cli.ts:419,433` | Hidden `boot-watchdog`/`ui-restart` appear in shell completion. | Filter on commander's hidden flag. | S |",
    "replace_with": "| `completion-cli.ts:250-251,385,419,435` (+ bash/fish/pwsh generators at :490-657) | Hidden `boot-watchdog`/`ui-restart` appear in shell completion because `getCoreCliCommandNames()` ignores `hidden` and none of the four shell generators filter it. | Filter once at the source (`getCoreCliCommandNames()` or `createHelp().visibleCommands()`) so all four shells are covered. | S |",
    "reason": "3.7-3.8-29 anchors"
  },
  {
    "section": "3.9 Docs",
    "find": "463 nav entries, 270 with no file (en: 21 `install/*`,",
    "replace_with": "463 nav entries, 270 with no file (en: 20 `install/*`,",
    "reason": "3.9-01 partial: count"
  },
  {
    "section": "3.9 Docs",
    "find": "both redirecting to missing pages; 8 real pages link into `/install/*`; `docs-link-audit.mjs` only checks redirects, not nav, and is not in CI. Correction: Mintlify does not refuse to build; it renders 404 nav entries. |",
    "replace_with": "`/start/faq` dead-ends at `/help` (no page) while `/troubleshooting` chains to the existing `docs/gateway/troubleshooting.md`; both fail today because `docs.bitterbot.ai` is NXDOMAIN; the same troubleshooting URL is also printed by `status.command.ts:619` and `status-all/diagnosis.ts:245`; 8 real pages link into `/install/*`; `docs-link-audit.mjs` only checks redirects, not nav or redirect destinations, it IS in CI via `check:docs` (ci.yml:83), and its `docs/**/*.md` glob skips the four top-level `docs/*.md` files, so `docs/index.md`'s three missing images are never scanned; ~38 of the 48 English phantoms are covered by redirects. Correction to the correction: Mintlify documents missing nav file paths as a cause of failed preview deployments and `mint validate` exits non-zero; the hosted production build's behaviour is undocumented, so do not rely on \"it just renders 404s\". |",
    "reason": "3.9-01/02/03/04 partial"
  },
  {
    "section": "3.9 Docs",
    "find": "create or repoint troubleshooting/faq; fix 8 inbound links; extend link audit to walk nav and run in CI. | M |",
    "replace_with": "create a troubleshooting hub over the four existing runbooks or repoint the nav entry; add a FAQ page; collapse the redirect chains to single hops; fix 8 inbound links; extend the link audit to walk nav + redirect destinations and fix its glob (it already runs in CI); consider `mint validate` / `mint broken-links --check-redirects`. | M |",
    "reason": "3.9-01/3.9-02/3.9-03/3.9-15 recommendation needs-change"
  },
  {
    "section": "3.9 Docs",
    "find": "Internal audits incl. wired-but-dead (17 HIGH unfixed) and economy audit (\"wallet-service.ts:331 throws 'Token swaps ... not yet implemented' while the tool advertises trade\") in the public docs tree;",
    "replace_with": "Internal audits incl. wired-but-dead (17 findings at HIGH confidence, 9 of them fixed 2026-08-09/10) and the economy audit (partly stale: its `Token swaps` throw and the wallet `trade` action were removed in a5db7bf on 2026-06-10, the day after that audit; refuted as a live example) in the public docs tree; the circles security-remediation doc is untracked, not among the nine;",
    "reason": "3.9-06 refuted; 1-21 partial; 3.9-05 nuance"
  },
  {
    "section": "3.9 Docs",
    "find": "| `src/terminal/links.ts:5`, `src/commands/docs.ts:8`, `src/agents/system-prompt.ts:648` | `docs.bitterbot.ai` -> `ENOTFOUND`; 81 source files and the system prompt link to it. | D9: deploy after the prune, or repoint `formatDocsLink` at GitHub blob URLs and make `bitterbot docs` search local `docs/`. | M |",
    "replace_with": "| `src/commands/docs.ts:8,164`, `src/agents/system-prompt.ts:648`, `daemon-cli/status.print.ts:316`, `status.command.ts:619`, `status-all/diagnosis.ts:245` | `docs.bitterbot.ai` is NXDOMAIN (the Cloudflare-hosted bitterbot.ai zone has no `docs` record); `src/terminal/links.ts:3` already points `formatDocsLink` at the GitHub docs/ tree (007db0a, 2026-04-16), so most of the 62 src files (not 81) that mention the host only use it as a link label; the raw dead strings are the six sites listed plus `docs.ts:8`'s Mintlify MCP search endpoint. | D9: the `formatDocsLink` repoint is already done; replace the raw literals with one `DOCS_SITE` constant from links.ts, give `bitterbot docs` a local `docs/` grep fallback, and decide the DNS record + Mintlify deploy separately (no workflow or plan exists for it; it should not gate V1). | M |",
    "reason": "3.9-07 partial and recommendation needs-change"
  },
  {
    "section": "3.9 Docs",
    "find": "| `docs/index.md:24,27,47,100,114,125` | Docs home: \"EXFOLIATE! EXFOLIATE!\", \"gateway for AI agents across WhatsApp, Telegram, Discord, iMessage\", \"AI coding agents like Pi\", `npm install -g`, UI at `:19001`, \"bundled Pi binary\", two missing images; zero mention of memory/dreams/circles/wallet. |",
    "replace_with": "| `docs/index.md:25,28,46,100,111-122,126,133` | Docs home: \"EXFOLIATE! EXFOLIATE!\", \"gateway for AI agents across WhatsApp, Telegram, Discord, iMessage\", \"AI coding agents like Pi\" (Pi is the real embedded runtime, so off-brand rather than false), `npm install -g` (package unpublished), UI at `:19001`, \"bundled Pi binary\", three missing images (two logo PNGs + `whatsapp-bitterbot.jpg`); one generic \"memory\" mention, zero dreams/circles/wallet; `docs.json:4` carries the same fork-era description. |",
    "reason": "3.9-08 partial"
  },
  {
    "section": "3.9 Docs",
    "find": "| `docs/web/dashboard.md:10,15`, `docs/web/control-ui.md:10`, `docs/start/getting-started.md:14,71`, `docs/start/hubs.md:24` | Five contradictory UI access stories (served at `/`, `:5173` via `pnpm dev`, `:19001`, \"Vite + Lit\", `pnpm gateway:watch`). | One story (D5 outcome); \"Vite + React\"; dev-mode commands to CONTRIBUTING only. | S |",
    "replace_with": "| `docs/web/dashboard.md:10,15`, `docs/web/control-ui.md:11,13`, `docs/start/getting-started.md:14,84-90`, `docs/start/hubs.md:24`, `docs/web/index.md:11,13`, `docs/index.md:122`, `docs/platforms/linux.md:22`, `docs/concepts/architecture.md:19,215,225` | Three contradictory access stories (served at `/`, `:5173` via `pnpm dev`/`gateway:watch`, `:19001`) plus the stale \"Vite + Lit\" label (the renderer is React 18, no `lit` dependency); getting-started contradicts itself (19001 at :15, 5173 at :90); install docs are split at least five ways, of which only the README flow is executable. | One story (D5 outcome); \"Vite + React\"; dev-mode commands to CONTRIBUTING only; include the zh-CN/ja-JP mirrors and reuse the PLAN-39 §8 docs-sweep checklist. | S |",
    "reason": "3.9-09/6.3-6.4-07 partial and recommendation needs-change"
  },
  {
    "section": "3.9 Docs",
    "find": "do not match `src/wizard/onboarding.ts` (auth -> embeddings -> web search -> gateway -> P2P -> channels -> skills -> genome -> wallet -> hooks -> control-ui env -> finalize). | Rewrite from the real flow; collapse three wizard reference pages into one generated from `register.onboard.ts`. | M |",
    "replace_with": "do not match `src/wizard/onboarding.ts` + `onboarding.finalize.ts` (mode -> workspace -> auth/model -> embeddings -> web search -> gateway -> P2P -> channels -> skills -> genome -> wallet -> hooks -> finalize: daemon install -> health check -> control-ui env); docs/reference/wizard.md (2026-05-22) already has Wallet but not embeddings/web search/P2P/genome. | Rewrite from the real flow in `onboarding.ts` + `onboarding.finalize.ts` (`register.onboard.ts` holds flags only and can generate just the flag table); collapse the four wizard pages to two (walkthrough + flag reference). | M |",
    "reason": "3.9-10 partial and recommendation needs-change"
  },
  {
    "section": "3.9 Docs",
    "find": "remove config residue. | S-M |",
    "replace_with": "remove config residue (also `MSTeamsReplyStyleSchema` at `zod-schema.core.ts:342` and bluebubbles labels; the queue-mode object is `.strict()`, so dropping its irc/mattermost/msteams keys needs a legacy-strip rule or a changelog note); `@bitterbot/msteams` also 404s on npm while `docs/channels/msteams.md:27,242` and `docs/tools/plugin.md:43,45` instruct installing it; the zh-CN nav block (docs.json:1312-1318) references a tree that does not exist. | S-M |",
    "reason": "3.9-12 recommendation needs-change; 3.9-11 additions"
  },
  {
    "section": "3.9 Docs",
    "find": "drop Venice highlight; add or drop litellm. | S |",
    "replace_with": "drop Venice highlight; fix the stale `anthropic/claude-opus-4-6` example at :31; add a litellm page (the auth flow exists in `onboard-auth.config-litellm.ts` and a redirect already exists at docs.json:103); a thin Gemini page can lift `docs/concepts/model-providers.md:79-93`; scrub Mattermost from the ~12 other docs too. | S |",
    "reason": "3.9-13 recommendation needs-change"
  },
  {
    "section": "3.9 Docs",
    "find": "exclude plans/reviews/SPECs; nav-coverage check in link audit. | S-M |",
    "replace_with": "exclude reviews/SPECs (plans are already gitignored; ~30 of the 119 orphans are local plan files, ~11 reviews, so the real nav-addition set is ~70; wallet pages are already in nav at docs.json:1013; hidden pages stay URL-reachable on Mintlify, so exclusion means moving them); nav-coverage check in link audit. | S-M |",
    "reason": "3.9-14 recommendation needs-change"
  },
  {
    "section": "3.9 Docs",
    "find": "| No troubleshooting/FAQ page; `/help/faq -> /help` and `/faq -> /help/faq` loop; README holds the only Bitterbot-specific fixes. | `docs/help/troubleshooting.md` from README \"Common fast fixes\" + doctor guidance; short FAQ; delete circular redirects. | S |",
    "replace_with": "| The Help nav lists three missing pages (help/index, help/troubleshooting, help/faq) and no FAQ exists; `/faq -> /help/faq -> /help -> /help/environment` is a 3-hop chain ending on a real page, not a loop; a Bitterbot-specific runbook already exists at `docs/gateway/troubleshooting.md` (doctor, EADDRINUSE, orchestrator, dream engine) and is the redirect target of `/help/troubleshooting`, with three more runbooks (channels, automation, browser-linux); README's six fast fixes are partly unique (desktop/.env, dist/entry, skip flags). | `docs/help/troubleshooting.md` as a short triage hub over the four existing runbooks (which `gateway/troubleshooting.md:11` already expects) folding in README's unique fixes, or drop the nav entry; short FAQ; collapse the multi-hop redirects to single hops (none are circular). | S |",
    "reason": "3.9-15 partial and recommendation needs-change"
  },
  {
    "section": "3.9 Docs",
    "find": "`docs/start/personal-assistant.md:10` | `allowFrom: [\"1234567890\", \"steipete\"]`; `### iMessage` section; \"Supported: ... imessage, msteams\"; \"gateway for **Pi** agents. Plugins add Mattermost.\" (14 pages mention iMessage/Mattermost/Pi). | Grep-and-fix pass; retire personal-assistant.md. | S |",
    "replace_with": "`docs/start/personal-assistant.md:11` (already out of nav and unlinked) | `allowFrom: [\"1234567890\", \"steipete\"]` (upstream author handle, 4 spots); `### iMessage` section and \"Supported: ... imessage, msteams\" document real code paths (`src/imessage/`, `src/channels/dock.ts:296`, 27 msteams src refs), so they are not residue; \"gateway for **Pi** agents. Plugins add Mattermost.\" (Pi is the embedded runtime; Mattermost has no extension); ~24 tracked pages mention iMessage/Mattermost (15 Mattermost, 12 msteams), 46 with Pi. | Grep-and-fix limited to `steipete` and Mattermost; do not strip iMessage/msteams/Pi; delete or re-nav personal-assistant.md after fixing line 11; include the zh-CN mirrors. | S |",
    "reason": "3.9-16 partial and recommendation needs-change"
  },
  {
    "section": "3.9 Docs",
    "find": "| `docs/memory/dream-engine.md:79`, `architecture-overview.md:637`, `AGENTS.md:21`, `README.md:118`, `dream-types.ts:12` | \"7 Dream Modes\" vs \"Twelve specialized modes\" vs 12-member union; README table lists 5 disabled modes (mutation, research, reconsolidation, interceptor_harvest, harness_evolve) as live and omits the 3 PLAN-40 lanes that run; \"Dream Quality Score\" the dream review says to retire. | One table generated from `dream-types.ts` defaults; disabled modes under \"Experimental modes\". | S |",
    "replace_with": "| `docs/memory/dream-engine.md:19,79`, `architecture-overview.md:156,637`, `AGENTS.md:21`, `docs/concepts/architecture.md:66`, `docs/concepts/memory.md:18`, `README.md:118`, `dream-types.ts:2,11,12-27` | \"7 Dream Modes\" (dream-engine.md, architecture-overview.md, AGENTS.md, concepts/*) vs \"Twelve specialized modes\" (README.md:118 only) vs \"9 dream modes\" (dream-types.ts header comment) vs the 15-member union (10 enabled, 5 disabled); README table lists 5 disabled modes (mutation, research, reconsolidation, interceptor_harvest, harness_evolve) as live and omits the 3 PLAN-40 lanes, of which only hygiene runs on the live node (distillation/anticipation are disabled in bitterbot.json); \"Dream Quality Score\" the dream review says to retire. | Document the surviving lanes per PLAN-40 §8b (a table generated from code defaults would list distillation/anticipation as live); remove mutation/research outright rather than parking them under \"Experimental modes\"; fix the \"9 dream modes\" comment and the 7-mode tables. | S |",
    "reason": "3.9-17 partial and recommendation needs-change"
  },
  {
    "section": "3.9 Docs",
    "find": "| `docs/plans/PLAN-25-SELF-OPTIMIZING-HARNESS.md:6`, `types.agent-defaults.ts:300` | \"LANDED, on by default\" while `harness_evolve: { enabled: false }` and it has never produced output. | Status HOLD; make the two switches agree. | S |",
    "replace_with": "| `docs/plans/PLAN-25-SELF-OPTIMIZING-HARNESS.md:6` (local, gitignored), `dream-types.ts:64`, `types.agent-defaults.ts:298`, `README.md:133` | \"LANDED, on by default\" while `harness_evolve: { enabled: false }` (`dream-types.ts:64`, the PLAN-40 hold with a doctor-visible wake counter at 25 executions, currently 13) and it has never produced output (0 of 13 executions fall in the held-out bucket); `types.agent-defaults.ts:298` is only a comment saying \"Default: true\" about the separate kill switch. | Status HOLD; fix the comment at `types.agent-defaults.ts:298`, PLAN-25:6 (zero release impact, untracked) and the README:133 row (the public overclaim); do not default the kill switch to false, it adds nothing while the hold is on and needs a second edit when it wakes. | S |",
    "reason": "3.9-18 partial and recommendation needs-change"
  },
  {
    "section": "3.9 Docs",
    "find": "| `README.md:269,451` |",
    "replace_with": "| `README.md:270-275,453` |",
    "reason": "3.9-19 partial anchors"
  },
  {
    "section": "3.9 Docs",
    "find": "audit F7/F10/F11/F14 open and the x402 -> revenue -> USDC path has never run. |",
    "replace_with": "wired-but-dead audit F7/F10/F11/F14 open (the 70/20/10 split is implemented but pays crystal UUIDs; any node, not only management nodes, can post bounties; demand-driven dreams are wired but fed by 0 purchases) and the x402 -> revenue -> USDC path has 0 recorded purchases on the audited node (the pay side, `pay_for_resource`/`send_usdc`, is proven in prod). |",
    "reason": "3.9-19 partial"
  },
  {
    "section": "3.9 Docs",
    "find": "| `README.md:18`, `Sidebar.tsx:79`, `docs/start/setup.md:16`, `gateway-lock.md:11`, `providers/minimax.md:192`, `RELEASING.md:60` | `version-2026.2.15--beta` badge, \"(beta)\" nav label, \"Last updated 2026-01-01\", \"2026.1.12 (unreleased at the time of writing)\", `--tag beta`. | Decide the V1 version string; remove beta signalling and hand-maintained dates. | S |",
    "replace_with": "| `README.md:18`, `components/layout/Sidebar.tsx:79`, `docs/start/setup.md:16`, `gateway-lock.md:11`, `providers/minimax.md:192,194`, `docs/reference/RELEASING.md:60`, `docs/cli/update.md:23` | `version-2026.2.15--beta` badge, \"(beta)\" nav label, \"Last updated: 2026-01-01\" (setup.md) and \"Last updated: 2025-12-11\" (gateway-lock.md), \"2026.1.12 (unreleased at the time of writing)\" (minimax.md), `--tag beta` (RELEASING.md, update.md), which documents the real beta update channel (`update-channels.ts`). | Decide the V1 version string; remove the badge, the three hand-maintained dates and the minimax note; keep `--tag beta`; decide whether \"Dreams (beta)\" is honest labelling before stripping it. | S |",
    "reason": "3.9-20 partial and recommendation needs-change"
  },
  {
    "section": "3.9 Docs",
    "find": "| \"Help & Docs\" footer link; \"Run diagnostics\" hint on Disconnected. | S |",
    "replace_with": "| \"Help & Docs\" footer link once a docs destination exists (`docs.bitterbot.ai` does not resolve; meanwhile about.bitterbot.ai or the GitHub docs tree); \"Run diagnostics\" hint on Disconnected. | S |",
    "reason": "2.1-2.2-21 recommendation needs-change"
  },
  {
    "section": "3.9 Docs",
    "find": "| `docs/channels/telegram.md:27` + 4 | `grep -l \"Control UI\" docs/channels/*.md` is empty; every channel page goes from BotFather to hand-editing json5; pages last committed 2026-03-28 while the UI guided flow shipped 2026-07-31. | \"Set up from the Control UI\" first step on the five real pages; JSON under Advanced. | M |",
    "replace_with": "| `docs/channels/telegram.md:27` + 5 | `grep -l \"Control UI\" docs/channels/*.md` is empty; every channel page goes from BotFather to hand-editing json5; five pages last committed 2026-03-28 (signal.md 2026-05-21) while the UI guided flow shipped 2026-07-31 (5d7a22f). | \"Set up from the Control UI\" first step on the six bundled pages, linking `docs/web/control-ui.md:70-73` rather than duplicating it; JSON under Advanced. | M |",
    "reason": "3.9-23 precision"
  },
  {
    "section": "3.9 Docs",
    "find": "| signal-cli (Java) prerequisite has no install story in UI or platform docs; install only in CLI onboarding via Homebrew. | Actionable reason from the greyed card; per-platform doc; list Signal under Advanced channels. | S |",
    "replace_with": "| signal-cli (native GraalVM build, or JVM build + JRE) has no macOS/Windows install doc (signal.md:104-121 covers Linux); the greyed card already shows \"signal-cli not found ... Install it or set channels.signal.cliPath\"; CLI onboarding auto-installs from GitHub releases on macOS and Linux x64, via Homebrew only on other Linux archs, and not at all on Windows. | Extend the existing card reason with the install command/doc link; add macOS + Windows sections to signal.md; list Signal under Advanced channels. | S |",
    "reason": "3.9-24 partial and recommendation needs-change"
  },
  {
    "section": "3.9 Docs",
    "find": "| `scripts/docs-link-audit.mjs:48` | Passes (1233 links) while nav and images are broken; never reads `navigation`; does not resolve `<img src>`. | Assert nav pages and redirect destinations exist; resolve images; keep in `check:docs`. | S |",
    "replace_with": "| `scripts/docs-link-audit.mjs:47,90-131` | Passes (1233 links / 277 files) while nav and images are broken; never reads `navigation` or redirect destinations; it DOES extract `src=` and markdown images (:285, :156-158), but the `git ls-files 'docs/**/*.md'` pathspec at :47 skips the four top-level `docs/*.md` files, so `docs/index.md` (three missing images, dead `/reference/credits` link) is never scanned. | Add `docs/*.md` `docs/*.mdx` to the pathspec (will immediately flag the three missing images); assert nav pages and redirect destinations exist; it is already in `check:docs` and CI. | S |",
    "reason": "3.9-03 partial and recommendation needs-change"
  },
  {
    "section": "3.9 Docs",
    "find": "| `src/discord/voice-message.ts:81` | Shells out to `ffmpeg`, undeclared prerequisite. | Document as optional or degrade gracefully. | S |",
    "replace_with": "| `src/discord/voice-message.ts:81,188` | Shells out to `ffmpeg`/`ffprobe`; it IS declared (`docs/channels/discord.md:599`, `docs/start/setup.md:32`) and installed by `setup-deps.sh:67`; the waveform path already degrades to a placeholder (:62-68); only the duration probe and Opus conversion still throw, so voice messages fail without ffmpeg while text is unaffected. | Already documented; make the duration/convert path fail soft (fall back to a plain audio attachment) or add an ffmpeg presence check to doctor. | S |",
    "reason": "3.9-25 partial and recommendation needs-change"
  },
  {
    "section": "3.10 First-run runtime",
    "find": "`loadGatewayPlugins` is synchronous, jiti-loads 12 `extensions/*/index.ts` and runs `register()` inline; no per-plugin timing. Corrections: the hormonal accessor awaits dynamic imports first and cannot be the stall; memory init ran after and took 1.6-26 s;",
    "replace_with": "`loadBitterbotPlugins` (`src/plugins/loader.ts:180`, wrapped by `loadGatewayPlugins`) is synchronous, jiti-loads the 9 extensions enabled by default (of 12) plus their `./src/*.ts` AND the whole `src/plugin-sdk` graph (~1,900 src modules per the jiti cache) because `loader.ts:52-61` resolves the `bitterbot/plugin-sdk` alias to TypeScript source unless `NODE_ENV=production` (the running gateway has `NODE_ENV=development`); the transpile cache was already warm on the 27-min boot, so transpilation is not the cost and per-module resolution over DrvFS is the suspect; the 27.4-min span also covers `initSubagentRegistry`/`listGatewayMethods` (`server.impl.ts:283-313`); reproduced on 30 of 30 boots since 08-08 (23-35 min); no per-plugin timing. Corrections: the hormonal accessor awaits dynamic imports first and cannot be the stall, but its eager first refresh is what puts the memory build on the pre-listen path; memory init ran after and took 0.2-26 s (24-26 s only on the three most recent boots);",
    "reason": "3.10-3.11-02/03 partial"
  },
  {
    "section": "3.10 First-run runtime",
    "find": "| (1) Per-plugin timing in `loadBitterbotPlugins`; reproduce on ext4/macOS. (2) If it reproduces: precompile bundled extensions to JS; async plugin load with listen() earlier. (3) Stop the sync FTS-drift repair before listen; fix the stale comment. If DrvFS-only: warn in onboarding when repo path starts with `/mnt/`. | S then M |",
    "replace_with": "| (0) First try the cheap lever: `NODE_ENV=production` or prefer the already-built `dist/plugin-sdk/index.js` in the alias candidate order (one-line change). (1) Per-plugin timing in `loadBitterbotPlugins` (also time the other steps in the span); reproduce on ext4/macOS (PLAN-39 §176-181 already lists this). (2) Drop \"precompile extensions\" (warm cache + 27-min stall shows transpile is not the cost); async plugin load is not small (`gatewayHandlers` are consumed before listen). (3) Defer the hormonal accessor's first refresh past listen (moves the 24-26 s memory build off the pre-listen path with no FTS semantics change); measure the FTS backfill separately before touching it, it restores keyword recall for chunks written outside the sync path; fix the stale comment (64345e9 already knew the ctor is ~500 ms). If DrvFS-only: extend the existing `doctor-runtime.ts:119-128` WSL2 hint to key on the repo path and surface it from onboarding. | S then M |",
    "reason": "3.10-3.11-01/02/04/05 recommendation needs-change"
  },
  {
    "section": "3.10 First-run runtime",
    "find": "| `src/logging/subsystem.ts:150`, `server.impl.ts:178`, `manager.ts:525` | `boot step`/`init step` logged with `{label, ms}` meta that the console formatter never renders; every boot prints ~10 bare lines. |",
    "replace_with": "| `src/logging/subsystem.ts:147-190`, `server.impl.ts:178`, `manager.ts:526,590` | `boot step`/`init step` logged with `{label, ms}` meta that the pretty/compact console styles drop (the file log and `logging.consoleStyle: json` keep it, which is how the 1,646,406 ms figure was recovered); every boot prints ~15 bare lines. |",
    "reason": "3.10-3.11-07 partial"
  },
  {
    "section": "3.10 First-run runtime",
    "find": "at warn because the sidecar logger only exposes `warn`. | Add `info` channel. | S |",
    "replace_with": "at warn because `startGatewaySidecars` narrows its `log` parameter type to `{ warn }` (`server-startup.ts:36`); the object passed is the full gateway subsystem logger, which already has `info`, and `server-startup-memory.ts:23` already declares `info?`. | Widen the parameter type and switch the two calls to `.info`; no new channel needed. | S |",
    "reason": "3.10-3.11-08 partial and recommendation needs-change"
  },
  {
    "section": "3.10 First-run runtime",
    "find": "| Journal on by default, only per-task deletion; 17.5 MB + 4 MB WAL after ~2 months. | 30-day retention sweep. | S |",
    "replace_with": "| Journal on by default; `deleteTask` has no production caller and 99.9% of rows (33,505 of 33,544) carry no task_id, so per-task deletion could never reclaim them; 17.6 MB + 4.2 MB WAL after ~3 months (first event 2026-05-22). | 30-day retention sweep on `ts` (indexed) plus a periodic WAL checkpoint; `heartbeat-considerations.ts:129-133` is prior art for a daily sweep. | S |",
    "reason": "3.10-3.11-10 partial"
  },
  {
    "section": "3.10 First-run runtime",
    "find": "| Constructor blocks the event loop; 155 `IF NOT EXISTS` + migrations + FTS self-heal on every open; 25.5 s on a 622 MB DB; \"event loop stalled: max=72410ms\". | Gate self-heal behind a meta flag; async heavy phases. | M |",
    "replace_with": "| Constructor blocks the event loop for 25.5 s in `ensureSchema` on the ~629 MB DB (23.6 s on 08-19; sub-second on most earlier boots); per-open work is ~37 `IF NOT EXISTS` (memory/dream/curiosity schemas) + ensureColumn PRAGMAs + the unconditional FTS backfill anti-join; the 155 statements live in `migrations.ts` and do not run on a current schema; the two \"event loop stalled: max=72410ms\" lines occurred at 14:05Z and 17:05Z on a gateway running since 08-19, hours before the 17:34Z boot, and are unrelated. | Add per-statement timing inside `ensureMemoryIndexSchema` first; replace the `NOT IN` backfill with a count compare / indexed anti-join or defer it past listen; a meta flag would re-open the 2026-08-12 missing-FTS-rows bug for chunks written by other openers (interceptor-autoboot, skill-lifecycle); node:sqlite is synchronous, so \"async\" means a worker or chunked yielding. | M |",
    "reason": "3.10-3.11-12 partial and recommendation needs-change"
  },
  {
    "section": "3.10 First-run runtime",
    "find": "| 160 curator-report dirs, 22 quarantine entries, no pruning. | Keep last 20; expire quarantine after 30 days. | S |",
    "replace_with": "| 158 curator-report dirs (1.3 MB) with no pruning; quarantine already has a 30-day TTL sweeper (`quarantine-sweeper.ts`, PLAN-13 Phase C, running every consolidation tick: 51 rejections logged 08-19), 20 entries today, none older than 30 d. | Keep last N curator reports (cosmetic at 1.3 MB); quarantine expiry is already done; investigate the sweeper re-rejecting UUID-named entries with `age=20664d` on consecutive days. | S |",
    "reason": "3.10-3.11-13 partial, recommendation already-done"
  },
  {
    "section": "3.10 First-run runtime",
    "find": "| Hide until an installer ships. | S |",
    "replace_with": "| `hideHelp()` on `--app` and drop it from `--all` and the interactive picker; harmless today (darwin-guarded, no-op when the .app is absent; local Tauri builds do produce /Applications/Bitterbot.app). | S |",
    "reason": "3.10-3.11-14 recommendation needs-change"
  },
  {
    "section": "3.10 First-run runtime",
    "find": "| Duplicate per-agent state (`main.sqlite` 622 MB + `default.sqlite` 44 MB, `workspace` + `workspace-default`); cause unverified. | `doctor` detects orphaned DBs/workspaces; single `resolveDefaultAgentId`. | S |",
    "replace_with": "| Duplicate per-agent state (`main.sqlite` ~629 MB + `default.sqlite` 44 MB last written 2026-08-09, `workspace` + `workspace-default` + `workspace-dev`); cause identified: seven call sites pass a literal `agentId: \"default\"` (`a2a-http.ts:151,263,517`, `session-updates.ts:114,201`, `a2a-status-tool.ts:461`, `a2a-client-tool.ts:56`, `interceptor-runner.ts:246`) while the resolved default agent is `main`; `memory-search.ts:131` is only the filename template. | Replace those literals with `resolveDefaultAgentId(cfg)`; extend the existing `doctor-subsystems.ts:296-305` default-vs-main split check into a generic orphan detector over `memory/*.sqlite` and `workspace-*`. | S |",
    "reason": "3.10-3.11-15 partial and recommendation needs-change"
  },
  {
    "section": "3.10 First-run runtime",
    "find": "| `src/config/backup-rotation.ts:13` | Named `.bak-pre-*` backups bypass rotation and pile up. | `~/.bitterbot/backups/config/` with the same cap. | S |",
    "replace_with": "| `src/config/backup-rotation.ts:1` | Named `.bak-pre-*` files are manual operator copies (no code anywhere writes them; 4 `bitterbot.json.bak-pre-*` plus `genesis-trust.txt.bak-pre-relay-fleet`), so they cannot \"bypass\" a rotation they were never in; PLAN-37 already flags them for deletion because they hold old secrets. | Delete/redact them per PLAN-37 item 9; fold any product need into the P1 `bitterbot backup` item rather than a capped dir for files no code writes. | S |",
    "reason": "3.10-3.11-16 partial and recommendation needs-change"
  },
  {
    "section": "3.11 Channels",
    "find": "wizard offers \"iMessage (imsg)\" on every platform and dead-ends at \"does not support onboarding yet\"; CLI `--channel imessage` advertised; `docs.json:90` redirects `/channels/imessage` to `/channels`; `onboard-channels.e2e.test.ts:6` imports the nonexistent extension (only passes because e2e is excluded).",
    "replace_with": "wizard offers \"iMessage (imsg)\" on every platform (no platform gating; the documented `platforms` field is unimplemented) and dead-ends at \"imessage plugin not available.\" (`onboard-channels.ts:480`; the \"does not support onboarding yet\" branch is unreachable for it); CLI `--channel imessage` advertised; `docs.json:91` redirects `/channels/imessage` to `/channels`; `onboard-channels.e2e.test.ts:6` and `channels.adds-non-default-telegram-account.e2e.test.ts:4` import the nonexistent extension (never run: excluded from vitest and absent from every workflow; they would fail on import).",
    "reason": "3.10-3.11-18/19 partial"
  },
  {
    "section": "3.11 Channels",
    "find": "| Remove from registry/DOCKS/aliases and follow the `ChatChannelId` ripple; fix the stale test; keep `src/imessage` for a future darwin plugin. | M |",
    "replace_with": "| Remove from `CHAT_CHANNEL_ORDER` (the wizard list and the CLI `--channel` options derive from it, so no separate edit), `CHAT_CHANNEL_META`, `DOCKS`, aliases, `schema.labels.ts:212,267` and `QueueModeBySurfaceSchema`; delete the two stale e2e tests and the docs.json redirect; `src/imessage` has 12 importers outside it (dock, outbound, plugin-sdk, plugins/runtime), so \"keep\" means leaving those intact. | M |",
    "reason": "3.10-3.11-17/18/19 recommendation needs-change"
  },
  {
    "section": "3.11 Channels",
    "find": "| Ollama provider only built when a key exists; docs say `export OLLAMA_API_KEY=\"ollama-local\"` (\"any value works\"); no wizard or UI option; README claims \"local models\" supported. | First-class \"Local (Ollama)\" wizard group probing `127.0.0.1:11434`; \"Use a local model\" in ModelsView; treat an explicit `models.providers.ollama` entry as opt-in. | M |",
    "replace_with": "| Ollama provider only built when a key exists; docs say `export OLLAMA_API_KEY=\"ollama-local\"` (\"any value works\"); no labelled wizard or UI option, but the \"Custom Provider\" choice already pre-fills `http://127.0.0.1:11434/v1` and live-probes it (`onboard-custom.ts:11,283,538-551`); explicit `models.providers.ollama` entries still need a key because pi's ModelRegistry requires `apiKey`; README claims \"local models\" supported. | Promote the existing Custom Provider Ollama default into a labelled \"Local model (no key)\" choice reusing its probe and `buildOllamaProvider` discovery (`/api/tags`); inject a placeholder key for keyless local providers (prior art: the MINIMAX/QWEN OAuth placeholders in the same file); \"Use a local model\" in ModelsView; LM Studio (:1234) is net-new. | M |",
    "reason": "3.10-3.11-22/4-04 partial and recommendation needs-change"
  },
  {
    "section": "3.11 Channels",
    "find": "| 24 groups / ~45 choices in the wizard picker incl. deprecated \"Anthropic setup-token (no longer works)\", Z.AI Coding-Plan-Global/CN variants, Chutes third in the list. | Short list (Anthropic, OpenAI, Google, OpenRouter, Local, Custom) + \"More providers\"; delete the deprecated choice. | M |",
    "replace_with": "| 24 groups / 36 pickable choices (38 in the flat list) incl. Z.AI Coding-Plan-Global/CN variants and Chutes third; the deprecated \"Anthropic setup-token\" entry is already hidden from the interactive picker (anthropic group = apiKey only, `auth-choice-options.ts:36-42`) and survives only in the flat list behind `--auth-choice` help, as does an orphaned `zai-api-key`. | Short list (Anthropic, OpenAI, Google, OpenRouter, Local, Custom) + \"More providers\"; remove `token` and `zai-api-key` from `BASE_AUTH_CHOICE_OPTIONS` while keeping the legacy-alias validator. | M |",
    "reason": "3.10-3.11-23 partial and recommendation needs-change"
  },
  {
    "section": "3.11 Channels",
    "find": "| `package.json:172`, `registry.ts:19,46` | WhatsApp on `baileys 7.0.0-rc.9`; it is `DEFAULT_CHAT_CHANNEL` while docs say Telegram is the fastest; blurb recommends \"a separate phone + eSIM\". | Pin stable 7.x; Telegram as quickstart default; one-line ToS caution. | M |",
    "replace_with": "| `package.json:172`, `registry.ts:20,47` | WhatsApp on `baileys 7.0.0-rc.9` (five RCs behind `latest`=7.0.0-rc14; no stable 7.x has ever been published, `legacy`=6.7.24); it is `DEFAULT_CHAT_CHANNEL`, which is the default delivery channel for `send`/agent delivery/channel-auth, not the wizard default (the wizard already picks Telegram via `quickstartScore` 10 vs 4-5); blurb recommends \"a separate phone + eSIM\". | Bump to rc14 with a QR-link + send regression test, or fall back to 6.7.24 if a non-RC pin is required; Telegram is already the quickstart default (reconsider whether `DEFAULT_CHAT_CHANNEL` should follow the configured channel); one-line ToS caution. | M |",
    "reason": "3.10-3.11-25 partial and recommendation needs-change"
  },
  {
    "section": "3 Refuted table",
    "find": "No finding was refuted. The verification pass corrected 14 findings;",
    "replace_with": "No finding was refuted in the first verification pass; a second, two-lens pass over 337 claims (see `v1-release-audit-2026-08-21-verification.md`) refuted 5 and partially confirmed 199, and its corrections are applied inline above (complete find/replace list in that file's appendix). The first pass corrected 14 findings;",
    "reason": "second-pass summary"
  },
  {
    "section": "3 Refuted table",
    "find": "B5 is a relay-fleet ops item. Remaining gap is sender-key rotation on removal. **medium**, config-default + polish. |",
    "replace_with": "B5 is a relay-fleet ops item whose code is not yet activated (placeholder key, relays on 0.2.2). Sender-key rotation on removal is implemented (per-node by design); the open work is the B7 batch. **medium**, config-default + polish. |",
    "reason": "3.1-19 partial"
  },
  {
    "section": "4 Patterns",
    "find": "uv installer (SHA-256 verify, receipt file, `--no-modify-path`), Coolify (same script installs and upgrades)",
    "replace_with": "uv installer (SHA-256 verify only when `sha256sum` exists, silently skipped on stock macOS; receipt file; `--no-modify-path` is deprecated in favour of `UV_NO_MODIFY_PATH=1`), Coolify (install.sh is also the manual upgrade command and delegates to an `upgrade.sh`; n8n by contrast refuses to touch an existing install without `--upgrade`)",
    "reason": "4-03 partial"
  },
  {
    "section": "4 Patterns",
    "find": "`bitterbot onboard`, health poll, final line \"Bitterbot is running at http://localhost:19001\". Write `~/.bitterbot/install-receipt.json`. Re-run = update. | M |",
    "replace_with": "`pnpm bitterbot onboard` (a clone never produces a global bin), health poll, final line naming the real UI URL (http://localhost:19001 only after PLAN-39 Phase 2; `http://localhost:5173` until then). The `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD`/`NODE_LLAMA_CPP_SKIP_DOWNLOAD` vars are used nowhere in the repo (untested speculation). Re-run delegates to `bitterbot update` (which already has the auto-rollback watchdog) rather than implementing a second update path; the receipt file is deferred. Hosting text/plain at bitterbot.ai is an out-of-repo change (SPA catch-all today). | M |",
    "reason": "4-03/3.2-11/4-02 recommendation needs-change"
  },
  {
    "section": "4 Patterns",
    "find": "| AnythingLLM built-in LLM/embedder/LanceDB; Jan auto-downloads a default model; Msty hardware scan + auto-detects Ollama; LM Studio/GPT4All download-one-model | Wizard first choice \"Use a local model (no key)\" probing `127.0.0.1:11434` and `:1234`;",
    "replace_with": "| AnythingLLM built-in LLM (desktop-only, still downloads a model) / native embedder / LanceDB, no cloud key; Jan auto-downloads a default model on first launch; Msty Studio hardware scan (the \"auto-detects existing Ollama\" wording is in the legacy Msty app docs); LM Studio suggests a first model (official docs only say \"download your first LLM\"); GPT4All requires a manual \"+ Add Model\" | Wizard first choice \"Use a local model (no key)\" built on the existing Custom Provider path (`onboard-custom.ts:11,283` already defaults to `127.0.0.1:11434/v1`, allows a blank key and probes the endpoint; `:1234` is net-new);",
    "reason": "4-05 partial and recommendation needs-change"
  },
  {
    "section": "4 Patterns",
    "find": "| Run a one-token completion before writing provider keys in the wizard and in `models.auth.set`; extend validate-before-save (already on channels and model keys) to web-search, embeddings, wallet, skill API keys with a Test button beside every secret field | M |",
    "replace_with": "| Validate-before-save is enforced on channels only; for model keys the Test is optional (Save is not gated on a passing probe), `models.auth.set` never probes, the wizard's standard providers only format-check (`onboard-auth.ts`) while the custom-API path already runs a 16-token completion (`onboard-custom.ts:250-270`), and the existing probe is a GET `/models` list, not a completion. First make the existing path mandatory (gate Save on `probe.ok`, honouring `unsupported`; reuse `probeProviderKey` in `onboard-auth.ts` or add a server-side `verify: true` to `models.auth.set`); web-search/embeddings/wallet/skill keys have no UI fields today, so \"a Test button beside every secret field\" presupposes building them | M |",
    "reason": "4-06 partial; 4-07 recommendation needs-change"
  },
  {
    "section": "4 Patterns",
    "find": "| Home Assistant ConfigFlow (user/discovery/reauth/reconfigure, `async_set_unique_id`, `strings.json` for every error and abort) | `ChannelFlow` contract per plugin: steps, uniqueId (bot id/phone), strings map; one generic stepper in the Channels page; \"Needs re-authentication\" badges; Reconfigure reopens prefilled. Reuse declarations in `bitterbot onboard` and `configure --section channels` | L |",
    "replace_with": "| Home Assistant ConfigFlow (13 reserved steps incl. user/reauth/reconfigure/import plus per-transport discovery steps; the generic `discovery` step is deprecated; `async_set_unique_id`; `strings.json` error/abort maps, the \"every reason\" rule is hassfest tooling, not the doc) | Extend the existing plugin contract rather than add a new one: `onboarding-types.ts` (getStatus/configure per channel), the `setup` adapter, and the `loggedOut`/status-issue `auth` kind already exist; move `CHANNEL_SETUP_DESCRIPTORS` from the renderer into each plugin's `setup`/`configSchema` so the Channels page and `bitterbot onboard` read one declaration; surface `loggedOut` as the \"Needs re-authentication\" badge; Reconfigure reopens prefilled | M |",
    "reason": "4-08 partial and recommendation needs-change"
  },
  {
    "section": "4 Patterns",
    "find": "with name, one sentence, configPath, requiresRestart, docs link; rendered as a Labs section in Settings and `bitterbot config labs list|enable|disable`; rule: removed from Labs on graduation or two releases after abandonment | M |",
    "replace_with": "with name, one sentence, configPath, a state field (most listed flags are default-ON shipped features with kill switches, not opt-in experiments), docs link, and `requiresRestart` derived from the existing `config-reload.ts` rules rather than hand-declared; exclude `circles.p2pDial` until finding #2 lands (the strict schema rejects it, so `labs enable` would write a key doctor deletes); HA's runtime-toggle rule should gate what may appear in Labs at all; rendered as a Labs section in Settings and `bitterbot config labs list|enable|disable`; the \"two releases after abandonment\" rule is Bitterbot's own, HA documents only procedural graduation/removal checklists | M |",
    "reason": "4-09/4-10 recommendation needs-change"
  },
  {
    "section": "4 Patterns",
    "find": "| HA deprecating `show_advanced_options` (\"a single binary switch that gates unrelated features\"); OpenClaw `uiHints` common vs advanced | Populate the already-declared `advanced` hint in `schema.hints.ts` (ADVANCED_PATHS); ConfigView opens common fields, advanced under a per-section disclosure; raw JSON5 editor stays as the second view with base-hash guard | M |",
    "replace_with": "| HA deprecating `FlowHandler.show_advanced_options` (removal in Core 2027.6) as part of removing the profile-level Advanced mode toggle (\"a single binary switch that gates a collection of unrelated features across Home Assistant\"); OpenClaw `uiHints` common vs advanced | Populate the declared-but-unused `advanced` hint in `schema.hints.ts` (no `ADVANCED_PATHS` exists; no path sets `advanced: true`; nothing in the renderer reads uiHints) AND teach ConfigView to consume it: common fields open, advanced under a per-section disclosure; the raw JSON5 editor with base-hash guard already exists; also apply per-step disclosure to the wizard, whose quickstart/advanced `flow` flag is exactly the global switch HA is removing | M |",
    "reason": "4-12 partial and recommendation needs-change"
  },
  {
    "section": "4 Patterns",
    "find": "| Search input in ConfigView filtering leaf paths from `config.schema` (title + description + dotted path) and deep-linking to the field; same box from the sidebar reaches Models & Keys, Channels, P2P, raw config | M |",
    "replace_with": "| Search input in ConfigView filtering leaf paths from `config.schema` (title + description + dotted path) and deep-linking to the field, which presupposes pattern 6 (there is no rendered form to deep-link into today); a sidebar-wide box reaching Models & Keys, Channels, P2P needs a separate static route/keyword index because those views are not config.schema-backed | M |",
    "reason": "4-13 recommendation needs-change"
  },
  {
    "section": "4 Patterns",
    "find": "| Open WebUI PersistentConfig (env seeds DB on first launch, then UI wins, `ENABLE_PERSISTENT_CONFIG`); Claude Code `/status` \"Setting sources\" and a precedence table; Vaultwarden warns config.json overrides env | One paragraph in `docs/gateway/configuration.md` (CLI flag > env > bitterbot.json > default); generalize the Models & Keys \"source\" badge to every ConfigView field; `bitterbot config explain <path>`; warning chip for unresolved `${VAR}` | S |",
    "replace_with": "| Open WebUI ConfigVar (formerly PersistentConfig: env seeds the DB on first launch, then UI wins, `ENABLE_PERSISTENT_CONFIG`); Claude Code `/status` lists the settings FILES it loaded (its docs say it does not show which file supplied each key; env vars sit outside its precedence stack) and publishes a precedence list; Vaultwarden warns config.json overrides env | One paragraph per class in `docs/gateway/configuration.md`, not a uniform chain: the gateway token is config-first (`auth.ts:187`), provider credentials are profiles-first (PLAN-37, `models-auth.ts:90`), `config.env` is env-first, and most keys have no env equivalent at all; generalize the Models & Keys `winningSource` badge only where more than one source can win (credentials, `gateway.auth.token`, `update.channel`, `${VAR}` leaves) via a `source` map from `config.get`, there is no generic per-path resolver to reuse; `bitterbot config explain <path>` modelled on `sandbox explain`; warning chip for unresolved `${VAR}` | S (doc) + M (badge) |",
    "reason": "4-15/4-16/4-17 partial and recommendation needs-change"
  },
  {
    "section": "4 Patterns",
    "find": "| LibreChat (everything needs `docker compose down`, a known pain) vs Open WebUI live admin UI; Bitterbot `config.patch` already diffs against reload rules | Expose the reload classification in `config.schema` (`x-reload: hot|restart`), render a \"restarts gateway\" chip, show the post-save reload summary as a toast | S |",
    "replace_with": "| LibreChat docs require `docker compose down && up -d` for any librechat.yaml change (the \"pain\" is this report's gloss; #11175 shows a Redis cache makes even that insufficient) vs Open WebUI ConfigVar settings editable live from the Admin UI; Bitterbot `config.patch` already diffs against reload rules and RETURNS the plan (`reload.mode/hotReasons/noopPaths` or `restartReasons`) but the Control UI saves via `config.apply`, which skips the plan, always schedules a SIGUSR1 restart and whose response ConfigView discards | First switch ConfigView from `config.apply` to `config.patch` and render the returned summary as a toast (nearly free; removes the forced restart on every UI save); then derive `x-reload` in `config.schema` mechanically from `config-reload.ts` (note unmatched prefixes such as p2p/memory/a2a/forage default to restart, so audit the rule table) and render the \"restarts gateway\" chip | S |",
    "reason": "4-18/4-19 partial and recommendation needs-change"
  },
  {
    "section": "4 Patterns",
    "find": "| RPC over `doctor` findings; Repairs cards on Overview next to UpdateCard (severity, why, Fix or Show me how); sidebar badge; `bitterbot doctor --list/--run <check>`; `bitterbot bugreport` | M |",
    "replace_with": "| RPC relaying the existing `doctor --json` findings (run doctor as a subprocess, not in-process: it probes the gateway from outside, runs model/agent-turn probes and writes config on `--fix`); Repairs cards on Overview next to UpdateCard (Fix buttons only for config-write/gateway-side repairs); reuse the existing `AttentionBadge` for the sidebar count; `--list/--run <check>` as filters on the existing section runners (`--fix` already exists); `bitterbot bugreport` as `status --all` + `doctor --json` + redacted config + log tail rather than a third diagnostics surface | M |",
    "reason": "4-20/4-21 recommendation needs-change"
  },
  {
    "section": "4 Patterns",
    "find": "| Letta memory blocks (label/description/value/limit, char count vs limit, context-window viewer); Claude.ai Settings > Memory (categorized summary, Pause/Reset/incognito, \"tell Claude what to change\"); ChatGPT \"Memory updated\" + `/memories` per chat |",
    "replace_with": "| Letta memory blocks (label/description/value/limit; `chars_current` vs `chars_limit` is reported to the agent, the viewer's display of it is not stated in primary docs; context-window viewer); Claude.ai Settings > Memory (categorized summary, Pause/Reset/incognito, \"tell Claude what to change\"); ChatGPT \"Memory updated\" chip (documented in OpenAI's announcement, not at the cited learn.chatgpt.com page, which documents `/memories` per chat) |",
    "reason": "4-22 partial"
  },
  {
    "section": "4 Patterns",
    "find": "\"Memory updated: <block>\" chip under replies; crystals/RRF/bitemporal behind Details | M |",
    "replace_with": "\"Memory updated: <block>\" chip under replies; crystals/RRF/bitemporal behind Details. Build it as PLAN-33 Phase 4 (dashboard pane + CANONICAL.md mirror), not a new page, and add a `memory` rule to `config-reload.ts` before shipping a Pause toggle, otherwise every click schedules a gateway restart (memory.* is unmatched today). The four block names are this report's design, not drawn from any source | M |",
    "reason": "4-22 recommendation note"
  },
  {
    "section": "4 Patterns",
    "find": "| Immich nightly DB dumps (keep 14, UI restore, auto restore point); `gitea dump`; `vaultwarden backup` (SQLite online backup API); Coolify Settings > Backup with honest scope note; HA Labs one-click backup before enabling a preview feature |",
    "replace_with": "| Immich daily 02:00 DB dumps (keep 14, UI restore, automatic restore point taken before a restore, not before upgrades); `gitea dump` (instance must be shut down); `vaultwarden backup` (since 1.32.1; its implementation is `VACUUM INTO`, the online backup API is what the wiki recommends for the sqlite3 CLI); Coolify Settings > Backup with honest scope note; HA Labs one-click backup before enabling a preview feature |",
    "reason": "4-26 partial"
  },
  {
    "section": "4 Patterns",
    "find": "The pile of `bitterbot.json.bak-pre-*` files is the evidence this is missing | L |",
    "replace_with": "The pile of `bitterbot.json.bak-pre-*` files (manual operator copies, 4 plus genesis-trust) is the evidence this is missing. Caveats: the only existing mechanism is the 5-deep config rotation (fold it in rather than add a third convention); at least four WAL-mode SQLite files live under ~/.bitterbot, so a consistent snapshot needs `VACUUM INTO` / `db.backup()` through the gateway's open handles, not a file copy from a CLI while the gateway runs; tar.zst needs Node >= 22.15 for node:zlib zstd (engines say >= 22.12) so use gzip or bump; the passphrase-encrypted keys element overlaps PLAN-37 | L |",
    "reason": "4-25/4-26 recommendation needs-change"
  },
  {
    "section": "4 Patterns",
    "find": "| Immich Version Check (Stable vs RC); Coolify sidebar Upgrade; HA Updates page with backup toggle and \"read all release notes between versions\"; Tailscale grey vs red arrows; LM Studio app and runtimes on separate clocks with release notes | Bitterbot already has in-UI update + drift prompts + auto-rollback. Add channel selector (stable/beta) in Settings > Updates; `breaking` flag in the release manifest that blocks one-click update until notes are opened; \"Back up before updating\" default on once #14 exists; gateway and orchestrator as separately updatable rows; 24 h snooze; `update.checkEnabled` kill switch | S |",
    "replace_with": "| Immich Version Check Stable vs Release candidate (documented in the v3.0.0 release post, not the system-settings page); Coolify sidebar Upgrade; HA Updates page with backup toggle and \"read all release notes between versions\"; Tailscale grey vs red arrows (admin console); LM Studio app and llama.cpp/MLX runtimes on separate clocks | Bitterbot already has in-UI update + drift prompts + auto-rollback, AND `update.channel` (stable/beta/dev) in config + CLI `--channel`, `update.checkOnStart=false` as the check kill switch, and a per-sha banner dismiss. Add: a UI selector over the existing `update.channel` (S); a timestamp on the existing dismiss if a timed snooze is wanted; expose `checkOnStart` in the UI rather than adding `update.checkEnabled`; a `breaking` flag needs a manifest/tag convention that does not exist for git installs (M); \"Back up before updating\" after #14; the orchestrator already refreshes via the postinstall fetcher on `update.run`, so a separate row is informational (version/drift), not a separate update action | S + M |",
    "reason": "4-27/4-28 partial and recommendation needs-change"
  },
  {
    "section": "4 Patterns",
    "find": "`release-please-config.json` for `.`, `orchestrator` (`orchestrator-v`), `desktop` (`desktop-v`); `actions/attest-build-provenance` + cosign bundle in orchestrator/desktop/docker workflows; installer verifies sha256 from checksums.txt; move `playwright` to devDependencies, node-llama-cpp/canvas to optionalDependencies, `bitterbot browser install` on demand; doctor lines for \"browser available\", \"local LLM available\", \"native deps loaded\" | M |",
    "replace_with": "`release-please-config.json` (nothing exists today; the `desktop` component is not ready, its version is split 0.1.0 in tauri.conf/src-tauri vs 2026.2.15 in desktop/package.json so `extra-files` are required; the `orchestrator` component only mints unpublishable tags until signing is activated); minisign end-to-end first, `actions/attest-build-provenance` as an optional later add-on (needs `id-token`/`attestations: write`), drop cosign (duplicate trust root, the remediation doc chose minisign); there is no docker workflow to attest; installer sha256 verification already exists in `fetch-orchestrator.mjs` and in shell form in `update-orchestrator.sh:83-99`; drop the unused `playwright` meta-package (nothing imports it; keep `playwright-core`), move node-llama-cpp/canvas from peerDependencies (not devDependencies) to optionalDependencies (runtime detection already exists); no `bitterbot browser install` (the browser layer attaches over CDP to a system Chrome; a \"Chrome-family browser found at <path>\" doctor line via the existing resolver is the right shape); \"local LLM available\" already exists (`doctor-memory-search.ts:69-79`); \"native deps loaded\" is the genuinely missing doctor check | M |",
    "reason": "4-29/4-30 partial and recommendation needs-change"
  },
  {
    "section": "4b Deep research",
    "find": "and it is stricter: every claim below survived three independent attempts to refute it against the primary source. It explicitly found no surviving evidence on status/health pages, update flows, activity feeds, versioning, release automation, or artifact signing, and no evidence tying any pattern to adoption metrics; for those areas section 4 (single-agent research) is the only input and should be weighted accordingly.",
    "replace_with": "but it is not demonstrably stricter: two HA sub-claims passed only 2-1, the same 3-vote verifier falsely refuted three claims that their cited pages state verbatim (see below), and 106 of the 131 extracted claims were never voted on (110 = agent calls, not distinct agents). It has no VERIFIED claims on status/health pages, update flows, activity feeds, versioning, release automation, or artifact signing, and none tying any pattern to adoption metrics; sources on those angles (Immich x4, Coolify, n8n, HA repairs/update/versioning) WERE fetched and ~50 claims extracted but dropped by the top-25 budget, so re-verifying those extracted claims is cheaper than new research; section 4 remains the only input meanwhile.",
    "reason": "4b-01/4b-02 partial and recommendation needs-change"
  },
  {
    "section": "4b Deep research",
    "find": "| D1/D5 packaging: if Tauri ships post-V1, the orchestrator goes in `bundle.externalBin` with one binary per target triple from the release matrix; budget for tauri#11992 (macOS sidecar notarization) before promising a signed DMG. |",
    "replace_with": "| D1/D5 packaging: externalBin is already declared and CI-built for the gateway SEA (`tauri.conf.json:38`, `build-sea.mjs`, `desktop-release.yml:134-136`), though `main.rs:63` still spawns `node` rather than the sidecar API. The orchestrator is spawned by the gateway, which resolves it by fixed name (`orchestrator-binary.ts:53-69`), so putting it in externalBin (which renames to `-<triple>`) would hide it unless the shell passes the path via `p2p.orchestratorBinary`; `bundle.resources` or the existing fetcher is the simpler slot; release assets use Node platform names (`darwin-arm64`) and would need renaming to rust triples. tauri#11992 is a single untriaged 2024 report with no maintainer reply, contradicted by Jan's notarized externalBin builds: do a signed+notarized test build instead of budgeting around it. |",
    "reason": "4b-03/4b-04/4b-05 recommendation needs-change"
  },
  {
    "section": "4b Deep research",
    "find": "but these are vendor-stated, not measured, and the shipped Tauri builds are still 55-200 MB because the llama.cpp/cortex sidecar dominates size. | 3-0 (both merged claims) | D1: keep Tauri post-V1. Jan is the closest precedent and its installer is still 55-200 MB because the sidecar dominates; Bitterbot would carry Node + Chromium/Playwright + the Rust sidecar, so the size win is not there. |",
    "replace_with": "but only the memory/CPU/security claims are unmeasured: the size win IS measurable from Jan's own releases (Windows installer 1214 MB -> 55 MB, AppImage 1495 -> 150, universal DMG 231 -> 97 between the last Electron v0.5.17 and Tauri v0.8.4); current builds are 55-150 MB and bundle bun/uv sidecars (plus mlx-server on macOS), not an inference engine (cortex was dropped after v0.6.0, whose 208 MB-1 GB installers are the only ones near 200 MB; llama.cpp backends download at first run). #3735 does not mention Electron; the rationale is in #4485 only. | 3-0 (both merged claims; 2nd pass: partially confirmed) | D1: keep Tauri post-V1 on schedule grounds; \"the size win is not there\" is unsupported by Jan. Bitterbot's floor is its own Node SEA sidecar plus the 12-14 MB orchestrator; Playwright is already externalized from the gateway bundle and should stay a first-run download, matching Jan's llama.cpp precedent. |",
    "reason": "4b-06/4b-07/4b-08 partial and recommendation needs-change"
  },
  {
    "section": "4b Deep research",
    "find": "downloading a prebuilt per-arch tarball (ollama-linux-{amd64,arm64}.tar.zst with .tgz fallback) into $PREFIX/lib/ollama and symlinking into PATH on Linux,",
    "replace_with": "downloading a prebuilt per-arch tarball (ollama-linux-{amd64,arm64}.tar.zst; the .tgz fallback only serves pinned older versions, current releases are .tar.zst only) into the prefix of the first PATH bin dir (/usr/local, /usr or /) so bin/ollama lands directly on PATH (the symlink branch is effectively dead code) on Linux; Ollama also ships an install.ps1 for Windows,",
    "reason": "4b-09 partial"
  },
  {
    "section": "4b Deep research",
    "find": "| P0 WP4 `install.sh`: copy the shape literally. `main()` guard, per-arch tarball or pinned git ref, service user + systemd/launchd unit as an opt-in, print the URL + token location at the end, zero questions. Add what Ollama lacks: a checksum check on the orchestrator binary (already done in `scripts/fetch-orchestrator.mjs`). |",
    "replace_with": "| P0 item 3 / D1 `install.sh` (there is no \"WP4\"): copy the `main()` guard; a pinned git ref, not a per-arch tarball (no app tarball exists for a Node app with native addons); no dedicated service user (Ollama needs one because it is stateless per user; Bitterbot's config, keys and memory DBs live in `$HOME/.bitterbot` and the daemon code is per-user) and Ollama's unit install is unconditional, not opt-in; reuse the wizard's existing daemon-install step (systemd user unit, launchd, schtasks) instead of emitting a new unit; the URL + token-location print line belongs in the wizard finalize step; \"zero questions\" conflicts with DoD 1 (risk ack, provider + key). The SHA-256 check already exists in the fetcher; the missing piece is `.minisig` verification once a signed release exists. |",
    "reason": "4b-09/4b-10/4b-11 recommendation needs-change, already-done"
  },
  {
    "section": "4b Deep research",
    "find": "| D8 Docker: one `docker run` with one named volume for `~/.bitterbot`, image on GHCR, tags `:latest`, `:1.0.0`, `:git-<sha>`; a `:slim` variant without Playwright/Chromium is the analogue of `:main-slim`. |",
    "replace_with": "| D8 Docker: a named-volume run already exists (`docker-setup.sh` `BITTERBOT_HOME_VOLUME`; compose bind-mounts `~/.bitterbot`); the missing pieces are the Dockerfile fix and a GHCR publish workflow (tags `:1.0.0`, `:git-<sha>`; make `:latest` track the newest stable, not Open WebUI's rolling `:main`=`:latest` footgun). No `:slim` variant is needed: the image bakes no Chromium today (playwright has no postinstall and the Dockerfile never runs `playwright install`); if browser tooling is wanted in Docker it is an opt-in `:browser` addition. |",
    "reason": "4b-13 recommendation needs-change"
  },
  {
    "section": "4b Deep research",
    "find": "However, the stronger claim that it auto-discovers a running Ollama with zero configuration was REFUTED (0-3): the Ollama connection must be configured first. | 3-0 (both merged claims); auto-discovery claim refuted 0-3 | Wizard: do not ask for a model key before the first screen. First browser visit claims the instance (token handoff), then the model picker offers 'Add a key' or 'Use Ollama' inline; do not claim auto-discovery of Ollama unless it is implemented and tested. |",
    "replace_with": "The 0-3 refutation of \"auto-discovers a running Ollama with zero configuration\" was itself wrong: the cited page says Open WebUI \"will automatically attempt to connect to your Ollama instance\" at its built-in default URL (`localhost:11434`, `host.docker.internal:11434` in Docker); it is default-URL probing, not service discovery, and the Admin Settings step is for changing it. (The data-local sentence is on the quick-start page, not the roles page; pending default is `DEFAULT_USER_ROLE=pending` in config.py:1699.) | 3-0 (both merged claims); Ollama refutation REVERSED in the 2nd pass | Wizard: do not ask for a model key before the first screen. \"First browser visit claims the instance\" is a duplicate of P0 item 19 and not the Open WebUI mechanism (signup creates the admin; Bitterbot has no accounts and FirstRun is a paste-token screen); the browser UI already never asks for a model key, the ordering problem is the CLI wizard's auth step, so make it skippable and surface 'Add a key' / 'Use a local model' inline in Models & Keys; Open WebUI is a precedent FOR probing `127.0.0.1:11434` by default, not against claiming it. |",
    "reason": "4b-15 refuted; 4b-14 recommendation needs-change"
  },
  {
    "section": "4b Deep research",
    "find": "| 3-0 (wizard), 2-1 (roadmap framing), 2-1 (critical-steps belief) | Wizard + Overview: cap the wizard at ~5 screens (claim instance, model, optional channel, network consent, done) and move everything else to a post-wizard 'Next steps' card on Overview, which is where HA's product team says the real onboarding happens. |",
    "replace_with": "| 3-0 (wizard; HA's own UX lead counts the shipped wizard as 6 screens incl. device discovery), 2-1 (roadmap framing), 2-1 (critical-steps belief; issue #25 was closed as duplicate with no recorded target, presumably #123, which proposes moving area/floor setup INTO the wizard) | Wizard + Overview: tighten QuickStart (risk ack + model/auth + gateway + optional channel + done; \"claim instance\" is a UI concern, not a CLI screen) and leave the Manual flow long; a post-wizard 'Next steps' card on Overview (none exists) holds reversible add-ons (channels, skills, wallet, web search, genome), while costly-to-change choices (workspace, bind/auth, P2P consent) stay in the wizard, which is the direction HA's successor issue actually takes. |",
    "reason": "4b-16/4b-17 recommendation needs-change"
  },
  {
    "section": "4b Deep research",
    "find": "(b) a two-tier PersistentConfig/ConfigVar scheme where env vars seed settings only on first launch and thereafter the database value wins and the env value is ignored on restart; (c) one kill switch, ENABLE_PERSISTENT_CONFIG=False, flips precedence so env/config is the source of truth and Admin UI edits become session-only; (d) restart-required handling is documented per variable: ConfigVar settings are hot-editable from the UI, while non-ConfigVar infra settings carry the annotation 'This variable is read once at startup and requires a restart to change.' | 3-0 (all four merged claims) | D5/3.3 Configuration model: this is the template for the Settings rewrite. Basic form in the UI + an explicit 'Advanced' tier + raw JSON disclosure; file seeds on first launch, UI edits persist; one documented precedence kill switch; every schema key annotated `hot` vs `restart-required` and the UI shows a restart banner only when a restart-required key changed. |",
    "replace_with": "(b) a per-key `Config` model in `backend/open_webui/models/config.py` (no `PersistentConfig` class exists on main or v0.11.0; `env.py` holds none of it) where env vars seed settings only on first launch and thereafter the database value wins; (c) two kill switches, `ENABLE_PERSISTENT_CONFIG` and `ENABLE_OAUTH_PERSISTENT_CONFIG` (config.py:3186-3187), flip precedence so env is the source of truth and Admin UI edits become session-only; (d) the exact sentence 'read once at startup and requires a restart to change' appears once on the docs page; the recurring non-ConfigVar annotation is 'read once at startup; it is not a ConfigVar and cannot be changed from the Admin UI'. | 3-0 (all four merged claims; 2nd pass: partially confirmed) | D5/3.3 Configuration model: basic form in the UI + an explicit 'Advanced' tier + raw JSON disclosure. \"File seeds on first launch, UI edits persist\" and the precedence kill switch are Open WebUI's DB model and do not map: Bitterbot has one store (`bitterbot.json`) that UI and CLI both edit; a kill switch only makes sense for env-var overrides. Hot vs restart already exists per prefix in `config-reload.ts` and `config.patch` already returns it; the missing piece is the renderer consuming that response (and optionally exporting the rule table through `config.schema`), not annotating every schema key. |",
    "reason": "4b-18 partial and recommendation needs-change"
  },
  {
    "section": "4b Deep research",
    "find": "so Circles, P2P dashboard, Dreams dashboard, Wallet, Workspace, Guards qualify only if their UI mounts/unmounts dynamically; anything that changes boot (p2p.enabled, embeddings provider) is an Advanced setting with a restart banner, not a Labs flag. |",
    "replace_with": "derived from `config-reload.ts` rather than from whether UI panels mount dynamically: a flag qualifies when its config path resolves to kind none/hot in the reload rule table (today `circles.*` does; `p2p.*`, `memory.*`, `a2a.*`, `forage.*` have no rule and fall through to restart-required, so they need a rule added if they are really read at runtime, or live under Advanced with the restart banner); pattern 5's `requiresRestart` should be computed from that table. |",
    "reason": "4b-19 recommendation needs-change"
  },
  {
    "section": "4b Deep research",
    "find": "- (0-3) Jan ships its native inference backend (cortex-server / llama.cpp) as a Tauri sidecar binary placed in src-tauri/binaries per the Tauri v2 sidecar convention, and the issue flags that a sidecar needs a watchdog/self-restart spawner and multi-architecture binary bundling to be production-ready. Source checked: https://github.com/janhq/jan/issues/4485",
    "replace_with": "- (0-3; REVERSED in the 2nd pass) Jan ships its native inference backend (cortex-server / llama.cpp) as a Tauri sidecar binary placed in src-tauri/binaries per the Tauri v2 sidecar convention, and the issue flags that a sidecar needs a watchdog/self-restart spawner and multi-architecture binary bundling to be production-ready. Source checked: https://github.com/janhq/jan/issues/4485. The issue says this almost verbatim (\"Copy cortex-server binary into `src-tauri/binaries`\", \"runs as a sidecar process without a watchdog\"); it is a 2025 roadmap for a design Jan has since replaced (current externalBin = bun/uv; llama.cpp is a Tauri plugin). Cite it as a historical design note, not as a shipped watchdog.",
    "reason": "4b-20 refuted (the refutation was wrong)"
  },
  {
    "section": "4b Deep research",
    "find": "- (0-3) Open WebUI's first-run onboarding is zero-question for the local-provider case: after install it auto-discovers and connects to a running Ollama instance on its default port without any user configuration. Source checked: https://docs.openwebui.com/getting-started/quick-start/connect-a-provider/starting-with-ollama/",
    "replace_with": "- (0-3; REVERSED in the 2nd pass) Open WebUI's first-run onboarding is zero-question for the local-provider case: after install it auto-discovers and connects to a running Ollama instance on its default port without any user configuration. Source checked: https://docs.openwebui.com/getting-started/quick-start/connect-a-provider/starting-with-ollama/. The page states \"it will automatically attempt to connect to your Ollama instance\" and `OLLAMA_BASE_URL` defaults to `http://localhost:11434`; this is default-URL probing, not discovery, but the claim is supported.",
    "reason": "4b-15 refuted (the refutation was wrong)"
  },
  {
    "section": "4b Deep research",
    "find": "- (1-2) Jan's documented install path is a three-step installer flow (download from jan.ai/download, run the platform installer, launch) with no terminal or dependency setup required. Source checked: https://www.jan.ai/docs/desktop/quickstart",
    "replace_with": "- (1-2; REVERSED in the 2nd pass) Jan's documented install path is a three-step installer flow (download from jan.ai/download, run the platform installer, launch) with no terminal or dependency setup required. Source checked: https://www.jan.ai/docs/desktop/quickstart. The page lists exactly \"Download Jan / Install the app (Mac, Windows, Linux) / Launch Jan\" and never mentions a terminal; the claim is supported.",
    "reason": "4b-20 refuted (the refutation was wrong)"
  },
  {
    "section": "4b Deep research",
    "find": "- (0-3) Jan reaches first success without asking the user any questions: it auto-downloads a default local foundation model on first launch and the user can chat once the download completes. Source checked: https://www.jan.ai/docs/desktop/quickstart",
    "replace_with": "- (0-3; REVERSED in the 2nd pass) Jan reaches first success without asking the user any questions: it auto-downloads a default local foundation model on first launch and the user can chat once the download completes. Source checked: https://www.jan.ai/docs/desktop/quickstart. The page says verbatim \"Jan automatically downloads its default foundation model on first launch. Once the download completes, you're ready to chat, no setup required\"; section 4 row 2 already cites this correctly. Jan MAY be cited as a zero-question first-run precedent.",
    "reason": "4b-20 refuted (the refutation was wrong)"
  },
  {
    "section": "4b Deep research",
    "find": "Jan's Tauri benefits are vendor-stated and partly contradicted by independent measurements (Tauri memory on Linux WebKitGTK exceeds Electron; shipped Jan builds are 55-200 MB because the inference sidecar dominates), and the refuted Jan claims mean Jan should not be cited as a documented externalBin/watchdog example. Ollama's installer performs no checksum or signature verification and requires root/sudo plus possible CUDA driver installation on Linux,",
    "replace_with": "Jan's memory/CPU benefits are vendor-stated; one 2022 Tauri-1.x benchmark by an Electron-affiliated engineer (tauri#5889, closed 2024 as a discussion) found Tauri above Electron on all three desktop OSes, largest on Linux; the size benefit itself is measured from Jan's release assets (1 GB -> 82-150 MB on Linux) and shipped builds are 55-150 MB bundling bun/uv/mlx, not the inference engine; Jan may be cited as a documented zero-question first-run and externalBin precedent, though not as a watchdog implementation. Ollama's installer performs no checksum or signature verification (Ollama does publish `sha256sum.txt`; the script ignores it), requires root/sudo on Linux only (macOS runs unprivileged), plus possible CUDA driver installation on Linux,",
    "reason": "4b-06/07/08/11/20 partial"
  },
  {
    "section": "4b Deep research",
    "find": "Home Assistant roadmap claims (2-1 votes) are stated intent labelled 'Considering', the original issue was closed as duplicate of a narrower one, and the 'measurable' hindrance has no data behind it. Time-sensitivity: Tauri docs and the open notarization bug (#11992),",
    "replace_with": "Home Assistant roadmap claims (2-1 votes) are stated intent (labelled 'status: proposal' on GitHub, 'Considering' in the OHF Roadmap project), the original issue was closed as duplicate with no recorded target (presumably #123, which moves area setup into the wizard, the opposite direction), and the 'drastically' hindrance has no data behind it. Time-sensitivity: Tauri docs and the dormant, untriaged notarization report (#11992, single reporter, no activity since 2024-12, contradicted by Jan's notarized externalBin builds),",
    "reason": "4b-17/4b-04 partial"
  },
  {
    "section": "5 P0",
    "find": "1. Publish `orchestrator-v0.2.3` (set minisign secrets, push tag, verify 302); CI guard for Cargo version vs published release; fetcher fallback with loud warning; doctor error instead of warn. (S)",
    "replace_with": "1. Publish `orchestrator-v0.2.3`: run SIGNING.md steps 1-5 (keypair; embed pubkey in `update-orchestrator.sh:40`; `MINISIGN_SECRET_KEY` secret, 0 repo secrets exist; create the protected `release` environment, 404 today), push the tag, verify 302 on checksums.txt and `.minisig`; tag-equals-Cargo check in the release workflow + a post-merge check (not a PR guard); no fetcher fallback; doctor stays at warn (error blocks the update gate); fix the four stale \"re-run pnpm install\" hints. (S)",
    "reason": "P0-A.1 recommendation needs-change"
  },
  {
    "section": "5 P0",
    "find": "3. Docs Step 1: README git-clone flow (or real installer per D1); delete npm/curl claims, `test:install:*`, `test:docker:*`; fix windows.md clone URL; docs lint. (S)",
    "replace_with": "3. Docs Step 1: README git-clone flow (or real installer per D1, which also needs text/plain hosting on bitterbot.ai); delete npm/curl claims, `test:install:*`, `test:docker:*`; fix all 14 `github.com/bitterbot/bitterbot` URLs and the windows.md block; fix the dangling `/install` link and docs.json install/* pages; grep step inside the existing `check:docs`. (S)",
    "reason": "P0-A.3 recommendation needs-change"
  },
  {
    "section": "5 P0",
    "find": "4. Docker: fix per D8 with a `docker build` CI job, or delete plus docs entries. Delete Podman files. (M or S)",
    "replace_with": "4. Docker: fix per D8 (= PLAN-39 D4; image fix is two Dockerfile lines plus dropping the UI build step, orchestrator fetched outside the mounted tree), then a `docker build` CI job; or delete incl. `src/docker-setup.test.ts`, `.dockerignore` and docs entries. Delete Podman files (supersedes PLAN-37 row 39). (S + M, or S)",
    "reason": "P0-A.4 recommendation needs-change"
  },
  {
    "section": "5 P0",
    "find": "5. `bitterbot dashboard` and docs point at the real UI port; finalize health check uses the 90 s poll; remove `npx playwright` from setup-deps; fix preinstall-check promise; corepack pnpm line. (S x5)",
    "replace_with": "5. `resolveControlUiLinks` (all six callers incl. `status`, `configure`, daemon status) and docs point at the real UI port and drop the unread `#token=` fragment; finalize health check uses the 90 s poll with the soft \"still starting\" note kept; remove `npx playwright` from setup-deps and drop the unused `playwright` package; fix preinstall-check promise; corepack pnpm line with an `npm i -g pnpm@10.23.0` fallback. (S x5)",
    "reason": "P0-A.5 recommendation needs-change"
  },
  {
    "section": "5 P0",
    "find": "6. Keyless memory path (D7): `auto` falls back to local GGUF with auto-download + kill switch; health RPC exposes manager error; Control UI \"Memory is offline\" banner; wizard local option default for Anthropic. (M)",
    "replace_with": "6. Keyless memory path (D7): `auto` reaches the existing local GGUF download last in the chain (after remote keys), only after node-llama-cpp and sqlite-vec load, with a kill switch and progress log; health RPC exposes the manager error (the `/dreams` iframe page needs it too, plus `status.scan.ts` stops discarding it); Control UI \"Memory is offline\" banner; wizard local option (after a node-llama-cpp probe) default for Anthropic; omit `provider` on blank key. (M)",
    "reason": "P0-A.6 recommendation needs-change"
  },
  {
    "section": "5 P0",
    "find": "7. P2P `keyDir` default under state dir, always pass `--key-dir`, migration, reset/uninstall coverage, docs fix. (S-M)",
    "replace_with": "7. P2P `keyDir` default per PLAN-37 D5 (`~/.bitterbot/keys`), always pass `--key-dir`, migration from `<repo>/keys`, `<repo>/desktop/keys` and `~/keys` plus the co-located genesis/bootnode files, fail-hard for management tier, reset/uninstall coverage, doc fix (doctor-identity is already correct; the /tmp socket needs no cleanup, the orchestrator unlinks it). (S-M)",
    "reason": "P0-A.7 recommendation needs-change"
  },
  {
    "section": "5 P0",
    "find": "8. Boot stall: per-plugin timing + native-FS reproduction; then precompile extensions / async load if it reproduces; stop sync FTS repair before listen. (S, then M if needed)",
    "replace_with": "8. Boot stall: first try `NODE_ENV=production` / prefer `dist/plugin-sdk/index.js` in the alias order (the plugin-sdk alias drags ~1,900 src modules through jiti); then per-plugin timing + native-FS reproduction; defer the hormonal accessor's first refresh past listen; measure the FTS backfill before touching it; skip \"precompile extensions\". (S, then M if needed)",
    "reason": "P0-A.8 recommendation needs-change"
  },
  {
    "section": "5 P0",
    "find": "9. A2A bypass to loopback only + `safeEqualSecret` + tests + audit check. (S)",
    "replace_with": "9. A2A bypass via `isLocalDirectRequest` (loopback-only still waives every tailscale-serve caller; also disable the waiver when `gateway.tailscale.mode != off`) + Origin/Host check on POST /a2a + `safeEqualSecret` + tests with 192.168.1.10 and 100.64.0.5 + audit check for bind != loopback or tailscale != off. (S)",
    "reason": "P0-B.9 recommendation needs-change"
  },
  {
    "section": "5 P0",
    "find": "10. Default flips per D3/D4 and the two small defaults: circles, practicePartner, marketplace, payment, forage.nightShift, forage.audit, skillSeekers, marketability, harnessEvolve, curiosity, rlm, architectEvolution, tools.wallet, sandbox explicit opt-in; bundled twitch/device-pair/phone-control/talk-voice out of the default-enabled set. One wizard consent step for the network. (S each, ~2 d total with doc lines)",
    "replace_with": "10. Default flips per D3/D4 and the two small defaults: circles, marketplace, forage.nightShift, forage.audit, skillSeekers, marketability, curiosity (or ship the F9 fix instead), rlm (removes the deep_recall tool; prefer keeping it capped), architectEvolution, tools.wallet (currently ON on base-sepolia); payment is already derived OFF without CDP creds and harnessEvolve is already mode-held, so both are no-ops; keep practicePartner ON inside opted-in circles; fix the sandbox-agent.ts comment, the sandbox default itself is a Victor decision; bundled twitch/device-pair/phone-control/talk-voice out of the default-enabled set (`config-state.ts:16-34`). Promote the existing advanced-flow P2P consent to QuickStart. (S each, ~2 d total with doc lines)",
    "reason": "P0-B.10 recommendation needs-change"
  },
  {
    "section": "5 P0",
    "find": "11. Delete `demo-config.json`; fix SECURITY.md path and claim; dependabot + audit job; commit or move the untracked remediation doc. (S x4)",
    "replace_with": "11. Delete `demo-config.json` (and the `local-dev-token` fallbacks that keep the convention alive); fix SECURITY.md path and claim (and the `(same as CI)` comment in `.pre-commit-config.yaml:22`); enable Dependabot alerts in repo settings + dependabot.yml (npm, two cargo dirs, actions) + non-blocking audit job; move the untracked remediation doc to `docs/plans/` or gitignore it, do not commit it. (S x4)",
    "reason": "P0-B.11 recommendation needs-change"
  },
  {
    "section": "5 P0",
    "find": "13. Nav regroup to 8 items with an Advanced group; `advanced` NavItem flag; delete Debug, Instances, Projects UI; re-home Logs/Sessions/Usage/Nodes/Workspace; derive VIEW_MAP and NAV_ITEMS from one list. (M)",
    "replace_with": "13. Nav regroup to 8 items (baseline 11) with an Advanced group; generalize the hardcoded `requireFeature === \"management\"` check; delete Debug and Instances; decide Projects as a whole feature (backend is wired into chat.send); drop or justify Sessions (duplicates Conversations); expose Logs/Usage/Nodes/Workspace for the first time under Advanced; make one nav list the source of `TabId`; keep the Circles attention badge visible. (M)",
    "reason": "P0-C.13 recommendation needs-change"
  },
  {
    "section": "5 P0",
    "find": "14. Dreams: native summary + trimmed native tabs; remove Forage/Earnings; drop \"(beta)\"; strip PLAN/D1 labels. (M)",
    "replace_with": "14. Dreams: relabel/gate the nav entry first (PLAN-39 keeps the iframe same-origin); native summary + trimmed tabs if rewritten; gate Forage/Earnings on their backend flags rather than deleting; drop \"(beta)\"; strip PLAN/D1 labels incl. the \"PLAN-40 Phases 1-3\" text at :574 and the dead \"Review queue (D1 pilot)\" card. (M)",
    "reason": "P0-C.14 recommendation needs-change"
  },
  {
    "section": "5 P0",
    "find": "15. Settings form via `config.schema` + `config.patch` for the curated key set; raw JSON under Advanced; replace the four \"edit your config\" strings with toggles; Labs section from a manifest (pattern 5). (M + M)",
    "replace_with": "15. Settings form via `config.schema` + `config.patch` for the curated key set (wire `config.schema` into the existing empty config-store slot; switch saves from `config.apply` to `config.patch` so the reload plan comes back); raw JSON under Advanced (exists); replace the three hand-edit strings with toggles (wallet via the existing `wallet.setConfig`); Labs section from a manifest (pattern 5, `requiresRestart` derived from `config-reload.ts`). (M + M)",
    "reason": "P0-C.15 recommendation needs-change"
  },
  {
    "section": "5 P0",
    "find": "16. Replace 28 native dialogs; `no-restricted-globals` rule. (M)",
    "replace_with": "16. Replace 28 native dialogs; oxlint `eslint/no-alert` after removing `desktop/` from `.oxlintrc.json` ignorePatterns (the repo has no eslint and the renderer is unlinted today). (M)",
    "reason": "P0-C.16 recommendation needs-change"
  },
  {
    "section": "5 P0",
    "find": "17. Active Guards copy rewrite and move to Advanced; P2P dashboard trimmed; Skills marketplace controls behind disclosure; Wallet panel hidden unless configured; Overview channel-status fix and paths under Details; Management `?token=` removal. (S x6)",
    "replace_with": "17. Active Guards copy rewrite (lines 91, 97, 258, 311) and move to Advanced; P2P dashboard trimmed (drop \"Skills Verified\", it has no producer); only \"Publish to P2P\" gated on p2p state, Trust settings behind a disclosure; Wallet panel hidden unless configured, paired with a nav entry or link so WalletView stays reachable; Overview channel-status fix from the `health.channels` keys that exist, paths under Details; Management `?token=` removal (the view then relies on the loopback waiver or a page token). (S x6)",
    "reason": "P0-C.17 recommendation needs-change"
  },
  {
    "section": "5 P0",
    "find": "18. Dark-only for V1 (hide theme toggle) or light-mode pass. (S for dark-only)",
    "replace_with": "18. Dark-only for V1 (hide the theme toggle AND force the store default; ui-store restores a persisted `light`) or light-mode pass (the light token set exists; ~340 zinc/white and 79 status-colour literals are the defect). (S for dark-only)",
    "reason": "P0-C.18 recommendation needs-change"
  },
  {
    "section": "5 P0",
    "find": "19. FirstRun rewrite + one-time token handoff from `bitterbot dashboard`; remove `VITE_GATEWAY_TOKEN` define and `local-dev-token` fallbacks; GatewayControls reads stored token; stop wizard writing `desktop/.env`. (M)",
    "replace_with": "19. FirstRun rewrite (token paste now, per PLAN-37 D4); the `bitterbot dashboard` fragment handoff is half-built (CLI emits `#token=`, renderer never reads `location.hash`, 19001 serves no UI) so it lands after PLAN-39; remove `VITE_GATEWAY_TOKEN` define and `local-dev-token` fallbacks; GatewayControls reads stored token; stop wizard writing `desktop/.env` (it is PLAN-37 Phase 2 and must ship with the define removal; note vite.config.ts also reads the token from `bitterbot.json`); delete the stale on-disk `dist-renderer` that already contains the live token. (M)",
    "reason": "P0-C.19 recommendation needs-change"
  },
  {
    "section": "5 P0",
    "find": "20. D5: gateway serves `dist-renderer` on 19001 (PLAN-39 phase 1); `start:all` and onboarding build the renderer once and stop spawning `pnpm dev`; remove port 5173 from docs. (M-L)",
    "replace_with": "20. D5: gateway serves `dist-renderer` on 19001 (PLAN-39 Phases 0-2; serving is Phase 2, gated on the Phase 0 blackout measurement); `start:all`, onboarding AND `src/infra/ui-restart.ts:337` build the renderer once and stop spawning `pnpm dev`; remove port 5173 from the 11+ docs that mention it. (M-L)",
    "reason": "P0-D.20 recommendation needs-change"
  },
  {
    "section": "5 P0",
    "find": "21. Vendor Geist fonts; CSP `'self'`. (S)",
    "replace_with": "21. Vendor the Geist woff2 files with hand-written `@font-face` (the CDN stylesheet URLs have 404'd since day one; the `geist` npm package ships no CSS); remove the preconnect; CSP `'self'`. (S)",
    "reason": "P0-D.21 recommendation needs-change"
  },
  {
    "section": "5 P0",
    "find": "22. Dream model defaults to the primary model; skip first cycle on empty DB. (S)",
    "replace_with": "22. Dream model via the key-aware cheap-sibling chooser already in `manager.ts:1568-1577` (not the primary Opus model at 8 calls per cycle); centralize the 5 fallback sites; warn instead of debug on LLM-mode failures; the empty-DB skip already exists. (S)",
    "reason": "P0-D.22 recommendation needs-change"
  },
  {
    "section": "5 P0",
    "find": "24. Delete the 32 dead package.json scripts, 10 mac scripts, Swift configs, `setup-local-env.sh`, personal ops scripts, `write-cli-compat.ts` shim, `daemon` alias, LINE code + dep, clawhub/moltbook skills, legacy config migrations, root research `.md` files; untrack 56 MB of benchmark artifacts; `.gitignore` rewrite; stale `apps/`/`Swabble` refs. (M)",
    "replace_with": "24. Delete the 30 dead package.json scripts (16 missing-file + 14 apps/) and the `format:all`/`lint:all`/`test:docker:all` chains, 10 mac scripts + `protocol-gen-swift.ts`, Swift configs and pre-commit Swift hooks, `setup-local-env.sh`, the two personal auth scripts (not the PLAN-26/29 scripts), `write-cli-compat.ts` shim + `daemon-cli-compat.ts`, `daemon` alias (fix `restart-mac.sh` or just hide it), LINE code + dep (after relocating `stripMarkdown` and removing the `line` plugin-runtime namespace), clawhub/moltbook skills, legacy config migrations (with the validation check and five test files; consider deferring), root research `.md` files; untrack ~57 MB of benchmark artifacts (two run dirs + `.work-bio`); `.gitignore` rewrite retaining the load-bearing Python/Rust rules; stale `apps/`/`Swabble` refs incl. `.oxfmtrc.jsonc` and `.pre-commit-config.yaml`. (M)",
    "reason": "P0-E.24 recommendation needs-change"
  },
  {
    "section": "5 P0",
    "find": "26. docs.json prune (language blocks, Install tab, dead groups) + add Memory & Dreams and Circles & Network groups + troubleshooting/FAQ pages + link audit walks nav in CI. (M)",
    "replace_with": "26. docs.json prune (language blocks, Install tab and its 17 redirects, dead groups) + add Memory & Dreams and Circles & Network groups (~70 real orphans; wallet is already in nav) + a troubleshooting hub over the four existing runbooks + FAQ + collapse multi-hop redirects; link audit walks nav and redirect destinations and includes `docs/*.md` (it already runs in CI via `check:docs`). (M)",
    "reason": "P0-E.26 recommendation needs-change"
  },
  {
    "section": "5 P0",
    "find": "28. CLI: `-v` fix; real descriptions + fixed tagline; hide the 8 dev commands and `gateway call`; `--dev` and debug flags `hideHelp()`; happy-path examples; `doctor` economy/wallet sections behind `--deep`; `config` without subcommand prints help; docs/cli fixes for nonexistent commands. (S x8)",
    "replace_with": "28. CLI: `-v` fix in all three sites (`help.ts`, `argv.ts`, `banner.ts`); real descriptions + fixed tagline (keep the commit hash); hide the dev commands in both the placeholders and the real registrars, delete `daemon`, decide `checkpoints`, `gateway call` via `{ hidden: true }` in gateway-cli; debug flags `hideHelp()` (hiding `--dev`/`--allow-unconfigured` needs a docs pass); happy-path examples; `doctor` suppresses info-level posture lines for unconfigured subsystems (do not overload `--deep`); `config` without subcommand prints help (remove its `--section`, fix docs/cli/config.md:11); docs/cli fixes for nonexistent commands (tui/voicecall pages, nav entries, dead `tui` scripts and `pi-tui` dep). (S x8)",
    "reason": "P0-E.28 recommendation needs-change"
  },
  {
    "section": "5 P0",
    "find": "29. Repo identity sed to `Bitterbot-AI/bitterbot-desktop`; CHANGELOG.md; one-page RELEASING runbook; version bump script and `v1.0.0` tag (D2). (S x3)",
    "replace_with": "29. Repo identity sed to `Bitterbot-AI/bitterbot-desktop` across ~20 files incl. `update-cli/shared.ts:40` and `system-prompt.ts:649`; CHANGELOG.md or `--generate-notes` (decide; the one live pipeline uses inline notes); fix the existing `docs/reference/RELEASING.md`; bump script replacing the dangling `plugins:sync`/`release:check`; `desktop-v1.0.0` tag or a `v*` trigger (no workflow listens for `v*`); guard both version comparators (D2). (S x3)",
    "reason": "P0-E.29 recommendation needs-change"
  },
  {
    "section": "5 P1",
    "find": "First-class Ollama wizard group + \"Use a local model\" button; provider picker short list + \"More providers\"; Telegram as quickstart default; Baileys stable pin. (M x2, S x2)",
    "replace_with": "First-class local-model choice built on the existing Custom Provider path + \"Use a local model\" button; provider picker short list + \"More providers\" (the deprecated setup-token choice is already hidden from the picker); Telegram is already the quickstart default; Baileys rc14 bump or 6.7.24 fallback (no stable 7.x exists). (M x2, S x1)",
    "reason": "P1 recommendation needs-change"
  },
  {
    "section": "5 P1",
    "find": "Help & Docs link in the sidebar; `bitterbot docs` local fallback. (M, S x4)",
    "replace_with": "Help & Docs link in the sidebar once a docs destination exists; `bitterbot docs` local fallback. (M, S x4)",
    "reason": "2.1-2.2-21 recommendation needs-change"
  },
  {
    "section": "5 Install matrix",
    "find": "| Orchestrator prebuilt binaries | **Supported** (existing signed workflow) | GitHub Release `orchestrator-v*` | postinstall fetcher / `doctor --fix` | Publish 0.2.3 now; add minisign verify in the fetcher |",
    "replace_with": "| Orchestrator prebuilt binaries | **Supported once SIGNING.md steps 1-5 run and 0.2.3 ships signed** (the signing workflow has never executed; no `release` environment; 0 repo secrets; 0.2.2 has no `.minisig`) | GitHub Release `orchestrator-v*` | postinstall fetcher / `doctor --fix` | Publish 0.2.3 after activating signing; add minisign verify in the fetcher |",
    "reason": "5-33/6.9-6.10-09 partial"
  },
  {
    "section": "5 Install matrix",
    "find": "| `install.sh` / `install.ps1` at bitterbot.ai | **Supported if built in P0; otherwise remove every mention** | wraps the source path | re-run the script |",
    "replace_with": "| `install.sh` / `install.ps1` at bitterbot.ai | **Supported if built in P0 and hosted as text/plain outside this repo; otherwise remove every mention** | wraps the source path | re-run delegates to `bitterbot update` |",
    "reason": "3.2-11/4-03 recommendation needs-change"
  },
  {
    "section": "5 Install matrix",
    "find": "| Swift/Sparkle macOS app, iOS, Android, Podman | **Removed** | none | n/a | Delete scripts and docs |",
    "replace_with": "| Swift/Sparkle macOS app, iOS, Android, Podman | **Removed** | none | n/a | Delete scripts and docs (no Swift/iOS/Android source is tracked; what exists is 10 scripts, two Swift lint configs, and the two Podman files) |",
    "reason": "3.7-3.8-05 precision"
  },
  {
    "section": "5 Versioning",
    "find": "git tag `v1.0.0` triggers `release.yml`. Add a one-line guard in `src/infra/update-check.ts` so a CalVer-shaped installed version (`2026.x.y`) is treated as older than any SemVer 1.x during the transition.",
    "replace_with": "git tag `desktop-v1.0.0` (or add `v*` to a workflow trigger; no `release.yml` exists and nothing listens for `v*`). Add a guard in `src/infra/update-check.ts` (package installs only, npm unpublished) AND in `src/config/version.ts` (`compareBitterbotVersions`, which fires on every existing git install via `warnIfConfigFromFuture`) so a CalVer-shaped installed version (`2026.x.y`) is treated as older than any SemVer 1.x during the transition.",
    "reason": "5-32/3.7-3.8-03 recommendation needs-change"
  },
  {
    "section": "5 Versioning",
    "find": "then the release-please config uses `Release-As` per monthly cut.",
    "replace_with": "then a release-please config (net-new; nothing is installed) uses `Release-As` per monthly cut.",
    "reason": "5-32/4-29 recommendation needs-change"
  },
  {
    "section": "5 Versioning",
    "find": "- Orchestrator: independent SemVer, `orchestrator-v0.x` tags, existing signed workflow; bump to `1.0.0` when the wire protocol is frozen.",
    "replace_with": "- Orchestrator: independent SemVer, `orchestrator-v0.x` tags, the signing workflow (never yet run; activate per SIGNING.md first); bump to `1.0.0` when the wire protocol is frozen.",
    "reason": "6.9-6.10-09 partial"
  },
  {
    "section": "5 Versioning",
    "find": "- Automation: release-please manifest mode over the conventional commits already in use; CHANGELOG.md in Keep a Changelog format; attestations + cosign on every artifact.",
    "replace_with": "- Automation: release-please manifest mode over the conventional commits already in use (net-new setup; `extra-files` needed for the split desktop versions); CHANGELOG.md in Keep a Changelog format or `--generate-notes`; minisign end-to-end first, attestations optional later, drop cosign (duplicate trust root).",
    "reason": "4-29/3.7-3.8-14 recommendation needs-change"
  },
  {
    "section": "5 DoD",
    "find": "1. The documented install path (README Step 1 verbatim) completes with no prompt beyond risk ack, provider + key (or local model), and go;",
    "replace_with": "1. The documented install path (README Step 1 verbatim) completes with no prompt beyond risk ack, provider + key (or local model), and go (a wizard change: QuickStart asks 15-19 prompts today and hard-wires `desktop/.env`);",
    "reason": "5-35 partial"
  },
  {
    "section": "5 DoD",
    "find": "`bitterbot status` and `doctor` (default, not `--deep`) are green with zero Forage/wallet/P2P-identity lines on a node without wallet credentials.",
    "replace_with": "`bitterbot status` and `doctor` (default) are green with zero Forage/wallet/P2P-identity lines on a node without wallet credentials (`--deep` already means something else).",
    "reason": "3.7-3.8-20 recommendation needs-change"
  },
  {
    "section": "5 DoD",
    "find": "3. Memory works without an OpenAI/Gemini/Voyage key: a first chat produces crystals, the Memory summary shows them, and the first dream cycle runs against the configured primary model.",
    "replace_with": "3. Memory works without an OpenAI/Gemini/Voyage key on platforms where node-llama-cpp and sqlite-vec load: a first chat produces crystals, the Memory summary shows them, and the first dream cycle runs against the chosen cheap dream model (not the primary model) with mode failures surfaced at warn.",
    "reason": "3.1-11/3.3-21 recommendation needs-change"
  },
  {
    "section": "5 DoD",
    "find": "9. A tagged `v1.0.0` (or `2026.9.0`) release exists with a CHANGELOG entry, attested artifacts,",
    "replace_with": "9. A tagged release (`desktop-v1.0.0`, `v1.0.0` with a new trigger, or `2026.9.0`) exists with release notes, minisign-signed GitHub release assets (npm is unpublished; attestations optional),",
    "reason": "D2 recommendation needs-change"
  }
]
```
