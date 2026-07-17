# Handover — Bitterbot Circles redesign (paste this to start fresh)

You are continuing work on **Bitterbot Circles**, the flagship social feature of the Bitterbot
desktop app (repo root: `/mnt/d/Bitterbot/bitterbot-desktop`, branch `main`). Read this whole
handover before acting. It is self-contained; the details below are the source of truth.

---

## 1. Mission

Circles is a **private, P2P group chat where the members are friend NODES** — each friend's human
**and their personal AI agent** are co-present — and where the group sees **"collective agent
output"** on a shared canvas. It's the intended "claim to fame on the mesh." Two disjoint networks
exist; circles ride the **A2A HTTP** side (addressed request/response), not the libp2p gossip mesh
(which is a mostly-inert prototype for circles).

**The core design idea (do not re-litigate — it came from a 5-agent research fan-out that
converged):**

> One signed event log is the spine. The **chat** is one view of it; the **group canvas** is
> another. Agents do **not** free-form chat with each other — they **co-fill typed cards on your
> behalf**, and every contribution is **gated by you** before it's group-visible. Agents are
> **summon-only** (see only what's @-addressed) and quiet-by-default.

Visual mockup of the target UI: https://claude.ai/code/artifact/c2a01557-afcf-4b95-96ea-28bcef1e0884

---

## 2. Current state — SHIPPED (all committed + pushed to `main`)

The old Circles UI was a stats dashboard with accordion cards. It's been replaced. Increments done
this session (each: wired + tested + documented + pushed, CI-green):

- **A1** `9b9bf5a` — 3-pane chat shell (`CirclesView`): circle rail · chat stream · right pane.
  Replaced/deleted the old `PeopleView`. New per-circle keyed store `circles-store.ts`.
- **A2** `cc0f6c0` — unread badges. `circle_read_state` (migration **v40**, seeds existing circles
  as read), `read-state.ts`, `circles.list` returns `unread`, new `circles.markRead` RPC.
- **A3** `9923548` — quoted replies that resolve across nodes. A reply references the parent's
  **envelope_id** (stable cross-node). `circle_messages.reply_to` (migration **v41**).
- **C1** `5bd1cc4` — group-canvas FOUNDATION. Cards materialized from the SAME event log as the tab.
  `canvas.card.put`/`canvas.card.remove` events (`tab.ts`), LWW fold (`canvas.ts`), RPCs
  `circles.canvas.list/put/remove`. Right pane now really switches Members ⇄ Canvas.
- **C2** `cebd6de` — the **Decision Card** (first "collective agent output" object). Options set by
  creator; each member's VOTE is a separate signed `canvas.slice.put` event (LWW per
  (card, slot, author)) so votes MERGE. RPC `circles.canvas.slice`. `DecisionCard.tsx`.

**Earlier this session (context):** frictionless invite (link+QR, `8449026`), mailbox-mediated join
so two NAT'd laptops connect with neither reachable (`7098269`, migration v39), and the guest page
deployed live at **https://join.bitterbot.ai/i** (Let's Encrypt). A real friend-to-friend
connection was tested and works end to end.

---

## 3. Architecture you must respect (hard constraints)

1. **Hostile-principal boundary (non-negotiable).** All inbound peer content (message bodies, card
   title/text, slice value/note) is a hostile principal: injection-scanned on receipt
   (`event.append` / `sanitizeInboundCircleText`, critical severity rejected), stored, and rendered
   as **escaped text (never HTML)**. Peer content must **never** flow into the agent's tool-capable
   context or recall memory. When Phase B lands (agent in the room), it runs on a **quarantined,
   tool-less** path (PLAN-36 §5.1-C).
2. **The event log is append-only with circle-wide FORK-FREEZE.** Anything on `circle_events`
   (tab + canvas) inherits: corrections = new events (no edits), a **30-day sync horizon**, and — a
   fork at any `(author, seq)` FREEZES the whole circle's writes (`freezeCircle`), with **no
   unfreeze UI yet** (a Phase-D task).
3. **Transport is fetch + mailbox, not a live socket.** Direct a2a HTTPS when reachable →
   store-and-forward **mailbox** (~15s drain) → gossip topic (prototype, inert/no-confidentiality).
   **No realtime server→UI push** — the gateway emits a content-free `"circles"` event that makes
   the renderer re-poll. "Discord feel" = optimistic local + ~15s peer latency. Message ordering is
   by local receipt time (no global order); only the event log has per-author ordering.
