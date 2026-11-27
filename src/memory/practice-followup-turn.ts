/**
 * PLAN-64 Phase 1b: the per-turn steps of follow-up learning, around the
 * correction pass (practice-followups.ts has the rules and the pieces).
 *
 * Before the run (the prompt path): `resolveOfferAnswerBeforeRun` applies a
 * bare yes or no to the offer the previous reply carried and returns the
 * note the agent gets for that turn.
 *
 * After the run (the reply path): `beginFollowUpTurn` reports an answered
 * offer and decides whether this message may be a follow-up to a
 * recurring-task answer (handing the correction pass the context for the
 * one model call); `finishFollowUpTurn` stores the gap as a candidate or a
 * repeat, picks at most one offer for the reply and records this turn's
 * answer for the next message.
 *
 * Nothing here throws into the reply path, and nothing calls a model.
 */

import type { BitterbotConfig } from "../config/config.js";
import { practiceFollowUpsEnabled, practiceOffersEnabled } from "../config/feature-switches.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  isExplicitStandingInstruction,
  type PracticeWrite,
  resolveUserMessageEvidenceRef,
  stripNonProse,
} from "./correction-capture.js";
import {
  areGapStatementsMatching,
  type FollowUpContext,
  type FollowUpGap,
  type FollowUpState,
  type FollowUpStateStore,
  formatOfferAnswerLine,
  formatOfferAnswerNote,
  formatOfferLine,
  type GapSightingResult,
  OFFER_ANSWER_WINDOW_MS,
  parseOfferAnswer,
  pickOffer,
  recordGapSighting,
} from "./practice-followups.js";
import type { Practice, PracticesStore } from "./practices.js";
import { stripMessageEnvelope, type TaskTypesStore } from "./task-types.js";

const log = createSubsystemLogger("memory/practice-followups");

/** What the per-turn steps need from the memory manager (or a test double). */
export type FollowUpTurnDeps = {
  practices: PracticesStore;
  taskTypes: TaskTypesStore;
  state: FollowUpStateStore;
  /** Run a synchronous write serialised with the other memory writes. */
  change: <T>(label: string, fn: () => T) => Promise<T>;
  /** The owner's yes or no to an offer, audited (owner-controls.answerPracticeOffer). */
  answerOffer: (practiceId: string, answer: "yes" | "no") => Promise<boolean>;
};

const prose = (text: string) =>
  stripMessageEnvelope(stripNonProse(text)).replace(/\s+/g, " ").trim();

function taskLabelOf(deps: FollowUpTurnDeps, practice: Pick<Practice, "scope">): string {
  if (!practice.scope.startsWith("task:")) {
    return "";
  }
  const slug = practice.scope.slice("task:".length);
  return deps.taskTypes.get(slug)?.label.trim() || slug.replace(/-/g, " ");
}

type AppliedAnswer = { kind: "confirmed" | "declined"; practice: Practice };

/**
 * Apply a bare yes or no to the pending offer of this session. Null when
 * there is no offer inside the window, the message is not a bare answer, or
 * the candidate is gone. An ambiguous message changes nothing.
 */
async function applyOfferAnswer(
  deps: FollowUpTurnDeps,
  state: FollowUpState | null,
  text: string,
  opts: { sessionKey: string; runId?: string | null; now: number },
): Promise<AppliedAnswer | null> {
  if (
    !state?.offerPracticeId ||
    state.offeredAt === null ||
    opts.now - state.offeredAt > OFFER_ANSWER_WINDOW_MS
  ) {
    return null;
  }
  const answer = parseOfferAnswer(prose(text));
  if (!answer) {
    return null;
  }
  const practice = deps.practices.get(state.offerPracticeId);
  if (!practice || practice.status !== "candidate") {
    deps.state.clearOffer(opts.sessionKey, opts.now);
    return null;
  }
  if (!(await deps.answerOffer(practice.id, answer))) {
    return null;
  }
  const kind = answer === "yes" ? "confirmed" : "declined";
  deps.state.setOfferAnswer(opts.sessionKey, {
    practiceId: practice.id,
    kind,
    runId: opts.runId ?? null,
    now: opts.now,
  });
  log.info(`practice offer ${kind}: ${practice.id}`);
  return { kind, practice: deps.practices.get(practice.id) ?? practice };
}

/**
 * The prompt path, before the run: when the owner's message is a bare yes
 * or no to the offer the previous reply carried, apply it and return the
 * note that tells the agent what the message was answering. A retried
 * attempt of the same run gets the same note. Null on every other turn.
 * No model call. Never throws.
 */
