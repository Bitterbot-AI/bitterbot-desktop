---
title: "System Prompt"
summary: "How Bitterbot assembles each agent's identity, memory, economics, and tools into a living system prompt"
read_when:
  - Understanding what the agent sees in its context window
  - Editing system prompt behavior or bootstrap injection
  - Debugging why the agent behaves a certain way
---

# System Prompt

Bitterbot builds a unique system prompt for every agent run. Unlike static system prompts, this one is **alive** — it reflects who the agent is right now: its emotional state, its evolving personality, what it's curious about, what it's earned, and what it knows about you.

The prompt is the agent's mirror. Change the Genome, and the safety axioms change. Let the dream engine run overnight, and the Phenotype section will read differently in the morning. Earn USDC from skill sales, and the economic identity updates. It's not configuration — it's identity.

## Prompt Structure and the cache boundary

The prompt is rendered in two halves separated by one constant marker line,
`<!-- BITTERBOT_CACHE_BOUNDARY -->`. Everything **above** the marker is stable
for the life of a session; everything **below** may change on every call.
Anthropic's prompt cache is a prefix match over `tools -> system -> messages`,
so the split lets the stable half (and the tool definitions in front of it)
stay cached while hormones, facts and runtime state move underneath.

The marker is consumed by the Anthropic payload wrapper (the model never sees
it: `system` is sent as two text blocks). For every other provider it stays in
the prompt as an HTML comment, constant bytes with no instruction content.
The stable half is byte-normalized (CRLF to LF, trailing whitespace trimmed,
blank-line runs collapsed) so cosmetic differences can never bust the cache.

### Above the boundary (cached, stable per session), in order

1. Identity line.
2. **Tooling**: one sorted line of tool _names_ only (`Tools: a2a_status, exec, ...`). No prose summaries: descriptions already ship in the `tools` parameter and a recap in the prompt is pure inflation.
3. **Tool Call Style**, **Work Planning**, **Workflow Management**.
4. **Safety**: short guardrail reminders (enforced at runtime by tool policy, exec approvals and sandboxing).
5. **Agent Wallet** (when the `wallet` tool is present), **Bitterbot CLI Quick Reference**.
6. **Skills (mandatory)**: the `<available_skills>` index, compacted to name + one short line per skill and capped at ~1k tokens (descriptions step down 160 -> 80 -> 40 chars, then names only; skills are never dropped). Skills whose file sits at `<root>/<name>/SKILL.md` under the dominant root (the bundled dir on a stock install) share one `Default location:` line instead of a ~70-char `<location>` each. The PLAN-13 P2P trust notice, when present, is compacted to its operative rule (~110 tokens) and pi-coding-agent's preamble sentences that the Skills rules restate are dropped. Bodies load on demand with `read`.
7. **Memory System**: a short index (<= 600 tokens): one line per memory tool (`memory_search`, `memory_get`, `memory_status`, `working_memory_note`, `dream_search`/`dream_status`, `curiosity_state`/`curiosity_resolve`, Crystal Pointers) saying when to reach for it, two rules (`INTERCEPTOR:` directives are guardrails, hormones colour tone), then compact **Economic Identity** (+ Forage) and **Circles** fragments. The long-form guidance that used to be inlined here (crystal lifecycle and pipeline, hormonal modulation, pre-action interceptors, curiosity engine, working-memory protocol, Forage, Circles) moved to bundled skills that load only when their situation applies: `memory-architecture`, `working-memory-protocol`, `curiosity-loop`, `pre-action-interceptors`, `forage-economy`, `circles-protocol` (and `wallet-payments` for the HTTP 402 workflow that used to sit in the Agent Wallet section).
   Economic Identity carries a capability sentence only ("disabled" / "offline" / "connected to the P2P skills marketplace (you are 12D3..., edge tier)"). Peer counts, network health, telemetry pulse and anomaly counts are never rendered; the agent calls `network_status`, `a2a_status` or `management.anomalies` for live numbers.
