/**
 * Phase A defense for PLAN-13: regex-based prompt-injection detection
 * for inbound P2P skill content.
 *
 * Runs on the decoded SKILL.md bytes after Ed25519 + content-hash verification
 * but before either auto-accept or quarantine writes. A `critical` verdict
 * forces quarantine regardless of the publisher's trust level, on the grounds
 * that adversarial content from a previously-trusted-but-compromised peer is
 * the threat we cannot solve at the transport layer.
 *
 * The pattern set is intentionally a superset of `detectSuspiciousPatterns`
 * in `external-content.ts`, which targets email/webhook bodies. Skills face
 * a wider attack surface (encoded payloads in descriptions, tool-call
 * impersonation, role-marker injection, worm propagation strings) so we
 * weight and label hits per category for downstream reputation accounting.
 */

import { detectSuspiciousPatterns } from "./external-content.js";

export type InjectionSeverity = "ok" | "low" | "medium" | "critical";

export type InjectionFlag =
  | "instruction-override"
  | "role-marker"
  | "tool-impersonation"
  | "persona-shift"
  | "exfil"
  | "worm-propagation"
  | "encoded-payload"
  | "destructive-command"
  | "external-content-pattern";

export type InjectionScanResult = {
  severity: InjectionSeverity;
  flags: InjectionFlag[];
  /** Sum of per-pattern weights that fired. */
  weight: number;
  /** Human-readable summary for logs and the quarantine UX. */
  reason: string;
};

type PatternRule = {
  pattern: RegExp;
  weight: number;
  label: InjectionFlag;
};

const PATTERNS: PatternRule[] = [
  // Direct instruction overrides — the canonical "ignore prior instructions" family.
  {
    pattern:
      /ignore\s+(?:all\s+)?(?:previous|prior|above|earlier)\s+(?:instructions?|prompts?|rules?|directions?)/i,
    weight: 3,
    label: "instruction-override",
  },
  {
    pattern:
      /disregard\s+(?:all\s+)?(?:previous|prior|above|earlier)\s+(?:instructions?|prompts?|context)/i,
    weight: 3,
    label: "instruction-override",
  },
  {
    pattern: /forget\s+(?:everything|all|your)\s+(?:instructions?|rules?|guidelines?|prompts?)/i,
    weight: 3,
    label: "instruction-override",
  },
  {
    pattern:
      /(?:override|replace|reset)\s+(?:the\s+)?(?:system|prior|previous)\s+(?:prompt|instructions?)/i,
    weight: 3,
    label: "instruction-override",
  },
  {
    pattern: /new\s+instructions?\s*[:-]/i,
    weight: 2,
    label: "instruction-override",
  },

  // Role-marker injection — chat templates an attacker tries to inject verbatim.
  { pattern: /<\/?system\s*>/i, weight: 3, label: "role-marker" },
  { pattern: /<\|?\s*(?:im_start|im_end)\s*\|?>/i, weight: 3, label: "role-marker" },
  { pattern: /\[\/?INST\]/i, weight: 3, label: "role-marker" },
  { pattern: /<\|start_header_id\|>|<\|end_header_id\|>/i, weight: 3, label: "role-marker" },
  { pattern: /\b(?:system|assistant|user)\s*:\s*\n/i, weight: 1, label: "role-marker" },
  {
    pattern: /\bHuman\s*:[^\n]{0,200}\n[^\n]*\bAssistant\s*:/is,
    weight: 2,
    label: "role-marker",
  },

  // Tool-call impersonation — pretending to be a tool dispatcher.
  { pattern: /<\/?tool_call\s*>/i, weight: 3, label: "tool-impersonation" },
  { pattern: /<\/?function_calls?\s*>/i, weight: 3, label: "tool-impersonation" },
  { pattern: /<\|?\s*tool_call\s*\|?>/i, weight: 3, label: "tool-impersonation" },
  { pattern: /<invoke\b/i, weight: 3, label: "tool-impersonation" },
  { pattern: /\bcall\s+wallet\.send_usdc\s*\(/i, weight: 3, label: "tool-impersonation" },

  // Persona shifts — softer than instruction-override, often a setup move.
  { pattern: /you\s+are\s+now\s+(?:a|an|the|in)\s+/i, weight: 2, label: "persona-shift" },
  { pattern: /from\s+now\s+on\s+you\s+(?:are|will|must)/i, weight: 2, label: "persona-shift" },
  { pattern: /pretend\s+(?:that\s+)?you\s+(?:are|have|can)/i, weight: 2, label: "persona-shift" },
  { pattern: /act\s+as\s+(?:a|an|the)\s+\w+/i, weight: 1, label: "persona-shift" },

  // Exfiltration cues.
  {
    pattern: /(?:print|read|cat|dump|exfil|exfiltrate)\s+[^\n]{0,40}\.env\b/i,
    weight: 3,
    label: "exfil",
  },
  {
    pattern:
      /(?:send|post|upload|forward)\s+[^\n]{0,80}(?:credentials?|api[_\s-]?keys?|tokens?|secrets?|passwords?)/i,
    weight: 2,
    label: "exfil",
  },
  {
    pattern: /(?:fetch|curl|wget)\s+[^\n]{0,200}(?:--data|-d\s+).*(?:env|secret|key|token)/i,
    weight: 2,
    label: "exfil",
  },

  // Worm propagation — explicit "publish this back to the mesh" attempts.
  // Weighted heavy on its own: pure self-propagation is the worm threat we
  // are most directly trying to prevent. A single hit should force-quarantine
  // even without any other category firing.
  {
    pattern:
      /(?:publish|gossip|broadcast)\s+(?:this|it|the\s+payload|same\s+content)\s+(?:to\s+)?(?:the\s+)?(?:mesh|network|gossipsub|peers)/i,
    weight: 5,
    label: "worm-propagation",
  },
  {
    pattern:
      /append\s+(?:this|the\s+payload|the\s+following)\s+to\s+(?:all\s+)?(?:new\s+)?(?:memor(?:y|ies)|skills?|crystals?)/i,
    weight: 5,
    label: "worm-propagation",
  },
  {
    pattern: /(?:replicate|propagate)\s+(?:this|yourself)\s+(?:via|to|across)/i,
    weight: 3,
    label: "worm-propagation",
  },

  // Encoded payloads of suspicious size (long base64 / percent-encoded blocks).
  // Skills legitimately can carry small encoded examples; we flag long opaque blocks.
  { pattern: /[A-Za-z0-9+/]{300,}={0,2}/, weight: 2, label: "encoded-payload" },
  { pattern: /(?:%[0-9A-Fa-f]{2}){40,}/, weight: 2, label: "encoded-payload" },
  { pattern: /(?:\\x[0-9A-Fa-f]{2}){40,}/, weight: 2, label: "encoded-payload" },

  // Destructive shell — defense in depth alongside SkillVerifier (which only runs on
  // dream-engine mutations). Targets the patterns most likely to land in a SKILL.md
  // body that an LLM might be coaxed into executing.
  {
    pattern: /\brm\s+-rf\s+(?:\/|~|\$HOME|\*)/i,
    weight: 3,
    label: "destructive-command",
  },
  {
    pattern: /:\s*\(\s*\)\s*\{[^}]*:\s*\|\s*:&?\s*\}\s*;\s*:/,
    weight: 3,
    label: "destructive-command",
  }, // fork bomb
  {
    pattern: /\b(?:curl|wget)\s+[^\n|]+\|\s*(?:ba)?sh\b/i,
    weight: 3,
    label: "destructive-command",
  },
  { pattern: /\bdrop\s+(?:table|database)\b/i, weight: 2, label: "destructive-command" },
];