export async function resolveOfferAnswerBeforeRun(
  deps: FollowUpTurnDeps,
  params: {
    cfg: BitterbotConfig;
    sessionKey?: string;
    /** The owner's message (context blocks and the envelope are stripped here). */
    text: string;
    runId?: string;
    now?: number;
  },
): Promise<string | null> {
  try {
    if (!params.sessionKey || !practiceOffersEnabled(params.cfg.memory?.practices)) {
      return null;
    }
    const now = params.now ?? Date.now();
    const state = deps.state.get(params.sessionKey);
    let applied: AppliedAnswer | null = null;
    if (
      state?.answerKind &&
      state.answerPracticeId &&
      params.runId &&
      state.answerRunId === params.runId
    ) {
      const practice = deps.practices.get(state.answerPracticeId);
      applied = practice ? { kind: state.answerKind, practice } : null;
    } else {
      applied = await applyOfferAnswer(deps, state, params.text, {
        sessionKey: params.sessionKey,
        runId: params.runId,
        now,
      });
    }
    if (!applied) {
      return null;
    }
    return formatOfferAnswerNote({
      kind: applied.kind,
      statement: applied.practice.statement,
      taskLabel: taskLabelOf(deps, applied.practice),
    });
  } catch (err) {
    log.debug(`practice offer answer failed: ${String(err)}`);
    return null;
  }
}

export type FollowUpTurn = {
  /** The generated line that reports the owner's yes or no, or null. */
  answerLine: string | null;
  /** This message answered an offer: it is not a follow-up and earns no new offer. */
  isOfferAnswer: boolean;
  /** An offer was waiting for this message. */
  hadOffer: boolean;
  /** Set when this message may be a follow-up: the context for the one gap check. */
  gapContext: FollowUpContext | null;
};

const NO_TURN: FollowUpTurn = {
  answerLine: null,
  isOfferAnswer: false,
  hadOffer: false,
  gapContext: null,
};

/**
 * The reply path, before the correction pass. Reports an offer answered on
 * this turn (applying it here when the prompt path did not see a bare
 * answer, for example because the prompt carried other blocks), and spends
 * the previous recurring-task answer's one gap check on this message when it
 * arrived inside the window in the same session.
 */
export async function beginFollowUpTurn(
  deps: FollowUpTurnDeps,
  params: {
    cfg: BitterbotConfig;
    sessionKey?: string;
    sessionId?: string;
    userMessage: string;
    now?: number;
  },
): Promise<FollowUpTurn> {
  const sessionKey = params.sessionKey;
  if (!sessionKey) {
    return NO_TURN;
  }
  const now = params.now ?? Date.now();
  const turn: FollowUpTurn = { ...NO_TURN };
  try {
    const state = deps.state.get(sessionKey);
    turn.hadOffer = Boolean(state?.offerPracticeId);
    if (practiceOffersEnabled(params.cfg.memory?.practices)) {
      let applied: AppliedAnswer | null = null;
      if (state?.answerKind && state.answerPracticeId) {
        const fresh = state.answerAt !== null && now - state.answerAt <= OFFER_ANSWER_WINDOW_MS;
        const practice = fresh ? deps.practices.get(state.answerPracticeId) : null;
        applied = practice ? { kind: state.answerKind, practice } : null;
      } else {
        applied = await applyOfferAnswer(deps, state, params.userMessage, { sessionKey, now });
      }
      if (applied || state?.answerKind) {
        deps.state.clearOfferAnswer(sessionKey, now);
      }
      if (applied) {
        turn.isOfferAnswer = true;
        turn.answerLine = formatOfferAnswerLine({
          kind: applied.kind,
          statement: applied.practice.statement,
          taskLabel: taskLabelOf(deps, applied.practice),
        });
      }
    }
    if (!turn.isOfferAnswer && practiceFollowUpsEnabled(params.cfg.memory?.practices)) {
      const pending = deps.state.pendingAnswer(sessionKey, now);
      const sameSession =
        !state?.sessionId || !params.sessionId || state.sessionId === params.sessionId;
      const type = pending ? deps.taskTypes.get(pending.taskSlug) : null;
      if (pending && sameSession && type?.recurring && pending.answerText.trim()) {
        // Spent now, whatever happens next: at most one check per answer.
        deps.state.markGapChecked(sessionKey, now);
        turn.gapContext = {
          taskSlug: type.slug,
          taskLabel: type.label,
          previousOwnerMessage: pending.ownerText,
          previousAnswer: pending.answerText,
        };
      }
    }
  } catch (err) {
    log.debug(`follow-up turn setup failed: ${String(err)}`);
  }
  return turn;
}

