import { randomUUID } from "node:crypto";
import { defaultRuntime } from "../../runtime.js";
import type { WizardPrompter } from "../../wizard/prompts.js";
import { WizardSession } from "../../wizard/session.js";
import {
  ErrorCodes,
  errorShape,
  validateWizardCancelParams,
  validateWizardNextParams,
  validateWizardStartParams,
  validateWizardStatusParams,
} from "../protocol/index.js";
import {
  clearSetupInProgress,
  hashToken,
  isSetupOnlyScopes,
  liveSetupTokenHash,
  markSetupInProgress,
  revokeSetupToken,
  setupInProgress,
  verifySetupToken,
} from "../setup-token.js";
import { formatForLog } from "../ws-log.js";
import type { GatewayClient, GatewayRequestContext, GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

function readWizardStatus(session: WizardSession) {
  return {
    status: session.getStatus(),
    error: session.getError(),
  };
}

function isSetupOnlyClient(client: GatewayClient | null): boolean {
  return Boolean(client && isSetupOnlyScopes(client.connect.scopes));
}

/**
 * True once setup has run: a config file holding more than a first gateway
 * start writes (PLAN-56 Phase 2 `isFirstBootOnlyConfig`). After that, only an
 * admin-authenticated caller may run the wizard again.
 */
export async function onboardingComplete(): Promise<boolean> {
  // A browser setup that wrote part of the config and then lost its session
  // is not complete: the next setup link may finish it.
  if (setupInProgress()) {
    return false;
  }
  const { readConfigFileSnapshot } = await import("../../config/config.js");
  const { isFirstBootOnlyConfig } = await import("../../wizard/onboarding.first-boot.js");
  const snapshot = await readConfigFileSnapshot();
  return snapshot.exists && !isFirstBootOnlyConfig(snapshot.resolved);
}

/**
 * The default runner: the shared setup step model (src/wizard/setup-steps.ts),
 * plus the first reply and the doctor summary. `context.wizardRunner` (tests)
 * replaces it entirely.
 */
function createSetupRunner(context: GatewayRequestContext) {
  return async (prompter: WizardPrompter) => {
    const { runSetupWizard } = await import("../../wizard/setup-wizard.js");
    const { runSetupFirstTurn } = await import("../setup-first-turn.js");
    const { agentHandlers } = await import("./agent.js");
    const { collectSetupDoctorSummary } = await import("../../commands/doctor-findings.js");
    const { detectInstallKind } = await import("../../infra/install-kind.js");
    const { resolveBitterbotPackageRoot } = await import("../../infra/bitterbot-root.js");
    const packageRoot = await resolveBitterbotPackageRoot({
      moduleUrl: import.meta.url,
      argv1: process.argv[1],
      cwd: process.cwd(),
    }).catch(() => null);
    const { detectSetupServiceSupport, installSetupGatewayService } =
      await import("../../wizard/setup-service.js");
    const { isLikelySupervisedProcess } = await import("../../infra/process-respawn.js");
    const { scheduleSetupHandoverExit } = await import("../../infra/setup-handover.js");
    const { resolveGatewayPort } = await import("../../config/config.js");
    const agentHandler = agentHandlers.agent;
    const installKind = detectInstallKind(packageRoot);
    await runSetupWizard(prompter, {
      installKind,
      service: await detectSetupServiceSupport({ installKind }),
      installService: (cfg) =>
        installSetupGatewayService({ config: cfg, port: resolveGatewayPort(cfg) }),
      // Only an unsupervised gateway (the one `bitterbot onboard` started)
      // hands its port over; on Windows the scheduled task starts at the next
      // sign-in, so this gateway keeps running until then.
      onHandover: () => {
        if (!isLikelySupervisedProcess() && process.platform !== "win32") {
          scheduleSetupHandoverExit();
        }
      },
      runFirstTurn: (cfg) => runSetupFirstTurn({ cfg, context, agentHandler }),
      collectDoctorSummary: (cfg) => collectSetupDoctorSummary({ cfg }),
      markInProgress: () => markSetupInProgress(),
      // The token that drove this setup dies with it; setup is now complete.
      onComplete: () => {
        revokeSetupToken();
        clearSetupInProgress();
      },
    });
  };
}

const SETUP_OWNER_PREFIX = "setup:";

function ownerKeyFor(token: string | undefined): string {
  return `${SETUP_OWNER_PREFIX}${hashToken(token?.trim() ?? "")}`;
}

/** Who is calling: "admin", or the setup token's owner key. */
function callerOwner(client: GatewayClient | null): string {
  return isSetupOnlyClient(client) ? ownerKeyFor(client?.setupToken) : "admin";
}

/** Admin may drive any session; a setup token only the one it started. */
function mayUseSession(session: WizardSession, owner: string): boolean {
  return owner === "admin" || session.owner === owner;
}

/**
 * A setup-token session whose token is no longer the live one (replaced by a
 * newer `bitterbot onboard`, or expired): nobody can resume it any more.
 */
function isOrphanedSetupSession(session: WizardSession): boolean {
  if (!session.owner?.startsWith(SETUP_OWNER_PREFIX)) {
    return false;
  }
  const live = liveSetupTokenHash();
  return !live || session.owner !== `${SETUP_OWNER_PREFIX}${live}`;
}

function sessionNotFound() {
  return errorShape(ErrorCodes.INVALID_REQUEST, "wizard not found");
}

function setupLinkError(reason: string) {
  return errorShape(
    ErrorCodes.INVALID_REQUEST,
    `setup link ${reason === "expired" ? "expired" : "no longer valid"}; run \`bitterbot onboard\` for a new one`,
  );
}

export const wizardHandlers: GatewayRequestHandlers = {
  "wizard.start": async ({ params, respond, context, client }) => {
    if (!assertValidParams(params, validateWizardStartParams, "wizard.start", respond)) {
      return;
    }
    const setupOnly = isSetupOnlyClient(client);
    const owner = callerOwner(client);
    if (setupOnly) {
      // The connection proved the token at connect; it must still be live now
      // (not expired, not used up by a finished setup).
      const check = verifySetupToken(client?.setupToken);
      if (!check.ok) {
        respond(false, undefined, setupLinkError(check.reason));
        return;
      }
    }
    let running = context.findRunningWizard();
    const runningSession = running ? context.wizardSessions.get(running) : undefined;
    if (running && runningSession && isOrphanedSetupSession(runningSession)) {
      // Its tab closed, then `bitterbot onboard` minted a new link (or the
      // old one expired): cancel it so the new link can start fresh.
      runningSession.cancel();
      context.wizardSessions.delete(running);
      running = null;
    }
    if (running) {
      // A reload of the setup page resumes its own session where it was.
      const session = context.wizardSessions.get(running);
      if (session && mayUseSession(session, owner)) {
        const result = await session.next();
        respond(true, { sessionId: running, ...result }, undefined);
        return;
      }
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "wizard already running"));
      return;
    }
    if (setupOnly) {
      if (await onboardingComplete()) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            "setup already completed; sign in to the Control UI (admin) to run it again",
          ),
        );
        return;
      }
    }
    const sessionId = randomUUID();
    const opts = {
      mode: params.mode,
      workspace: typeof params.workspace === "string" ? params.workspace : undefined,
    };
    const injected = context.wizardRunner;
    const setupRunner = createSetupRunner(context);
    const session = new WizardSession((prompter) =>
      injected ? injected(opts, defaultRuntime, prompter) : setupRunner(prompter),
    );
    session.owner = owner;
    context.wizardSessions.set(sessionId, session);
    const result = await session.next();
    if (result.done) {
      context.purgeWizardSession(sessionId);
    }
    respond(true, { sessionId, ...result }, undefined);
  },
  "wizard.next": async ({ params, respond, context, client }) => {
    if (!assertValidParams(params, validateWizardNextParams, "wizard.next", respond)) {
      return;
    }
    if (isSetupOnlyClient(client)) {
      const check = verifySetupToken(client?.setupToken);
      if (!check.ok) {
        respond(false, undefined, setupLinkError(check.reason));
        return;
      }
    }
    const sessionId = params.sessionId;
    const session = context.wizardSessions.get(sessionId);
    if (!session || !mayUseSession(session, callerOwner(client))) {
      respond(false, undefined, sessionNotFound());
      return;
    }
    const answer = params.answer as { stepId?: string; value?: unknown } | undefined;
    if (answer) {
      if (session.getStatus() !== "running") {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "wizard not running"));
        return;
      }
      try {
        await session.answer(String(answer.stepId ?? ""), answer.value);
      } catch (err) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, formatForLog(err)));
        return;
      }
    }
    const result = await session.next();
    if (result.done) {
      context.purgeWizardSession(sessionId);
    }
    respond(true, result, undefined);
  },
  "wizard.cancel": ({ params, respond, context, client }) => {
    if (!assertValidParams(params, validateWizardCancelParams, "wizard.cancel", respond)) {
      return;
    }
    const sessionId = params.sessionId;
    const session = context.wizardSessions.get(sessionId);
    if (!session || !mayUseSession(session, callerOwner(client))) {
      respond(false, undefined, sessionNotFound());
      return;
    }
    session.cancel();
    const status = readWizardStatus(session);
    context.wizardSessions.delete(sessionId);
    respond(true, status, undefined);
  },
  "wizard.status": ({ params, respond, context, client }) => {
    if (!assertValidParams(params, validateWizardStatusParams, "wizard.status", respond)) {
      return;
    }
    const sessionId = params.sessionId;
    const session = context.wizardSessions.get(sessionId);
    if (!session || !mayUseSession(session, callerOwner(client))) {
      respond(false, undefined, sessionNotFound());
      return;
    }
    const status = readWizardStatus(session);
    if (status.status !== "running") {
      context.wizardSessions.delete(sessionId);
    }
    respond(true, status, undefined);
  },
};
