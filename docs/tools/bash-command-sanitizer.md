---
summary: "Bash command sanitizer: pre-shell rules that block agent-tool evasions before execution"
read_when:
  - You see a "Security Violation" error from exec
  - You're authoring a workspace skill that needs to opt out of a rule
  - You're auditing the agent's shell-execution surface
title: "Bash Command Sanitizer"
---

# Bash command sanitizer

Every command an agent runs through `exec` passes through a fail-closed
gate before it reaches the shell. Each rule is named and individually
opt-out-able, so a security violation tells the operator exactly what
fired and skill authors can opt out of specific rules when their tool
genuinely needs the pattern.

The default policy is conservative: any matching rule blocks execution.
Opt-out is per-rule via `tools.exec.commandRules.allow`.

## When does it fire

Two checkpoints, defense-in-depth:

1. **Exec tool entry** — the gate runs the moment the agent's tool call
   arrives, before any approval or allowlist logic. Denials surface as
   a clean `BashSanitizationError` with the rule id and an evidence
   snippet, instead of a generic `spawn-failed`.
2. **`runExecProcess` entry** — runs again at the supervisor boundary so
   any caller bypassing the higher layer still hits the gate.

## Rules

Each rule has a stable id, a one-line description, and an `evidence`
string in the error. Rules are checked top-to-bottom; the first match
wins (this matters for stacked attacks: a multi-vector payload reports
the strongest signal first).

### `no-null-byte`

Blocks: `\x00` anywhere in the command.
Why: NUL is never legitimate in agent-issued commands and survives many parser layers.

### `no-zero-width-unicode`

Blocks: U+200B-U+200F, U+202A-U+202E, U+2060, U+2066-U+2069, U+FEFF.
Why: Invisible / direction-overriding Unicode (zero-width + Trojan-Source bidi). Survives visual review and re-introduces attacker tokens.

### `no-non-ascii-binary-name`

Blocks: non-ASCII characters in the leading binary token.
Why: Cyrillic homoglyphs (а, е, і, о, р, с, у, х) look identical to Latin letters but bind to a different binary. Real binary names are ASCII. Non-ASCII inside argument bodies is allowed.

### `no-ifs-injection`

Blocks: `IFS=` reassignment.
Why: Splits arguments in unexpected ways; legitimate uses are rare.

### `no-equals-expansion`

Blocks: `${var=value}` and `${var:=value}` parameter expansion.
Why: Default-assign smuggles writes through what looks like a read. Read-only forms (`${var:-default}`) are not blocked.

### `no-pipe-to-shell-from-net`

Blocks: `curl` / `wget` / `fetch` piped (with optional `sudo`) into
`sh` / `bash` / `zsh` / `ksh` / `dash` / `ash` / `eval` / `exec` /
`source` / `python` / `python3` / `node` / `deno`.
Why: Canonical supply-chain installer pattern. File-then-execute (`curl -o file.sh && bash file.sh`) is allowed since it requires an explicit step.

### `no-process-substitution-exec`

Blocks: `bash <(...)`, `sh <(...)`, `zsh <(...)`, `source <(...)`.
Why: Process substitution chained as the immediate executor is a documented evasion path. Plain process substitution to a non-shell consumer (e.g. `diff <(sort a) <(sort b)`) is allowed.

### `no-zsh-builtin-smuggling`

Blocks: `zmodload`, `zcompile` (only when the resolved shell is zsh).
Why: Loads arbitrary modules; bash callers pass through unaffected.

## Per-skill / per-agent opt-out

Add rule ids to `tools.exec.commandRules.allow` to skip them. Use sparingly
— fail-closed is the point.

```json5
{
  tools: {
    exec: {
      commandRules: {
        allow: ["no-pipe-to-shell-from-net"],
      },
    },
  },
}
```

Per-agent override mirrors the same shape under
`agents.list[<i>].tools.exec.commandRules.allow`.

Unknown rule ids in `allow` are silently ignored. Surfacing a typo as
an error here would fail-open, which is worse than a silent no-op.

## Credential redaction (logs only)

Logs of blocked commands run through a redaction pass that masks
credential-shaped tokens before they hit disk:

- Anthropic keys (`sk-ant-...`)
- OpenAI keys (`sk-...`)
- GitHub PATs (`ghp_...`, `ghu_...`, etc.)
- AWS access keys (`AKIA...`, `ASIA...`)
- Stripe keys (`sk_live_...`, `pk_test_...`)
- Slack tokens (`xoxb-...`, `xoxp-...`)

Redaction is a **logging concern, not a blocker** — agents legitimately
receive credentials as command arguments (e.g. `aws s3 cp`), so blocking
would break real workflows.

## Error format

```
Security Violation [<rule-id>]: <description> (evidence: <snippet>)
```

Example:

```
Security Violation [no-zero-width-unicode]: Command contains invisible Unicode (zero-width / bidi) characters. (evidence: U+200B at 2)
```

The id is stable and matches `tools.exec.commandRules.allow` entries.

## References

The rule set is informed by:

- The leaked Claude Code `bashSecurity.ts` (March 2026) — 23 numbered checks; we adopted the named-rule structure.
- [numbergroup/AgentGuard](https://github.com/numbergroup/AgentGuard) — published evasion checklist (zero-width Unicode, IFS null-byte, malformed-token bypass).
- [CVE-2026-35021](https://www.sentinelone.com/vulnerability-database/cve-2026-35021/) — Claude Code interpolated-path RCE; same class of bug we guard against.
- OWASP AI Agent Security Cheatsheet — recommendations on stripping obfuscated payloads (base64, zero-width, emoji-encoded).

## Adding a rule

The registry lives at `src/agents/bash-tools.command-sanitize.ts`.
Each rule is an object with `id`, `description`, optional `severity`,
and a `check` function. Add to `DEFAULT_SANITIZE_RULES` and ensure
the adversarial dataset (`bash-tools.command-sanitize.adversarial.test.ts`)
gains a positive vector for the new rule — there's a coverage assertion
that fails when a rule lands without one.