export type FollowUpTurnResult = {
  /** The generated offer line for this reply, or null. */
  offerLine: string | null;
  /** What became of a detected gap, when there was one. */
  sighting: GapSightingResult | null;
};

/**
 * The reply path, after the correction pass. Never throws.
 */
export async function finishFollowUpTurn(
  deps: FollowUpTurnDeps,
  turn: FollowUpTurn,
  params: {
    cfg: BitterbotConfig;
    sessionKey?: string;
    sessionId?: string;
    sessionFile?: string;
    userMessage: string;
    replyText: string;
    chatType?: string;
    activeProject?: string | null;
    /** The follow-up classification from the correction pass's call. */
    followUp: FollowUpGap | null;
    /** Practices the correction pass stored on this turn. */
    captured: PracticeWrite[];
    now?: number;
  },
): Promise<FollowUpTurnResult> {
  const out: FollowUpTurnResult = { offerLine: null, sighting: null };
  const sessionKey = params.sessionKey;
  if (!sessionKey) {
    return out;
  }
  const now = params.now ?? Date.now();
  const sessionId = params.sessionId || sessionKey;
  const text = prose(params.userMessage);
  try {
    const ctx = turn.gapContext;
    if (ctx && params.followUp?.kind === "gap") {
      deps.taskTypes.dropDeferred(sessionKey, stripNonProse(params.userMessage));
      const statement = params.followUp.statement;
      // The owner said it as an instruction and the correction pass already
      // saved it as an active practice: nothing left to offer.
      const savedExplicitly = params.captured.some(
        (p) => p.status === "active" && areGapStatementsMatching(p.statement, statement),
      );
      if (!savedExplicitly) {
        const evidenceRef = await resolveUserMessageEvidenceRef(
          params.sessionFile,
          params.userMessage,
        );
        out.sighting = await deps.change("practice-follow-up", () =>
          recordGapSighting({
            store: deps.practices,
            taskSlug: ctx.taskSlug,
            statement,
            ownerProse: text,
            evidenceRef,
            sessionId,
            explicit: isExplicitStandingInstruction(params.userMessage),
            origin: "follow_up",
            activeProject: params.activeProject,
            now,
          }),
        );
        log.info(`follow-up gap on ${ctx.taskSlug}: ${out.sighting.kind}`);
      }
    } else {
      // Not a follow-up after all (or nobody could say): a turn that was
      // held back from task typing is counted now.
      deps.taskTypes.countDeferred(sessionKey, stripNonProse(params.userMessage), now);
    }

    const type = text ? deps.taskTypes.classify(text) : null;
    const direct = !params.chatType || params.chatType.toLowerCase() === "direct";
    const offerSlug = out.sighting?.kind === "candidate" ? ctx?.taskSlug : type?.slug;
    if (
      offerSlug &&
      direct &&
      !turn.isOfferAnswer &&
      practiceOffersEnabled(params.cfg.memory?.practices)
    ) {
      const pick = pickOffer(deps.practices, {
        taskSlug: offerSlug,
        sessionId,
        preferId: out.sighting?.kind === "candidate" ? out.sighting.practice.id : null,
      });
      if (
        pick &&
        (await deps.change("practice-offer", () =>
          deps.practices.recordOffer(pick.practice.id, { sessionId, now }),
        ))
      ) {
        deps.state.setOffer(sessionKey, pick.practice.id, { sessionId, now });
        out.offerLine = formatOfferLine({
          statement: pick.practice.statement,
          taskLabel: taskLabelOf(deps, pick.practice),
          sightings: pick.sightings,
        });
      }
    }
    if (!out.offerLine && turn.hadOffer) {
      // The owner's next message has come and gone: the offer lapses.
      deps.state.clearOffer(sessionKey, now);
    }

    if (type && practiceFollowUpsEnabled(params.cfg.memory?.practices)) {
      deps.state.recordAnswer(sessionKey, {
        sessionId,
        taskSlug: type.slug,
        ownerText: text,
        answerText: params.replyText,
        now,
      });
    } else {
      deps.state.clearAnswer(sessionKey, now);
    }
  } catch (err) {
    log.debug(`follow-up turn failed: ${String(err)}`);
  }
  return out;
}
