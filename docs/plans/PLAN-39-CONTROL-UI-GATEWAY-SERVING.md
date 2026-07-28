# PLAN-39: Control UI Gateway Serving (One-Process Boot)

> Status: DRAFT v1.1, 2026-07-28. **FUTURE WORK — not scheduled, not started.**
> Synthesis of a 3-agent code survey (gateway HTTP surface, Vite/renderer side,
> boot/update/onboarding lifecycle) commissioned by Victor. §12 lists the
> decisions that are Victor's. Standing workflow applies: adversarial review
> pass (§11) before any phase is called complete; every phase lands wired, on
> by default, with tests and docs in the same commit.
>
> **v1.1 review pass, 2026-07-28.** Five corrections folded in, each marked
> inline: (1) §7's WS-derivation precedence, which as written broke the dev
> flow it promised to preserve; (2) N-1 asset retention promoted from an open
> question in §11.4 to a Phase 1 decision, because the no-restart update path
> is exactly the case with no reload trigger; (3) the Host-header allowlist
> promoted from "tested in §11.1" to "built in Phase 3", since nothing was
> building it; (4) §4/D2 gained the first real blackout measurement (a
> 40-minute warm restart), which moves the recommended tier to T2; (5) D7's
> ui-restart work has landed as `82d3d95`, so it becomes the bridge to delete
> in Phase 4 rather than a collision to avoid. Also: skip the desktop install
> on an unchanged lockfile (Phase 1).

## 0. Thesis

The gateway should serve the built Control UI at `GET /` on port 19001, making
`pnpm start gateway` (or the systemd service) the only thing an operator boots.
The Vite dev server remains, but only as the development workflow.

This is not a new design. It is finishing an abandoned one. The config surface
(`gateway.controlUi.{enabled,basePath,root}`, root defaulting to
`dist/control-ui`), the `bitterbot dashboard` command (which already opens
`http://127.0.0.1:19001/` and 404s), the update CLI's dead `ui:build` progress
labels, the `run-node --no-clean` flag and its test asserting
`dist/control-ui/index.html` survives rebuilds, and three docs pages describing
gateway serving as shipped: all of it exists today with no serving code behind
it. This plan makes the code match the promises, and deletes every vestige it
does not resurrect.

**The one real trade-off:** today the Vite UI is a separate process that
survives gateway restarts, so the user sees a reconnect spinner and, crucially,
a working UI when a bad update fails to boot. Merged, the browser gets
connection refused for the whole restart window. §4 (Phase 0) gates the plan on
measuring that window for real, and §9 (Phase 5) scopes the mitigation.

## 1. Verified current state

All verified 2026-07-28 against main + working tree. File:line citations are to
that snapshot.

**Gateway side:**

- Raw `node:http`/`node:https`, hand-written if-chain routing ending in 404
  (`src/gateway/server-http.ts:483-710`). `GET /` is a 404.
- `gateway.controlUi.root` and `.enabled` are read by nothing. `.basePath` is
  consumed only as the avatar URL prefix (`server-runtime-config.ts:49`) and by
  Tailscale exposure (`server.impl.ts:652`), which already proxies the gateway
  port expecting a UI at that base path.
- Working static-file machinery exists twice under `src/canvas-host/`
  (`server.ts:298-385`, `a2ui.ts:130-197`): traversal-safe resolver
  (`file-resolver.ts:211-255`), index.html directory fallback, per-request
  async reads. Known gaps if reused: the MIME table (`src/media/mime.ts:6-41`)
  has no `.js/.mjs/.css/.svg/.woff2/.map` entries (ES modules would be served
  as `application/octet-stream` and rejected by browsers), `Cache-Control:
no-store` is hardcoded, and there is no compression anywhere in the gateway.
- The gateway binds N sockets (127.0.0.1 + ::1 by default), each with its own
  server instance (`server-runtime-state.ts:141-191`). WS upgrade is
  path-agnostic (`server-http.ts:726-756`), so a same-origin WS needs no
  routing change.
- Auth: loopback HTTP is effectively unauthenticated on the existing HTML pages
  (`/dreams`, `/management`, `/m`, `/wallet/fund`), each of which injects the
  gateway token server-side into the page (`server-http.ts:525,548,587,613`).
  The WS origin check allows the 5173 cross-origin connection only via the
  both-loopback fallback (`origin-check.ts:47`).

**Renderer side (`desktop/`):**

- Pure static build: single HTML entry, `base: "./"`, no client-side router
  (zustand tab switch, `AppShell.tsx:29-56`), no service worker, no dev-only
  runtime dependencies. `vite build` output: `desktop/dist-renderer`, ~12 MB,
  ~2.5 MB cold load; the tail is lazy Shiki chunks.
