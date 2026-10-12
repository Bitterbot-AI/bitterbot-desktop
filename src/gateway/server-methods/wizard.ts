import { createHash, randomUUID } from "node:crypto";
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
import { isSetupOnlyScopes, revokeSetupToken, verifySetupToken } from "../setup-token.js";
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
    const agentHandler = agentHandlers.agent;
    await runSetupWizard(prompter, {
      installKind: detectInstallKind(packageRoot),
      runFirstTurn: agentHandler
        ? (cfg) => runSetupFirstTurn({ cfg, context, agentHandler })
        : undefined,
      collectDoctorSummary: (cfg) => collectSetupDoctorSummary({ cfg }),
      // Single-use: the token that drove this setup dies with it.
      onComplete: () => revokeSetupToken(),
    });
  };
}

function ownerKeyFor(token: string | undefined): string {
  return `setup:${createHash("sha256")
    .update(token ?? "")
    .digest("hex")}`;
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
    const owner = setupOnly ? ownerKeyFor(client?.setupToken) : "admin";
    if (setupOnly) {
      // The connection proved the token at connect; it must still be live now
      // (not expired, not used up by a finished setup).
      const check = verifySetupToken(client?.setupToken);
      if (!check.ok) {
        respond(false, undefined, setupLinkError(check.reason));
        return;
      }
    }
    const running = context.findRunningWizard();
    if (running) {
      // A reload of the setup page resumes its own session where it was.
      const session = context.wizardSessions.get(running);
      if (session && (session.owner === owner || owner === "admin")) {
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
    if (!session) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "wizard not found"));
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
  "wizard.cancel": ({ params, respond, context }) => {
    if (!assertValidParams(params, validateWizardCancelParams, "wizard.cancel", respond)) {
      return;
    }
    const sessionId = params.sessionId;
    const session = context.wizardSessions.get(sessionId);
    if (!session) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "wizard not found"));
      return;
    }
    session.cancel();
    const status = readWizardStatus(session);
    context.wizardSessions.delete(sessionId);
    respond(true, status, undefined);
  },
  "wizard.status": ({ params, respond, context }) => {
    if (!assertValidParams(params, validateWizardStatusParams, "wizard.status", respond)) {
      return;
    }
    const sessionId = params.sessionId;
    const session = context.wizardSessions.get(sessionId);
    if (!session) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "wizard not found"));
      return;
    }
    const status = readWizardStatus(session);
    if (status.status !== "running") {
      context.wizardSessions.delete(sessionId);
    }
    respond(true, status, undefined);
  },
};
