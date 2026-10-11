/**
 * PLAN-55 Phase 1: immediate correction capture ("teach it once").
 *
 * The owner says "no, the deploy endpoint is api2.acme.com" in a chat. Until
 * this pass, that correction reached the facts ledger only if the model chose
 * `memory_pin`, or hours later when the dream-time session extractor got to
 * the transcript. This module runs on the run-completion path of an owner
 * turn (never inside `dream()`):
 *
 * 1. A fast regex pre-filter (CORRECTION_PREFILTER_PATTERNS) decides whether
 *    the user's message has a corrective or imperative shape at all. Most
 *    turns do not, and cost nothing.
 * 2. On a hit, ONE cheap-model call over the owner's own words plus the
 *    assistant reply, with the narrow canonical-only prompt from the
 *    extractor's prompt family (buildCorrectionExtractionPrompt), returns
 *    `{facts:[{key,value,statement,correction,scope}]}`.
 * 3. Each fact is pinned. At tier `owner` (owner-controls.pinFact) when the
 *    model flagged it as a correction AND the value appears as a whole token
 *    in the owner's own words outside a negation ("not X", "instead of X");
 *    at tier `extraction` otherwise. Evidence is the session line ref of the
 *    owner's message. The model's `correction` and `scope` are hints: the
 *    owner tier is reached only through the owner's text, so neither a tool
 *    result, a quoted or forwarded message, nor an agent pin's forged
 *    `evidence` can promote a fact. Credential-shaped values never land.
 * 4. The reply gets one "Memory updated" line generated from the op results
 *    (never by the model): the pass's writes, the agent's own `memory_pin`
 *    writes during the turn, and agent supersedes or retires that were held
 *    for the owner (`pending_supersede` / `pending_retire`).
 *
 * Skipped: heartbeats, cron, subagents, A2A, circles, group/channel chats
 * and guests (classifySessionKeyTrust), non-owner senders, the slug
 * generator and isolated cron runs (they never reach the hook),
 * `session.memory = "off"`, `memory.correction.enabled = false`, and every
 * pre-filter miss. Budget: at most one model call per owner turn, recorded
 * in the usage ledger as `memory/correction`, cancelled (not just abandoned)
 * when the reply-path cap expires, and paused by `usage.budgets.mode:
 * enforce` like the other background lanes.
 */

import type { BitterbotConfig } from "../config/config.js";
import { USAGE_FEATURES } from "../infra/usage-features.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { isCronSessionKey } from "../sessions/session-key-utils.js";
import {
  type CanonicalFactsStore,
  normalizeCanonicalScope,
  normalizeScopeName,
} from "./canonical-facts.js";
import type { OwnerPinInput, OwnerPinResult } from "./owner-controls.js";
import {
  buildCorrectionExtractionPrompt,
  type CorrectionFact,
  parseCorrectionResponse,
} from "./session-extractor.js";
import { classifySessionKeyTrust } from "./session-trust.js";

const log = createSubsystemLogger("memory/correction");

/** The usage-ledger lane for the per-turn call (`memory/correction`). Live, never batched. */
export const CORRECTION_LLM_LANE = {
  feature: USAGE_FEATURES.memoryCorrection,
  maxTokens: 1024,
  batch: false,
} as const;

/** Wall-clock cap on the whole pass; the reply is waiting on it and the model call is aborted. */
export const CORRECTION_CAPTURE_TIMEOUT_MS = 12_000;

const EXTERNAL_START = "<<<EXTERNAL_UNTRUSTED_CONTENT>>>";
const EXTERNAL_END = "<<<END_EXTERNAL_UNTRUSTED_CONTENT>>>";
/** Code points, not UTF-16 units: the cut never splits a surrogate pair. */
const MAX_LINE_CHARS = 320;
/** Transcripts above this are cited by file only (no line lookup on the reply path). */
export const MAX_TRANSCRIPT_BYTES_FOR_LINE_REF = 4 * 1024 * 1024;

export type CorrectionLlmCall = (
  prompt: string,
  opts?: { signal?: AbortSignal },
) => Promise<string>;

