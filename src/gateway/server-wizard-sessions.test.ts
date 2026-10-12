import { describe, expect, it } from "vitest";
import { WizardSession } from "../wizard/session.js";
import {
  createWizardSessionTracker,
  WIZARD_SESSION_IDLE_TTL_MS,
} from "./server-wizard-sessions.js";

function waitingSession(): WizardSession {
  return new WizardSession(async (prompter) => {
    await prompter.note("waiting for a client that never comes back");
  });
}

describe("wizard session tracker", () => {
  it("cancels a running session nobody touched within the idle TTL", async () => {
    let now = 1_000_000;
    const tracker = createWizardSessionTracker({ now: () => now });
    const session = waitingSession();
    await session.next();
    session.lastActivityAt = now;
    tracker.wizardSessions.set("s1", session);
    expect(tracker.findRunningWizard()).toBe("s1");

    now += WIZARD_SESSION_IDLE_TTL_MS + 1;
    expect(tracker.findRunningWizard()).toBeNull();
    expect(session.getStatus()).toBe("cancelled");
    expect(tracker.wizardSessions.has("s1")).toBe(false);
  });
});
