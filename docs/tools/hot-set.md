---
summary: "Hot-set tool exposure: a few tools by schema, the rest deferred (native Anthropic tool search) or reached through list_tools/use_tool, long results spilled to files"
read_when:
  - A tool the agent needs is "missing" from the model's tool list
  - Promoting or demoting a tool in the hot set for a lane
  - Tuning tools.resultMaxChars or cleaning up tool-results files
  - Reading the token-efficiency research (docs/reviews/sota-token-efficiency-research-2026-09-19.md, item E)
  - Working out why a session has (or lacks) list_tools/use_tool
title: "Hot set"
---

# Hot set and deferred tools

Bitterbot registers about 59 agent tools. Sending every schema on every call
cost roughly 20k tokens per request, heartbeats included, and tool selection
accuracy degrades past 30 to 50 loaded tools. Since 2026-09-19 the model
loads only the lane's **hot set** with full JSON schemas; everything else
stays registered and reachable through one of two modes that share the same
hot-set selection:

- `native-deferred`: Anthropic API-key auth on a model with tool search,
  in-tree runtime (`agents.defaults.anthropic.runtime: "native"`, the default)
  and `toolSearch.enabled`. The model gets the **full registry**: hot tools
  loaded, the rest `defer_loading: true`, plus Anthropic's server-side search
  tool. No meta-tools.
- `dispatcher`: every other provider, setup-token (OAuth) auth, non-Anthropic
  base URLs, tool search disabled, or `runtime: "vendored"`. Hot tools with
  schemas plus `list_tools` and `use_tool`.
- `all`: hot set disabled, nothing to defer, or an empty hot set in native
  mode (never defer everything). Every schema, sorted, no flags, no meta-tools.

The mode is decided once per run in `src/agents/pi-tools.ts`
(`isNativeToolSearchActive`) and logged at debug as `hot-set exposure`.

## Native mode (Anthropic tool search)

`src/agents/tools/tool-registry-hot-set.ts` returns the whole sorted registry
and marks every non-hot tool with a deferral flag on the tool object. The
in-tree provider (`src/agents/providers/anthropic/`) turns the flag into
`defer_loading: true`, appends `tool_search_tool_bm25_20251119` (or the
regex variant) and puts the cache marker on the last non-deferred definition.
The API keeps deferred schemas out of the rendered prefix; when Claude
searches, the matching `tool_reference`s are expanded server-side and the
model calls the tool as a normal `tool_use`. pi-agent-core executes it by name
against the same registry array, so every gate (policy pipeline,
before-tool-call hook, capability enforcer, abort, cache, result spill) runs
exactly as for a hot tool. The `server_tool_use` and `tool_search_tool_result`
blocks are kept on the assistant message and replayed on later turns, so a
discovered tool stays visible for the session without re-searching. See
[Anthropic](/providers/anthropic) for the config keys and guards.

## Dispatcher mode: what the model sees

For a chat turn the tool array is, sorted by name:

```text
code_interpreter, edit, exec, list_tools, memory_search, process, read,
sessions_send, use_tool, web_fetch, web_search, write
```

That is ~3.3k tokens instead of ~20.6k (chars/2.6 estimate; measured
2026-09-19 against the live registry). The prose "Tooling" list in the system
prompt lists tool **names only**, so the model still knows every registered
tool exists.

The array is sorted by name (ASCII) and byte-stable across turns for a lane,
so the cached prefix survives.

## The two meta-tools

`list_tools({ query?, name? })`

- No arguments: every registered tool that is **not** hot, as
  `{ name, description }` (first line of the description, at most 140 chars),
  plus the lane and the hot names.
- `query`: case-insensitive substring, or a regex when it compiles
  (`"^task_"`, `"memory|dream"`).
- `name`: the full description and JSON schema of that one tool (hot or not).

`use_tool({ name, input })`

- `input` is validated against the target tool's schema with the same ajv
  path pi-agent uses for direct calls. A bad input returns an error result
  (`{ ok: false, status: "error", error }`, with a hint to fetch the schema);
  it does not throw and the target never runs.
- On success the target's result is returned verbatim.

### Gates are preserved