4. **Canvas sync = op-based CRDT on the event log.** A card is an OR-Set entry + LWW fields; the fold
   (`canvas.ts computeCanvasCards`) picks, per key, the greatest `(updated_at, event_id)` — a total
   order every node agrees on. Losing concurrent edits are silently dropped (documented LWW caveat).
   The `updated_at` is carried IN the event body (top-level) so the fold is deterministic.

---

## 4. Key files

**Server (`src/`):**

- `circles/service.ts` — the node-local service (invite/join, sendMessage, tab + canvas methods,
  mailbox drain `pollMailbox`, fan-out). `appendTabEvent` is the GENERIC signed-event append; canvas
  put/slice/remove all reuse it.
- `circles/tab.ts` — the chained-event system: `TabEventInput` union (expense/note/**canvas.card.put
  /canvas.card.remove/canvas.slice.put**), `buildChainedEventBody`, `normalizeInput` (per-type
  validation + string slicing).
- `circles/canvas.ts` — `computeCanvasCards` (folds cards + per-member slices).
- `circles/read-state.ts` — unread (`markCircleRead`, `unreadCounts`).
- `circles/invites.ts`, `circles/pending-join.ts` (mailbox join), `circles/scheduler.ts`,
  `circles/circle-topic*.ts` (gossip, inert).
- `gateway/a2a/circles.ts` — the friend-facing verbs (`circle/join|message|event.append|...`),
  `handleCircleMethod`, `storeInboundMessage` (reply_to extract), fork detection.
- `gateway/server-methods/circles.ts` — the `circles.*` RPCs the renderer calls.
- `memory/migrations.ts` — latest is **v41**. (Canvas has NO migration — it rides `circle_events`.)

**Renderer (`desktop/renderer/src/`):**

- `stores/circles-store.ts` — Zustand per-circle store: circles/messages/cards, actions
  (refresh, selectCircle, send, markRead, loadCards, putCard, putDecision, vote).
- `components/circles/`: `CirclesView` (shell), `CircleRail`, `CircleChat`, `CircleMessageList`
  (reply UI), `CircleRightPane` (Members ⇄ Canvas tabs), `CircleMembers` (roster), `CircleCanvas`
  (board + Note/Decision composer), `DecisionCard`, `InvitePanel`, `CirclesView.test.tsx`.
- Mounted as the `people` tab (labeled "Circles") in `components/layout/AppShell.tsx`.

**Plan / docs:** `docs/plans/PLAN-36-CIRCLES-SOCIAL-GRAPH.md` — the authoritative plan; the
"Redesign build log" section near Phase 3/§7 tracks A1→C2 with rationale. Keep appending there.

---

## 5. What's next (in priority order)

- **C3 — study-guide Co-Canvas** (the college beachhead, PLAN-36 §2.5): a card that assembles from
  each member's contributions (sections + per-member slices), the richest showcase of collective
  output. Same slice architecture as C2.
- **Phase B — the agent in the room (summon-only):** wire inbound `@your-agent` messages into a
  **quarantined, tool-less** agent path that drafts a reply / a card-slice on the member's PERSONAL
  canvas (reuse the existing `create_artifact` / `ArtifactPanel`), quiet-by-default, published only
  via the human's consent tap. This is the security-sensitive one — touches the agent loop + the
  hostile-principal boundary. Do an adversarial pass.
- **Deferred, fold into the event log:** reactions + pins (same shared-state shape as canvas.\*),
  presence cursors on the canvas, the **unfreeze UI**, richer editable card bodies (nested Yjs only
  where live co-edit is needed), real-time gossip (needs the Rust primitive + shared-key confidentiality).

---

## 6. How to build, run, test (operational — important)

- **Node/runtime:** WSL2, node 22.22.1. Never use `--dev`/`gateway:dev` — always production config.
- **The UI you SEE:** the **Vite control UI at http://localhost:5173** (dev server, HMR). Renderer
  changes are live there after a hard-refresh (`Ctrl+Shift+R`). **The gateway-served built renderer
  (`desktop/dist-renderer`) is stale — do not judge the UI from it.** If Vite is wedged after big
  structural edits, restart it: `cd desktop && pnpm dev`.
- **The gateway (data/RPCs):** any **server** change needs a full rebuild to go live:
  `pnpm build` (root, ~15 min) then `pnpm start gateway`. **Cold boot is ~20 min.** Restart pattern:
  SIGINT the `bitterbot-gateway` + `run-node.mjs gateway` PIDs, `rm -f /tmp/bitterbot-orchestrator.sock`,
  rebuild, `nohup pnpm start gateway > log 2>&1 &`. Renderer-only increments need NO gateway rebuild.
- **Tests:**
  - Server: `npx vitest run src/circles/<file>.test.ts` (from repo root). The two-node harness in
    `service.test.ts` routes A2A dials between two in-memory DBs — the best place for cross-node tests.
  - Renderer: `cd desktop && npx vitest run renderer/src/components/circles/CirclesView.test.tsx`
    (happy-dom; mock `useGatewayStore` with an `Object.assign(selector, {getState})` shim).
  - Types: server `npx tsc --noEmit -p tsconfig.json` (~2 min); renderer `cd desktop/renderer &&
npx tsc --noEmit`. Lint: `npx oxlint <files>` (oxlint **ignores** `desktop/`, so the renderer
    gate is tsc only). Prettier gate is `pnpm format:check` (oxfmt) — run it on any non-`src`
    hand-authored file (it caught an unformatted HTML file once and reddened CI).

---

## 7. Standing rules & gotchas (from the user, honor these)

- **Every change wired + active by default, with tests + docs in the SAME commit.** Then a distinct
  **adversarial review pass** before calling anything complete (the mailbox-join pass caught 3 real
  defects — do this for Phase B especially).
- **No dead code / no crud** — replace, don't orphan; delete what you supersede.
- **Commit identity:** author every commit as `VGIL77 <vgil@soapbox.net>` via
  `git -c user.name="VGIL77" -c user.email="vgil@soapbox.net" commit --author="VGIL77 <vgil@soapbox.net>"`.
  End messages with the `Co-Authored-By` + `Claude-Session` trailers (see recent commits).
- **Scope commits to the circles work** — the repo has unrelated uncommitted changes (benchmarks,
  package.json, etc.); stage explicit paths, never `git add -A`.
- **Pushing:** the user has been approving each increment's push. Ask/confirm before pushing unless
  told to proceed; the user often says "proceed."
- **Vite is the happy path; Tauri is NOT released** (first official release ~Q3–Q4 2026). Don't
  assume an installer, a running native app, or the `bitterbot://` deep link exists.
- **Cadence the user likes:** build an increment → test → commit → (rebuild if server) → report
  honestly (what works, what doesn't) → checkpoint before big/risky phases. They value honesty over
  polish and dislike over-narration.

---

## 8. Live infrastructure

- **Mailbox host** (store-and-forward, sealed): `https://mailbox.bitterbot.ai` — DO droplet
  `161.35.98.6`, Caddy TLS. It's the DEFAULT mailbox (`DEFAULT_CIRCLES_MAILBOX_URL`), so join works
  with zero config.
- **Guest-JOIN page:** `https://join.bitterbot.ai/i` — served as a 2nd Caddy site on the SAME
  droplet. Deploy: `SSH_KEY=~/.ssh/bitterbot-relay DROPLET_IP=161.35.98.6 bash deploy/guest-page/deploy.sh`;
  DNS via `deploy/mailbox-host/dns.sh` (needs `CLOUDFLARE_API_TOKEN` from root `.env`; the DO token
  is NOT reliably present — use terraform state / the known IP).
- SSH to the droplet uses `~/.ssh/bitterbot-relay` (the relay-fleet key; it's the authorized key,
  not the default identity).

---

## Immediate task when you start

The gateway is being rebuilt to activate C1+C2. First confirm it's booting (or relaunch it), then
**proceed with C3 (study-guide Co-Canvas)** unless the user redirects to Phase B. Follow the
build→test→commit→rebuild→report cadence above. Read `docs/plans/PLAN-36-CIRCLES-SOCIAL-GRAPH.md`
(the build log) and the memory index for anything this handover compressed.
