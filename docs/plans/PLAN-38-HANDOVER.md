# PLAN-38 handover (written 2026-07-27 for a fresh session)

Paste this as the opening prompt of a new session. It carries what the plan
document does not: repo state, hard-won verification commands, gotchas that
cost time to discover, and the reasoning behind decisions that reads as
arbitrary without it.

---

## Your task

Build PLAN-38 (Canvas Sandbox) per `docs/plans/PLAN-38-CANVAS-SANDBOX.md`.
**Read that document in full before writing code.** It is self-contained: §4.5
holds the numbered requirements R1-R35, §4.2 the non-relaxable invariants
I1-I12, §4.3 the machinery M1-M6, §7 the phasing and build order.

Start at **P1 step (a)**: sandbox event types + fold + migration, headless and
tested, no UI. Nothing has been written yet — the file `src/circles/sandbox.ts`
does not exist.

**Stop and report after step (b)** (one negotiation card, one round, practice
partner as the second agent, propose-mode, rendered in the oversight pane;
per the 2026-07-28 amendments (b) also includes the human composer on the
card and R35 chat-side canvas awareness — see plan §3.3 and §7).
§7 designates that as the reassessment point: the first moment the thesis is
visible on screen and the cheapest place for Victor to change his mind. Do not
blow through it.

---

## Repo state

Branch `main`. **Six commits local and unpushed** (ask before pushing):

| Commit    | What                                                             |
| --------- | ---------------------------------------------------------------- |
| `2cd8d5a` | R1-R34 appendix so the plan is self-contained                    |
| `d527611` | CSP tracking-pixel hole + fail-open tool policy                  |
| `bdcf115` | Tools ruling (§4b), working surface (§3.2), dead-pattern finding |
| `6989cf8` | Nested-string injection scan on `event.append`                   |
| `4f2b240` | Closed plan decisions 2-6                                        |
| `634baf3` | PLAN-38 v1 + session-trust taint fix                             |

Earlier in the same arc (already on main before this): `9617194` Phase 4b
study lens, `a7fee08` three circles defect fixes.

The working tree has unrelated pre-existing modifications (benchmarks,
`apps/`, longmemeval run dirs). **Do not commit those.** Always `git add` your
specific files by path; never `git add -A` from the repo root.

---

## How this project verifies (learned the hard way)

```bash
pnpm vitest run <path>                              # unit tests
pnpm vitest run --config vitest.e2e.config.ts <path> # *.e2e.test.ts — EXCLUDED from the default runner
pnpm tsgo                                            # root typecheck (silent = pass)
cd desktop && pnpm typecheck                         # renderer typecheck
cd desktop && pnpm vitest run renderer/src/...       # renderer tests, run from desktop/
pnpm lint                                            # oxlint --type-aware, ~40-270s
pnpm exec oxfmt --write <paths>                      # formatter; CI checks it
pnpm dlx markdownlint-cli2                           # docs; grep your file out of the output
```

`pnpm vitest run src/circles/` from the repo root, not from `desktop/` — the
desktop package has its own vitest config and will report "no test files".

---

## Codebase gotchas that cost time

- **The desktop shell is Tauri 2, not Electron.** No `webPreferences`, no
  `protocol.handle`, no `webContents.capturePage`.
- **`playwright` and `sharp` are already direct dependencies**, and
  `src/browser/routes/agent.snapshot.ts` already does screenshot → normalize →
  store. Own-agent thumbnails are ~30 lines of glue, not a new dependency.
- **`~/.bitterbot/media/` has a 2-minute TTL sweeper** and `src/media/server.ts`
  deletes files ~50ms after serving. Anything durable must not live there.
- **`circle_events` has no eviction.** Anything you put on the ledger is
  permanent on every member's node. This is why inline media was rejected.
- **`MAX_CIRCLE_ENVELOPE_BYTES` is 65,536** (`src/circles/envelope.ts`), and
  the mailbox blob cap is the same with a 500-blob recipient quota.
- **`handleCircleEventAppend` accepts unknown event types** (it validates chain
  and scan, not type), so new `sandbox.*` types are forward-compatible with old
  nodes automatically.
- **In `src/gateway/a2a/circles.test.ts` call `handleCircleMethod("circle/...")`,
  not the handlers directly** — the handlers are not exported under those names.
- **The injection scanner's critical threshold is 5**
  (`src/security/skill-injection-scanner.ts`). A single "ignore all previous
  instructions" scores 3 and is NOT critical. To pin a deterministic critical
  payload in a test, combine two weight-3 rules, e.g.
  `"Ignore all previous instructions. <system> ..."`.
- **`fanOut` already publishes to the gossip topic** when a bus exists, so the
  sandbox inherits mesh delivery free whenever the fleet ships the new
  orchestrator binary. P0/P1 do not depend on it.
