# Handover — Bitterbot Circles: agent-tool gaps + UI polish (paste to start fresh)

You are continuing work on **Bitterbot Circles**, the flagship social feature of the Bitterbot
desktop app (repo root: `/mnt/d/Bitterbot/bitterbot-desktop`, branch `main`). Read this whole
handover before acting. It is self-contained.

Circles = a private, P2P group chat where the members are friend **nodes** (each friend's human
**and** their personal AI agent are co-present), riding the **A2A HTTP** side (addressed
request/response), not the libp2p gossip mesh (a mostly-inert prototype). One signed event log is
the spine; the chat is one view, the group canvas another. The authoritative plan +
running build log is `docs/plans/PLAN-36-CIRCLES-SOCIAL-GRAPH.md` — read the build-log section
(the long run of "**X LANDED**" paragraphs near the bottom) for the full history; **keep appending
to it** as you land work.

---

## 1. Current state — everything below is SHIPPED (committed, pushed to `main`, CI-green, deployed)

This session shipped a large run of circles work. The whole §5 security spine and a set of UX
features are live. Highlights (newest first), each was wired + tested + adversarially reviewed +
docs-updated + gateway-rebuilt/restarted:

- **Invite a friend to an EXISTING circle** (`1d3f1b1`) — the members pane has "Invite someone to
  this circle"; scoped invite passes `circleId` so the invitee joins that circle (grows a group).
  Backend `circles.invite` already took `circleId`; this wired the UI. **← this button is the UI nit
  in Task 3 below.**
- **Archive + delete circles** (`b1f5d76` + review `885b930`) — hover a rail tile → "⋯" → Archive
  (reversible) / Delete (permanent, node-local; friends keep their copy). `circles.archive/
unarchive/delete`; `deleteCircle` cascades all circle-scoped tables; archived circles refuse
  inbound (`storeInboundMessage` archived-guard). `circles.list` now uses `listCirclesForUi`
  (active+frozen+archived) so frozen circles are visible (the unfreeze banner was unreachable
  before).
- **Name your own agent** (`52a7696` + `886270c`) — edit "Your name" on the You row; stored
  node-local in `circle_settings` (migration v49); carried in presence so existing friends' rosters
  refresh (~30s), and written into the creator's own member row at circle creation.
- **§5.6 petname layer** (`1ba552b` + review `9ae3b03`) — per-person PRIVATE label (node-local,
  keyed by pubkey, `circle_petnames` migration v48) that overrides the spoofable `displayName` for
  your eyes only, never synced. `memberName() = petname ?? displayName` threaded through the UI.
  Anti-impersonation cues computed server-side in `src/circles/petnames.ts` (`computeNameFlags`):
  `unverified` + `nameCollision` (keys on the SPOOFABLE displayName). RPCs
  `circles.petname.set/clear`; onboarding prompt + inline rename on the roster.
- **§5.3 approval card** (`5d16440` + review `7f31e86`) — agent tool writes (send/ask/log_expense)
  ONLY QUEUE; the inline `PendingOutboundCard` is the sole path that executes (server runs stored
  params) or rejects. `circle_pending_outbound` (migration v46); RPCs `circles.outbound.list/
approve/reject`; per-circle cap; named expense splits.
- **§5.5 member eviction** (`bf1fb09` + review `4bb20ac`) — any member prunes another from their
  OWN node-local roster (`circles.member.remove`); removed member's writes default-denied at the
  A2A boundary.
- **§5.2 persisted rate buckets** (`90994c0` + review `b154b33`) — `circle_rate_hits` (migration
  v47); refused requests do zero DB writes; amortized GC.
- **Reactions + pins** (`903db9e` + review `b274e7c`) — `message.react`/`message.pin` on the event
  log (`src/circles/annotations.ts`); `circles.react/pin`; hardened fold (collision keys on
  displayName, clamped timestamps, event_hash tiebreak, durable server-resolved pins).
- **Phase B agent-in-the-room + B2 slices** (`c8665a9`/`c1a6868`/`37df34f`/`c101281`) — summon-only
  `@agent` drafts on a quarantined tool-less path (`src/circles/agent-drafts.ts`); consent-gated
  publish. B2: agent pre-fills a card slice.
- **C3 study-guide Co-Canvas** (`cfe2d93` + review `8a9705b`) — per-section contribution slices,
  gap markers.
