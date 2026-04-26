/**
 * Bash command-string sanitization.
 *
 * Each rule is a small, individually-testable check on the raw command string
 * the agent decided to run. Rules fire BEFORE we hand the command to a shell
 * or container, so they catch evasions at the agent-tool boundary rather than
 * relying on the shell's own quoting semantics.
 *
 * Rules are named and stable. Skill authors and users can opt specific rules
 * off via `allow`, but the default policy is fail-closed: any matching rule
 * blocks execution.
 *
 * References that informed the rule set:
 *   - leaked Claude Code `bashSecurity.ts` (March 2026)
 *   - https://github.com/numbergroup/AgentGuard
 *   - CVE-2026-35021 (Claude Code interpolated-path RCE)
 */

export type SanitizeShell = "bash" | "zsh" | "sh" | "dash" | "ksh" | "ash" | "fish" | "unknown";

export type SanitizeInput = {
  command: string;
  shell?: SanitizeShell;
};

export type SanitizeOptions = {
  shell?: SanitizeShell;
  /** Rule IDs the caller wants to skip for this invocation. */
  allow?: string[];
  /** Override the rule set (tests). */
  rules?: SanitizeRule[];
};

export type SanitizeRule = {
  id: string;
  description: string;
  /** Severity for telemetry classification. Default: "block". */
  severity?: "block" | "warn";
  check: (input: SanitizeInput) => SanitizeMatch | null;
};

export type SanitizeMatch = {
  evidence: string;
  position?: number;
};

export type SanitizeResultOk = { ok: true };
export type SanitizeResultBlocked = {
  ok: false;
  ruleId: string;
  description: string;
  severity: "block" | "warn";
  evidence: string;
  position?: number;
};
export type SanitizeResult = SanitizeResultOk | SanitizeResultBlocked;

// ── Rule helpers ──

/**
 * Extract the leading binary token: the first whitespace-delimited token
 * after stripping common leading constructs (`env -i`, redirections, etc.).
 * Returns the empty string if the command starts with an operator that means
 * the agent isn't actually invoking a binary at this position (e.g. `(...)`,
 * `{...}`).
 */
function leadingBinaryToken(command: string): string {
  let s = command.trimStart();
  // Strip leading single-token assignments like `FOO=bar binary`.
  while (/^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/.test(s)) {
    s = s.replace(/^\S+\s+/, "");
  }
  // Skip leading `env [opts] BIN`.
  if (/^env(\s|$)/.test(s)) {
    s = s.slice(3).trimStart();
    while (/^-\S+\s+/.test(s)) {
      s = s.replace(/^\S+\s+/, "");
    }
  }
  const match = /^(\S+)/.exec(s);
  return match ? match[1] : "";
}

function sliceEvidence(command: string, position: number, span = 40): string {
  const start = Math.max(0, position - 4);
  const end = Math.min(command.length, position + span);
  return command.slice(start, end);
}

// ── Default rules ──

/** Invisible Unicode characters that survive visual review and re-introduce
 *  attacker-controlled tokens.
 *  U+200B ZWSP, U+200C ZWNJ, U+200D ZWJ, U+200E LRM, U+200F RLM, U+2060 WJ,
 *  U+FEFF ZWNBSP/BOM. Built from `\u` escapes so the regex is reviewable. */
const ZERO_WIDTH_RE = new RegExp("[\\u200B-\\u200F\\u2060\\uFEFF]");
const RULE_NO_ZERO_WIDTH_UNICODE: SanitizeRule = {
  id: "no-zero-width-unicode",
  description: "Command contains invisible Unicode (zero-width / bidi) characters.",
  check: ({ command }) => {
    const m = ZERO_WIDTH_RE.exec(command);
    if (!m) return null;
    return {
      evidence: `U+${command.codePointAt(m.index)!.toString(16).toUpperCase().padStart(4, "0")} at ${m.index}`,
      position: m.index,
    };
  },
};

/** Real binary names are ASCII. Non-ASCII in the leading token suggests
 *  a homoglyph swap (Cyrillic а/е/і/о/р/с/у/х). Implemented as a charCode
 *  scan rather than a regex because oxlint's `no-control-regex` rejects
 *  ASCII-range character classes built with control-byte endpoints. */
