---
title: "Launch-Day Runbook"
summary: "The checklist for posting Bitterbot anywhere with an audience."
read_when:
  - Announcing a release publicly (HN, X, Reddit)
  - Preparing launch-day support coverage
---

# Launch-Day Runbook

Rules of engagement for posting Bitterbot anywhere with an audience. The
theme: a first-hour skeptic should find working commands, honest limits,
and a human who answers.

## Before posting

- [ ] CI green on `main`, including the Docker smoke job and the
      pack-content gate.
- [ ] Latest release cut and verified per
      [RELEASE-PROCEDURE](/reference/RELEASE-PROCEDURE): GHCR tags present,
      `gh attestation verify` passes.
- [ ] Clean-machine smoke: fresh clone, README Quick Start **verbatim**
      (copy-paste, no muscle memory), gateway serves the Control UI, first
      chat answers.
- [ ] Demo assets load fast from where they're embedded (the README hero
      gif and the demo tape output must be CDN-served, not LFS-throttled —
      test from a cold connection).
- [ ] `about.bitterbot.ai` resolves and renders under load. Do **not**
      link `docs.bitterbot.ai` anywhere until it actually resolves.
- [ ] [LIMITATIONS.md](https://github.com/Bitterbot-AI/bitterbot-desktop/blob/main/LIMITATIONS.md)
      is current — a skeptic should discover gaps from us, not from a
      comment thread.

## The pinned known-issues issue

Open a pinned GitHub issue titled "Known first-hour issues" BEFORE
posting, seeded with the failure modes we already know:

- `EADDRINUSE 19001` — a previous gateway is still running
  (`ss -tlnp | grep 19001`, stop it, or set `BITTERBOT_GATEWAY_PORT`).
- WSL: cloned under `/mnt/c` → everything is slow. Move the checkout to
  `~` (ext4). This is the most common Windows report.
- Node < 22 → cryptic startup SyntaxError. `node --version` first.
- `pnpm: command not found` → `corepack enable pnpm || npm install -g pnpm`.
- Orchestrator binary 404 during `pnpm install` → normal until a prebuilt
  release exists for the current `orchestrator/Cargo.toml` version; the
  node runs local-only without it. _(Delete this entry the day the signed
  orchestrator release ships.)_

## Posting

- [ ] Post only when you can be present for the next **3–4 hours**. An
      unanswered first-hour question is the launch.
- [ ] Never ask for upvotes, anywhere, including privately. Vote-ring
      detection is real and the ban is permanent.
- [ ] Lead with the mechanism (memory that consolidates, dreams that get
      graded, an unedited MEMORY.md), not adjectives.
- [ ] Answer criticism by linking the code or LIMITATIONS.md. If a critic
      finds something real, thank them, file it, and pin the fix commit in
      the thread.

## After

- [ ] Triage every new issue same-day for the first week.
- [ ] Fold the real first-hour failures back into the pinned issue and
      the README Troubleshooting section.