- The WS URL is baked absolute (`ws://localhost:19001` default) via a Vite
  `define`; nothing derives from `window.location`
  (`gateway-store.ts:101-108`). Five call sites re-derive an HTTP origin by
  string-replacing `ws:` to `http:`, each with its own hardcoded fallback
  (ArtifactPanel, DreamsView, ManagementView, WalletView,
  CodeInterpreterView).
- The gateway token is baked into the bundle at build time
  (`vite.config.ts:87-92`). PLAN-37 item 13 already schedules this mechanism
  for deletion.
- Public assets referenced with absolute root paths (`/bitterbot_avatar.png`,
  `/Bitterbot_logo.svg`) contradict `base: "./"` under any non-root mount.
- `window.__BITTERBOT_GATEWAY_URL__` is read in ManagementView and set by
  nothing (orphan).
- Tauri already consumes the same artifact as static files
  (`tauri.conf.json:8`, `frontendDist: "../dist-renderer"`).

**Lifecycle:**

- Root `pnpm build` does not build the renderer. Only Tauri consumes
  `dist-renderer`. The wizard writes `desktop/.env` and calls the missing
  version "the single biggest friction point" (`onboarding.control-ui-env.ts:5-9`).
- A service-installed node has a supervised gateway and an unsupervised Vite
  process that dies on reboot with nothing to restart it. There is no unit,
  plist, or scheduled task for the UI.
- `src/infra/ui-restart.ts` (port probe, PID sniff + identity match,
  SIGTERM/SIGKILL, supervisor handshake, respawn watch) plus
  `update.uiRestart.enabled` config, a hidden CLI command, the boot-watchdog
  hook, and `start-all.mjs`'s UI-respawn policy exist only because the Vite
  process cannot pick up an applied update. `[updated 2026-07-28: landed as
82d3d95, no longer uncommitted — see D7 for the bridge-then-delete ruling]`
- Vestiges of the abandoned design: `ui:build` progress labels
  (`src/cli/update-cli/progress.ts:24-26`) emitted by nothing; update-runner
  tests mocking a nonexistent `pnpm ui:build`; `doctor-update.ts:54` telling
  users a ui:build step runs; Dockerfile lines 20-21,30 referencing `ui/` and
  `patches/` dirs that do not exist (the Dockerfile cannot build as written);
  `:!dist/control-ui/` pathspec exclusions in update-check, update-runner, and
  boot-watchdog that are currently no-ops; `run-node.test.ts:16-68` protecting
  an artifact that never ships; docs (`docs/web/control-ui.md:168`,
  `docs/web/index.md:118`, `docs/web/dashboard.md:9`) describing gateway
  serving as shipped.
- Boot-time figures in-repo disagree by two orders of magnitude: 1.5 s
  advertised restart hint (`run-loop.ts:78`), ~60 s wizard-measured cold start
  (`onboarding.finalize.ts:645-648`), ~190 s on 9P pre-bundling
  (`build-gateway-entry.mjs:6-8`), "~20 minutes" in three docs. Observed
  2026-07-27 on Victor's node: ~5 minutes.

## 2. Goals and non-goals

**Goals:**

1. One process to boot for operators: gateway serves the Control UI at `/`.
2. Zero functional regression: everything the UI does today (chat, canvas
   iframes, dreams/management embeds, wallet funding, update banner, FirstRun
   remote connect) keeps working, same-origin or cross-origin.
3. No crud left behind: every vestige in §1 is either resurrected into live
   code or deleted in the phase that touches it. No orphaned config keys, dead
   progress labels, broken Dockerfile lines, or docs that describe fiction.
4. Preserve the dev workflow byte-for-byte: `pnpm dev:all` (Vite + HMR against
   the gateway, cross-origin) stays first-class.
5. Advance, not fight, the release roadmap (§10): Tauri Q3-Q4 2026, the W2
   hosted-renderer option, PLAN-37 secret consolidation, PLAN-32 fleet sync.

**Non-goals:**

- Replacing Vite/HMR for development.
- Building the W2 hosted webapp (`app.bitterbot.ai`) or any hosted tier.
- Changing Tauri packaging (it already uses the static artifact).
- Serving the UI off-loopback by default, changing bind modes, or altering the
  gateway auth model beyond the token-handoff endpoint in §7.
- General HTTP-server hardening (CSP headers for the API routes, rate limits)
  beyond what the new static route itself requires.

## 3. Design principles

1. **Same artifact, three consumers.** `desktop/dist-renderer` is the single
   build output; the gateway copy (`dist/control-ui`), Tauri, and any future
   hosted deployment consume it unmodified. No gateway-specific build flavor.