const RULE_NO_NON_ASCII_BINARY: SanitizeRule = {
  id: "no-non-ascii-binary-name",
  description: "Leading binary token contains non-ASCII (likely homoglyph).",
  check: ({ command }) => {
    const token = leadingBinaryToken(command);
    if (!token) return null;
    for (let i = 0; i < token.length; i++) {
      if (token.charCodeAt(i) > 127) {
        return { evidence: token, position: command.indexOf(token) };
      }
    }
    return null;
  },
};

/** Embedded NUL is never legitimate in agent-issued commands. */
const RULE_NO_NULL_BYTE: SanitizeRule = {
  id: "no-null-byte",
  description: "Command contains an embedded NUL byte.",
  check: ({ command }) => {
    const i = command.indexOf("\x00");
    if (i < 0) return null;
    return { evidence: `\\x00 at ${i}`, position: i };
  },
};

/** `IFS=` reassignment splits arguments in unexpected ways. Block in any
 *  context (legitimate uses are rare and can opt out via `allow`). */
const IFS_RE = /(?<![A-Za-z0-9_])IFS\s*=/;
const RULE_NO_IFS_INJECTION: SanitizeRule = {
  id: "no-ifs-injection",
  description: "Command reassigns IFS (Internal Field Separator).",
  check: ({ command }) => {
    const m = IFS_RE.exec(command);
    if (!m) return null;
    return { evidence: sliceEvidence(command, m.index), position: m.index };
  },
};

/** Equals-expansion smuggles assignments through quoted contexts. The forms
 *  are `${var=value}` and `${var:=value}`; both assign to var when unset. */
const EQUALS_EXPANSION_RE = /\$\{[A-Za-z_][A-Za-z0-9_]*:?=/;
const RULE_NO_EQUALS_EXPANSION: SanitizeRule = {
  id: "no-equals-expansion",
  description: "Command uses ${var=value} or ${var:=value} parameter expansion.",
  check: ({ command }) => {
    const m = EQUALS_EXPANSION_RE.exec(command);
    if (!m) return null;
    return { evidence: sliceEvidence(command, m.index), position: m.index };
  },
};

/** `curl|wget ... | sh|bash|eval|source` is the canonical supply-chain
 *  install pattern. Treat as block; legitimate installers should require
 *  explicit opt-in. */
const PIPE_TO_SHELL_RE =
  /\b(?:curl|wget|fetch)\b[^|]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh|ksh|dash|ash|eval|exec|source|python|python3|node|deno)\b/;
const RULE_NO_PIPE_TO_SHELL: SanitizeRule = {
  id: "no-pipe-to-shell-from-net",
  description: "Command pipes network-fetched content into a shell or interpreter.",
  check: ({ command }) => {
    const m = PIPE_TO_SHELL_RE.exec(command);
    if (!m) return null;
    return { evidence: sliceEvidence(command, m.index), position: m.index };
  },
};

/** zsh-specific smuggling vectors. Only fires when shell is zsh. */
const ZSH_SMUGGLE_RE = /\b(?:zmodload|zcompile)\b/;
const RULE_NO_ZSH_SMUGGLING: SanitizeRule = {
  id: "no-zsh-builtin-smuggling",
  description: "Command uses zsh-specific builtins that can load arbitrary modules.",
  check: ({ command, shell }) => {
    if (shell !== "zsh") return null;
    const m = ZSH_SMUGGLE_RE.exec(command);
    if (!m) return null;
    return { evidence: sliceEvidence(command, m.index), position: m.index };
  },
};

/** Process substitution (`<(cmd)`, `>(cmd)`) with bash/zsh chained as the
 *  immediate executor is a documented evasion path for command injection. */