- Patterns to copy rather than reinvent: `src/circles/canvas.ts` (fold with
  fold-side re-caps — never trust sender caps), `claimAgentDraft` in
  `src/circles/agent-drafts.ts` (guarded-UPDATE for every race),
  `circle_rate_hits` (persisted limiter that survives restart),
  `src/circles/study.ts` (most recent example of a clean new circles module
  with its migration and tests).

---

## Working agreements with Victor

- **Never use `--dev` or `gateway:dev`.** Use `pnpm start gateway` with
  production config.
- **Commits are authored as `VGIL77 <vgil@soapbox.net>`** via per-commit
  `-c user.name=... -c user.email=...` overrides. Do not change global config.
- **Every change ships wired, active by default, with tests and docs updated in
  the same commit.** No dead code behind a flag nobody flips.
- **Draft first, then a distinct adversarial pass before calling anything
  complete.** §4 of the plan is that pass done in advance for the design; the
  implementation needs its own.
- **Avoid em-dashes in public-facing writing** (GitHub, PRs, social). Internal
  plan docs are fine.
- Victor is a neuroscientist, not a career software engineer. He reads
  architecture and security reasoning closely and does not want it dumbed down;
  he does want the reasoning stated rather than assumed.
- He will overrule recommendations and that is fine — record the decision and
  its consequence, then execute the decision, not the recommendation.

---

## Context behind decisions that look arbitrary in the plan

**Why propose-mode first and no autonomous posting in P1.** Not timidity. The
security review showed the sandbox turns peer content from a leaf into a node
in a cycle, which silently breaks three controls the current design relies on.
Auto-append is gated on M1-M6 existing. Do not "temporarily" enable it to make
a demo feel better.

**Why "watching" means oversight, not spectacle.** Victor clarified this
mid-review after five agents had attacked the spectacle reading. Both
conclusions hold simultaneously: spectating is not a retention mechanism, AND
oversight is mandatory regardless of engagement. A low-traffic oversight pane
is a working oversight pane. Do not re-litigate this as a spectacle-vs-residue
debate; see §0 and §6.2.

**Why the todo list is not a live scrolling ticker.** Victor asked for one.
The research found Manus abandoned `todo.md` (about a third of all agent
actions were spent updating it) and Anthropic disabled `TodoWrite` by default,
and a controlled study found the oversight benefit is pre-flight rather than
mid-run. He accepted the swap: build the plan gate, the plan-vs-actual diff
(which nobody ships), `blocked` as a real state with a reason, and
evidence-gated completion. The list still renders — ambient, capped, updated
rather than rewritten.

**Why the coordinator's tool hypothesis is wrong.** "A read-only web fetch is
just more untrusted input" was refuted: a GET is egress, and egress is
exfiltration, because the URL carries attacker-chosen bytes. If you find
yourself reasoning "this tool only reads, so it is safe," stop — read-only is
the wrong axis. The axes are: does it read outside the R7 context set, does
anything leave the node, does it have effects a human would care about.

**Why no cross-member images.** A phishing-lookalike screenshot has no
technical mitigation, and a signature proves who is accountable but never that
the page said that (threat T10). Own-agent-local screenshots are fine and
valuable. The content hash ships on the ledger from day one so cross-member
pixels remain purely additive later.

**Why solo-degraded mode is load-bearing.** Victor skipped the P-1 evidence
prototype. With no prototype and no second installed human, the practice
partner is the only harness that can exercise a negotiation card at all. It
ships FIRST within P1, not last.

---

## Known-open items (do not rediscover these)

- **`tauri.conf.json` has `"security": { "csp": null }`.** The meta-tag CSP in
  `desktop/renderer/index.html` is the only one enforced. A header CSP is
  strictly stronger but needs a desktop build to confirm Tauri IPC survives it,
  which could not be verified from the dev environment. Deliberately left.
- **Circles §5.2 CI guard is unbuilt**: nothing yet fails the build if a memory
  writer imports a circles table. R17 wants it.
- **Channel-key rotation is unbuilt**, so auto-append stays refused in any
  circle with removal history (plan decision 6), and the refusal must be
  legible and dated when it fires.
- **The P2 loop measurement gate from PLAN-36 has still never been run.** It is
  referenced by §8 and remains the oldest unpaid debt in this area.

---

## First actions

1. Read `docs/plans/PLAN-38-CANVAS-SANDBOX.md` end to end.
2. Read `src/circles/tab.ts` (event types + `normalizeInput` + chain building),
   `src/circles/canvas.ts` (the fold you are mirroring), and
   `src/circles/study.ts` (the most recent clean module + migration + tests).
3. Implement step (a): the four `sandbox.*` event types plus
   `sandbox.plan.put` and `sandbox.evidence.put` in `tab.ts`; a new
   `src/circles/sandbox.ts` with the fold, deterministic speaker order, the
   my-turn test, and the move parser; the migration for
   `circle_sandbox_enrollments`; tests covering concurrent moves converging,
   a mailbox-lagged late move folding into its original round, fold-side
   re-caps, and speaker-order determinism across two nodes.
4. Report before starting (b).