2. **The gateway serves files, not a bundler.** No SSR, no transforms, no
   template rewriting of the Vite output. The only dynamic behavior is the
   token handoff endpoint (§7), which is separate from the static files, so
   the artifact stays deployable to a CDN untouched (W2 compatibility).
3. **Runtime config beats build-time config.** The renderer must work with
   zero baked env: WS URL derived from `window.location` when same-origin,
   localStorage override for remote gateways, `VITE_*` defines demoted to
   dev-only conveniences and the token define deleted outright.
4. **Kill switch, on by default.** `gateway.controlUi.enabled` (already in
   schema) gates the whole feature, default true, per the standing
   wired-and-active rule. Disabling restores today's 404 exactly.
5. **Delete, don't strand.** Each phase's checklist names the vestiges it
   retires. The adversarial pass greps for every identifier this plan touches.

## 4. Phase 0: measure, then decide the mitigation tier (gate)

The blackout cost (§9) is the only argument against this plan, and every
number for it is folklore. Before any code:

- [ ] Instrument and record real wall-clock on Victor's node (WSL2) and one
      clean Linux box: (a) SIGUSR1 restart-to-first-HTTP-byte with warm dist,
      (b) full update path (`update.run`: fetch, rebase, build, doctor,
      restart), (c) cold boot after reboot. The gateway already logs listen
      time; add a `boot.timings` line to the health snapshot if needed
      (doctor's agent-turn probe work gives a precedent for where).
- [ ] Record how long `vite build` takes on the same hardware (affects Phase 1
      update-path latency).
- [ ] Decide mitigation tier per §9 based on the numbers: T0 (browser retry,
      document it), T1 (update-banner countdown + retry loop in the SPA), T2
      (watchdog serves a static status page during downtime).
- [ ] Confirm `pnpm --dir desktop build` succeeds from a clean checkout today
      (the existing dist-renderer is stale, dated May 3) and that the built
      index.html carries the current CSP (the checked-in stale copy does not).

Exit criteria: numbers written into this doc, tier chosen (Victor's call,
§12 D2), go/no-go recorded.

**First real data point, recorded 2026-07-28** (unprompted, from a routine
restart on Victor's WSL2 node — this is measurement (a), the CHEAPEST case):
a deliberate stop + `pnpm start:all` with a freshly-built warm `dist`, no
update, no rebase, **had not bound port 19001 after 40 minutes**. The process
was alive and burning ~12% CPU the whole time, so this is slow boot work, not
a hang. Vite by contrast was serving in seconds.

Two consequences, before the rest of Phase 0 even runs:

- The "1.5 s advertised restart hint" (`run-loop.ts:78`) is off by three
  orders of magnitude on this hardware. Whatever tier is chosen, that
  constant is a bug in its own right.
- **T0 ("browsers retry cheaply") is not a tier on this node, it is table
  stakes.** A 40-minute connection-refused window with no explanation on
  screen is exactly the failure this plan's one real trade-off predicts. Plan
  for **T2** and treat T0+T1 as the floor beneath it. Phase 0 still runs — a
  clean Linux box may look nothing like this, and the gap between the two is
  itself the finding.

## 5. Phase 1: build pipeline (`ui:build` becomes real)

- [ ] Add root script `"ui:build": "pnpm --dir desktop install --frozen-lockfile && pnpm --dir desktop build && node --import tsx scripts/control-ui-copy.ts"`.
      The name is chosen deliberately: it is the name the update flow's
      progress labels and tests already expect.
- [ ] `scripts/control-ui-copy.ts`, modeled on `scripts/canvas-a2ui-copy.ts`:
      copies `desktop/dist-renderer` to `dist/control-ui`, fails loudly if the
      source is missing (env escape `BITTERBOT_CONTROL_UI_SKIP_MISSING` for
      CI slices that legitimately skip the renderer, mirroring
      `BITTERBOT_A2UI_SKIP_MISSING`).
- [ ] **N-1 asset retention — DECIDED here, not deferred to §11.4**
      `[added 2026-07-28 review]`. The copy step must NOT empty
      `dist/control-ui`: it overwrites `index.html` and public files, adds the
      new content-hashed `assets/*`, and prunes only generations older than
      the previous one. Rationale: this plan's headline feature is that a UI
      update needs **no restart** — which is precisely the case with no reload
      trigger. An open tab holds the old `index.html`; if the copy purges the
      old hashed chunks, every lazy import (the Shiki tail, any code-split
      view) 404s mid-session with nothing prompting a reload. When the gateway
      restarts, §9's poll-reload covers it; when only files changed, nothing
      does. Two-generation retention costs ~12 MB of disk and makes the race
      impossible rather than "accepted". §11.4 verifies this; it does not
      re-open it.
- [ ] Content-hash skip, modeled on `scripts/bundle-a2ui.sh:79-90`: hash the
      renderer source tree; skip `vite build` when unchanged so `pnpm build`
      does not pay ~12 MB of Vite for a gateway-only change. **Skip the
      `pnpm --dir desktop install` the same way** `[added 2026-07-28 review]`:
      gate it on the desktop lockfile hash plus the existence of
      `desktop/node_modules`, because on 9P/WSL filesystems a frozen-lockfile
      install that changes nothing still costs real minutes on every root
      build — and the root build runs inside `update.run`, where that time is
      blackout time (§9).
- [ ] Wire `ui:build` into the root `build` script after
      `canvas-a2ui-copy`. `run-node.mjs --no-clean` already preserves
      `dist/control-ui` across incremental tsdown runs; `run-node.test.ts`
      finally protects a real artifact.
- [ ] `update-runner.ts`: emit the existing `"ui:build"` and
      `"ui assets verify"` progress steps for real (build renderer during
      update, verify `dist/control-ui/index.html` exists post-build). Un-mock
      the tests: they currently mock `pnpm ui:build`; make them assert the
      real step ordering. `doctor-update.ts:54`'s message becomes true.
- [ ] Dockerfile: replace the broken lines that reference `ui/package.json`,
      `pnpm ui:build`, and `patches/` with the real paths (`desktop/`), or, if
      Victor prefers (§12 D4), delete Docker support and the file. It cannot
      build today either way; leaving it broken is not an option.
- [ ] `run-gateway-fast.mjs`: no change needed for the copy (it rsyncs `dist/`
      wholesale), but the resolver in Phase 2 must find assets relative to the
      staged dist, not the repo (candidate-list pattern, §6).
- [ ] npm tarball: `package.json` `files` already includes `dist/`; the
      published package grows ~12 MB and a global npm install gains a UI it
      never had (§12 D3 confirms acceptance). Trim the two largest wins first:
      `bitterbot_avatar.png` is 1.35 MB and should be optimized or downscaled
      as part of this phase.

Crud retired in this phase: dead `ui:build` labels become live; update-runner
test mocks become real; Dockerfile fiction fixed or removed;
`doctor-update.ts` message becomes accurate.

## 6. Phase 2: gateway static serving

New module `src/gateway/control-ui-http.ts` plus a resolver
`src/gateway/control-ui-assets.ts`, modeled on the canvas-host pair but
independent of canvas-host (which is disabled under test env and gated on
`if (canvasHost)`; the Control UI must not inherit either gate).

- [ ] Root resolution via candidate list, exactly the `a2ui.ts:17-55` pattern:
      explicit `gateway.controlUi.root` if set, else `dist/control-ui`
      relative to the package root, else `desktop/dist-renderer` (dev
      convenience for `pnpm start` from a checkout without full build), else
      `dirname(process.execPath)/control-ui` (SEA/Tauri sidecar), plus env
      override `BITTERBOT_CONTROL_UI_DIR`. Cached realpath. This also covers
      the `run-gateway-fast` staged-dist case and systemd `WorkingDirectory`.
- [ ] Serving: GET/HEAD only, `resolveFileWithinRoot` for traversal safety,
      `index.html` fallback for `/` and directory paths only (no SPA history
      fallback; the renderer has no router). Whole-file async reads are
      acceptable at this size; never `readFileSync` (the avatar route's
      synchronous read is an anti-pattern, not a precedent).
- [ ] MIME: extend `MIME_BY_EXT` in `src/media/mime.ts` with `.js`, `.mjs`,
      `.css`, `.svg`, `.woff2`, `.woff`, `.map`, `.wasm`, `.json`, `.txt`.
      This fixes canvas-host serving too (today it serves JS as octet-stream);
      note that in the changelog since it is a behavior change for canvas.
- [ ] Caching: `Cache-Control: public, max-age=31536000, immutable` for
      `assets/*` (Vite content-hashes them), `no-cache` plus ETag for
      `index.html` and public files. This is what makes "UI update = file
      copy, next reload gets it" true with no restart.
- [ ] Compression (§12 D5): precompress `.js/.css/.svg` to `.br`/`.gz` at
      copy time in `control-ui-copy.ts` and serve by `Accept-Encoding`, or
      skip compression entirely for v1 (loopback makes it near-free to skip).
      No runtime zlib in the request path either way.
- [ ] Mounting: in `server-http.ts`, after every existing route and
      immediately before the 404 at `:703`, gated on
      `gateway.controlUi.enabled !== false` and method GET/HEAD. Mounted at
      `basePath` (default `/`) via the existing `normalizeControlUiBasePath`.
      Explicitly excluded prefixes are unnecessary because ordering already
      protects `/dreams`, `/management`, `/m`, `/wallet/fund`, `/a2a`,
      `/v1/*`, hooks, Slack, canvas, avatars, and runtime plugin routes; the
      adversarial pass (§11) must include a route-shadowing test proving a
      plugin registering `/api/x` still wins.
- [ ] Auth semantics: static assets are served with the same gate as the
      existing HTML pages, i.e. authorized bearer token OR
      `isLocalDirectRequest` (loopback). Off-loopback binds without auth
      already refuse to start, so this adds no new exposure; the UI shell
      itself contains no secrets once Phase 3 removes the baked token.
- [ ] Event-loop: reads are async and the cold burst is ~2.5 MB; no yielding
      changes expected, but the event-loop monitor thresholds
      (`event-loop-monitor.ts`) are the regression check in §11.
- [ ] Unit tests: MIME table, traversal attempts, basePath stripping,
      index.html fallback, enabled=false restores 404, immutable vs no-cache
      split, candidate-list resolution order.

Crud retired: `controlUi.root` and `controlUi.enabled` become live config;
`docs/web/control-ui.md` and `docs/web/index.md` claims become true;
`bitterbot dashboard` and `resolveControlUiLinks` URLs stop 404ing.

## 7. Phase 3: renderer changes

- [ ] **WS URL derivation.** New single helper `lib/gateway-origin.ts`.
      **Precedence, in this order — the order is the spec, not an
      implementation detail** `[fixed 2026-07-28 review]`: 1. localStorage override (remote gateways, FirstRun's manual entry); 2. `VITE_GATEWAY_URL` **when `import.meta.env.DEV`** — this is the
      branch that keeps `pnpm dev:all` alive and it MUST sit above
      derivation; 3. `location`-derived (`ws(s)://${location.host}`, HTTP origin =
      `location.origin`) when the page origin is a real HTTP(S) origin; 4. hardcoded loopback fallback (`ws://localhost:19001`).
      The naive "derive whenever the origin is real" rule breaks the dev flow
      it claims to preserve: under `pnpm dev:all` the page origin is
      `http://localhost:5173`, which is a perfectly real origin, so
      derivation would yield `ws://localhost:5173` where no gateway listens
      and the fallback chain would never be reached. (The alternative — a Vite
      WS proxy so same-origin derivation is correct in dev too — is cleaner
      but a larger change than this plan intends; if it is ever taken, this
      precedence list collapses to 1 → 3 → 4.)
      Replace all five `ws:` to `http:` string-replace call sites
      (ArtifactPanel, DreamsView, ManagementView, WalletView,
      CodeInterpreterView) with the helper. FirstRun's manual URL entry and
      localStorage override keep working for remote gateways.
- [ ] **Delete the token define** (`VITE_GATEWAY_TOKEN` in
      `vite.config.ts:87-92` and its uses), completing PLAN-37 item 13.
      Replacement: a same-origin token handoff endpoint on the gateway,
      `GET <basePath>/auth/session-token`, gated by exactly
      `isLocalDirectRequest` (the same trust the existing dashboard pages
      encode when they inject the token into HTML). Response:
      `{ token }` or 403. The renderer's bootstrap tries, in order:
      localStorage, same-origin handoff endpoint, FirstRun manual entry.
      Off-loopback there is no silent handoff; FirstRun is the documented
      path (the PLAN-37-accepted UX cost). This endpoint is new attack
      surface and gets first billing in §11.
- [ ] **Host-header allowlist — BUILD it here, don't just test it**
      `[added 2026-07-28 review]`. §11.1 names DNS rebinding as an attack on
      the handoff endpoint and says the Host check "must hold", but no phase
      previously built one, so the adversarial pass would have discovered a
      MISSING control rather than verified a present one. `isLocalDirectRequest`
      answers "did this connection arrive on a loopback socket", which a
      rebinding attack satisfies: the victim's browser connects to
      127.0.0.1 on the attacker's behalf after the DNS TTL flips, and
      `evil.example` resolving to 127.0.0.1 is an ordinary loopback request.
      The missing check is on the `Host` header itself. Deliverable: the
      handoff endpoint (and, since they encode the same trust today, the
      existing token-injecting HTML routes `/dreams`, `/management`, `/m`,
      `/wallet/fund`) reject any request whose `Host` is not
      `localhost`/`127.0.0.1`/`[::1]` on the bound port, plus any operator-
      configured hostnames (Tailscale Serve's name, `controlUi.allowedHosts`).
      Verify how this composes with `trustedProxies` before writing it.
- [ ] **Origin check tightening.** Same-origin serving means the browser's
      `Origin` equals the gateway host and passes the exact-match branch of
      `checkBrowserOrigin`; the loopback-fallback branch remains only for the
      dev flow. Config `gateway.controlUi.allowedOrigins` stays (dev and
      Tauri `tauri://` origins), docs updated to say so.
- [ ] **Asset path fixes.** Change the four absolute public-asset references
      (`/bitterbot_avatar.png` in MessageList and BitterBotAvatar,
      `/Bitterbot_logo.svg` twice in Sidebar) to imported assets or
      `import.meta.env.BASE_URL`-relative paths so a non-root `basePath`
      works.
- [ ] **CSP.** With same-origin serving, `connect-src 'self'` covers WS and
      HTTP to the gateway on every origin (loopback, tailnet, LAN); keep the
      explicit loopback entries solely for the cross-origin dev flow and the
      remote-gateway case, and reevaluate the jsdelivr font sources (self-host
      the two Geist files into `public/` to drop the CDN dependency, making
      the UI fully offline-capable).
- [ ] **Orphan cleanup.** Delete `window.__BITTERBOT_GATEWAY_URL__` handling
      in ManagementView (set by nothing) in favor of the helper; delete
      ManagementView's token-in-query-string (`/management?token=`), since
      same-origin iframes inherit the loopback trust the page itself used.
      Keep DreamsView/ArtifactPanel iframes pointed at the derived origin.
- [ ] **`desktop/.env` demotion.** The wizard stops writing it (Phase 4);
      `VITE_GATEWAY_URL` remains an optional dev override documented in
      `desktop/README`. Delete `writeControlUiEnv` and its tests once the
      wizard no longer calls it.
- [ ] Renderer tests: gateway-origin helper unit tests (same-origin, override,
      dev fallback), FirstRun flow against handoff-403.

Crud retired: token-in-bundle mechanism (PLAN-37 item 13), token-in-query for
management iframe, `__BITTERBOT_GATEWAY_URL__` orphan, `desktop/.env` wizard
friction, docs' unimplemented `?gatewayUrl=` bootstrap claims (either
implement that spec here or delete it from `docs/web/control-ui.md:196-212`
and `TAURI.md:64-84`; recommendation: delete, the handoff endpoint replaces
it).

## 8. Phase 4: lifecycle rewiring and crud deletion

- [ ] **`start-all.mjs`**: gateway now implies UI. `planStack` reduces to
      "start gateway unless managed elsewhere or already up"; the UI child,
      port-5173 probe, `UI_PORT`, respawn window logic, and
      `BITTERBOT_START_ALL_NO_GATEWAY` UI-only mode are deleted. `start:all`
      becomes a thin alias of `start gateway` kept for muscle memory (or is
      removed, §12 D6). `dev-all.mjs` is untouched.
- [ ] **Delete the ui-restart machinery**: `src/infra/ui-restart.ts` and its
      test, the `update.uiRestart.enabled` config key (type + zod schema), the
      hidden `ui-restart` CLI command (registry entry + `register.maintenance`
      action), the `spawnUiRestarter` call in `update.run`, the boot-watchdog's
      post-rollback hook, and `start-all.mjs`'s `decideChildExitAction` +
      `UI_RESPAWN_*` constants + their tests. It landed as `82d3d95` (§12 D7):
      delete it here rather than reverting it out from under the fleet. This
      plan makes the entire mechanism unnecessary because served assets are
      read from disk per request: after `update.run` rebuilds and recopies,
      the next browser reload gets the new UI with no UI process to restart.
      **Order matters**: this deletion lands in the SAME commit as the
      wizard/start-all cutover, never before it, or a node updating mid-window
      gets neither mechanism.
- [ ] **Wizard**: `CONTROL_UI_PORT`/5173 removed; success page and
      `spawnStackHardened` open `http://127.0.0.1:<gatewayPort><basePath>`;
      `writeControlUiEnv` deleted; the 90 s WS poll now doubles as the UI
      readiness check (same port). The "gateway is not user-facing" comment
      dies.
- [ ] **`bitterbot dashboard` / `resolveControlUiLinks`**: already emit the
      right URL; delete the never-read `#token=` fragment appending or make
      the renderer consume it. Recommendation: delete; the handoff endpoint
      covers loopback and FirstRun covers remote.
- [ ] **Update flow**: `update.run` keeps its sequence with `ui:build` now
      real (Phase 1). The `:!dist/control-ui/` pathspec exclusions in
      update-check, update-runner, and boot-watchdog become meaningful
      (UI assets must not mark the tree dirty and must not be nuked by
      rollback's `git reset --hard`, which they survive by being gitignored
      under `dist/`). Verify the boot-watchdog's rebuild path also runs
      `ui:build` so a rollback restores a servable UI.
- [ ] **Docs sweep**, same commit as the code it describes: README (three
      5173 references), CONTRIBUTING, `docs/concepts/architecture.md`,
      `docs/start/*`, `docs/web/index.md` and `control-ui.md` and
      `dashboard.md`, `docs/gateway/configuration-reference.md` (controlUi
      table), `docs/gateway/remote.md` (Tailscale Serve section now
      literally true). Dev docs state plainly: production = gateway-served,
      development = `pnpm dev:all` with Vite on 5173.
- [ ] **Doctor**: add a `control-ui` check to the contract (severity model
      per the doctor overhaul): error if `controlUi.enabled` and the resolved
      root lacks `index.html` (a node that would 404 its own dashboard);
      info-level note of resolved root and basePath. This keeps "one thing to
      boot" honest under the update gate.

## 9. Phase 5: restart blackout mitigation (tier chosen in Phase 0)

- **T0, always shipped**: document the behavior; browsers retry on refused
  connections cheaply, and the SPA already reloads after reconnect. Verify
  `UpdateBanner.reloadAfterReconnect` handles connection-refused (today it
  waits for a WS drop then reloads; against a dead server the reload lands on
  a browser error page). Change it to: on disconnect during update, poll
  `GET /` with backoff and reload only after a 200. This alone converts the
  worst UX (error page) into "spinner until the gateway is back".
- **T1, if measured restart is tens of seconds**: nothing more than T0 plus a
  banner countdown fed by the `restartExpectedMs` hint, corrected to a
  realistic measured value instead of 1500 ms.
- **T2, if measured window is minutes or the failed-boot case matters**
  (recommended if cold boot stays over ~2 min): the boot-watchdog (already a
  detached process that outlives the gateway, PLAN "auto-rollback" work)
  binds the gateway port the moment the gateway releases it and serves a
  single static status page (inline HTML, no assets) showing update progress
  from the sentinel/beacon files, releasing the port when the gateway is
  ready to bind. This restores the one genuine loss from killing the separate
  UI process: a screen that can say "the update failed, here is the log
  line", instead of connection refused. Scope it as its own commit; it
  touches the watchdog, not the gateway.

## 10. Future-release alignment

- **Tauri (Q3-Q4 2026 target)**: unaffected and helped. Tauri already loads
  the same static artifact from disk and spawns the gateway as a sidecar; it
  never needed the gateway to serve HTTP. Phase 3's location-derived WS URL
  is written to fall back exactly as today when the page origin is
  `tauri://`, and the `dirname(execPath)/control-ui` resolver candidate is
  the SEA-sidecar path. Nothing in this plan forks the artifact.
- **W2 hosted renderer (browser-node review)**: Phase 3 is a strict
  prerequisite of W2 as well: a CDN-hosted renderer needs no baked token and
  a runtime-configurable WS target. Principle 2 (no server-side rewriting of
  the artifact) keeps the same build deployable to `app.bitterbot.ai`
  unchanged. This plan moves toward W2, not away from it.
- **PLAN-37 secret consolidation**: Phase 3 lands item 13 (delete the token
  define) with the gateway-served handoff PLAN-37 sketched at lines 653-656
  and 783-786. Cross-reference in both docs when landing.
- **PLAN-32 fleet sync**: UI assets ride `dist/` and the existing update
  channel; config-push needs no new asset story.
- **Public circles / hosted tiers**: no interaction; the UI remains
  operator-local.

## 11. Attack surfaces for the adversarial pass

Per the standing workflow, each phase gets a distinct adversarial review
before being called complete. Designated surfaces:

1. **Token handoff endpoint** (§7): loopback spoofing via proxy headers
   (`isLocalDirectRequest`'s `X-Forwarded-*` rejection must hold), DNS
   rebinding (the Host allowlist §7 now BUILDS — verify it rejects
   `evil.example` resolving to 127.0.0.1, which is an ordinary loopback
   request as far as socket-level checks are concerned), token exposure in
   logs, interaction with `trustedProxies` and Tailscale Serve.
2. **Static resolver**: traversal, symlink escape, case-insensitive
   filesystems (WSL/mnt), encoded slashes, basePath confusion, the
   candidate-list picking a wrong root when both `dist/control-ui` and
   `desktop/dist-renderer` exist but differ.
3. **Route shadowing**: prove plugin routes, `/a2a`, `/.well-known`, hooks,
   Slack, and canvas all still win over the catch-all; prove a plugin
   registered after boot still wins.
4. **Caching correctness across updates**: immutable assets + no-cache
   index.html must guarantee "reload after update = new UI, never a
   half-old/half-new mix". N-1 retention is DECIDED in Phase 1, so this row
   VERIFIES it rather than re-opening it: with a tab holding the previous
   `index.html`, a lazy chunk from the previous generation must still 200
   after an update lands, and the generation before that must be gone.
5. **Origin/CSP matrix**: same-origin loopback, same-origin tailnet via
   Serve, cross-origin dev (5173), Tauri webview, remote-gateway FirstRun.
   Each row: WS connects, iframes render, no mixed-content, no token leak.
6. **Blackout behavior**: kill the gateway mid-session at each tier; verify
   the SPA's poll-reload; verify T2's port handoff has no race with the
   gateway's `exclusive: false` listen.
7. **Event-loop regression**: cold-load burst while a consolidation sweep
   runs; event-loop monitor max-delay must not cross the 250 ms warn
   threshold attributable to static serving.
8. **Deletion sweep**: grep for every retired identifier (`ui-restart`,
   `uiRestart`, `writeControlUiEnv`, `VITE_GATEWAY_TOKEN`,
   `__BITTERBOT_GATEWAY_URL__`, `CONTROL_UI_PORT`, `UI_PORT`,
   `BITTERBOT_START_ALL_NO_GATEWAY` UI branch, `#token=`, `?gatewayUrl=`)
   proving zero survivors outside changelogs and this doc.

## 12. Decisions for Victor

- **D1. Ship it at all?** This plan changes the operator happy path from
  "two processes" to "one". Everything below assumes yes.
- **D2. Blackout mitigation tier** (§9): T0/T1/T2, informed by Phase 0
  numbers. ~~Recommendation: T0+T1 now, T2 only if cold boot stays over ~2
  min~~ — **revised 2026-07-28**: the first real measurement (§4) is a
  40-minute warm restart on Victor's node, which is 20x past the T2 trigger
  the original recommendation set. Recommendation is now **T0+T1+T2**, with
  T2 built on the boot-watchdog. Phase 0 still runs to see whether this is
  WSL2-specific.
- **D3. npm tarball growth** (~+12 MB, global installs gain a UI).
  Recommendation: accept; it converts a broken promise into a feature.
- **D4. Dockerfile: fix or delete.** It cannot build today. Recommendation:
  fix in Phase 1 (it is four lines), unless Docker is formally unsupported.
- **D5. Compression: precompress at copy time vs skip for v1.**
  Recommendation: skip for v1 (loopback), leave the hook in
  `control-ui-copy.ts`.
- **D6. `start:all` fate**: thin alias of `start gateway` vs removal.
  Recommendation: keep as alias one release, then remove; the wizard and docs
  move immediately.
- **D7. The ui-restart work**: `[updated 2026-07-28 — it landed]` no longer
  uncommitted. It is `82d3d95` on main: `src/infra/ui-restart.ts`,
  `update.uiRestart.enabled`, the hidden `ui-restart` CLI command, the
  boot-watchdog hook, and the `start-all.mjs` UI-respawn policy, with tests
  and docs. Recommendation: **keep it as the bridge, delete it in Phase 4.**
  The edge fleet's stale-UI pain is today; this plan is six phases behind a
  measurement gate. The two mechanisms do not conflict in the interim — the
  restarter only fires on `update.run` success and on rollback, both of which
  become no-ops once assets are served from disk per request. The original
  "do not ship both mechanisms" rule is therefore **struck as an interim
  rule**: shipping both briefly is the safe bridge state, and Phase 4 already
  enumerates every identifier to remove (`ui-restart`, `uiRestart`, the
  respawn window constants) for §11.8's sweep to prove gone.
- **D8. Default `basePath`**: keep `/`. Sub-path serving works after Phase
  3's asset fixes but stays non-default (Tailscale Serve uses it).

## 13. Phase ordering and rollback

Order: 0 (gate) → 1 → 2 → 3 → 4 → 5, each phase landing wired-and-on with
tests and docs per the standing rule. Phases 1+2 are independently shippable
(gateway serves UI; nothing else changes; 5173 still works cross-origin).
Phase 3 is renderer-only and backward compatible (derivation falls back to
today's chain). Phase 4 is the cutover commit and the only one that changes
operator-visible behavior; it is also the crud-deletion commit. Phase 5 rides
the watchdog.

Rollback at any point: `gateway.controlUi.enabled: false` restores the 404
and the cross-origin flow, which Phase 3 keeps functional forever (it is the
dev flow). No migration, no data, no schema. The only irreversible step is
deleting the ui-restart machinery, which is exactly the point.
