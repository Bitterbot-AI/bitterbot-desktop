import type { WizardSession } from "../wizard/session.js";

/**
 * A running wizard nobody has touched for this long is cancelled the next
 * time anyone looks for the running wizard (PLAN-56 Phase 4: a closed setup
 * tab must not block every later setup until the gateway restarts).
 */
export const WIZARD_SESSION_IDLE_TTL_MS = 30 * 60 * 1000;

export function createWizardSessionTracker(opts?: { idleTtlMs?: number; now?: () => number }) {
  const wizardSessions = new Map<string, WizardSession>();
  const idleTtlMs = opts?.idleTtlMs ?? WIZARD_SESSION_IDLE_TTL_MS;
  const now = opts?.now ?? Date.now;

  const findRunningWizard = (): string | null => {
    for (const [id, session] of wizardSessions) {
      if (session.getStatus() !== "running") {
        continue;
      }
      if (now() - session.lastActivityAt > idleTtlMs) {
        session.cancel();
        wizardSessions.delete(id);
        continue;
      }
      return id;
    }
    return null;
  };

  const purgeWizardSession = (id: string) => {
    const session = wizardSessions.get(id);
    if (!session) {
      return;
    }
    if (session.getStatus() === "running") {
      return;
    }
    wizardSessions.delete(id);
  };

  return { wizardSessions, findRunningWizard, purgeWizardSession };
}