`use_tool` dispatches to the **same wrapped tool object** a direct call would
hit. That object already carries the policy pipeline (profile, allow/deny,
group policy, sandbox, subagent, A2A floor), the `before_tool_call` hook and
PLAN-20 interceptors, the capability enforcer, the abort relay, the result
cache, and the result spill below. Exec approvals, wallet consent and spend
grants live inside the tool implementations themselves, so they run
unchanged. A tool removed by `tools.deny` is not registered at all, so
`use_tool` reports it as unknown; `src/agents/pi-tools.hot-set.test.ts`
proves both the deny path and the exec security gate through the dispatcher.

## Lanes and defaults

The lane is derived the same way `promptMode` is: heartbeat from the run flag
(heartbeats run on the main session key) or a `:heartbeat` key suffix,
subagent and cron from the session-key shape, everything else is chat.

Defaults come from transcript telemetry (308 session files, 4,849 tool calls):
exec 64.8%, read 11.9%, process 4.3%, web_search 3.1%, web_fetch 2.5%,
memory_search 2.1%, code_interpreter 1.9%, browser 1.3%, write 1.2%,
edit 1.0%; everything else under 0.7%.

| lane      | always              | lane list                                                                                      | est. tokens |
| --------- | ------------------- | ---------------------------------------------------------------------------------------------- | ----------- |
| chat      | read, memory_search | exec, process, write, edit, web_search, web_fetch, code_interpreter, sessions_send             | ~3.3k       |
| heartbeat | read, memory_search | message                                                                                        | ~3.7k       |
| cron      | read, memory_search | same as chat minus browser/canvas                                                              | ~3.3k       |
| subagent  | read, memory_search | chat list minus sessions_send (the subagent policy already denies memory_search/sessions_send) | ~2.9k       |

`message` (7.1k chars, 85 properties, 0.06% of calls) is deferred in chat and
hot in heartbeat, where it is the delivery path. `browser` (3.2k chars) is
deferred everywhere. `max` is 10; the selection is a priority cut, `always`
first, then the lane list, in the order written.

The meta-tools are only added when something is actually deferred. Sessions
whose policy already narrows the list to a handful of tools (skill-validation
rollouts, the A2A remote floor) get their full sorted list and no meta-tools.

## Promoting a tool to hot

Edit `tools.hotSet` in `bitterbot.json` (global) or `agents.list[].tools.hotSet`
(per agent; fields override the global block one by one, lanes individually):

```json5
{
  tools: {
    hotSet: {
      enabled: true, // default true; false = every schema on every call
      max: 10,
      always: ["read", "memory_search"],
      perLane: {
        chat: [
          "exec",
          "process",
          "write",
          "edit",
          "web_search",
          "web_fetch",
          "code_interpreter",
          "sessions_send",
          "message",
        ],
        heartbeat: ["message"],
      },
    },
  },
}
```

Names are matched case-insensitively and only against tools that survived
the policy pipeline: a denied tool cannot be promoted back by this block.
Watch the estimate in the gateway log (`agents/tools/hot-set` at debug) or
run `src/agents/pi-tools.hot-set.test.ts`, which prints it and fails above
5k tokens.

## Tool results: spill to file

`tools.resultMaxChars` (default 8000, minimum 1000) caps every text block a
tool hands back to the model. Over the cap, the full text is written to

```text
~/.bitterbot/agents/<id>/tool-results/<runId>-<n>.txt
```

and the model receives the first 75% of the cap, one marker line, and the
last 18.75% (6000 + 1500 chars at the default):

```text
[truncated: 48213 chars total; full output saved to /home/u/.bitterbot/agents/main/tool-results/run-7f3a-2.txt; use read to view]
```

The model can `read` the file with an offset when the middle matters. Files
older than 24 hours are swept on the next spill (at most one sweep per hour
per directory). If the write fails the head/tail is still returned with the
failure in the marker. Image blocks and `details` are untouched. The event
stream (UI, journal, `after_tool_call`) keeps its own 8000-char guard using
the same head/marker/tail shape.

## Related

- `docs/reviews/sota-token-efficiency-research-2026-09-19.md`, section 4 item E
- `src/agents/tools/tool-registry-hot-set.ts`, `tool-dispatcher-tool.ts`, `tool-result-spill.ts`
- `src/agents/providers/anthropic/tool-search.ts` (native deferral plan and guards)
- [Anthropic](/providers/anthropic) for the runtime switch and tool search config
- [Tools](/tools/index) for allow/deny and profiles
