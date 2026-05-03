import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSkillsStore } from "../../stores/skills-store";
import { SkillsView } from "./SkillsView";

const requestMock = vi.fn();
const subscribeMock = vi.fn(() => () => {});

vi.mock("../../stores/gateway-store", () => ({
  useGatewayStore: (selector: (state: unknown) => unknown) =>
    selector({
      request: requestMock,
      status: "connected",
      subscribe: subscribeMock,
    }),
}));

const skills = [
  {
    skillKey: "shell",
    name: "shell",
    description: "Run shell",
    eligible: true,
    state: "ready",
    reasons: [],
  },
  {
    skillKey: "talk-voice",
    name: "talk-voice",
    description: "Voice mode",
    eligible: false,
    state: "missing-bin",
    reasons: ["needs ffmpeg"],
  },
];

const agents = {
  defaultId: "main",
  agents: [
    { id: "main", identity: { name: "Main" } },
    { id: "research", identity: { name: "Research" } },
  ],
};

describe("SkillsView", () => {
  beforeEach(() => {
    requestMock.mockReset();
    subscribeMock.mockClear();
    useSkillsStore.setState({ skills: [], loading: false, error: null, filter: "" });
    requestMock.mockImplementation((method: string) => {
      if (method === "agents.list") return Promise.resolve(agents);
      if (method === "skills.status") return Promise.resolve({ skills });
      if (method === "skills.metrics")
        return Promise.resolve({
          metrics: [
            {
              skillKey: "shell",
              totalExecutions: 4,
              successRate: 0.75,
              avgRewardScore: 0.7,
              avgExecutionTimeMs: 120,
              userFeedbackScore: 0,
              lastExecutedAt: 1000,
              errorBreakdown: {},
            },
          ],
        });
      if (method === "skills.incoming.list") return Promise.resolve({ skills: [] });
      return Promise.resolve({ ok: true });
    });
  });

  it("renders skills from skills.status", async () => {
    render(<SkillsView />);
    await waitFor(() => {
      expect(screen.getByText("shell")).toBeTruthy();
      expect(screen.getByText("talk-voice")).toBeTruthy();
    });
  });

  it("filters tabs (Ready / Needs setup)", async () => {
    const user = userEvent.setup();
    render(<SkillsView />);
    await waitFor(() => screen.getByText("shell"));

    // Switch to "Needs setup" tab — only talk-voice should be visible.
    await user.click(screen.getByRole("button", { name: /needs setup/i }));
    expect(screen.queryByText("shell")).toBeNull();
    expect(screen.getByText("talk-voice")).toBeTruthy();
  });

  it("renders a metrics line for skills with telemetry", async () => {
    render(<SkillsView />);
    await waitFor(() => {
      expect(screen.getByText(/4 runs/)).toBeTruthy();
      expect(screen.getByText(/75% success/)).toBeTruthy();
    });
  });

  it("opens the trust settings modal", async () => {
    const user = userEvent.setup();
    render(<SkillsView />);
    await waitFor(() => screen.getByText("shell"));
    await user.click(screen.getByRole("button", { name: /trust settings/i }));
    expect(screen.getByText(/skill trust settings/i)).toBeTruthy();
  });
});