8. **Bitterbot Self-Update**, **Model Aliases**, the `session_status` date hint.
9. **Workspace**, **Documentation** (one pointer line: local docs path, mirror, source), **Sandbox**, **User Identity**, **Workspace Files (injected)** header (plus one `Sections omitted for this session` pointer line when template sections were left out, see below), **Reply Tags**, **Messaging** (routing rules and the `message` tool; the inline-buttons hint follows the triggering channel, so it renders below the boundary), **Voice (TTS)**, **Reasoning Format**.
10. **Project Context**: the stable workspace files `GENOME.md`, `PROTOCOLS.md`, `TOOLS.md`. Each file renders under its own `## <path>` heading and the file's own headings are demoted one level (`## Safety` in PROTOCOLS.md becomes `### Safety`), so a workspace file can never contribute a second `## Heartbeats` or `## Safety` next to the built-in section. A few template sections are session-conditional (constant for the life of a session, so cache-safe): PROTOCOLS.md `## Group Chats` only in group/channel sessions, PROTOCOLS.md `## Heartbeats` only on heartbeat runs (the built-in `## Heartbeats` ack contract is always present), TOOLS.md `## GitHub` only when the `gh` CLI (github skill) or a github tool is available. Omitted sections are named in the pointer line so the agent can `read` the file for them. The runner can pass `sessionContext: { group, githubAvailable }` explicitly; without it, `group` follows a full-mode Group Chat Context and `githubAvailable` follows the skills index.
11. **Silent Replies**, **Heartbeats** (the `HEARTBEAT_OK` ack contract, four lines).

Also above the boundary: **Canonical Facts** (`- [key] value` lines sorted by key, no confirmation counts, dates or statement sentences; the block is capped at 2,400 chars on top of `memory.canonicalLedger.budgetTokens`, and render-time guards skip placeholder values such as `not stated` and heartbeat scaffolding the ingest denylist missed; the bytes move only when a fact is added, retired or reworded) and `MEMORY.md` (rewritten only by a dream cycle, hours apart, so one cache rebuild per cycle instead of one per turn).

### Token budget for the stable half