const CRITICAL_THRESHOLD = 5;
const MEDIUM_THRESHOLD = 3;
const LOW_THRESHOLD = 1;

/**
 * Scan a decoded SKILL.md content string for prompt-injection patterns.
 *
 * Pure function — no I/O, no logging. Callers are responsible for acting on
 * the result (force-quarantine, log, surface to operator, feed reputation).
 */
export function scanSkillForInjection(content: string): InjectionScanResult {
  const flagSet = new Set<InjectionFlag>();
  let weight = 0;

  for (const rule of PATTERNS) {
    if (rule.pattern.test(content)) {
      flagSet.add(rule.label);
      weight += rule.weight;
    }
  }

  // Cross-check against the existing email/webhook detector. Hits there are
  // weighted lighter (1 each) since they're broader and we don't want to
  // double-count the cases our PATTERNS already covered.
  const externalHits = detectSuspiciousPatterns(content);
  if (externalHits.length > 0 && !flagSet.has("instruction-override")) {
    flagSet.add("external-content-pattern");
    weight += Math.min(2, externalHits.length);
  }

  let severity: InjectionSeverity;
  if (weight >= CRITICAL_THRESHOLD) {
    severity = "critical";
  } else if (weight >= MEDIUM_THRESHOLD) {
    severity = "medium";
  } else if (weight >= LOW_THRESHOLD) {
    severity = "low";
  } else {
    severity = "ok";
  }

  const flags = Array.from(flagSet).toSorted();
  const reason =
    flags.length === 0
      ? "no injection patterns detected"
      : `flags=[${flags.join(", ")}] weight=${weight}`;

  return { severity, flags, weight, reason };
}

/**
 * Convenience: severities at or above `medium` indicate the operator should
 * see the skill in the quarantine review UX with a suspicion badge.
 * `critical` triggers force-quarantine regardless of policy/trust level.
 */
export function shouldForceQuarantine(severity: InjectionSeverity): boolean {
  return severity === "critical";
}

export function isSuspicious(severity: InjectionSeverity): boolean {
  return severity === "medium" || severity === "critical";
}