- **Wrap hiding** (`d98cb2f`) — inbound chat shows body + a shield, not the security envelope.
- **Unfreeze recovery** (`ff111b4` + review `7ace2a8`) — fork-freeze evidence + two-tap unfreeze +
  forgiven-fork audit trail (`forgiven_forks`, migration v45).
- **Chat ordering** (`f028b46`) — newest at the bottom (store reverses the DESC window).
- **Resizable members/canvas pane** (`aa2b36c`) — default 570px, drag handle, localStorage.

Latest migration is **v49**. Gateway is running the latest build; Vite is running at
`http://localhost:5173`.

---

## 2. THE THREE IMMEDIATE TASKS (in priority order)

The user asked for these explicitly. Tasks 1 & 2 came out of "does the agent tool need anything so
the agent can use circles properly?"; Task 3 is a UI polish nit.

### Task 1 (build) — GAP 1: let the agent READ circle conversation (highest value)

**Problem:** the `circles` agent tool (`src/agents/tools/circles-tool.ts`) has actions
`status/connections/tab/briefing/asks/send/ask/log_expense` but **no action that returns message
BODIES**. The agent can `send` into a circle but cannot see what anyone said or any replies — so it
can't answer "what did the group decide?" or summarize a circle. This is the biggest limitation on
the agent being useful in circles.