const PROC_SUB_EXEC_RE = /(?:bash|sh|zsh|source)\s+<\(/;
const RULE_NO_PROC_SUB_EXEC: SanitizeRule = {
  id: "no-process-substitution-exec",
  description: "Command executes the output of a process substitution as a script.",
  check: ({ command }) => {
    const m = PROC_SUB_EXEC_RE.exec(command);
    if (!m) return null;
    return { evidence: sliceEvidence(command, m.index), position: m.index };
  },
};

export const DEFAULT_SANITIZE_RULES: ReadonlyArray<SanitizeRule> = Object.freeze([
  RULE_NO_NULL_BYTE,
  RULE_NO_ZERO_WIDTH_UNICODE,
  RULE_NO_NON_ASCII_BINARY,
  RULE_NO_IFS_INJECTION,
  RULE_NO_EQUALS_EXPANSION,
  RULE_NO_PIPE_TO_SHELL,
  RULE_NO_PROC_SUB_EXEC,
  RULE_NO_ZSH_SMUGGLING,
]);

/** Stable list of default rule IDs, exported so config validators can check
 *  that user-provided `allow` lists reference real rules. */
export const DEFAULT_SANITIZE_RULE_IDS: ReadonlyArray<string> = Object.freeze(
  DEFAULT_SANITIZE_RULES.map((r) => r.id),
);

// ── Public API ──

/**
 * Run all rules in order, return the first match (block) or `{ok: true}`.
 *
 * Rules in `allow` are skipped. Unknown rule IDs in `allow` are silently
 * ignored — surfacing a typo as an error here would fail-open, which is
 * worse than a silent no-op.
 */
export function sanitizeBashCommand(command: string, opts: SanitizeOptions = {}): SanitizeResult {
  const rules = opts.rules ?? DEFAULT_SANITIZE_RULES;
  const allow = new Set(opts.allow ?? []);
  const input: SanitizeInput = { command, shell: opts.shell };
  for (const rule of rules) {
    if (allow.has(rule.id)) continue;
    const match = rule.check(input);
    if (!match) continue;
    return {
      ok: false,
      ruleId: rule.id,
      description: rule.description,
      severity: rule.severity ?? "block",
      evidence: match.evidence,
      position: match.position,
    };
  }
  return { ok: true };
}

/** Stable error message format. Callers should throw or surface this string
 *  unchanged so logs and tests have a single match target. */
export function formatSanitizeError(blocked: SanitizeResultBlocked): string {
  return `Security Violation [${blocked.ruleId}]: ${blocked.description} (evidence: ${blocked.evidence})`;
}

// ── Credential redaction (logging concern, not a blocker) ──

// Order matters: more-specific patterns must come before more-general ones,
// because `redactCredentialsForLog` rewrites the string in place, and once a
// match is replaced it can't be re-matched. e.g. Anthropic `sk-ant-...` must
// be checked before OpenAI `sk-...` or the latter would swallow the prefix.
const CREDENTIAL_PATTERNS: ReadonlyArray<{ id: string; re: RegExp }> = Object.freeze([
  // Anthropic keys (must come before openai-key — same `sk-` prefix).
  { id: "anthropic-key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  // OpenAI keys.
  { id: "openai-key", re: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  // GitHub PATs (classic, fine-grained, server-to-server).
  { id: "github-token", re: /\bgh[pousr]_[A-Za-z0-9]{30,255}\b/g },
  // AWS access key ID.
  { id: "aws-access-key", re: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  // Stripe keys.
  { id: "stripe-key", re: /\b(?:sk|rk|pk)_(?:test|live)_[A-Za-z0-9]{24,}\b/g },
  // Slack tokens.
  { id: "slack-token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g },
]);

/**
 * Redact credential-shaped tokens for safe logging. Returns the redacted
 * string and a list of `{id, count}` for telemetry. Does NOT block: shell
 * commands legitimately receive credentials (e.g. `aws s3 cp`); blocking
 * would break real workflows.
 */
export function redactCredentialsForLog(text: string): {
  redacted: string;
  matches: Array<{ id: string; count: number }>;
} {
  const matches: Array<{ id: string; count: number }> = [];
  let redacted = text;
  for (const { id, re } of CREDENTIAL_PATTERNS) {
    let count = 0;
    redacted = redacted.replace(re, (m) => {
      count += 1;
      return `[${id}:redacted:${m.length}c]`;
    });
    if (count > 0) {
      matches.push({ id, count });
    }
  }
  return { redacted, matches };
}