The cached half is the dominant per-turn cost on cold starts, so it has a budget: **9,000 tokens** (estimated as chars / 2.7, which tracked Anthropic's `count_tokens` at 40,942 chars = 15,220 tokens on the live node, 2026-09-20). `system-prompt-cache-boundary.test.ts` renders a production-shaped prompt (stock GENOME/PROTOCOLS/TOOLS/MEMORY templates, 24 bundled skills, a 26-fact canonical block, wallet + circles + every memory tool) and asserts the estimate stays under the budget, that the memory index stays under 600 tokens, and that no `#`/`##`/`###` heading appears twice.

The prompt's own text (everything before Project Context) is about 5,100 estimated tokens on the live node; the rest is the workspace files, of which `MEMORY.md` (about 3,100 tokens for the live dream-written file) is the largest. `MEMORY.md` is capped at 200 lines / 25 KB with a constant `(truncated, use memory tools)` line (`WORKING_MEMORY_MAX_LINES` / `WORKING_MEMORY_MAX_CHARS` in `src/agents/bootstrap-files.ts`).

### Below the boundary (uncached, may change every call), in order

On Anthropic the whole volatile half is sent as an unmarked `<runtime-state>` block appended to the **last user message**, after pi-ai's cache marker, so it never invalidates the cached conversation prefix. Other providers keep it as the tail of the system prompt.

1. **Research Findings** (one-shot idle-research brief).
2. **Endocrine State**: hormones bucketed to one decimal with a level label (`- Dopamine: 0.6 elevated (DOMINANT)`), budget pressure in 10% steps, self-concept, last-session brief, proactive memories, session coherence, developmental note.
3. **Group Chat Context** / **Subagent Context**, **Reactions**, **Current Date & Time** (time zone only).
4. **Project Context (live)**: `memory/scratch.md` and, on heartbeat runs only, `HEARTBEAT.md`.
5. **Runtime** line (host, model, channel, capabilities, thinking level) and the Reasoning visibility line.

Operators can prove the split holds with the cache trace (`BITTERBOT_CACHE_TRACE=1`, JSONL at `<state>/logs/cache-trace.jsonl`): every `stream:context` event carries `stableDigest`, `volatileDigest` and `toolsDigest`, and `stream:usage` carries the provider's `cacheRead` / `cacheWrite`. Across turns of one session `stableDigest` and `toolsDigest` must not change; see [Anthropic provider: prompt caching](/providers/anthropic#prompt-caching-anthropic-api) for the marker layout.

## Workspace Bootstrap Injection

Bootstrap files are trimmed and injected under **Project Context** so the agent sees its identity without needing explicit file reads:

| File                | Purpose                                                  | Injected?                                                                                                                        |
| ------------------- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `GENOME.md`         | Immutable safety axioms, hormonal baselines, core values | Always (above the cache boundary)                                                                                                |
| `MEMORY.md`         | Living working memory — Phenotype, Bond, Niche, context  | Always (main session only; above the boundary, capped at 200 lines / 25 KB with a constant `(truncated, use memory tools)` line) |
| `PROTOCOLS.md`      | Operating procedures, group behavior, heartbeat rules    | Always (above the cache boundary); `## Group Chats` only in group/channel sessions, `## Heartbeats` only on heartbeat runs       |
| `TOOLS.md`          | Environment-specific notes (devices, SSH, voice prefs)   | Always (above the cache boundary); `## GitHub` only when `gh` is available                                                       |
| `HEARTBEAT.md`      | Periodic task instructions                               | Heartbeat runs only (`includeHeartbeatFile`); other turns read it on demand, as the heartbeat prompt instructs                   |
| `memory/scratch.md` | Unsynthesized notes (write-ahead log)                    | Main session only, below the boundary, same cap as MEMORY.md                                                                     |
| `memory/*.md`       | Daily logs                                               | NOT injected — accessed via `memory_search` on demand                                                                            |

**Security note:** `MEMORY.md` is only loaded in the main, private session. It's never injected in group chats, Discord channels, or shared contexts to prevent personal information leakage.

Large files are truncated with a marker. Limits:

- Per-file: `agents.defaults.bootstrapMaxChars` (default: 20000)
- Total: `agents.defaults.bootstrapTotalMaxChars` (default: 24000)

Sub-agent sessions only inject `TOOLS.md` and `GENOME.md` (safety axioms are inherited; full identity is not).

Internal hooks can intercept bootstrap injection via `agent:bootstrap` to mutate or replace files (e.g., swapping `GENOME.md` for an alternate persona).

Use `/context list` or `/context detail` to inspect how much each file contributes to the context window.

## Prompt Modes

Bitterbot renders different prompt sizes depending on the session type:

| Mode      | Used For                                | What's Included                                                                                                     |
| --------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `full`    | Main sessions, direct chats             | Everything above                                                                                                    |
| `minimal` | Sub-agents, cron jobs, background tasks | Tooling, Safety, Workspace, Sandbox, Date/Time, Runtime. Omits Skills, Memory, Self-Update, Heartbeats, Reply Tags. |
| `none`    | Internal operations                     | Base identity line only                                                                                             |

When `promptMode=minimal`, injected context is labeled **Subagent Context** instead of **Group Chat Context**.

## How the Agent Experiences Its Prompt

From the agent's perspective, the system prompt is its sense of self. On every turn, it knows:

- **Who it is** — Phenotype, personality, communication style (from MEMORY.md)
- **How it feels** — Dopamine/cortisol/oxytocin levels (from hormonal system)
- **Who you are** — Theory of mind, trust level, preferences (from the Bond)
- **What it's good at** — Skills, marketplace reputation (from the Niche)
- **What it's curious about** — Knowledge gaps, exploration targets (from CuriosityEngine)
- **What happened recently** — Active context, weighted by emotional salience
- **What happened last session** — Session handover brief (gated by cosine similarity — skipped if irrelevant) with entity snapshot for anaphora resolution
- **What it can do** — Tools, browser, code execution, wallet, A2A, deep recall
- **What it must never do** — Safety axioms from the Genome

This isn't a static instruction set — it's a biological identity that evolves through experience and dreams. The prompt tomorrow will be different from the prompt today, because the agent will have lived another day.