**Why it's absent + the safe way to add it:** peer messages are a hostile principal — stored
**WRAPPED** as untrusted external content (`sanitizeInboundCircleText` / `wrapExternalContent`),
never handed to the agent as bare text. So add a read action (e.g. `action: "messages"` /
`"recent"`, `{ circle_id, limit }`) that returns the **already-wrapped** `content` (the exact
string in `circle_messages.content`), so the agent sees it as untrusted external data — the SAME
boundary the Phase B draft path (`buildQuarantinedDraftPrompt`) already respects. Do NOT unwrap.
Return author (see Gap 2 for naming), direction, kind, createdAt, envelopeId, replyTo. This touches
the agent-context boundary, so **do a distinct adversarial pass** (prompt-injection via returned
content; confirm nothing is unwrapped; confirm it doesn't leak petnames to a peer-reachable path).

### Task 2 (build) — GAP 2: use the human's petnames in the agent tool's people-facing reads

**Problem:** `connections` (and `asks`) return each member's self-asserted `displayName`
("Bitterbot agent"), never the **petname** the human assigned ("Maya"). The agent is the human's
own; when it talks to the human it should use the human's name for the person.

**Fix:** in `circles-tool.ts` `connections` (and the new `messages` action from Task 1, and `asks`),
resolve the shown name as `svc.petnames()[pubkey] ?? displayName`. Optionally include
`theyCallThemselves: displayName` as a secondary field. **Privacy nuance (carry into the review):**
the petname is node-local and must never reach a peer. The tool's _write_ path already queues for
human approval and the human reviews before send, so exposing petnames to the agent for REFERENCE
is safe — but do not let a petname flow onto an outbound envelope unreviewed. `svc.petnames()`
exists on `CirclesService` (returns `Record<pubkey, petname>`).

**What must STAY OUT of the agent tool (do not add):** archive/delete circle, remove member,
invite, petname-set, self-name-set, react, pin, unfreeze, canvas mutations. These are consequential
or destructive and are deliberately human-UI-only — a prompt-injected agent must not be able to
delete a circle, evict someone, or invite a stranger. The safe pattern is the existing §5.3 queue
(agent proposes → human taps).

### Task 3 (UI nit) — restyle the "Invite someone to this circle" button

**Problem:** the button is **too loud** (dashed border) and its **text is washed out**. Make it
look like the **"New Conversation"** button in the left sidebar.

- **Current** (`desktop/renderer/src/components/circles/CircleMembers.tsx`, the `canModerate`
  button near the top of the return):
  `className="flex items-center gap-2 text-xs font-medium text-primary rounded-md border
border-dashed border-primary/40 px-2.5 py-1.5 hover:bg-primary/5"`
- **Target style** (copy the "New Conversation" button in
  `desktop/renderer/src/components/layout/Sidebar.tsx:285-300`): soft filled purple tint, no dashed
  border, purple text —
  `"flex items-center gap-2 rounded-lg bg-[rgba(139,92,246,0.1)] hover:bg-[rgba(139,92,246,0.15)]
text-purple-400 px-3 py-2 text-sm font-medium"` with a `<Plus className="w-4 h-4" />` icon
  (currently `UserPlus`; either is fine — match the softer weight). Drop the dashed border; use the
  filled tint so it reads as a calm primary action, not an alert. Renderer-only; verify visually on
  Vite.

---

## 3. Key files

**Agent tool (Tasks 1 & 2):** `src/agents/tools/circles-tool.ts` (the `circles` tool: schema
`CirclesSchema`, the `execute` switch with the action cases). Its test:
`src/agents/tools/circles-tool.test.ts` (builds a real in-memory CirclesService; pins
`BITTERBOT_STATE_DIR`). The wrapped-content boundary + read pattern to mirror:
`src/circles/agent-drafts.ts` (`buildQuarantinedDraftPrompt`), `src/security/external-content.ts`
(`wrapExternalContent`). Message storage: `src/gateway/a2a/circles.ts` `storeInboundMessage`;
message read: `src/circles/service.ts` `messages(circleId, limit)` (returns rows incl. `content`,
`envelopeId`, `replyTo`). Petnames: `service.petnames()`; `src/circles/petnames.ts`.

**Renderer (Task 3):** `desktop/renderer/src/components/circles/CircleMembers.tsx` (the invite
button + the members roster), `desktop/renderer/src/components/circles/InvitePanel.tsx` (scoped vs
new-circle modes), reference `desktop/renderer/src/components/layout/Sidebar.tsx`.

**Server RPCs:** `src/gateway/server-methods/circles.ts` (all `circles.*`). Service:
`src/circles/service.ts`. Store: `src/memory/circles-store.ts`. Migrations:
`src/memory/migrations.ts` (latest **v49**).

**Renderer store:** `desktop/renderer/src/stores/circles-store.ts`. Circles components live in
`desktop/renderer/src/components/circles/`. The main renderer test is
`desktop/renderer/src/components/circles/CirclesView.test.tsx` (mock `useGatewayStore` with an
`Object.assign(selector, {getState})` shim; `requestMock.mockImplementation` stubs the `circles.*`
RPCs).

---

## 4. Build / run / test / deploy (operational — important)

- **Node/runtime:** WSL2, node 22.22.1. Never use `--dev` / `gateway:dev` — always production config.
- **The UI you SEE = the Vite control UI at `http://localhost:5173`** (dev server, HMR). Renderer
  changes are live after a hard-refresh (Ctrl+Shift+R). Restart Vite: kill the pid on :5173, then
  `cd desktop && nohup pnpm dev > <log> 2>&1 &`. **Renderer-only changes (Task 3, most of Task 2's
  UI) need NO gateway rebuild.** The user often asks "reload vite so I can look" — just restart it.
- **Gateway (server changes — Tasks 1 & 2 touch `src/`):** need a full rebuild to go live.
  `pnpm build` (root, ~15 min) → then restart. **Cold boot is ~20 min.** Restart pattern that works
  here (SIGINT is flaky; be defensive):
  1. `pnpm build` (wait for `[copy-hook-metadata] Done` + fresh `dist/entry.js`).
  2. Stop: `kill -INT <bitterbot-gatew pid>`; if still up after ~15s, wait more; then
     `pkill -f "run-node.mjs gateway"`; `rm -f /tmp/bitterbot-orchestrator.sock`.
  3. Start: `nohup pnpm start gateway > <log> 2>&1 &`; poll `ss -tln | grep 127.0.0.1:19001` until
     up (~20 min). Confirm boot log shows `listening on ws://127.0.0.1:19001` + `fast scheduler
active`. Verify a new migration table via a `node -e` `DatabaseSync` read of
     `/home/vicmg/.bitterbot/memory/main.sqlite`.
  - **Gotcha:** if you edit `src/` AFTER kicking off a build, that build is stale — kill it and
    rebuild, or the deployed binary won't have your fix. (Happened twice this session.)
- **Tests:**
  - Server: `npx vitest run src/circles/<file>.test.ts` (repo root). The two-node harness is in
    `src/circles/service.test.ts` (routes A2A dials between two in-memory DBs). A2A verbs:
    `src/gateway/a2a/circles.test.ts`. Store: `src/memory/circles-store.test.ts`. **Run the
    store-layer test file too when you touch `circles-store.ts`** — CI once caught a store test I'd
    missed by only running `src/circles/`.
  - Renderer: `cd desktop && npx vitest run renderer/src/components/circles/CirclesView.test.tsx`.
  - Types: server `npx tsc --noEmit -p tsconfig.json` (~2 min, from repo root — NOT from
    `desktop/`); renderer `cd desktop/renderer && npx tsc --noEmit`. Lint: `npx oxlint <files>`
    (oxlint ignores `desktop/`, so the renderer gate is tsc only). Pre-commit hook runs oxlint +
    format; `String(unknown)` trips `no-base-to-string` (use a typed extractor).

---

## 5. Standing rules & gotchas (from the user — honor these)

- **Every change wired + active by default, with tests + docs in the SAME commit.** Then a distinct
  **adversarial review pass** before calling anything complete — spawn a background review agent
  (general-purpose) that attacks the diff; it has found real defects on nearly every increment this
  session. **Task 1 especially needs one** (it exposes peer content to the agent). Fold its findings
  in, re-test, re-commit. Record the review outcome in the PLAN-36 build log.
- **Commit identity:** author every commit as `VGIL77 <vgil@soapbox.net>`:
  `git -c user.name="VGIL77" -c user.email="vgil@soapbox.net" commit --author="VGIL77 <vgil@soapbox.net>" -m "…"`.
  End messages with the `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>` +
  `Claude-Session: …` trailers (copy from recent commits). Occasionally a stale `.git/index.lock`
  blocks a commit — `rm -f .git/index.lock` and retry.
- **Scope commits to the circles work** — the repo has unrelated uncommitted changes (benchmarks,
  package.json, etc.). Stage explicit paths, never `git add -A`.
- **Pushing:** the user has approved pushing each circles increment to `main` this session; they
  often say "proceed"/"yes". Confirm if unsure. After push, a CI run kicks off (~12 min); a red CI
  is usually a markdown-lint (MD034 bare URLs — angle-bracket them) or a store test outside the
  suite you ran.
- **No dead code / no crud** — replace, don't orphan; delete what you supersede.
- **Vite is the happy path; Tauri is NOT released** (first official release ~Q3–Q4 2026). No
  installer / running native app / `bitterbot://` deep link exists.
- **Cadence the user likes:** build an increment → test → adversarial review → commit → (rebuild if
  server) → deploy → report honestly (what works, what doesn't). They value honesty over polish and
  dislike over-narration. They frequently ask "reload vite" to look at renderer changes.
- **Doc build-log reflows:** the PLAN-36 build log gets auto-reformatted (oxfmt/prettier), so exact
  Edit `old_string` matches on it often fail — re-read the surrounding lines and match current text.

---

## 6. Live infrastructure

- **Gateway:** local, `ws://127.0.0.1:19001` (+ orchestrator on 19004). Socket
  `/tmp/bitterbot-orchestrator.sock`. Memory DB `/home/vicmg/.bitterbot/memory/main.sqlite`.
- **Mailbox host** (store-and-forward, sealed): `https://mailbox.bitterbot.ai` (DO droplet
  `161.35.98.6`, Caddy TLS) — the DEFAULT mailbox, so join works with zero config.
- **Guest-JOIN page:** `https://join.bitterbot.ai/i`.
- **P2P/orchestrator** is a separate Rust layer (`orchestrator/`); NOTE an open question the user
  raised: the libp2p swarm is NOT transport-isolated (no pnet PSK, no ConnectionGater) — the peer
  count is a raw connection tally, so it can include non-Bitterbot libp2p connections and likely
  overcounts. The user said "leave it for now"; the clean fix if it resurfaces is to count only
  identify-verified (`/bitterbot/id/1.0.0`) peers. Not a circles task.

---

## Immediate task when you start

Confirm the gateway is up (or note it's mid-boot). Then do **Task 3** first (renderer-only, quick,
visible win — the user is looking at it), then **Task 1 + Task 2** together (agent tool: add the
wrapped-message read action AND petname-aware names), with a distinct adversarial pass before
calling them complete, then rebuild + restart the gateway to deploy Tasks 1/2 and reload Vite for
Task 3. Follow the build→test→review→commit→deploy→report cadence. Read
`docs/plans/PLAN-36-CIRCLES-SOCIAL-GRAPH.md` and the memory index for anything this handover
compressed.