/** Verbs that make `always`/`never` an instruction rather than a description. */
const INSTRUCTION_VERB =
  "(?:use|do|call|reply|respond|answer|send|write|deploy|run|put|say|ask|include|add|remove|format|start|stop|treat|assume|refer|speak|address|check|open|commit|push|merge|skip|avoid|keep|make|book|schedule|order|buy|pay|set|post|email|text|ping|tag|log|save|store|read|show|tell|give|print|return|render|output|apply|follow|ignore|prefer|want|need|be|go|sign|wake|mention|default|cc|reach|contact|talk|greet|summarize|summarise|translate|pick|choose|route|deliver|notify|remind|wait|confirm|assume)";
/** Nouns after "my" that name an identity or a standing preference. */
const IDENTITY_NOUN =
  "(?:name|first name|last name|surname|nickname|handle|username|timezone|time zone|email|e-mail|phone|number|address|birthday|pronouns?|repo|repository|endpoint|url|domain|editor|shell|os|stack|language|preference|default|company|employer|team|role|title|github|discord|slack|telegram|wallet|project|workspace|branch|org|organization|organisation|locale|currency|city|country|calendar|assistant|bot)";

/**
 * The corrective / imperative shapes that earn a model call. Documented
 * here because the list IS the cost policy: a shape not in it is never
 * captured on the hot path (the dream-time extractor still sees it later).
 * `unless` vetoes a match (question frames, hedges). All patterns run over
 * prose only: fenced code, inline code, quoted lines (`> ...`), reply /
 * quote / forward blocks, inbound-context blocks and external-content
 * envelopes are stripped first, so a pasted diff, a quoted message or a
 * forwarded email cannot trigger a call or reach the model as the owner's
 * words.
 */
