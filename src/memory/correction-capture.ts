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
 * PLAN-64 Phase 1: the same single call may also return `practices`
 * (standing behavioural instructions, "include npm downloads too"). A
 * practice reaches the owner tier, and so becomes active, only when the
 * model marked it explicit AND a majority of its content words are in the
 * owner's own prose; otherwise it is stored as a candidate at tier
 * `extraction`, which is never rendered. Its scope is the narrowest the
 * turn supports (resolvePracticeScope). Off with `memory.practices.enabled
 * = false`.
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
import {
  conversationMemoryEnabled,
  correctionCaptureEnabled,
  practicesEnabled,
} from "../config/feature-switches.js";
import { USAGE_FEATURES } from "../infra/usage-features.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { isCronSessionKey } from "../sessions/session-key-utils.js";
import {
  type CanonicalFactsStore,
  normalizeCanonicalScope,
  normalizeScope,
  normalizeScopeName,
} from "./canonical-facts.js";
import type { OwnerPinInput, OwnerPinResult, SavePracticeInput } from "./owner-controls.js";
import type { Practice, PracticesStore, PracticeUpsertResult } from "./practices.js";
import {
  buildCorrectionExtractionPrompt,
  type CorrectionFact,
  type CorrectionPractice,
  parseCorrectionPractices,
  parseCorrectionResponse,
} from "./session-extractor.js";
import { classifySessionKeyTrust } from "./session-trust.js";
import { contentWords } from "./task-types.js";

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
  // ── PLAN-64 Phase 1: behavioural phrasings the Phase 0 replay found the
  // list above misses. Each is an imperative addressed to the assistant;
  // the `unless` guards keep narration ("I had to stop working") and
  // questions ("should I stop using npm?") from earning a model call.
  // "stop asking", "please stop apologizing", "can you stop adding emojis".
  {
    name: "stop-verbing",
    rx: /(^|[.!?,;:]\s+|\b(?:please|just|and|you can|you should|you need to|you must|can you|could you|would you|(?:told|asked|want|need) you to)\s+)stop\s+(?!(?:every|any|some|no)thing\b)[a-z]+ing\b/im,
    unless:
      /\b(should|shall|can|could|did|does|do|will|would|when|why|how)\s+(i|we|it|they|he|she|the\s+\w+)\s+(\w+\s+)?stop\b|\b(i|we|it|they|he|she)\s+((had|have|need|want|tried|try|decided|plan|will|would|should|could|can|can'?t|cannot|must|might|may|did|didn'?t|won'?t|never)\s+)?(to\s+)?stop\s+[a-z]+ing\b/i,
  },
  // "don't worry about the reputation score".
  {
    name: "dont-worry-about",
    rx: /\b(don'?t|do not|no need to|never)\s+worry\s+about\b/i,
    unless: /\b(i|we|they|he|she)\s+(really\s+|usually\s+)?(don'?t|do not|never)\s+worry\b/i,
  },
  // "no need to <instruction verb>": "no need to include the table".
  {
    name: "no-need-to",
    rx: new RegExp(String.raw`\bno need to\s+(\w+ly\s+)?${INSTRUCTION_VERB}\b`, "i"),
    unless: /\b(is|was|if|whether)\s+there('?s| is| was)?\s+no need\b|\bno need to\b[^.!?\n]*\?/i,
  },
  // "give me X too", "include the npm downloads as well", "show views every time".
  {
    name: "give-too",
    rx: /(^|[.!?]\s+|\b(?:please|just|and|also|can you|could you|would you|you should|you can)\s+)(give|show|include|add)\b[^.!?\n]{2,120}?(\b(too|as well)\s*([.!?,;]|$)|\b(every|each) time\b)/im,
    unless:
      /\b(too|as well)\s+(much|many|long|short|few|little|late|early|big|small|hard|soon|often)\b/i,
  },
  // "you should <instruction verb>": "you should check the docs first".
  {
    name: "you-should",
    rx: new RegExp(
      String.raw`\byou\s+(should|shouldn'?t|should not|ought to)\s+(\w+ly\s+)?(not\s+)?${INSTRUCTION_VERB}\b`,
      "i",
    ),
    unless:
      /\b(what|which|how|why|where|when|whether|if|think|sure)\s+(do\s+you\s+think\s+)?you\s+should\b|\byou\s+should(n'?t| not)?\s+be\s+(able|fine|good|ok|okay|all set|set|getting|seeing|receiving|hearing)\b|\byou\s+should\b[^.!?\n]*\?/i,
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
  // Typographic apostrophes ("don’t") read as plain ones for every pattern.
  const prose = stripNonProse(text).replace(/[\u2018\u2019]/g, "'");
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

/** A practice the pass stored (or widened) this turn. */
export type PracticeWrite = {
  id: string;
  statement: string;
  scope: string;
  status: Practice["status"];
  /** `widen`: an existing practice was made global by the owner's "everywhere". */
  op: "add" | "strengthen" | "promote" | "widen";
  tier: CorrectionTier;
  /** The task type's plain label, for the confirmation line. */
  taskLabel?: string;
};

/** What the pass needs to store practices (PLAN-64 Phase 1); absent disables it. */
export type PracticeCaptureDeps = {
  /** The practices writer (manager.ownerSavePractice, serialised on the maintenance mutex). */
  save: (input: SavePracticeInput) => Promise<PracticeUpsertResult>;
  /** Widen by "everywhere": needs to find and re-scope the practice just stored. */
  store?: PracticesStore | null;
  setScope?: ((id: string, scope: string) => Promise<PracticeUpsertResult>) | null;
  /** The recurring task type of this turn or of the owner turn just before it. */
  taskType?: { slug: string; label: string } | null;
  /** The cron job this turn is about, when the turn carries a cron context for one. */
  cronJobId?: string | null;
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
  /** PLAN-64 Phase 1: practice capture; ignored when `memory.practices.enabled` is false. */
  practices?: PracticeCaptureDeps | null;
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
  /** PLAN-64 Phase 1: practices stored or widened this turn (candidates included). */
  practices: PracticeWrite[];
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
  if (!correctionCaptureEnabled(params.cfg.memory?.correction)) {
    return "disabled";
  }
  if (!conversationMemoryEnabled(params.cfg.session)) {
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

/** Where a practice applies, in plain words: "repo stats", "project acme", "everything". */
export function describePracticeScope(scope: string, taskLabel?: string): string {
  const normalized = normalizeScope(scope) ?? "global";
  const name = normalized.slice(normalized.indexOf(":") + 1).replace(/-/g, " ");
  if (normalized.startsWith("task:")) {
    return taskLabel?.trim() || name;
  }
  if (normalized.startsWith("job:")) {
    return "this scheduled job";
  }
  if (normalized.startsWith("project:")) {
    return `project ${name}`;
  }
  if (normalized.startsWith("person:")) {
    return name;
  }
  return "everything";
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
  /** PLAN-64 Phase 1. Only active practices are announced: a candidate changes nothing yet. */
  practices?: PracticeWrite[];
  chatType?: string;
}): string | null {
  const { writes, held } = params;
  const practices = (params.practices ?? []).filter((p) => p.status === "active");
  if (writes.length === 0 && held.length === 0 && practices.length === 0) {
    return null;
  }
  const direct = !params.chatType || params.chatType.toLowerCase() === "direct";
  const parts: string[] = [];
  if (!direct) {
    if (writes.length > 0) {
      parts.push(`Memory updated (${writes.length} fact${writes.length === 1 ? "" : "s"})`);
    }
    if (practices.length > 0) {
      parts.push(
        `${writes.length > 0 ? "" : "Memory updated: "}${practices.length} practice${practices.length === 1 ? "" : "s"} saved`,
      );
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
  for (const practice of practices) {
    const where = describePracticeScope(practice.scope, practice.taskLabel);
    parts.push(
      practice.op === "widen"
        ? `Practice now applies to ${where}: "${practice.statement}"`
        : `Practice saved for ${where}: "${practice.statement}"`,
    );
  }
  if (held.length > 0) {
    const items = held.map((h) =>
      h.kind === "pending_retire"
        ? `retire ${humanizeFactKey(h.key)} (${h.currentValue})`
        : `${humanizeFactKey(h.key)} ${h.currentValue} -> ${h.proposedValue}`,
    );
    parts.push(
      `${writes.length > 0 || practices.length > 0 ? "held" : "Memory: held"} for your confirmation: ${items.join("; ")}`,
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
    practices: [],
    line: null,
  };
  const skipped = resolveCorrectionSkipReason(input);
  if (skipped) {
    result.skipped = skipped;
    return result;
  }
  const store = input.store ?? null;
  const practiceDeps =
    input.practices && practicesEnabled(input.cfg.memory?.practices) ? input.practices : null;
  if (!store && !practiceDeps) {
    result.skipped = "no-ledger";
    return result;
  }
  const now = input.now ?? Date.now();
  const confirm = input.cfg.memory?.correction?.confirm !== false;

  try {
    result.prefilter = matchesCorrectionPrefilter(input.userMessage);
    // Facts need the ledger and its owner writer; practices need their own.
    const canPinFacts = Boolean(store && input.pinAsOwner);
    if (result.prefilter && input.llmCall && (canPinFacts || practiceDeps)) {
      const extracted = await extractWithOneCall(input, result, Boolean(practiceDeps));
      const facts = canPinFacts ? extracted.facts : [];
      const practices = practiceDeps ? extracted.practices : [];
      const evidenceRef =
        facts.length > 0 || practices.length > 0
          ? await resolveUserMessageEvidenceRef(input.sessionFile, input.userMessage)
          : null;
      for (const fact of facts) {
        const write = await pinCorrectionFact({ fact, input, store: store!, evidenceRef });
        if (write) {
          result.writes.push(write);
        }
      }
      // "everywhere" as the whole reply, right after a practice was saved
      // at a narrower scope: the owner widening it. Decided from the stored
      // row, not the model output, and it replaces that output ("apply that
      // everywhere" is not itself a practice).
      const widened = practiceDeps
        ? await widenRecentPractice({ input, deps: practiceDeps, now })
        : null;
      if (widened) {
        result.practices.push(widened);
      }
      for (const practice of widened ? [] : practices) {
        const write = await saveCapturedPractice({
          practice,
          input,
          deps: practiceDeps!,
          evidenceRef,
        });
        if (write) {
          result.practices.push(write);
        }
      }
    }
    if (store) {
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
    }
    if (confirm) {
      result.line = formatMemoryUpdatedLine({
        writes: result.writes,
        held: result.held,
        practices: result.practices,
        chatType: input.chatType,
      });
    }
  } catch (err) {
    log.warn(`correction capture failed: ${String(err)}`);
  }
  if (result.writes.length > 0 || result.held.length > 0 || result.practices.length > 0) {
    log.info(
      `correction capture: ${result.writes.length} write(s), ${result.held.length} held, ` +
        `${result.practices.length} practice(s) ` +
        `(prefilter ${result.prefilter ?? "miss"}, ${result.llmCalls} call(s), ${Date.now() - now}ms)`,
    );
  }
  return result;
}

async function extractWithOneCall(
  input: CorrectionCaptureInput,
  result: CorrectionCaptureResult,
  withPractices: boolean,
): Promise<{ facts: CorrectionFact[]; practices: CorrectionPractice[] }> {
  const prompt = buildCorrectionExtractionPrompt({
    userMessage: stripNonProse(input.userMessage),
    assistantReply: input.assistantReply,
    project: input.activeProject ?? null,
    practices: withPractices,
  });
  result.llmCalls += 1;
  let raw: string;
  try {
    raw = await input.llmCall!(prompt, { signal: input.signal });
  } catch (err) {
    log.warn(`correction capture LLM call failed: ${String(err)}`);
    return { facts: [], practices: [] };
  }
  return {
    facts: parseCorrectionResponse(raw),
    practices: withPractices ? parseCorrectionPractices(raw) : [],
  };
}

/** Share of a statement's content words the owner's prose must contain for the owner tier. */
export const PRACTICE_OWNER_WORD_SHARE = 0.5;

/**
 * Did the owner say this instruction? True when MORE than half of the
 * statement's content words (stopwords dropped, lightly stemmed) occur in
 * the owner's own prose: code, quoted lines, forwarded and pasted blocks
 * are stripped first, so an instruction inside a pasted email or a tool
 * result never counts. The practices counterpart of
 * userMessageContainsValue, and the only gate to the owner tier.
 */
export function ownerProseSupportsStatement(userMessage: string, statement: string): boolean {
  const wanted = contentWords(statement);
  if (wanted.length < 2) {
    return false;
  }
  const prose = new Set(contentWords(stripNonProse(userMessage)));
  if (prose.size === 0) {
    return false;
  }
  const present = wanted.filter((word) => prose.has(word)).length;
  return present / wanted.length > PRACTICE_OWNER_WORD_SHARE;
}

/**
 * The scope a captured practice is stored with: the narrowest the turn
 * supports. The model's scope is a hint and can only narrow to a project or
 * person the owner's words name.
 * - "everywhere"/"globally" in the owner's words: global, whatever else;
 * - a cron context for a job: `job:<id>`;
 * - a recurring task type on this turn or the owner turn before it:
 *   `task:<slug>`;
 * - the model said `project:<x>`, x is the active project and the owner's
 *   words name it: `project:<x>`;
 * - the model said `person:<x>` and the owner's words name x: `person:<x>`;
 * - otherwise global.
 */
export function resolvePracticeScope(params: {
  modelScope: string | undefined;
  activeProject: string | null | undefined;
  userMessage: string;
  taskSlug?: string | null;
  cronJobId?: string | null;
}): string {
  const prose = stripNonProse(params.userMessage);
  if (EVERYWHERE_RX.test(prose)) {
    return "global";
  }
  const job = params.cronJobId ? normalizeScopeName(params.cronJobId) : null;
  if (job) {
    return `job:${job}`;
  }
  const task = params.taskSlug ? normalizeScopeName(params.taskSlug) : null;
  if (task) {
    return `task:${task}`;
  }
  const named = resolveCorrectionScope({
    modelScope: params.modelScope === "task" ? undefined : params.modelScope,
    activeProject: params.activeProject,
    userMessage: params.userMessage,
  });
  return named ?? "global";
}

const SCOPE_ONLY_WORDS = new Set(
  [
    "apply",
    "everywhere",
    "globally",
    "global",
    "always",
    "project",
    "chat",
    "time",
    "rule",
  ].flatMap((w) => contentWords(w)),
);

async function saveCapturedPractice(params: {
  practice: CorrectionPractice;
  input: CorrectionCaptureInput;
  deps: PracticeCaptureDeps;
  evidenceRef: string | null;
}): Promise<PracticeWrite | null> {
  const { practice, input, deps } = params;
  // "Apply that everywhere" is a scope change, not an instruction: once the
  // scope words are set aside there must still be something to do.
  if (contentWords(practice.statement).filter((w) => !SCOPE_ONLY_WORDS.has(w)).length < 2) {
    log.debug("practice dropped: nothing left besides scope words");
    return null;
  }
  const scope = resolvePracticeScope({
    modelScope: practice.scope,
    activeProject: input.activeProject,
    userMessage: input.userMessage,
    taskSlug: deps.taskType?.slug,
    cronJobId: deps.cronJobId,
  });
  const ownerAuthored =
    practice.explicit && ownerProseSupportsStatement(input.userMessage, practice.statement);
  const tier: CorrectionTier = ownerAuthored ? "owner" : "extraction";
  const res = await deps.save({
    statement: practice.statement,
    scope,
    source: tier,
    origin: "explicit",
    evidenceRef: params.evidenceRef,
    actor: "correction",
  });
  if (!res.ok) {
    log.debug(`practice (${tier}) rejected: ${res.reason}`);
    return null;
  }
  return {
    id: res.practice.id,
    statement: res.practice.statement,
    scope: res.practice.scope,
    status: res.practice.status,
    op: res.op,
    tier,
    ...(deps.taskType && res.practice.scope === `task:${deps.taskType.slug}`
      ? { taskLabel: deps.taskType.label }
      : {}),
  };
}

/** How long after a practice is saved a bare "everywhere" still refers to it. */
export const PRACTICE_WIDEN_WINDOW_MS = 30 * 60_000;
const WIDEN_MAX_WORDS = 12;

/**
 * The owner answers a "Practice saved for repo stats" line with
 * "everywhere" (or "apply that everywhere"): widen that practice to global.
 * Deterministic and tight: the message must be short, match the
 * "everywhere" shape, and exactly one owner-tier practice captured from
 * this session's transcript in the last PRACTICE_WIDEN_WINDOW_MS must be
 * narrower than global. Anything else changes nothing.
 */
async function widenRecentPractice(params: {
  input: CorrectionCaptureInput;
  deps: PracticeCaptureDeps;
  now: number;
}): Promise<PracticeWrite | null> {
  const { input, deps } = params;
  if (!deps.store || !deps.setScope || !input.sessionFile) {
    return null;
  }
  const prose = stripNonProse(input.userMessage).trim();
  if (!EVERYWHERE_RX.test(prose) || prose.split(/\s+/).length > WIDEN_MAX_WORDS) {
    return null;
  }
  const ref = `session:${input.sessionFile}`;
  const recent = deps.store
    .list({ statuses: ["active"] })
    .filter(
      (p) =>
        p.scope !== "global" &&
        p.origin === "explicit" &&
        p.source === "owner" &&
        params.now - p.updatedAt <= PRACTICE_WIDEN_WINDOW_MS &&
        p.evidenceRefs.some((r) => r === ref || r.startsWith(`${ref}#`)),
    );
  if (recent.length !== 1) {
    return null;
  }
  const res = await deps.setScope(recent[0]!.id, "global");
  if (!res.ok) {
    return null;
  }
  return {
    id: res.practice.id,
    statement: res.practice.statement,
    scope: res.practice.scope,
    status: res.practice.status,
    op: "widen",
    tier: "owner",
  };
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
