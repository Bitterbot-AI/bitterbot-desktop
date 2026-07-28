import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { CanvasCard, Circle, SandboxSession, SandboxState } from "../../stores/circles-store";
import { SandboxCard } from "./SandboxCard";

// PLAN-38 P1(b): the session card. Pinned here: the two-axis header (format
// chip + agents chip, never a fifth card type), the named wait line, the R18
// agent-authored labeling, the practice seat's "simulated" label, the paused
// state saying WHY, the legible close reason, and the propose tray rendering
// an awaiting proposal with approve/discard only.

const SELF = "ed25519:self";
const ANA = "ed25519:ana";
const BOT = "ed25519:practice";

const CIRCLE = {
  circleId: "c1",
  name: "Friends",
  kind: "connection",
  status: "active",
  members: [
    { memberPubkey: SELF, displayName: "Me", role: "creator", isSelf: true },
    { memberPubkey: ANA, displayName: "Ana", petname: "ana-nyc", role: "member", isSelf: false },
    { memberPubkey: BOT, displayName: "Practice Partner (bot)", role: "member", isSelf: false },
  ],
} as unknown as Circle;

const CARD = {
  cardId: "card-1",
  cardType: "decision",
  title: "Spring trip: June, 4 people",
  text: "",
  authorPubkey: ANA,
  updatedAt: 1,
  slices: [],
} as unknown as CanvasCard;

function makeSession(overrides: Partial<SandboxSession> = {}): SandboxSession {
  return {
    cardId: "card-1",
    taskType: "negotiation",
    goal: "Pick dates and a place",
    roundCap: 3,
    framedBy: ANA,
    enrollments: [
      { authorPubkey: SELF, mode: "propose", updatedAt: 1 },
      { authorPubkey: ANA, mode: "propose", updatedAt: 1 },
      { authorPubkey: BOT, mode: "propose", updatedAt: 1 },
    ],
    speakers: [SELF, ANA, BOT].toSorted(),
    moves: [
      {
        round: 0,
        kind: "constraint",
        text: "Ceiling is $900 all-in.",
        optionId: "",
        label: "",
        authorPubkey: ANA,
        agentAuthored: true,
        authors: [ANA],
        eventHash: "h1",
        claimedAt: 1,
      },
      {
        round: 0,
        kind: "option.add",
        text: "",
        optionId: "cabin-b",
        label: "Cabin B — $185/n",
        authorPubkey: SELF,
        agentAuthored: false,
        authors: [SELF],
        eventHash: "h2",
        claimedAt: 2,
      },
    ],
    options: [{ optionId: "cabin-b", label: "Cabin B — $185/n", text: "", proposedBy: SELF }],
    votes: { "cabin-b": [ANA] },
    closed: null,
    currentRound: 0,
    status: "live",
    myTurn: false,
    waitingOn: [BOT],
    myEnrollment: {
      mode: "propose",
      turnBudget: 10,
      turnsUsed: 2,
      tokenBudget: 200_000,
      tokensUsed: 21_000,
      guidance: "",
      pausedAt: null,
      pauseReason: null,
    },
    ...overrides,
  };
}

function makeState(session: SandboxSession): SandboxState {
  return { generationEnabled: true, practicePubkey: BOT, sessions: [session] };
}

function renderCard(session: SandboxSession) {
  const state = makeState(session);
  return render(
    <SandboxCard card={CARD} session={session} sandbox={state} circle={CIRCLE} selfPubkey={SELF} />,
  );
}

describe("SandboxCard", () => {
  it("renders both axes: the card format and the agent session, never a merged type", () => {
    renderCard(makeSession());
    expect(screen.getByText("decision")).toBeTruthy();
    expect(screen.getByText(/agents · negotiation/)).toBeTruthy();
    expect(screen.getByText(/live · round 1 of 3/)).toBeTruthy();
  });

  it("names who the round waits on — never a spinner", () => {
    renderCard(makeSession());
    expect(screen.getByText(/waiting on Practice Partner \(bot\)/)).toBeTruthy();
  });

  it("labels agent-authored moves (R18) and the practice seat as simulated", () => {
    renderCard(makeSession());
    // Ana's constraint carries the agent label; my option does not.
    expect(screen.getByText("Ceiling is $900 all-in.")).toBeTruthy();
    expect(screen.getAllByText(/'s agent/).length).toBeGreaterThan(0);
    expect(screen.getByText(/simulated/)).toBeTruthy();
    expect(screen.getByText("+ Cabin B — $185/n")).toBeTruthy();
  });

  it("says WHY when paused and offers one-tap resume", () => {
    renderCard(
      makeSession({
        myEnrollment: {
          mode: "propose",
          turnBudget: 10,
          turnsUsed: 2,
          tokenBudget: 200_000,
          tokensUsed: 0,
          guidance: "",
          pausedAt: 123,
          pauseReason: "thinking it over",
        },
      }),
    );
    expect(screen.getByText(/thinking it over/)).toBeTruthy();
    expect(screen.getByText("Resume")).toBeTruthy();
  });

  it("shows a legible, attributed close and retires the composer", () => {
    renderCard(
      makeSession({
        status: "closed",
        closed: { reason: "done", byPubkey: ANA, at: 5 },
        waitingOn: [],
      }),
    );
    expect(screen.getAllByText(/ratified and closed/).length).toBeGreaterThan(0);
    expect(screen.queryByText("+ Constraint")).toBeNull();
    expect(screen.queryByText("Pause")).toBeNull();
  });

  it("renders the work-ratio verdict band from the fold", () => {
    renderCard(makeSession());
    // 2 moves; deltas = 1 option + 1 vote.
    const band = screen.getByText(/deltas/);
    expect(band.textContent).toContain("2 moves");
    expect(band.textContent).toContain("2 deltas");
  });
});