export const CORRECTION_PREFILTER_PATTERNS: ReadonlyArray<{
  name: string;
  rx: RegExp;
  unless?: RegExp;
}> = [
  // "No, ..." / "Nope." / "Wrong:" at the start of the message, a line or a sentence.
  { name: "no-comma", rx: /(^|[.!?]\s+)(no|nope|wrong|incorrect)\b\s*[,.!:;-]/im },
  // "X is not Y" / "it's not X" / "isn't".
  { name: "not-x", rx: /\b(is|it'?s|that'?s|was|are|were)\s+not\b|\b(isn'?t|aren'?t|wasn'?t)\b/i },
  // "actually" with a fact frame after it, never a hedge or a plan change.
  {
    name: "actually",
    rx: /\bactually\b[^.!?]{0,60}\b(is|are|was|were|it'?s|that'?s|not|isn'?t|should|use|call me|my|the)\b/i,
    unless: /\bactually,?\s+(let'?s|let us|can|could|would|maybe|i think|never mind|forget)/i,
  },
  // "always"/"never" as an instruction: sentence-initial, in a request frame,
  // or followed by an instruction verb within three tokens.
  {
    name: "always",
    rx: new RegExp(
      String.raw`(^|[.!?]\s+)(please\s+)?always\b|\b(you should|you must|should|please|i want you to|make sure (you|to)|from now on)\s+always\b|\balways\s+(\w+ly\s+)?${INSTRUCTION_VERB}\b`,
      "i",
    ),
  },
  {
    name: "never",
    rx: new RegExp(
      String.raw`(^|[.!?]\s+)(please\s+)?never\b|\b(you should|you must|should|please|i want you to|make sure (you|to)|from now on)\s+never\b|\bnever\s+(\w+ly\s+)?${INSTRUCTION_VERB}\b`,
      "i",
    ),
  },
  { name: "from-now-on", rx: /\bfrom now on\b/i },
  // "remember that/this/to/my ...", never "remember what/when" or a question.
  {
    name: "remember",
    rx: /\bremember\s+(that|this|to|my|our|the|i|i'm|we|it|he|she|they)\b/i,
    unless:
      /\b(do|can|could|would|did|will|don'?t|didn'?t)\s+you\s+remember\b|\bremember\s+(what|when|where|who|how|if|whether|why)\b/i,
  },
  // "it's X not Y" / "X, not Y".
  { name: "x-not-y", rx: /\b(it'?s|is)\s+[^,.;!?]{1,80}?,?\s+not\s+\S/i },
  { name: "use-instead", rx: /\buse\b[^.!?]{0,80}\binstead\b|\binstead of\b/i },
  // "I prefer X over/instead of/not Y", never "I'd prefer the blue one".
  {
    name: "i-prefer",
    rx: /\bI('d| would)?\s+prefer\b[^.!?]{0,80}\b(over|instead|not|rather than)\b/i,
  },
  { name: "call-me", rx: /\bcall me\b/i },
  // "my name is", "my timezone is", "my deploy endpoint is".
  {
    name: "my-x-is",
    rx: new RegExp(String.raw`\bmy\s+(?:\w+\s+){0,2}${IDENTITY_NOUN}\s+(is|are)\b`, "i"),
  },
  // "my X is <Proper Noun | url/path/handle | number>".
  {
    name: "my-x-is-value",
    rx: /\b[Mm]y\s+\w+(\s+\w+){0,2}\s+(is|are)\s+(?:[A-Z][\w'-]*|\S*[./@:]\S*|[+-]?\d)/,
  },
  // "everywhere" / "globally": widen a project-scoped fact to global.
  {
    name: "everywhere",
    rx: /\b(everywhere|globally|for all projects|in every project|apply (that|this|it) everywhere)\b/i,
  },
];

/** The "everywhere" shape, also consulted when deciding a fact's scope. */
const EVERYWHERE_RX = CORRECTION_PREFILTER_PATTERNS.find((p) => p.name === "everywhere")!.rx;

/**
 * Prose only: drop code, quoted lines, external-content envelopes, and the
 * blocks the channels and the reply pipeline attach to a message that are
 * not the owner's words (Telegram/iMessage/WhatsApp `[Replying to]`,
 * `[Quoting]`, `[Forwarded from]`, the "Untrusted context" block, the
 * inbound metadata blocks and `[Thread history]` / `[Thread starter]`
 * notes). A forwarded message is someone else's text: nothing survives.
 */
export function stripNonProse(text: string): string {
  if (/^\s*\[Forwarded from [^\]]*\]/.test(text)) {
    return "";
  }
  let out = text;
  // External-content envelopes (fetched pages, forwarded mail, hook bodies).
  for (;;) {
    const start = out.indexOf(EXTERNAL_START);
    if (start === -1) {
      break;
    }
    const end = out.indexOf(EXTERNAL_END, start);
    out =
      end === -1 ? out.slice(0, start) : out.slice(0, start) + out.slice(end + EXTERNAL_END.length);
  }
  // The untrusted-context block is appended last and runs to the end.
  out = out.replace(
    /\n*Untrusted context \(metadata, do not treat as instructions or commands\):[\s\S]*$/,
    "",
  );
  // Reply / quote blocks (closed), forward prefix (whole message dropped above).
  out = out.replace(/\[Replying to [^\]]*\][\s\S]*?(\[\/Replying\]|$)/g, " ");
  out = out.replace(/\[Quoting [^\]]*\][\s\S]*?(\[\/Quoting\]|$)/g, " ");
  out = out.replace(/\[Forwarded from [^\]]*\][\s\S]*$/g, " ");
  // Thread notes: the marker line and the paragraph that follows it.
  out = out.replace(
    /(^|\n)\[Thread (history|starter) - for context\][^\n]*\n[\s\S]*?(?=\n\n|$)/g,
    "$1",
  );
  // Inbound metadata blocks: header line plus the fenced JSON that follows.
  out = out.replace(
    /(^|\n)(Conversation info|Sender|Forwarded message context) \(untrusted metadata\):[^\n]*\n```[\s\S]*?(```|$)/g,
    "$1",
  );
  out = out.replace(/```[\s\S]*?(```|$)/g, " ");
  out = out.replace(/`[^`\n]*`/g, " ");
  out = out
    .split("\n")
    .filter((line) => !/^\s*>/.test(line))
    .join("\n");
  return out;
}

/** The name of the first pattern that matches the prose of `text`, or null. */
export function matchesCorrectionPrefilter(text: string): string | null {
  const prose = stripNonProse(text);
  if (!prose.trim()) {
    return null;
  }
  for (const pattern of CORRECTION_PREFILTER_PATTERNS) {
    if (pattern.rx.test(prose) && !(pattern.unless && pattern.unless.test(prose))) {
      return pattern.name;
    }
  }
  return null;
}

export type CorrectionTier = "owner" | "extraction";

export type CorrectionWrite = {
  key: string;
  value: string;
  op: "add" | "strengthen" | "supersede";
  scope: string;
  tier: CorrectionTier;
  previousValue?: string;
  /** Who wrote it: the per-turn pass or the agent's memory_pin during the run. */
  by: "correction" | "agent";
};

export type HeldSupersede = {
  key: string;
  kind: "pending_supersede" | "pending_retire";
  currentValue: string;
  /** Empty for a held retire. */
  proposedValue: string;
};

export type CorrectionCaptureInput = {
  cfg: BitterbotConfig;
  sessionKey?: string;
  /** The session transcript (JSONL) this turn was appended to; evidence refs point into it. */
  sessionFile?: string;
  /** The run's workspace project (basename), or null when none is active. */
  activeProject?: string | null;
  /** The owner's own words: the raw inbound body, never the prompt with its context blocks. */
  userMessage: string;
  assistantReply: string;
  senderIsOwner: boolean;
  isHeartbeat: boolean;
  /** `direct` | `group` | `channel`; values are only ever shown in a direct chat. */
  chatType?: string;
  /** When the run started: agent writes and holds since then are reported. */
  runStartedAt: number;
  store: CanonicalFactsStore | null | undefined;
  /** The owner tier's writer (manager.ownerPinFact, which serialises on the maintenance mutex). */
  pinAsOwner: ((input: OwnerPinInput) => Promise<OwnerPinResult>) | null | undefined;
  /** The cheap-model lane (manager.correctionLlmCall); null disables the model call. */
  llmCall: CorrectionLlmCall | null | undefined;
  /** Aborts the model call (the reply-path cap). */
  signal?: AbortSignal;
  now?: number;
};

export type CorrectionCaptureResult = {
  /** Why the whole pass was skipped (no model call, no line), or null. */
  skipped: string | null;
  /** The pre-filter pattern that fired, or null. */
  prefilter: string | null;
  /** Model calls made: 0 or 1, never more. */
  llmCalls: number;
  writes: CorrectionWrite[];
  held: HeldSupersede[];
  /** The "Memory updated" line for the reply, or null. */
  line: string | null;
};

/**
 * Why this turn is not an owner turn the pass may learn from. Null when it
 * is. Checked before anything is read, so a skipped turn costs nothing.
 */
export function resolveCorrectionSkipReason(params: {
  cfg: BitterbotConfig;
  sessionKey?: string;
  senderIsOwner: boolean;
  isHeartbeat: boolean;
  userMessage: string;
}): string | null {
  if (params.cfg.memory?.correction?.enabled === false) {
    return "disabled";
  }
  if (params.cfg.session?.memory === "off") {
    return "session-memory-off";
  }
  if (params.isHeartbeat) {
    return "heartbeat";
  }
  if (!params.senderIsOwner) {
    return "not-owner";
  }
  if (!params.sessionKey) {
    return "no-session-key";
  }
  // Cron sessions classify as "system" (learnable for extraction) but a cron
  // prompt is nobody's correction.
  if (isCronSessionKey(params.sessionKey)) {
    return "session-cron";
  }
  const trust = classifySessionKeyTrust(params.sessionKey);
  if (trust !== "first_party") {
    return `session-${trust}`;
  }
  if (!params.userMessage.trim()) {
    return "empty-message";
  }
  return null;
}

const normalizeForMatch = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
const escapeRx = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Tokens that, just before a value, mark it as the OLD or rejected one. */
const NEGATOR_TOKENS = new Set([
  "not",
  "no",
  "never",
  "isn't",
  "aren't",
  "wasn't",
  "weren't",
  "was",
  "were",
  "old",
  "formerly",
  "previously",
  "longer",
  "than",
  "of",
]);
const NEGATOR_PHRASE_RX = /\b(instead of|no longer|rather than|used to be|not)\s*$/;
const NEGATOR_WINDOW_TOKENS = 3;

/**
 * Did the owner literally write this value, as a whole token, somewhere
 * it is asserted rather than rejected? The gate to the owner tier.
 * "no, not api2, it's api3" makes api3 eligible and api2 not.
 */
export function userMessageContainsValue(userMessage: string, value: string): boolean {
  const needle = normalizeForMatch(value);
  if (needle.length < 2) {
    return false;
  }
  const prose = normalizeForMatch(stripNonProse(userMessage));
  if (!prose) {
    return false;
  }
  const rx = new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRx(needle)}(?=$|[^\\p{L}\\p{N}])`, "gu");
  for (const match of prose.matchAll(rx)) {
    // Only the clause the value sits in: "No, it is X" asserts X even though
    // the sentence opens with a negator.
    const before = prose
      .slice(0, match.index ?? 0)
      .split(/[,.;:!?]|\bbut\b/)
      .at(-1)!
      .trim();
    if (NEGATOR_PHRASE_RX.test(before)) {
      continue;
    }
    const window = before
      .split(/\s+/)
      .filter(Boolean)
      .slice(-NEGATOR_WINDOW_TOKENS)
      .map((t) => t.replace(/^[^\p{L}\p{N}']+|[^\p{L}\p{N}']+$/gu, ""));
    const negated = window.some((t) => NEGATOR_TOKENS.has(t) || t.endsWith("n't"));
    if (!negated) {
      return true;
    }
  }
  return false;
}

/** Does the owner's prose name this scope's project or person? */
function proseNamesScope(prose: string, name: string): boolean {
  const forms = new Set([name, name.replace(/-/g, " "), name.replace(/-/g, "")]);
  return [...forms].some((form) => form.length >= 2 && userMessageContainsValue(prose, form));
}

/**
 * The scope a correction is written with (PLAN-55 review items 6-8):
 * - "everywhere"/"globally" in the owner's words: explicitly global;
 * - no scope from the model: undefined, so a supersede keeps the replaced
 *   belief's scope and an add is global (deliberate deviation from plan
 *   §3.2, which defaulted to the current project);
 * - `project:<x>`: only when a project is active, it is that project, and
 *   the owner's words name it; otherwise undefined;
 * - `person:<x>`: only when the owner's words name the person.
 */
export function resolveCorrectionScope(params: {
  modelScope: string | undefined;
  activeProject: string | null | undefined;
  userMessage: string;
}): string | undefined {
  const prose = stripNonProse(params.userMessage);
  if (EVERYWHERE_RX.test(prose)) {
    return "global";
  }
  const scope = params.modelScope ? normalizeCanonicalScope(params.modelScope) : null;
  if (!scope || scope === "global") {
    return undefined;
  }
  if (scope.startsWith("project:")) {
    const project = params.activeProject ? normalizeScopeName(params.activeProject) : null;
    if (!project || scope !== `project:${project}` || !proseNamesScope(prose, project)) {
      return undefined;
    }
    return scope;
  }
  const person = scope.slice("person:".length);
  return proseNamesScope(prose, person) ? scope : undefined;
}

/**
 * Build the evidence ref for the owner's message: `session:<file>#L<n>`,
 * where n is the 1-based line of the flattened transcript (the form
 * `memory_expand` resolves). Scans the JSONL from the end for the last user
 * message whose text starts like the owner's message. Falls back to the
 * file alone when the line cannot be found, and to null when there is no
 * readable transcript (nothing proves where the words came from).
 */
export async function resolveUserMessageEvidenceRef(
  sessionFile: string | undefined,
  userMessage: string,
): Promise<string | null> {
  if (!sessionFile) {
    return null;
  }
  try {
    // The flattening reads and parses the whole transcript. Past this size
    // the file ref alone is the evidence: a correction must never cost a
    // multi-megabyte parse on the reply path.
    const { stat } = await import("node:fs/promises");
    const size = (await stat(sessionFile)).size;
    if (size > MAX_TRANSCRIPT_BYTES_FOR_LINE_REF) {
      return `session:${sessionFile}`;
    }
    const { buildSessionEntry } = await import("./session-files.js");
    const entry = await buildSessionEntry(sessionFile);
    if (!entry) {
      return null; // unreadable: nothing proves where the words came from
    }
    const lines = entry.content.split("\n");
    const head = normalizeForMatch(userMessage).slice(0, 48);
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i] ?? "";
      if (!line.startsWith("User: ")) {
        continue;
      }
      const body = normalizeForMatch(line.slice("User: ".length));
      if (!head || body.startsWith(head) || body.includes(head)) {
        return `session:${sessionFile}#L${i + 1}`;
      }
    }
    return `session:${sessionFile}`;
  } catch (err) {
    log.debug(`evidence ref unavailable: ${String(err)}`);
    return null;
  }
}

/** `infra.deploy_endpoint` -> `deploy endpoint`; `identity.user.name` -> `user name`. */
export function humanizeFactKey(key: string): string {
  const parts = key.split(".");
  const rest = parts.length > 1 ? parts.slice(1) : parts;
  return rest.join(" ").replace(/[_-]+/g, " ").trim() || key;
}

function describeScope(scope: string): string | null {
  const normalized = normalizeCanonicalScope(scope) ?? "global";
  if (normalized.startsWith("project:")) {
    return `scope ${normalized.slice("project:".length)}; say "everywhere" to apply to all`;
  }
  if (normalized.startsWith("person:")) {
    return `for ${normalized.slice("person:".length)}`;
  }
  return null;
}

/** Cut on code points so a surrogate pair is never split. */
function truncateLine(line: string, max: number): string {
  const points = Array.from(line);
  return points.length > max ? `${points.slice(0, max - 3).join("")}...` : line;
}

/**
 * The one-line, system-generated confirmation. In a direct chat it names
 * keys and values; anywhere else (group, channel) it carries counts only,
 * so a correction's content is never echoed to people who did not say it.
 */
export function formatMemoryUpdatedLine(params: {
  writes: CorrectionWrite[];
  held: HeldSupersede[];
  chatType?: string;
}): string | null {
  const { writes, held } = params;
  if (writes.length === 0 && held.length === 0) {
    return null;
  }
  const direct = !params.chatType || params.chatType.toLowerCase() === "direct";
  const parts: string[] = [];
  if (!direct) {
    if (writes.length > 0) {
      parts.push(`Memory updated (${writes.length} fact${writes.length === 1 ? "" : "s"})`);
    }
    if (held.length > 0) {
      parts.push(
        `${held.length} change${held.length === 1 ? "" : "s"} by the agent held for your confirmation`,
      );
    }
    return parts.join("; ");
  }
  if (writes.length > 0) {
    const items = writes.map((w) => {
      const notes: string[] = [];
      if (w.op === "supersede" && w.previousValue) {
        notes.push(`was ${w.previousValue}`);
      }
      const scope = describeScope(w.scope);
      if (scope) {
        notes.push(scope);
      }
      return `${humanizeFactKey(w.key)} = ${w.value}${notes.length ? ` (${notes.join("; ")})` : ""}`;
    });
    parts.push(`Memory updated: ${items.join("; ")}`);
  }
  if (held.length > 0) {
    const items = held.map((h) =>
      h.kind === "pending_retire"
        ? `retire ${humanizeFactKey(h.key)} (${h.currentValue})`
        : `${humanizeFactKey(h.key)} ${h.currentValue} -> ${h.proposedValue}`,
    );
    parts.push(
      `${writes.length > 0 ? "held" : "Memory: held"} for your confirmation: ${items.join("; ")}`,
    );
  }
  return truncateLine(parts.join("; ").replace(/\s+/g, " "), MAX_LINE_CHARS);
}

/**
 * The agent's own `memory_pin` writes during this run (source `agent_pin`,
 * row created since `since`), so the confirmation line covers the model
 * path too. Strengthens leave no new row and are not reported.
 */
export function collectAgentWritesSince(
  store: CanonicalFactsStore,
  since: number,
  exclude: ReadonlySet<string>,
): CorrectionWrite[] {
  const out: CorrectionWrite[] = [];
  for (const fact of store.listActive()) {
    if (fact.source !== "agent_pin" || fact.validFrom < since || exclude.has(fact.key)) {
      continue;
    }
    const previous = store
      .history(fact.key)
      .find((row) => row.supersededBy === fact.id && row.status === "superseded");
    out.push({
      key: fact.key,
      value: fact.value,
      op: previous ? "supersede" : "add",
      scope: fact.scope,
      tier: "extraction",
      by: "agent",
      ...(previous ? { previousValue: previous.value } : {}),
    });
  }
  return out;
}

/**
 * Run the pass for one completed turn. Never throws: a failure anywhere is
 * logged and the reply goes out without a line.
 */
export async function runCorrectionCapture(
  input: CorrectionCaptureInput,
): Promise<CorrectionCaptureResult> {
  const result: CorrectionCaptureResult = {
    skipped: null,
    prefilter: null,
    llmCalls: 0,
    writes: [],
    held: [],
    line: null,
  };
  const skipped = resolveCorrectionSkipReason(input);
  if (skipped) {
    result.skipped = skipped;
    return result;
  }
  const store = input.store;
  if (!store) {
    result.skipped = "no-ledger";
    return result;
  }
  const now = input.now ?? Date.now();
  const confirm = input.cfg.memory?.correction?.confirm !== false;

  try {
    result.prefilter = matchesCorrectionPrefilter(input.userMessage);
    if (result.prefilter && input.llmCall && input.pinAsOwner) {
      const facts = await extractWithOneCall(input, result);
      if (facts.length > 0) {
        const evidenceRef = await resolveUserMessageEvidenceRef(
          input.sessionFile,
          input.userMessage,
        );
        for (const fact of facts) {
          const write = await pinCorrectionFact({ fact, input, store, evidenceRef });
          if (write) {
            result.writes.push(write);
          }
        }
      }
    }
    // The model path: what the agent pinned itself during this run, and what
    // it tried to replace or retire and was held on.
    const own = new Set(result.writes.map((w) => w.key));
    result.writes.push(...collectAgentWritesSince(store, input.runStartedAt, own));
    result.held = store.listPendingSupersedes({ since: input.runStartedAt }).map((h) => ({
      key: h.key,
      kind: h.kind,
      currentValue: h.currentValue,
      proposedValue: h.proposedValue,
    }));
    if (confirm) {
      result.line = formatMemoryUpdatedLine({
        writes: result.writes,
        held: result.held,
        chatType: input.chatType,
      });
    }
  } catch (err) {
    log.warn(`correction capture failed: ${String(err)}`);
  }
  if (result.writes.length > 0 || result.held.length > 0) {
    log.info(
      `correction capture: ${result.writes.length} write(s), ${result.held.length} held ` +
        `(prefilter ${result.prefilter ?? "miss"}, ${result.llmCalls} call(s), ${Date.now() - now}ms)`,
    );
  }
  return result;
}

async function extractWithOneCall(
  input: CorrectionCaptureInput,
  result: CorrectionCaptureResult,
): Promise<CorrectionFact[]> {
  const prompt = buildCorrectionExtractionPrompt({
    userMessage: stripNonProse(input.userMessage),
    assistantReply: input.assistantReply,
    project: input.activeProject ?? null,
  });
  result.llmCalls += 1;
  let raw: string;
  try {
    raw = await input.llmCall!(prompt, { signal: input.signal });
  } catch (err) {
    log.warn(`correction capture LLM call failed: ${String(err)}`);
    return [];
  }
  return parseCorrectionResponse(raw);
}

async function pinCorrectionFact(params: {
  fact: CorrectionFact;
  input: CanonicalCaptureCtx;
  store: CanonicalFactsStore;
  evidenceRef: string | null;
}): Promise<CorrectionWrite | null> {
  const { fact, input, store } = params;
  const scope = resolveCorrectionScope({
    modelScope: fact.scope,
    activeProject: input.activeProject,
    userMessage: input.userMessage,
  });
  const current = store.get(fact.key);
  // "everywhere" on a value the ledger already holds is the owner widening
  // that fact: owner-authored by the value match, whatever the model's flag.
  const widening =
    scope === "global" && current?.status === "active" && current.value === fact.value;
  const ownerAuthored =
    widening || (fact.correction && userMessageContainsValue(input.userMessage, fact.value));
  const category = fact.key.split(".")[0];
  if (ownerAuthored) {
    const res = await input.pinAsOwner!({
      key: fact.key,
      value: fact.value,
      statement: fact.statement,
      category,
      scope,
      evidenceRef: params.evidenceRef ?? undefined,
      actor: "correction",
    });
    if (!res.ok) {
      log.debug(`correction (owner) rejected [${fact.key}]: ${res.reason}`);
      return null;
    }
    return {
      key: res.key,
      value: res.value,
      op: res.op,
      scope: res.scope,
      tier: "owner",
      by: "correction",
      ...(res.previousValue ? { previousValue: res.previousValue } : {}),
    };
  }
  const res = store.pin({
    key: fact.key,
    value: fact.value,
    statement: fact.statement,
    category,
    confidence: 0.75,
    source: "extraction",
    scope,
    evidenceRef: params.evidenceRef ?? undefined,
  });
  if (res.op === "rejected" || res.op === "held") {
    log.debug(`correction (extraction) ${res.op} [${fact.key}]: ${res.reason}`);
    return null;
  }
  return {
    key: res.fact.key,
    value: res.fact.value,
    op: res.op,
    scope: res.fact.scope,
    tier: "extraction",
    by: "correction",
    ...(res.op === "supersede" && current ? { previousValue: current.value } : {}),
  };
}

type CanonicalCaptureCtx = Pick<
  CorrectionCaptureInput,
  "activeProject" | "userMessage" | "pinAsOwner"
>;
